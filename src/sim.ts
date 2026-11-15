import { PATH_COST_PER_M, PATH_MAX_GRADE, PATH_MIN_LEG, PATH_SNAP, PATH_SPEED, PATH_WIDTH, Path, PathNet } from "./paths";
import { HIGHWAY, ROAD_COST_PER_M, ROAD_MAX_GRADE, ROAD_MIN_LEG, ROAD_SNAP, ROAD_WIDTH, Road, legGrade, nearestOnRoad, roadLength, routeTo } from "./roads";
import { SculptMode, TREELINE_M, flattenPad, isRock, rockAt, sculpt } from "./height";
import { elevation, elevationM, gradeAt, lerp, nearSegment, noise2, pointOnPolyline, polylineLength } from "./height";
import {
  BUILDING_LABEL,
  BUILDING_MAX,
  Building,
  BuildingType,
  COSTS,
  DIFF,
  FEATURE_SPEC,
  Feature,
  FOOD_BUILDINGS,
  HELI,
  LODGING_BUILDINGS,
  PARKING,
  STARTER_LOT_SKIERS,
  buildingRadius,
  OPERATING_COST_PER_MIN,
  FeatureType,
  INCOME_PER_MIN,
  CABIN_REACH,
  MAP_SCALE,
  MOVE_FEE,
  TRAIL_KIND_SPEC,
  TrailKind,
  BASE,
  CONQUER_DROP_M,
  CONQUER_RADIUS_M,
  PEAKS,
  TIERS,
  MountainId,
  PLACE_ANYWHERE,
  PLACE_MOUNTAIN,
  STAFF_LABEL,
  STAFF_ROLES,
  STAFF_WAGE_PER_MIN,
  StaffRole,
  Difficulty,
  Fx,
  Goal,
  LIFT_SPECS,
  Lift,
  LiftType,
  ECON,
  Skier,
  START_MONEY,
  START_TICKET,
  Toast,
  Tool,
  Trail,
  UNIT_M,
  VERTICAL_M,
  Vec2,
  WORLD_H,
  WORLD_W,
  liftCost,
  APPEAL,
  BUILDING_BLURB,
  SHOP_BUILDINGS,
  TRAILSIDE,
  unlockTier,
} from "./types";

void MAP_SCALE;

/** Each peak snapped to the true high point near its map label. */
export const SUMMITS = PEAKS.map((p) => {
  let best = { x: p.x, y: p.y, m: -1 };
  for (let dx = -250; dx <= 250; dx += 10) {
    for (let dy = -250; dy <= 250; dy += 10) {
      const m = elevationM(p.x + dx, p.y + dy);
      if (m > best.m) best = { x: p.x + dx, y: p.y + dy, m };
    }
  }
  return { id: p.id, name: p.name, x: best.x, y: best.y, elevation: Math.round(best.m) };
});

/** Forest grid: one possible tree per cell. */
const TREE_CELL = 12;
const WALK = 1.8;
const SKI = 2;

const NAMES = [
  "Ava", "Bo", "Cora", "Drew", "Eli", "Faye", "Gus", "Hana", "Ivy", "Jed",
  "Kai", "Liv", "Mae", "Ned", "Oli", "Pia", "Quin", "Rio", "Sky", "Tess",
];

const JACKETS = ["#c45c4a", "#3a6ea5", "#d98a2b", "#4f8a5b", "#7a4ea3", "#2c3d4f", "#d15a7c", "#1f6f8b"];

const TRAIL_PREFIX = ["Whisper", "Eagle", "Pine", "Goat", "Ridge", "Frost", "Cedar", "Hawk", "Willow", "Storm", "Fox", "Glacier"];
const TRAIL_SUFFIX = ["Run", "Glade", "Alley", "Line", "Trail", "Chute", "Way", "Bowl"];
const LIFT_PREFIX = ["Summit", "Lookout", "Aspen", "Powder", "Timber", "Falcon", "Bluebird", "Highline", "Raven", "Tamarack", "Cirque", "Sundance"];

export interface LiftCheck {
  error: string | null;
  length: number;
  rise: number;
  cost: number;
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function pick<T>(arr: T[]): T {
  return arr[(Math.random() * arr.length) | 0];
}

export function trailCost(length: number, kind: TrailKind = "slope"): number {
  return Math.round(((60 + length * 0.6) * TRAIL_KIND_SPEC[kind].costMul * ECON) / 10) * 10;
}

export function classifyGrade(dropM: number, lengthM: number): Difficulty {
  const grade = dropM / Math.max(12, lengthM);
  // Real-world-ish pitches: green < 25%, blue < 40%, black < 60%.
  if (grade < 0.25) return 0;
  if (grade < 0.4) return 1;
  if (grade < 0.6) return 2;
  return 3;
}

export function measureTrail(
  points: Vec2[],
  mountain: MountainId = 0,
  kind: TrailKind = "slope",
): { length: number; drop: number; difficulty: Difficulty; cost: number } {
  const length = polylineLength(points);
  const drop =
    elevation(points[0].x, points[0].y, mountain) -
    elevation(points[points.length - 1].x, points[points.length - 1].y, mountain);
  const base = classifyGrade(drop * VERTICAL_M, length * UNIT_M);
  const difficulty = Math.min(3, base + TRAIL_KIND_SPEC[kind].diffBump) as Difficulty;
  return { length, drop, difficulty, cost: trailCost(length, kind) };
}

export interface Selection {
  kind: "trail" | "building" | "lift" | "skier" | "hill";
  id: number;
}

export class Game {
  money = START_MONEY;
  ticketPrice = START_TICKET;
  day = 1;
  dayT = 0;
  /** New snow on the ground (cm): piles up in a storm, settles and gets skied off after. */
  freshSnowCm = 0;
  speed = 1;
  paused = false;
  managing = false;
  tool: Tool = "select";
  trails: Trail[] = [];
  lifts: Lift[] = [];
  /** Bottom station picked while placing a lift, and the pointer for the preview. */
  liftStart: Vec2 | null = null;
  liftHover: Vec2 | null = null;
  /** The highway (always first) and every road the player has built. */
  roads: Road[] = [{ id: 0, points: HIGHWAY.map((p) => ({ ...p })), highway: true }];
  /** Bumped whenever the road network changes. */
  roadVersion = 0;
  /** Footpaths people walk on between buildings. */
  paths: Path[] = [];
  pathVersion = 0;
  private pathNetCache: { v: number; net: PathNet } | null = null;
  /** Goals already paid out, and celebrations waiting to be shown. */
  goalsPaid = new Set<string>();
  rewards: Reward[] = [];
  private goalCheckT = 0;
  /** Circles of forest the player has felled with the tree brush. */
  clearings: { x: number; y: number; r: number }[] = [];
  /** Trees the player has planted (on top of the procedural forest). */
  planted: Vec2[] = [];
  private plantedCells = new Map<number, Vec2[]>();
  /** Tree planting: one tree per click, or a brush that fills an area. */
  plantMode: "single" | "brush" = "brush";
  treesPlanted = 0;
  treesFelled = 0;
  /** Shaping brush: mode, radius (m), and the stroke in progress. */
  shapeMode: SculptMode = "raise";
  shapeRadius = 60;
  shapeTarget: number | null = null;
  shapeCost = 0;
  shapeVolume = 0;
  private shapeAt: Vec2 | null = null;
  private shapeBroke = false;
  private shapeCleared: Vec2 | null = null;
  /** Bumped whenever the ground is regraded. */
  terrainEdits = 0;
  /** Where the tree brush is hovering (for its outline). */
  brushHover: Vec2 | null = null;
  private routeCache: { v: string; route: Vec2[] | null } = { v: "", route: null };
  private connCache: { v: number; ids: Set<number> } = { v: -1, ids: new Set() };
  buildings: Building[] = [];
  skiers: Skier[] = [];
  features: Feature[] = [];
  /** Kind of run the Trail tool cuts. */
  trailKind: TrailKind = "slope";
  /** Building being moved with the Move tool. */
  moveId: number | null = null;
  /** Settings: charge a fee to move buildings. */
  moveFeeOn = true;
  /** Settings: clear trees and shape the ground at no cost. */
  freeTreeClearing = false;
  freeShaping = false;
  /** The heli-ski helicopter: on the pad loading, or away on a drop. */
  heli: { flying: boolean; t: number; riders: number[]; wait: number } = { flying: false, t: 0, riders: [], wait: 0 };
  heliFlightsToday = 0;
  /**
   * Per-tick indexes so thousands of skiers stay cheap: skiers by id, each
   * lift's line in order, everyone's place in their line, line lengths, and
   * the runs each lift serves.
   */
  private byId = new Map<number, Skier>();
  private lines = new Map<number, Skier[]>();
  private lineSpot = new Map<number, number>();
  private lineLen = new Map<number, number>();
  private served = new Map<number, Trail[]>();
  private heliSpot = new Map<number, number>();
  /** Ticket money is shown as one float every couple of seconds, not per skier. */
  private boothTake = 0;
  /** Game seconds since start; orders lift lines. */
  clock = 0;
  private loadCache: ReturnType<Game["loadLimits"]> | null = null;
  private loadCacheT = -1;
  private loadCacheKey = "";
  private boothT = 0;
  heliTakeToday = 0;
  upkeepToday = 0;
  fx: Fx[] = [];
  toasts: Toast[] = [];
  draft: Vec2[] = [];
  hover: Selection | null = null;
  selected: Selection | null = null;
  nextId = 1;
  spawnAcc = 0;
  mood = 62;
  ticketsToday = 0;
  incomeToday = 0;
  shopIncomeToday = 0;
  totalTickets = 0;
  peakSkiers = 0;
  sfx: Array<"cash" | "build" | "err"> = [];
  nextToast = 1;
  usedTrailNames = new Set<string>();
  thoughtAcc = 0;
  currentMountain: MountainId = 0;
  /** Peaks conquered so far (by id). */
  conquered = new Set<string>();
  won = false;
  /** Bumped whenever the forest changes (a run, lift, building or feature clears it). */
  forestVersion = 0;
  lifetimeEarned = 0;
  wagesToday = 0;
  staff: Record<StaffRole, number> = { patrol: 0, food: 0, lift: 0, delivery: 0, maintenance: 0, instructor: 0 };

  constructor() {
    this.layoutStarter();
    for (let i = 0; i < 7; i++) this.spawnSkier(true);
  }

  /**
   * Find a spot for the starter T-bar on the gentle slopes above the base
   * village, and two short runs back down beside it.
   */
  private layoutStarter(): void {
    const money = this.money;
    this.money = Infinity;
    const baseM = elevationM(BASE.x, BASE.y);
    let best: { a: Vec2; b: Vec2; score: number } | null = null;
    for (let ang = 0; ang < 360; ang += 10) {
      const dx = Math.cos((ang * Math.PI) / 180);
      const dy = Math.sin((ang * Math.PI) / 180);
      for (const start of [120, 220, 320]) {
        const a = { x: BASE.x + dx * start, y: BASE.y + dy * start };
        for (const len of [450, 600, 750, 900]) {
          const b = { x: a.x + dx * len, y: a.y + dy * len };
          const check = this.checkLift("tbar", a, b);
          if (check.error) continue;
          // Want a solid rise on gentle-ish ground, close to the village.
          const grade = check.rise / len;
          const score = Math.min(check.rise, 180) - Math.abs(grade - 0.2) * 300 - start * 0.1 - (elevationM(a.x, a.y) - baseM) * 0.2;
          if (!best || score > best.score) best = { a, b, score };
        }
      }
    }
    if (!best) throw new Error("No room for the starter T-bar");
    this.lifts = [this.makeLift("tbar", "Valley T-Bar", best.a, best.b)];
    // Two runs from the top back to the bottom, swinging out either side of the lift.
    const { a, b } = best;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const names = ["Easy Street", "Valley Run"];
    [-1, 1].forEach((side, i) => {
      const off = (d: number) => ({ x: -uy * d * side, y: ux * d * side });
      const pts: Vec2[] = [];
      for (const [t, d] of [[1, 30], [0.75, 110], [0.5, 140], [0.25, 110], [0.02, 45]] as const) {
        const o = off(d);
        pts.push({ x: a.x + (b.x - a.x) * t + o.x, y: a.y + (b.y - a.y) * t + o.y });
      }
      this.trails.push(this.makeTrail(names[i], pts));
    });
    this.money = money;
  }

  private makeTrail(name: string, points: Vec2[], kind: TrailKind = "slope"): Trail {
    const m = measureTrail(points, this.currentMountain, kind);
    this.usedTrailNames.add(name);
    return { id: this.nextId++, name, points, kind, ...m };
  }

  /**
   * The forest is procedural: one possible tree per 12 m cell, jittered, kept
   * where a patchy density field says so, thinning out toward the treeline
   * and absent on cliffs and in the village. Runs, lifts, buildings and park
   * features clear it; glades only thin it. Nothing is stored per tree, so
   * the whole 28 km map can be forested.
   */
  treesIn(x0: number, y0: number, x1: number, y1: number, cleared = true, stride = 1): Vec2[] {
    const out: Vec2[] = [];
    const gx0 = Math.max(0, Math.floor(x0 / TREE_CELL));
    const gy0 = Math.max(0, Math.floor(y0 / TREE_CELL));
    const gx1 = Math.min(Math.floor(WORLD_W / TREE_CELL), Math.ceil(x1 / TREE_CELL));
    const gy1 = Math.min(Math.floor(WORLD_H / TREE_CELL), Math.ceil(y1 / TREE_CELL));
    const near = cleared ? this.clearersIn(x0 - 40, y0 - 40, x1 + 40, y1 + 40) : null;
    // A stride > 1 samples one random cell from each stride x stride block,
    // for a sparser far-off view that still doesn't fall into rows.
    const sx = Math.floor(gx0 / stride) * stride;
    const sy = Math.floor(gy0 / stride) * stride;
    for (let by = sy; by <= gy1; by += stride) {
      for (let bx = sx; bx <= gx1; bx += stride) {
        const gx = stride > 1 ? bx + Math.floor(cellHash(bx, by, 7) * stride) : bx;
        const gy = stride > 1 ? by + Math.floor(cellHash(bx, by, 8) * stride) : by;
        if (gx < gx0 || gx > gx1 || gy < gy0 || gy > gy1) continue;
        const t = forestCell(gx, gy);
        if (!t) continue;
        if (this.inVillage(t.x, t.y)) continue;
        if (near && this.isCleared(t.x, t.y, near)) continue;
        out.push(t);
      }
    }
    // Planted trees: a random share of them when sampling sparsely.
    const keep = 1 / (stride * stride);
    for (let cy = Math.floor(y0 / PLANT_CELL); cy <= Math.floor(y1 / PLANT_CELL); cy++) {
      for (let cx = Math.floor(x0 / PLANT_CELL); cx <= Math.floor(x1 / PLANT_CELL); cx++) {
        const list = this.plantedCells.get(cy * 4096 + cx);
        if (!list) continue;
        for (const t of list) {
          if (t.x < x0 || t.x > x1 || t.y < y0 || t.y > y1) continue;
          if (stride > 1 && treeHash(t.x, t.y) > keep) continue;
          if (near && this.isCleared(t.x, t.y, near, true)) continue;
          out.push(t);
        }
      }
    }
    return out;
  }

  /** Clear a circle of forest: the procedural trees stay cleared, planted ones are dug up. */
  private addClearing(x: number, y: number, r: number): void {
    this.clearings.push({ x, y, r });
    this.removePlanted(x, y, r);
  }

  private removePlanted(x: number, y: number, r: number): number {
    let n = 0;
    for (let cy = Math.floor((y - r) / PLANT_CELL); cy <= Math.floor((y + r) / PLANT_CELL); cy++) {
      for (let cx = Math.floor((x - r) / PLANT_CELL); cx <= Math.floor((x + r) / PLANT_CELL); cx++) {
        const key = cy * 4096 + cx;
        const list = this.plantedCells.get(key);
        if (!list) continue;
        const kept = list.filter((t) => Math.hypot(t.x - x, t.y - y) >= r);
        n += list.length - kept.length;
        if (kept.length) this.plantedCells.set(key, kept);
        else this.plantedCells.delete(key);
      }
    }
    if (n) this.planted = [...this.plantedCells.values()].flat();
    return n;
  }

  /** Why a tree can't be planted here, or null if it can. */
  private plantError(x: number, y: number, near: ClearIndex, existing: Vec2[]): string | null {
    if (x < 6 || y < 6 || x > WORLD_W - 6 || y > WORLD_H - 6) return "That's off the property.";
    if (isRock(x, y) || rockAt(x, y) > 0.3) return "Nothing grows on bare rock.";
    if (gradeAt(x, y) > 0.9) return "Too steep for a tree.";
    if (elevationM(x, y) > TREELINE_M + 150) return "Too high: that's above the treeline.";
    if (this.isCleared(x, y, near, true)) return "Keep trees off runs, lifts, roads and buildings.";
    if (existing.some((t) => Math.hypot(t.x - x, t.y - y) < PLANT_GAP)) return "There's already a tree there.";
    return null;
  }

  /** Plant one tree, or a brushful scattered around (x, y). */
  private paintPlanting(x: number, y: number): "ok" | "shake" | "none" {
    const single = this.plantMode === "single";
    if (!single && this.lastBrush && Math.hypot(this.lastBrush.x - x, this.lastBrush.y - y) < BRUSH_R * 0.45) return "none";
    const r = single ? PLANT_GAP : BRUSH_R;
    const near = this.clearersIn(x - r - 40, y - r - 40, x + r + 40, y + r + 40);
    const existing = this.treesIn(x - r - PLANT_GAP, y - r - PLANT_GAP, x + r + PLANT_GAP, y + r + PLANT_GAP);
    const spots: Vec2[] = [];
    if (single) {
      const err = this.plantError(x, y, near, existing);
      if (err) {
        this.toast(err, true);
        return "shake";
      }
      spots.push({ x, y });
    } else {
      for (let k = 0; k < 60 && spots.length < PLANT_PER_STAMP; k++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * BRUSH_R;
        const p = { x: x + Math.cos(a) * d, y: y + Math.sin(a) * d };
        if (!this.plantError(p.x, p.y, near, existing)) {
          spots.push(p);
          existing.push(p);
        }
      }
      if (!spots.length) return "none";
    }
    const cost = this.freeTreeClearing ? 0 : spots.length * TREE_PLANT_COST;
    if (cost > 0 && this.money < cost) {
      this.toast(`Need $${(cost - this.money).toLocaleString()} more to plant trees.`, true);
      return "shake";
    }
    this.money -= cost;
    for (const p of spots) {
      const key = Math.floor(p.y / PLANT_CELL) * 4096 + Math.floor(p.x / PLANT_CELL);
      const list = this.plantedCells.get(key);
      if (list) list.push(p);
      else this.plantedCells.set(key, [p]);
      this.planted.push(p);
    }
    this.treesPlanted += spots.length;
    this.lastBrush = { x, y };
    this.strokeCost += cost;
    this.clearTrees();
    if (single) this.endBrush();
    return "ok";
  }

  /**
   * Everything that keeps trees off the ground (runs, lifts, roads, buildings,
   * features, brushed clearings) as capsules, bucketed into a coarse grid over
   * a box so each tree only checks what's near it.
   */
  private clearersIn(x0: number, y0: number, x1: number, y1: number): ClearIndex {
    const cell = 64;
    const cells = new Map<number, ClearShape[]>();
    const cols = Math.ceil((x1 - x0) / cell) + 1;
    const add = (ax: number, ay: number, bx: number, by: number, r: number, glade = false, brush = false) => {
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / cell));
      const i1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + r - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - y0) / cell));
      const j1 = Math.floor((Math.min(y1, Math.max(ay, by) + r) - y0) / cell);
      if (i0 > i1 || j0 > j1) return;
      const shape: ClearShape = { ax, ay, bx, by, r, glade, brush };
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * cols + i;
          const list = cells.get(k);
          if (list) list.push(shape);
          else cells.set(k, [shape]);
        }
      }
    };
    for (const t of this.trails) {
      const glade = t.kind === "glades";
      const r = TRAIL_KIND_SPEC[t.kind].width / 2 + (glade ? 0 : 9);
      for (let i = 1; i < t.points.length; i++) add(t.points[i - 1].x, t.points[i - 1].y, t.points[i].x, t.points[i].y, r, glade);
    }
    for (const l of this.lifts) add(l.bottom.x, l.bottom.y, l.top.x, l.top.y, 16);
    for (const b of this.buildings) add(b.x, b.y, b.x, b.y, buildingRadius(b.type));
    for (const f of this.features) add(f.x, f.y, f.x, f.y, f.type === "halfpipe" ? 40 : 12);
    for (const [a, b, w] of this.roadSegsIn(x0, y0, x1, y1)) add(a.x, a.y, b.x, b.y, w / 2 + 5);
    for (const pth of this.paths) {
      for (let i = 1; i < pth.points.length; i++) add(pth.points[i - 1].x, pth.points[i - 1].y, pth.points[i].x, pth.points[i].y, PATH_WIDTH / 2 + 2);
    }
    for (const c of this.clearings) add(c.x, c.y, c.x, c.y, c.r, false, true);
    return { x0, y0, cell, cols, cells };
  }

  /** Is this spot kept clear of trees? Planted trees ignore old brushed clearings (a clearing digs up what was planted before it). */
  private isCleared(x: number, y: number, near: ClearIndex, planted = false): boolean {
    const i = Math.floor((x - near.x0) / near.cell);
    const j = Math.floor((y - near.y0) / near.cell);
    const list = near.cells.get(j * near.cols + i);
    if (!list) return false;
    for (const c of list) {
      if (planted && c.brush) continue;
      if (!nearSegment(c.ax, c.ay, c.bx, c.by, x, y, c.r)) continue;
      // Glades are thinned, not cleared: a narrow line down the middle, then every other tree.
      if (!c.glade || nearSegment(c.ax, c.ay, c.bx, c.by, x, y, 2.5) || treeHash(x, y) < 0.5) return true;
    }
    return false;
  }

  /** Trees standing inside a corridor along a path (for glades and the "trees cleared" count). */
  private treesAlong(points: Vec2[], halfWidth: number, cleared = true): number {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of points) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const probe = { points } as Trail;
    return this.treesIn(x0 - halfWidth, y0 - halfWidth, x1 + halfWidth, y1 + halfWidth, cleared).filter(
      (t) => distToTrail(probe, t.x, t.y) < halfWidth,
    ).length;
  }

  /** Called whenever something clears or thins the forest. */
  private clearTrees(): void {
    this.forestVersion++;
  }

  id(): number {
    return this.nextId++;
  }

  clockLabel(): string {
    const minutes = 8 * 60 + 30 + (this.dayT / 52) * (7.5 * 60);
    const h24 = Math.floor(minutes / 60);
    const m = Math.floor(minutes % 60);
    const h = ((h24 + 11) % 12) + 1;
    const ap = h24 >= 12 ? "PM" : "AM";
    const w = this.weather();
    const sky = w.snow > 0.15 ? "❄ Snowing" : w.cover > 0.45 ? "☁ Cloudy" : w.cover > 0.2 ? "⛅ Sunny spells" : "☀ Clear";
    return `Day ${this.day} · ${h}:${m.toString().padStart(2, "0")} ${ap} · ${sky}`;
  }

  /** Clock time for a point in the open day (0..52 game seconds), e.g. "2:15 PM". */
  timeOfDay(dayT = this.dayT): string {
    const minutes = 8 * 60 + 30 + (dayT / 52) * (7.5 * 60);
    const h24 = Math.floor(minutes / 60);
    const m = Math.floor(minutes % 60);
    return `${((h24 + 11) % 12) + 1}:${m.toString().padStart(2, "0")} ${h24 >= 12 ? "PM" : "AM"}`;
  }

  /** The weather at another point in game time (days from now, can be fractional). */
  private weatherAt(daysAhead: number): { cover: number; snow: number; wind: number } {
    const [day, dayT] = [this.day, this.dayT];
    const t = day + dayT / 52 + daysAhead;
    this.day = Math.floor(t);
    this.dayT = (t - this.day) * 52;
    const w = this.weather();
    this.day = day;
    this.dayT = dayT;
    return w;
  }

  /**
   * What the weather panel shows: conditions now, temperature at the base,
   * wind, fresh snow on the ground and a short forecast for the rest of the
   * day (looking into tomorrow morning once the afternoon is on).
   */
  weatherReport(): { icon: string; condition: string; tempC: number; windKmh: number; freshCm: number; forecast: string } {
    const w = this.weather();
    const icon = w.snow > 0.15 ? "❄" : w.cover > 0.45 ? "☁" : w.cover > 0.2 ? "⛅" : "☀";
    const condition =
      w.snow > 0.7 ? "Heavy snow" : w.snow > 0.15 ? "Snowing" : w.cover > 0.7 ? "Overcast" : w.cover > 0.45 ? "Cloudy" : w.cover > 0.2 ? "Sunny spells" : "Clear skies";
    // Coldest first thing, warmest mid-afternoon; cloud keeps it milder, snow colder.
    const f = this.dayFraction();
    const tempC = Math.round(-9 + 6 * Math.sin(Math.PI * Math.min(1, f * 1.15)) + (w.cover - 0.5) * 3 - w.snow * 2 + (noise2(this.day * 0.71, 3) - 0.5) * 6);
    const windKmh = Math.round(4 + w.wind * 30 + w.snow * 15);
    const snowing = w.snow > 0.15;
    let forecast = snowing ? "Snowing into tomorrow" : w.cover > 0.45 ? "Staying cloudy" : "Fine for the rest of the day";
    // Look ahead in steps of about 20 game minutes.
    const step = 1 / 22;
    const left = 1 - f;
    for (let k = 1; k <= 14; k++) {
      const a = k * step;
      const next = this.weatherAt(a);
      if ((next.snow > 0.15) === snowing) continue;
      const when = a <= left ? `by ${this.timeOfDay((f + a) * 52)}` : a - left < 0.35 ? "overnight" : "tomorrow morning";
      forecast = snowing ? `Clearing ${when}` : `Snow ${when === "overnight" || when === "tomorrow morning" ? when : `from ${this.timeOfDay((f + a) * 52)}`}`;
      break;
    }
    return { icon, condition, tempC, windKmh, freshCm: Math.round(this.freshSnowCm), forecast };
  }

  /** How far through the open day we are: 0 at 8:30 AM, 1 at 4 PM. */
  dayFraction(): number {
    return Math.min(1, Math.max(0, this.dayT / 52));
  }

  /**
   * The weather is a slow mix of waves over game time, so storms roll in and
   * clear over a day or two. Day one opens clear. cover: 0 clear .. 1 overcast;
   * snow: 0 none .. 1 heavy, only once the cloud is thick enough.
   */
  weather(): { cover: number; snow: number; wind: number } {
    const t = this.day + this.dayT / 52;
    const tau = Math.PI * 2;
    let cover =
      0.46 + 0.3 * Math.sin((tau * t) / 2.3 + 1.0) + 0.17 * Math.sin((tau * t) / 0.9 + 2.1) + 0.08 * Math.sin((tau * t) / 0.37 + 0.4);
    cover *= Math.min(1, Math.max(0, (t - 1.15) / 0.6));
    cover = Math.min(1, Math.max(0, cover));
    const k = Math.min(1, Math.max(0, (cover - 0.62) / 0.25));
    const snow = k * k * (3 - 2 * k);
    const wind = 0.5 + 0.5 * Math.sin((tau * t) / 1.7 + 0.8);
    return { cover, snow, wind };
  }

  variety(): { counts: number[]; score: number; kinds: Set<TrailKind> } {
    const counts = [0, 0, 0, 0];
    const kinds = new Set<TrailKind>();
    for (const t of this.trails) {
      counts[t.difficulty]++;
      kinds.add(t.kind);
    }
    let score =
      Math.min(counts[0], 2) / 2 * 0.28 +
      Math.min(counts[1], 2) / 2 * 0.26 +
      Math.min(counts[2], 1) * 0.24 +
      Math.min(counts[3], 1) * 0.22;
    // Specialty runs and park features widen the appeal.
    if (kinds.has("slalom")) score += 0.05;
    if (kinds.has("moguls")) score += 0.05;
    if (kinds.has("park")) score += 0.06;
    score += Math.min(0.08, this.features.length * 0.012);
    return { counts, score, kinds };
  }

  amenityScore(): number {
    let n = 0;
    if (this.has("lodge")) n += 0.18;
    n += Math.min(2, this.count("restroom")) * 0.1;
    if (this.has("coffee")) n += 0.12;
    if (this.has("sandwich")) n += 0.12;
    if (this.has("cafeteria")) n += 0.12;
    if (this.has("bar")) n += 0.13;
    n += Math.min(3, this.count("shack")) * 0.08;
    if (this.has("hotel")) n += 0.16;
    if (this.has("hostel")) n += 0.11;
    if (this.has("restaurant")) n += 0.14;
    if (this.has("shop")) n += 0.1;
    if (this.has("condo")) n += 0.14;
    if (this.has("spa")) n += 0.15;
    if (this.has("patrol")) n += 0.08;
    if (this.has("clinic")) n += 0.1;
    if (this.has("rental")) n += 0.11;
    if (this.has("school")) n += 0.12;
    // Ski-in / ski-out cabins: a little more appeal for each one, up to ten.
    n += Math.min(10, this.skiInCabins()) * 0.025;
    if (this.has("heli")) n += 0.15;
    // Pizzerias, steakhouses, boutiques, inns...: each kind on offer widens the appeal.
    for (const [type, v] of Object.entries(APPEAL) as [BuildingType, number][]) if (this.has(type)) n += v;
    return Math.min(2.1, n);
  }

  fairPrice(): number {
    return Math.round(34 + this.amenityScore() * 38 + this.variety().score * 22);
  }

  /** Roughly how long, in seconds, the average lift line takes right now. */
  liftWait(): number {
    // Average over the people in line: each waits about (their line / that lift's haul rate).
    let queued = 0;
    let total = 0;
    for (const l of this.lifts) {
      const spec = LIFT_SPECS[l.type];
      const q = this.lines.get(l.id)?.length ?? 0;
      const perSec = (spec.seats * spec.speed) / spec.spacing;
      queued += q;
      total += q * (q / perSec);
    }
    return queued > 0 ? total / queued : 0;
  }

  /** Current resort tier: grows as peaks are conquered. */
  tier(): number {
    let t = 0;
    TIERS.forEach((tier, i) => {
      if (this.conquered.size >= tier.peaksNeeded) t = i;
    });
    return t;
  }

  capacity(): number {
    return TIERS[this.tier()].capacity;
  }

  /** A peak is conquered when a lift's top station reaches its summit. */
  private checkConquest(): void {
    const before = this.tier();
    for (const p of SUMMITS) {
      if (this.conquered.has(p.id)) continue;
      const reached = this.lifts.some(
        (l) =>
          Math.hypot(l.top.x - p.x, l.top.y - p.y) <= CONQUER_RADIUS_M &&
          elevationM(l.top.x, l.top.y) >= p.elevation - CONQUER_DROP_M,
      );
      if (!reached) continue;
      this.conquered.add(p.id);
      const bonus = peakBonus(p.elevation);
      this.money += bonus;
      this.rewards.push({
        id: this.id(),
        kind: "peak",
        title: `${p.name} conquered`,
        text: `${p.elevation.toLocaleString()} m summit · ${this.conquered.size} of ${SUMMITS.length} peaks`,
        bonus,
      });
      this.toast(`🚩 ${p.name} (${p.elevation.toLocaleString()} m) conquered! ${this.conquered.size}/${SUMMITS.length} peaks. Bonus +$${bonus.toLocaleString()}.`);
      this.sfx.push("build");
    }
    const after = this.tier();
    if (after > before) {
      const t = TIERS[after];
      this.toast(`Your resort is now a ${t.name.toLowerCase()}: room for ${t.capacity.toLocaleString()} skiers and ${t.maxLifts} lifts.`);
    }
    if (!this.won && this.conquered.size === SUMMITS.length) {
      this.won = true;
      this.toast("You conquered the mountain! Every peak has a lift.");
    }
  }

  /**
   * How many skiers the resort can comfortably handle right now:
   * - lifts: each lift's riders/sec × a skier's full lap (ride up, ski a
   *   run it serves, walk back), kept a little under so lines stay short;
   * - runs: room on the snow, about one skier per 7 units of run;
   * - the mountain's hard cap.
   * The smallest one is the limit. Recomputed a few times a second.
   */
  loadLimits(): {
    lifts: number;
    runs: number;
    cap: number;
    parking: number;
    comfortable: number;
    limitedBy: "lifts" | "runs" | "capacity" | "parking";
  } {
    const lots = this.buildings.filter((b) => PARKING[b.type]).map((b) => b.id).join(",");
    const key = `${this.currentMountain}:${this.lifts.map((l) => l.id).join(",")}:${this.trails.map((t) => t.id).join(",")}:${this.roadVersion}:${lots}`;
    if (this.loadCache && this.loadCacheKey === key && this.clock - this.loadCacheT < 0.5) return this.loadCache;
    let lifts = 0;
    for (const l of this.lifts) {
      const spec = LIFT_SPECS[l.type];
      const served = this.servedBy(l);
      const bunny = l.type === "carpet" && served.length === 0;
      if (!served.length && !bunny) continue; // nothing to ski from the top
      const len = Math.hypot(l.top.x - l.bottom.x, l.top.y - l.bottom.y);
      const perSec = (spec.seats * spec.speed) / spec.spacing;
      const runLen = bunny ? len : served.reduce((n, t) => n + t.length, 0) / served.length;
      const lap = len / spec.speed + runLen / 110 + 18;
      lifts += perSec * lap * 0.85;
    }
    const runs = this.trails.reduce((n, t) => n + t.length / 7, 0);
    const cap = this.capacity();
    const parking = this.parkingCapacity();
    const comfortable = Math.round(Math.min(lifts, runs, cap, parking));
    const limitedBy =
      comfortable === parking && parking < cap ? "parking" : comfortable === cap ? "capacity" : lifts <= runs ? "lifts" : "runs";
    this.loadCache = { lifts: Math.round(lifts), runs: Math.round(runs), cap, parking, comfortable, limitedBy };
    this.loadCacheT = this.clock;
    this.loadCacheKey = key;
    return this.loadCache;
  }

  /** Skiers the resort will draw right now: its comfortable load, scaled by how appealing it is. */
  demand(): number {
    return Math.round(this.loadLimits().comfortable * clamp(this.attraction(), 0.25, 1));
  }

  maxLifts(): number {
    return TIERS[this.tier()].maxLifts;
  }

  attraction(): number {
    const fair = this.fairPrice();
    const priceFactor =
      this.ticketPrice <= fair ? 1 : clamp(1 - (this.ticketPrice - fair) / (fair + 8), 0.18, 1);
    // Word gets around about long lift lines.
    const wait = this.liftWait();
    const queueFactor = wait > 180 ? 0.45 : wait > 90 ? 0.7 : wait > 45 ? 0.88 : 1;
    return clamp(0.32 + this.variety().score * 0.42 + this.amenityScore() * 0.34, 0.15, 1.15) * priceFactor * queueFactor;
  }

  has(type: BuildingType): boolean {
    return this.buildings.some((b) => b.type === type);
  }

  count(type: BuildingType): number {
    return this.buildings.filter((b) => b.type === type).length;
  }

  goals(): Goal[] {
    const n = this.conquered.size;
    const total = SUMMITS.length;
    const tierGoals = TIERS.slice(1).map((t, i) => ({
      id: `tier${i + 1}`,
      text:
        t.peaksNeeded === 1
          ? `Run a lift to your first peak (${t.capacity.toLocaleString()}-skier ${t.name.toLowerCase()})`
          : `Conquer ${t.peaksNeeded} peaks (${t.capacity.toLocaleString()}-skier ${t.name.toLowerCase()})`,
      done: n >= t.peaksNeeded,
    }));
    return [
      { id: "road", text: "Build a road from the highway to the parking lot", done: this.parkingCapacity() > 0 },
      { id: "lodge", text: `Build a lodge ($${COSTS.lodge.toLocaleString()})`, done: this.has("lodge") },
      { id: "black", text: "Cut a black-diamond run", done: this.trails.some((t) => t.difficulty >= 2) },
      tierGoals[0],
      {
        id: "patrol",
        text: "Hire ski patrol (needed once you're a ski area)",
        done: !this.staffRequired() ? false : this.staff.patrol > 0,
      },
      ...tierGoals.slice(1),
      { id: "all", text: `Conquer the mountain: lifts to all ${total} peaks (${n}/${total})`, done: n >= total },
    ];
  }

  complaints(): string[] {
    const { counts } = this.variety();
    const out: string[] = [];
    const onHill = this.skiers.filter((s) => s.state !== "leaving" && s.state !== "arriving").length;
    if (this.parkingCapacity() === 0) out.push("No road reaches the parking lot. Build one from the highway so skiers can drive in.");
    else if (this.parkingLots().some((l) => !l.connected && l.id !== null)) out.push("A parking lot has no road to the highway, so nobody can park there.");
    if (!this.has("lodge")) out.push("A lodge would let you set ticket prices.");
    if (counts[2] === 0 && counts[3] === 0) out.push("Advanced skiers want a black diamond.");
    if (counts[3] === 0 && this.trails.length >= 4) out.push("A few experts keep asking for a double black.");
    if (counts[0] === 0) out.push("Beginners have nowhere gentle to ski.");
    if (this.count("restroom") === 0 && onHill > 6) out.push("People are hunting for a restroom.");
    if (this.has("school") && this.staff.instructor === 0) out.push("The ski school has no instructors. Hire some.");
    if (!this.has("school") && this.skiers.filter((k) => k.skill === 0).length >= 5) out.push("Beginners are asking about lessons.");
    if (!this.variety().kinds.has("park") && this.skiers.filter((k) => k.likes === "park").length >= 3) {
      out.push("Freestylers want a terrain park.");
    }
    if (this.ticketPrice > this.fairPrice() + 8) out.push("Tickets feel expensive for what is here.");
    if (
      this.has("lodge") &&
      !FOOD_BUILDINGS.some((t) => (t === "shack" ? this.count("shack") > 0 : this.has(t)))
    ) {
      out.push("Hungry skiers wish there was food.");
    }
    if (this.has("lodge") && !this.has("rental") && this.skiers.filter((k) => k.skill === 0).length >= 4) {
      out.push("Beginners keep asking where to rent skis.");
    }
    if (this.staffRequired()) {
      const need = this.staffNeeds();
      for (const role of STAFF_ROLES) {
        if (this.staff[role] < need[role]) {
          out.push(`Short on ${STAFF_LABEL[role].toLowerCase()}. Hire more staff.`);
          break;
        }
      }
    }
    const load = this.loadLimits();
    if (this.skiers.length >= this.demand() * 0.9) {
      if (load.limitedBy === "parking") out.push("The parking is full. Build more parking beside a road to draw more skiers.");
      else if (load.limitedBy === "lifts") out.push("The lifts are maxed out. Add or upgrade lifts to draw more skiers.");
      else if (load.limitedBy === "runs") out.push("The runs are crowded. Cut more trails to draw more skiers.");
      else if (this.tier() < TIERS.length - 1) out.push("The resort is full. Run a lift to another peak to grow it.");
      else out.push("The resort is at full size.");
    }
    if (!out.length) out.push("The hill feels friendly. Keep an eye on mix and price.");
    return out.slice(0, 3);
  }

  toast(text: string, bad = false): void {
    this.toasts.push({ id: this.nextToast++, text, bad, life: 3.6 });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  float(x: number, y: number, text: string, color = "#e2b857"): void {
    this.fx.push({ x, y, text, color, life: 1.1 });
  }

  startManaging(): void {
    this.managing = true;
    if (this.parkingCapacity() === 0) this.toast("Skiers need a way in: build a road from the highway to your parking lot.");
  }

  setTool(tool: Tool): void {
    this.liftStart = null;
    this.moveId = null;
    if (tool === "demolish" || tool === "clearTrees" || tool === "plantTrees" || tool === "shape") {
      this.tool = tool;
      this.draft = [];
      this.selected = null;
      this.lastBrush = null;
      return;
    }
    if (tool === "road" || tool === "path") {
      this.tool = tool;
      this.draft = [];
      this.selected = null;
      return;
    }
    if (tool.startsWith("trail:")) {
      this.trailKind = tool.slice(6) as TrailKind;
      this.tool = "cut";
      this.draft = [];
      this.selected = null;
      return;
    }
    if (tool.startsWith("feature:")) {
      this.tool = tool;
      this.draft = [];
      this.selected = null;
      return;
    }
    if (tool.startsWith("lift:")) {
      if (this.lifts.length >= this.maxLifts()) {
        this.toast(`${this.maxLifts()} lifts is the limit for this mountain.`, true);
        return;
      }
      this.tool = tool;
      this.draft = [];
      this.selected = null;
      return;
    }
    const build = tool as BuildingType | "select" | "cut" | "move";
    if (build === "move") return;
    if (build !== "select" && build !== "cut" && this.tier() < unlockTier(build)) {
      const need = unlockTier(build);
      this.toast(
        need <= 1
          ? `${BUILDING_LABEL[build]}s unlock after your first peak.`
          : `${BUILDING_LABEL[build]}s unlock once you're a ${TIERS[need].name.toLowerCase()} (${TIERS[need].peaksNeeded} peaks).`,
        true,
      );
      return;
    }
    if (build !== "select" && build !== "cut" && this.count(build) >= BUILDING_MAX[build]) {
      this.toast(`That's as many ${BUILDING_LABEL[build].toLowerCase()}s as this hill needs.`, true);
      return;
    }
    this.tool = tool;
    this.draft = [];
    if (tool !== "select") this.selected = null;
  }

  setSpeed(n: number): void {
    this.speed = n;
    if (n > 0) this.paused = false;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  setTicketPrice(n: number): void {
    if (!this.has("lodge")) return;
    this.ticketPrice = clamp(Math.round(n), 18, 88);
  }

  cancel(): void {
    this.tool = "select";
    this.draft = [];
    this.liftStart = null;
    this.moveId = null;
  }

  featureTool(): FeatureType | null {
    return this.tool.startsWith("feature:") ? (this.tool.slice(8) as FeatureType) : null;
  }

  // ---------- moving buildings

  moveFee(b: Building): number {
    return this.moveFeeOn ? Math.round((COSTS[b.type] * MOVE_FEE) / 10) * 10 : 0;
  }

  movingBuilding(): Building | null {
    return this.tool === "move" ? this.buildings.find((b) => b.id === this.moveId) ?? null : null;
  }

  startMove(id: number): void {
    const b = this.buildings.find((x) => x.id === id);
    if (!b) return;
    this.cancel();
    this.tool = "move";
    this.moveId = id;
    const fee = this.moveFee(b);
    this.toast(`Click a new spot for the ${BUILDING_LABEL[b.type].toLowerCase()}${fee ? ` · $${fee.toLocaleString()} to move` : " · moving is free"}.`);
  }

  canMoveTo(x: number, y: number): string | null {
    const b = this.movingBuilding();
    if (!b) return "Pick a building first.";
    return this.canPlace(b.type, x, y, { ignoreId: b.id, cost: this.moveFee(b) });
  }

  private clickMove(x: number, y: number): "ok" | "shake" | "none" {
    const b = this.movingBuilding();
    if (!b) return "none";
    const err = this.canMoveTo(x, y);
    if (err) {
      this.toast(err, true);
      return "shake";
    }
    const fee = this.moveFee(b);
    this.money -= fee;
    b.x = x;
    b.y = y;
    if (PARKING[b.type]) b.angle = this.parkingAngle(b.type, x, y);
    this.gradePad(b);
    this.clearTrees();
    if (fee) this.float(x, y, `-${fee}`, "#d9785f");
    this.toast(`${BUILDING_LABEL[b.type]} moved${fee ? ` for $${fee.toLocaleString()}` : ""}.`);
    this.tool = "select";
    this.moveId = null;
    this.selected = { kind: "building", id: b.id };
    return "ok";
  }

  // ---------- park features and jumps

  /** Where a feature at (x, y) would sit: its run (if any) and travel direction. */
  private featureSpot(x: number, y: number): { trail: Trail | null; angle: number; dist: number } {
    let best: Trail | null = null;
    let bestD = Infinity;
    for (const t of this.trails) {
      const d = distToTrail(t, x, y);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    if (best && bestD <= TRAIL_KIND_SPEC[best.kind].width / 2 + 3) {
      const near = nearestOnTrail(best, x, y);
      return { trail: best, angle: Math.atan2(near.dy, near.dx), dist: bestD };
    }
    // Off-piste jump: face down the fall line.
    const mid = this.currentMountain;
    const gx = elevation(x + 3, y, mid) - elevation(x - 3, y, mid);
    const gy = elevation(x, y + 3, mid) - elevation(x, y - 3, mid);
    return { trail: null, angle: Math.atan2(-gy, -gx), dist: bestD };
  }

  canPlaceFeature(type: FeatureType, x: number, y: number): string | null {
    const spec = FEATURE_SPEC[type];
    if (x < 14 || x > WORLD_W - 14 || y > WORLD_H - 12) return "That's off the property.";
    if (this.inVillage(x, y)) return "Build features up on the hill.";
    const spot = this.featureSpot(x, y);
    if (spec.parkOnly && (!spot.trail || spot.trail.kind !== "park")) {
      return `${spec.label}s go inside a terrain park. Cut a park run first.`;
    }
    if (!spot.trail) return "Put jumps on a run — skiers only ski designated trails.";
    const gap = type === "halfpipe" ? 70 : 16;
    if (this.features.some((f) => Math.hypot(f.x - x, f.y - y) < (f.type === "halfpipe" ? 70 : gap))) {
      return "Too close to another feature.";
    }
    if (this.buildings.some((b) => Math.hypot(b.x - x, b.y - y) < 24)) return "A building is in the way.";
    if (this.nearLift(x, y, 14)) return "Keep clear of the lift line.";
    if (this.money < spec.cost) return `Need $${(spec.cost - this.money).toLocaleString()} more.`;
    return null;
  }

  featureAngle(x: number, y: number): number {
    return this.featureSpot(x, y).angle;
  }

  private clickFeature(type: FeatureType, x: number, y: number): "ok" | "shake" | "none" {
    const err = this.canPlaceFeature(type, x, y);
    if (err) {
      this.toast(err, true);
      return "shake";
    }
    const spec = FEATURE_SPEC[type];
    const spot = this.featureSpot(x, y);
    this.money -= spec.cost;
    this.features.push({ id: this.id(), type, x, y, angle: spot.angle, trailId: spot.trail?.id ?? null });
    this.clearTrees();
    this.float(x, y, `-${spec.cost}`, "#d9785f");
    this.toast(`${spec.label} built on ${spot.trail?.name ?? "the hill"}.`);
    return "ok";
  }

  liftTool(): LiftType | null {
    return this.tool.startsWith("lift:") ? (this.tool.slice(5) as LiftType) : null;
  }

  nearLift(x: number, y: number, pad: number): boolean {
    return this.lifts.some((l) => nearSegment(l.bottom.x, l.bottom.y, l.top.x, l.top.y, x, y, pad));
  }

  /**
   * Can a lift of this type run from bottom station `a` to top station `b`?
   * Surface lifts (carpet, T-bar) drag people over the snow, so the ground
   * itself must climb the whole way and stay under the type's max pitch.
   * Chairs and gondolas fly, so they only need the top above the bottom.
   */
  checkLift(type: LiftType, a: Vec2, b: Vec2): LiftCheck {
    const spec = LIFT_SPECS[type];
    const mid = this.currentMountain;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const eA = elevation(a.x, a.y, mid);
    const eB = elevation(b.x, b.y, mid);
    const rise = (eB - eA) * VERTICAL_M;
    const cost = liftCost(type, length);
    const out = (error: string | null): LiftCheck => ({ error, length, rise, cost });
    const noun = liftNoun(type);
    const offProperty = (p: Vec2) => p.x < 14 || p.x > WORLD_W - 14 || p.y < 30 || p.y > WORLD_H - 12;
    if (offProperty(a) || offProperty(b)) return out("That's off the property.");
    if (this.lifts.length >= this.maxLifts()) return out(`${this.maxLifts()} lifts is the limit for this mountain.`);
    if (length < spec.minLength) return out(`Too short — a ${noun} needs at least ${Math.round(spec.minLength * UNIT_M)} m.`);
    if (length > spec.maxLength) return out(`Too long — a ${noun} tops out at ${Math.round(spec.maxLength * UNIT_M)} m.`);
    if (eB - eA < 0.012) {
      return out(
        spec.surface
          ? `A ${noun} can't go downhill — put the top station uphill of the bottom.`
          : "Lifts carry skiers up — put the top station higher than the bottom.",
      );
    }
    if (spec.surface) {
      const n = Math.max(4, Math.ceil(length / 3));
      const es: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        es.push(elevation(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, mid));
      }
      // Pitch over ~12-unit windows so tiny bumps don't count.
      const w = Math.max(1, Math.round(12 / (length / n)));
      for (let i = w; i <= n; i += 1) {
        const grade = ((es[i] - es[i - w]) * VERTICAL_M) / (((length / n) * w) * UNIT_M);
        if (grade > spec.maxGrade) {
          return out(
            type === "carpet"
              ? "Too steep for a magic carpet — keep it on gentle beginner terrain."
              : "Too steep for a T-bar — this pitch needs a chairlift.",
          );
        }
      }
      let highest = eA;
      for (let i = 1; i <= n; i++) {
        if (es[i] < highest - 0.004) {
          return out(`The ground dips along this line — a ${noun} rides on the snow, so it has to climb the whole way.`);
        }
        highest = Math.max(highest, es[i]);
      }
    }
    if (this.buildings.some((bd) => nearSegment(a.x, a.y, b.x, b.y, bd.x, bd.y, 16))) return out("A building is in the way.");
    for (const l of this.lifts) {
      if (segmentsCross(a, b, l.bottom, l.top)) return out(`That would cross ${l.name}.`);
      const close =
        nearSegment(l.bottom.x, l.bottom.y, l.top.x, l.top.y, a.x, a.y, 12) ||
        nearSegment(l.bottom.x, l.bottom.y, l.top.x, l.top.y, b.x, b.y, 12) ||
        nearSegment(a.x, a.y, b.x, b.y, l.bottom.x, l.bottom.y, 12) ||
        nearSegment(a.x, a.y, b.x, b.y, l.top.x, l.top.y, 12);
      if (close) return out(`Too close to ${l.name}'s line.`);
      if (Math.hypot(l.bottom.x - a.x, l.bottom.y - a.y) < 18 || Math.hypot(l.top.x - b.x, l.top.y - b.y) < 18) {
        return out(`Too close to ${l.name}'s station.`);
      }
    }
    if (this.money < cost) return out(`Need $${(cost - this.money).toLocaleString()} more.`);
    return out(null);
  }

  liftPreview(): ({ type: LiftType; a: Vec2; b: Vec2 } & LiftCheck) | null {
    const type = this.liftTool();
    if (!type || !this.liftStart || !this.liftHover) return null;
    return { type, a: this.liftStart, b: this.liftHover, ...this.checkLift(type, this.liftStart, this.liftHover) };
  }

  private clickLift(type: LiftType, x: number, y: number): "ok" | "shake" | "none" {
    const spec = LIFT_SPECS[type];
    if (!this.liftStart) {
      if (x < 14 || x > WORLD_W - 14 || y < 30 || y > WORLD_H - 12) {
        this.toast("That's off the property.", true);
        return "shake";
      }
      if (this.buildings.some((b) => Math.hypot(b.x - x, b.y - y) < 18)) {
        this.toast("A building is in the way.", true);
        return "shake";
      }
      this.liftStart = { x, y };
      this.toast(`Bottom station set. Now click uphill for the top of the ${liftNoun(type)}.`);
      return "ok";
    }
    const a = this.liftStart;
    const b = { x, y };
    const check = this.checkLift(type, a, b);
    if (check.error) {
      this.toast(check.error, true);
      return "shake";
    }
    this.money -= check.cost;
    const used = new Set(this.lifts.map((l) => l.name));
    let name = `${pick(LIFT_PREFIX)} ${spec.short}`;
    for (let i = 0; i < 20 && used.has(name); i++) name = `${pick(LIFT_PREFIX)} ${spec.short}`;
    const lift = this.makeLift(type, name, a, b);
    this.lifts.push(lift);
    this.clearTrees();
    this.checkConquest();
    this.float(a.x, a.y, `-${check.cost}`, "#d9785f");
    this.toast(`${name} is spinning. ${spec.label}, ${Math.round(check.length * UNIT_M)} m.`);
    this.liftStart = null;
    this.tool = "select";
    this.selected = { kind: "lift", id: lift.id };
    return "ok";
  }

  removeLift(id: number): void {
    const l = this.lifts.find((x) => x.id === id);
    if (!l) return;
    if (this.lifts.length <= 1) {
      this.toast("Keep at least one lift running.", true);
      return;
    }
    const refund = Math.round(liftCost(l.type, Math.hypot(l.top.x - l.bottom.x, l.top.y - l.bottom.y)) * 0.4);
    this.lifts = this.lifts.filter((x) => x !== l);
    for (const s of this.skiers) {
      if (s.liftId !== l.id) continue;
      s.liftId = null;
      if (s.state === "riding") {
        s.state = "toTrail";
        s.trailId = null;
      }
    }
    this.money += refund;
    this.selected = null;
    this.toast(`Took down ${l.name}. Salvage +$${refund.toLocaleString()}.`);
  }

  private makeLift(type: LiftType, name: string, bottom: Vec2, top: Vec2): Lift {
    const spec = LIFT_SPECS[type];
    const len = Math.hypot(top.x - bottom.x, top.y - bottom.y);
    const n = Math.max(2, Math.round(len / spec.spacing));
    return {
      id: this.id(),
      type,
      name,
      bottom: { ...bottom },
      top: { ...top },
      carriers: Array.from({ length: n }, (_, i) => ({ t: i / n, riders: [] })),
    };
  }

  /** Runs whose start is an easy hike from this lift's unload. */
  trailsFrom(l: Lift): Trail[] {
    const topE = elevation(l.top.x, l.top.y, this.currentMountain);
    return this.trails.filter((t) => {
      const p = t.points[0];
      return Math.hypot(p.x - l.top.x, p.y - l.top.y) < 250 && elevation(p.x, p.y, this.currentMountain) < topE + 0.04;
    });
  }

  draftInfo(): { length: number; drop: number; difficulty: Difficulty; cost: number } | null {
    if (this.draft.length < 2) return this.draft.length === 1 ? { length: 0, drop: 0, difficulty: 0, cost: trailCost(0, this.trailKind) } : null;
    return measureTrail(this.draft, this.currentMountain, this.trailKind);
  }

  /** The base village: a circle around the base that grows with the resort tier. */
  villageRadius(): number {
    return TIERS[this.tier()].villageRadius;
  }

  inVillage(x: number, y: number): boolean {
    return Math.hypot(x - BASE.x, y - BASE.y) < this.villageRadius();
  }

  private villageOk(x: number, y: number): boolean {
    return this.inVillage(x, y) && gradeAt(x, y) < 0.25;
  }

  /** Roads joined up to the highway (they share points with it, directly or through other roads). */
  connectedRoads(): Set<number> {
    if (this.connCache.v === this.roadVersion) return this.connCache.ids;
    const k = (p: Vec2) => `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;
    const byPoint = new Map<string, Road[]>();
    for (const r of this.roads) for (const p of r.points) {
      const key = k(p);
      const list = byPoint.get(key);
      if (list) list.push(r);
      else byPoint.set(key, [r]);
    }
    const ids = new Set<number>();
    const stack = this.roads.filter((r) => r.highway);
    while (stack.length) {
      const r = stack.pop()!;
      if (ids.has(r.id)) continue;
      ids.add(r.id);
      for (const p of r.points) for (const o of byPoint.get(k(p)) ?? []) if (!ids.has(o.id)) stack.push(o);
    }
    this.connCache = { v: this.roadVersion, ids };
    return ids;
  }

  /** Nearest point on a road that reaches the highway, within `reach` of a spot. */
  private connectedRoadNear(x: number, y: number, reach: number): { road: Road; p: Vec2; seg: number; d: number } | null {
    const ids = this.connectedRoads();
    let best: { road: Road; p: Vec2; seg: number; d: number } | null = null;
    for (const r of this.roads) {
      if (!ids.has(r.id)) continue;
      const n = nearestOnRoad(r.points, x, y);
      if (n.d < reach && (!best || n.d < best.d)) best = { road: r, p: n.p, seg: n.seg, d: n.d };
    }
    return best;
  }

  /** Every parking lot (the starter lot plus any built), with whether cars can reach it. */
  parkingLots(): { x: number; y: number; skiers: number; connected: boolean; id: number | null }[] {
    const exit = this.exit();
    const out = [{ x: exit.x, y: exit.y, skiers: STARTER_LOT_SKIERS, connected: this.starterLotConnected(), id: null as number | null }];
    for (const b of this.buildings) {
      const spec = PARKING[b.type];
      if (!spec) continue;
      out.push({ x: b.x, y: b.y, skiers: spec.skiers, connected: !!this.connectedRoadNear(b.x, b.y, spec.radius + PARKING_REACH), id: b.id });
    }
    return out;
  }

  private starterLotConnected(): boolean {
    return routeTo(this.roads, this.exit()) !== null;
  }

  /** Skiers the reachable parking can take. */
  parkingCapacity(): number {
    return this.parkingLots().reduce((n, l) => n + (l.connected ? l.skiers : 0), 0);
  }

  /** Line a lot up with the nearest road (or face the village if there isn't one). */
  parkingAngle(type: BuildingType, x: number, y: number): number {
    const spec = PARKING[type];
    let best: { a: Vec2; b: Vec2; d: number } | null = null;
    for (const r of this.roads) {
      const n = nearestOnRoad(r.points, x, y);
      if (!best || n.d < best.d) best = { a: r.points[n.seg], b: r.points[n.seg + 1] ?? r.points[n.seg], d: n.d };
    }
    if (!best || !spec || best.d > spec.radius + PARKING_REACH * 2) return Math.atan2(BASE.y - y, BASE.x - x) + Math.PI / 2;
    return Math.atan2(best.b.y - best.a.y, best.b.x - best.a.x);
  }

  /** Placement rules for parking: beside a road, off it, on gentle ground. */
  private parkingError(type: BuildingType, x: number, y: number, others: Building[]): string | null {
    const spec = PARKING[type]!;
    if (x < spec.radius || x > WORLD_W - spec.radius || y < spec.radius || y > WORLD_H - spec.radius) return "That's off the property.";
    // Sample the footprint: it has to be gradable, and not rock.
    let worst = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const px = x + dx * spec.w * 0.4;
      const py = y + dy * spec.d * 0.4;
      worst = Math.max(worst, gradeAt(px, py));
      if (isRock(px, py)) return "That's bare rock.";
    }
    if (worst > spec.maxGrade) return `Too steep for ${type === "garage" ? "a garage" : "a lot"} (${Math.round(worst * 100)}%, max ${Math.round(spec.maxGrade * 100)}%).`;
    if (others.some((b) => Math.hypot(b.x - x, b.y - y) < spec.radius + buildingRadius(b.type) + 6)) return "Too close to another building.";
    const exit = this.exit();
    if (Math.hypot(exit.x - x, exit.y - y) < spec.radius + 80) return "Too close to the main parking lot.";
    if (this.trails.some((t) => distToTrail(t, x, y) < spec.radius + 12)) return "Don't put parking on a run.";
    if (this.nearLift(x, y, spec.radius + 10)) return "Keep clear of the lift line.";
    if (this.nearRoad(x, y, spec.radius - 6)) return "Keep the lot off the road itself.";
    if (!this.nearRoad(x, y, spec.radius + PARKING_REACH)) return "Put parking right beside a road.";
    return null;
  }

  // ---------- shaping the ground

  /** Regrade the pad under a building to the median height of its footprint. */
  private gradePad(b: Building): void {
    const r = flattenPad(b.x, b.y, buildingRadius(b.type));
    if (r.volume > 0) this.terrainEdited(r.box);
  }

  /** After the ground changes: re-rate runs that cross it, and re-seat the forest. */
  private terrainEdited(box: { x0: number; y0: number; x1: number; y1: number }): void {
    for (const t of this.trails) {
      if (!t.points.some((p) => p.x > box.x0 - 40 && p.x < box.x1 + 40 && p.y > box.y0 - 40 && p.y < box.y1 + 40)) continue;
      Object.assign(t, measureTrail(t.points, this.currentMountain, t.kind));
    }
    this.terrainEdits++;
    this.clearTrees();
  }

  /** Ground under a building (or the starter lot) stays put while you shape around it. */
  private padLocked = (x: number, y: number): boolean => {
    const exit = this.exit();
    if (Math.abs(x - exit.x) < 90 && Math.abs(y - exit.y) < 50) return true;
    for (const b of this.buildings) if (Math.hypot(b.x - x, b.y - y) < buildingRadius(b.type) + 10) return true;
    return false;
  };

  /** Brush radius for the current tool (tree brush or shaping). */
  brushRadius(): number {
    if (this.tool === "plantTrees" && this.plantMode === "single") return 4;
    return this.tool === "shape" ? this.shapeRadius : BRUSH_R;
  }

  setShapeMode(mode: SculptMode): void {
    this.shapeMode = mode;
    this.shapeTarget = null;
  }

  /** One frame of the shaping brush held down at (x, y). */
  shapeStep(x: number, y: number, dt: number): void {
    if (!this.managing || this.tool !== "shape") return;
    if (this.shapeTarget === null) this.shapeTarget = elevationM(x, y);
    const amount = this.shapeMode === "raise" || this.shapeMode === "lower" ? SHAPE_RATE_M * dt : Math.min(1, 2.5 * dt);
    // Preview the cost with a dry run's worth of budget: stop when the money runs out.
    if (!this.freeShaping && this.money <= 0) {
      if (!this.shapeBroke) this.toast("Out of money for earthworks.", true);
      this.shapeBroke = true;
      return;
    }
    const r = sculpt(x, y, this.shapeRadius, this.shapeMode, amount, this.shapeTarget, this.padLocked);
    if (r.volume <= 0) return;
    const cost = this.freeShaping ? 0 : r.volume * EARTH_COST_PER_M3;
    this.money -= cost;
    this.shapeCost += cost;
    this.shapeVolume += r.volume;
    this.shapeAt = { x, y };
    // Earthworks bulldoze the forest they pass over.
    if (!this.shapeCleared || Math.hypot(this.shapeCleared.x - x, this.shapeCleared.y - y) > this.shapeRadius * 0.4) {
      this.addClearing(x, y, this.shapeRadius * 0.85);
      this.shapeCleared = { x, y };
    }
    this.terrainEdited(r.box);
  }

  /** Let go of the shaping brush: show what the stroke moved and cost. */
  endShape(): void {
    if (this.shapeAt && this.shapeCost >= 1) {
      this.float(this.shapeAt.x, this.shapeAt.y, `-$${Math.round(this.shapeCost).toLocaleString()}`, "#d9785f");
    }
    this.shapeTarget = null;
    this.shapeCost = 0;
    this.shapeVolume = 0;
    this.shapeAt = null;
    this.shapeBroke = false;
    this.shapeCleared = null;
  }

  /** What a demolish click at this spot would take down (closest thing wins). */
  demolishTarget(x: number, y: number): DemolishTarget | null {
    let best: DemolishTarget | null = null;
    let bestD = Infinity;
    const offer = (t: DemolishTarget, d: number) => {
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    };
    for (const b of this.buildings) {
      const d = Math.hypot(b.x - x, b.y - y);
      // Buildings win ties: they sit on top of everything else.
      if (d < buildingRadius(b.type) + 2) offer({ kind: "building", id: b.id, label: BUILDING_LABEL[b.type], refund: Math.round(COSTS[b.type] * SALVAGE) }, d - 8);
    }
    for (const f of this.features) {
      const d = Math.hypot(f.x - x, f.y - y);
      if (d < 14) offer({ kind: "feature", id: f.id, label: FEATURE_SPEC[f.type].label, refund: Math.round(FEATURE_SPEC[f.type].cost * SALVAGE) }, d - 4);
    }
    for (const l of this.lifts) {
      const d = nearestOnRoad([l.bottom, l.top], x, y).d;
      if (d < 18) {
        const refund = Math.round(liftCost(l.type, Math.hypot(l.top.x - l.bottom.x, l.top.y - l.bottom.y)) * SALVAGE);
        offer({ kind: "lift", id: l.id, label: l.name, refund }, d);
      }
    }
    for (const t of this.trails) {
      const d = distToTrail(t, x, y);
      if (d < TRAIL_KIND_SPEC[t.kind].width / 2 + 4) offer({ kind: "trail", id: t.id, label: t.name, refund: 0 }, d + 2);
    }
    for (const r of this.roads) {
      if (r.highway) continue;
      const d = nearestOnRoad(r.points, x, y).d;
      if (d < ROAD_WIDTH / 2 + 6) offer({ kind: "road", id: r.id, label: "Road", refund: Math.round(roadLength(r.points) * ROAD_COST_PER_M * 0.25) }, d);
    }
    for (const pth of this.paths) {
      const d = nearestOnRoad(pth.points, x, y).d;
      if (d < PATH_WIDTH / 2 + 5) offer({ kind: "path", id: pth.id, label: "Path", refund: Math.round(roadLength(pth.points) * PATH_COST_PER_M * 0.25) }, d + 1);
    }
    return best;
  }

  /** Leave the ground a demolished thing stood on cleared (the forest doesn't spring back). */
  private stampClearing(points: Vec2[], r: number): void {
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[Math.min(points.length - 1, i + 1)];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(len / (r * 0.9)));
      for (let k = 0; k < n; k++) this.addClearing(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, r);
    }
  }

  private demolishAt(x: number, y: number): "ok" | "shake" | "none" {
    const t = this.demolishTarget(x, y) as DemolishTarget | null;
    if (!t) {
      this.toast("Nothing to demolish there. Click a building, lift, run, park feature, road or path.", true);
      return "shake";
    }
    if (t.kind === "lift" && this.lifts.length <= 1) {
      this.toast("Keep at least one lift running.", true);
      return "shake";
    }
    if (t.kind === "building") {
      const b = this.buildings.find((q) => q.id === t.id)!;
      this.stampClearing([b], buildingRadius(b.type));
      this.buildings = this.buildings.filter((q) => q !== b);
    } else if (t.kind === "feature") {
      const f = this.features.find((q) => q.id === t.id)!;
      this.stampClearing([f], f.type === "halfpipe" ? 40 : 12);
      this.features = this.features.filter((q) => q !== f);
    } else if (t.kind === "lift") {
      const l = this.lifts.find((q) => q.id === t.id)!;
      this.stampClearing([l.bottom, l.top], 16);
      this.lifts = this.lifts.filter((q) => q !== l);
      for (const s of this.skiers) {
        if (s.liftId !== l.id) continue;
        s.liftId = null;
        if (s.state === "riding" || s.state === "queue") {
          s.state = "toTrail";
          s.trailId = null;
        }
      }
    } else if (t.kind === "trail") {
      const tr = this.trails.find((q) => q.id === t.id)!;
      if (tr.kind !== "glades") this.stampClearing(tr.points, TRAIL_KIND_SPEC[tr.kind].width / 2 + 9);
      this.trails = this.trails.filter((q) => q !== tr);
      // Park features go with the run they were built on.
      this.features = this.features.filter((f) => f.trailId !== tr.id);
      for (const s of this.skiers) if (s.trailId === tr.id) s.trailId = null;
    } else if (t.kind === "path") {
      this.paths = this.paths.filter((q) => q.id !== t.id);
      this.pathVersion++;
    } else {
      const r = this.roads.find((q) => q.id === t.id)!;
      this.stampClearing(r.points, ROAD_WIDTH / 2 + 5);
      this.roads = this.roads.filter((q) => q !== r);
      this.roadVersion++;
    }
    this.money += t.refund;
    this.selected = null;
    this.clearTrees();
    this.float(x, y, t.refund ? `+$${t.refund.toLocaleString()}` : "Gone");
    this.toast(
      `Demolished ${t.kind === "trail" ? `“${t.label}”` : t.label}.${t.refund ? ` Salvage +$${t.refund.toLocaleString()}.` : ""}` +
        (t.kind === "road" && !this.roadConnected() ? " The parking lot is cut off: no new skiers until it's reconnected." : ""),
      t.kind === "road" && !this.roadConnected(),
    );
    return "ok";
  }

  /** Trees the brush would fell at this spot. */
  treesUnderBrush(x: number, y: number): number {
    return this.treesIn(x - BRUSH_R, y - BRUSH_R, x + BRUSH_R, y + BRUSH_R).filter((t) => Math.hypot(t.x - x, t.y - y) < BRUSH_R).length;
  }

  private lastBrush: Vec2 | null = null;

  /** Fell the trees in a circle (click or drag). */
  private paintClearing(x: number, y: number): "ok" | "shake" | "none" {
    if (this.lastBrush && Math.hypot(this.lastBrush.x - x, this.lastBrush.y - y) < BRUSH_R * 0.45) return "none";
    const n = this.treesUnderBrush(x, y);
    if (!n) return "none";
    const cost = this.freeTreeClearing ? 0 : n * TREE_FELL_COST;
    if (cost > 0 && this.money < cost) {
      this.toast(`Need $${(cost - this.money).toLocaleString()} more to clear these trees.`, true);
      return "shake";
    }
    this.money -= cost;
    this.addClearing(x, y, BRUSH_R);
    this.lastBrush = { x, y };
    this.treesFelled += n;
    this.clearTrees();
    this.strokeCost += cost;
    return "ok";
  }

  private strokeCost = 0;

  /** Lift the brush: show what the stroke cost, and start the next one fresh. */
  endBrush(): void {
    if (this.lastBrush && this.strokeCost) this.float(this.lastBrush.x, this.lastBrush.y, `-$${this.strokeCost.toLocaleString()}`, "#d9785f");
    this.strokeCost = 0;
    this.lastBrush = null;
  }

  /** The drive in from the highway to the parking lot, or null if there isn't one. */
  carRoute(): Vec2[] | null {
    const lots = this.buildings.filter((b) => PARKING[b.type]).map((b) => b.id).join(",");
    const v = `${this.roadVersion}:${lots}`;
    if (this.routeCache.v !== v) {
      let route: Vec2[] | null = null;
      const lot = this.parkingLots()
        .filter((l) => l.connected)
        .sort((a, b) => b.skiers - a.skiers)[0];
      if (lot && lot.id === null) route = routeTo(this.roads, this.exit());
      else if (lot) {
        // Drive to the road beside the lot, then pull in.
        const spec = PARKING[this.buildings.find((b) => b.id === lot.id)!.type]!;
        const near = this.connectedRoadNear(lot.x, lot.y, spec.radius + PARKING_REACH);
        if (near) {
          const a = near.road.points[near.seg];
          const b = near.road.points[near.seg + 1] ?? a;
          const v0 = Math.hypot(a.x - near.p.x, a.y - near.p.y) < Math.hypot(b.x - near.p.x, b.y - near.p.y) ? a : b;
          const to = routeTo(this.roads, v0);
          if (to) route = [...to, { x: lot.x, y: lot.y }];
        }
      }
      this.routeCache = { v, route };
    }
    return this.routeCache.route;
  }

  /** The starter lot is linked to the highway. */
  roadConnected(): boolean {
    return this.starterLotConnected();
  }

  nearRoad(x: number, y: number, pad: number): boolean {
    return this.roadSegsIn(x - pad - 10, y - pad - 10, x + pad + 10, y + pad + 10).some(([a, b, w]) =>
      nearSegment(a.x, a.y, b.x, b.y, x, y, w / 2 + pad),
    );
  }

  /** Road legs touching a box, with their width (the highway is wider). */
  private roadSegsIn(x0: number, y0: number, x1: number, y1: number): [Vec2, Vec2, number][] {
    const out: [Vec2, Vec2, number][] = [];
    for (const r of this.roads) {
      const w = r.highway ? ROAD_WIDTH * 1.4 : ROAD_WIDTH;
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1];
        const b = r.points[i];
        if (Math.max(a.x, b.x) < x0 || Math.min(a.x, b.x) > x1 || Math.max(a.y, b.y) < y0 || Math.min(a.y, b.y) > y1) continue;
        out.push([a, b, w]);
      }
    }
    return out;
  }

  /** Snap a click onto the parking lot or the nearest road, if it's close. */
  private snapRoad(x: number, y: number): Vec2 | null {
    const exit = this.exit();
    if (Math.hypot(x - exit.x, y - exit.y) < ROAD_SNAP * 1.6) return { ...exit };
    let best: { p: Vec2; d: number } | null = null;
    for (const r of this.roads) {
      const n = nearestOnRoad(r.points, x, y);
      if (n.d < ROAD_SNAP && (!best || n.d < best.d)) best = { p: n.p, d: n.d };
    }
    return best ? best.p : null;
  }

  roadDraftInfo(): { length: number; cost: number; grade: number } {
    const length = roadLength(this.draft);
    let grade = 0;
    for (let i = 1; i < this.draft.length; i++) grade = Math.max(grade, legGrade(this.draft[i - 1], this.draft[i]));
    return { length, cost: Math.round(length * ROAD_COST_PER_M), grade };
  }

  private clickRoad(x: number, y: number): "ok" | "shake" | "none" {
    const snap = this.snapRoad(x, y);
    if (this.draft.length === 0) {
      if (!snap) {
        this.toast("Start the road on the highway, another road or the parking lot.", true);
        return "shake";
      }
      this.draft.push(snap);
      return "ok";
    }
    if (x < 12 || x > WORLD_W - 12 || y < 12 || y > WORLD_H - 12) {
      this.toast("That's off the map.", true);
      return "shake";
    }
    const p = snap ?? { x, y };
    const last = this.draft[this.draft.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < ROAD_MIN_LEG) return "none";
    const g = legGrade(last, p);
    if (g > ROAD_MAX_GRADE) {
      this.toast(`Too steep for a road (${Math.round(g * 100)}%, max ${Math.round(ROAD_MAX_GRADE * 100)}%). Zig-zag up the slope instead.`, true);
      return "shake";
    }
    this.draft.push(p);
    // Reaching another road or the parking lot finishes it.
    if (snap) return this.finishRoad();
    return "ok";
  }

  finishRoad(): "ok" | "shake" | "none" {
    if (this.draft.length < 2) {
      this.toast("Click along the way you want the road to go.", true);
      return "shake";
    }
    const { length, cost } = this.roadDraftInfo();
    if (this.money < cost) {
      this.toast(`Need $${(cost - this.money).toLocaleString()} more for this road.`, true);
      return "shake";
    }
    const wasConnected = this.roadConnected();
    const points = this.draft.map((p) => ({ ...p }));
    // Join up: split any road an end of this one lands on, so they share a point.
    for (const end of [points[0], points[points.length - 1]]) {
      for (const r of this.roads) {
        const n = nearestOnRoad(r.points, end.x, end.y);
        if (n.d > 0.5) continue;
        const a = r.points[n.seg];
        const b = r.points[n.seg + 1];
        if (Math.hypot(a.x - end.x, a.y - end.y) < 0.5) {
          end.x = a.x;
          end.y = a.y;
        } else if (Math.hypot(b.x - end.x, b.y - end.y) < 0.5) {
          end.x = b.x;
          end.y = b.y;
        } else {
          r.points.splice(n.seg + 1, 0, { x: end.x, y: end.y });
        }
        break;
      }
    }
    this.money -= cost;
    this.roads.push({ id: this.id(), points });
    this.roadVersion++;
    this.clearTrees();
    const tail = points[points.length - 1];
    this.float(tail.x, tail.y, `-${cost}`, "#d9785f");
    const now = this.roadConnected();
    this.toast(
      now && !wasConnected
        ? `Road open (${Math.round(length)} m). The parking lot is connected: skiers can drive in!`
        : `Road built: ${Math.round(length)} m for $${cost.toLocaleString()}.`,
    );
    this.draft = [];
    this.tool = "select";
    return "ok";
  }

  // ---------- footpaths

  /** Walking network over the footpaths (rebuilt when they change). */
  pathNet(): PathNet {
    if (!this.pathNetCache || this.pathNetCache.v !== this.pathVersion) this.pathNetCache = { v: this.pathVersion, net: new PathNet(this.paths) };
    return this.pathNetCache.net;
  }

  /**
   * Snap a path click onto something people walk to or from: another path,
   * a building's door, a lift's bottom station, the ticket booth or the lot.
   */
  private snapPath(x: number, y: number): { p: Vec2; joins: boolean } | null {
    let best: { p: Vec2; d: number; joins: boolean } | null = null;
    const offer = (p: Vec2, d: number, reach: number) => {
      if (d < reach && (!best || d < best.d)) best = { p: { x: p.x, y: p.y }, d, joins: true };
    };
    for (const pth of this.paths) {
      const n = nearestOnRoad(pth.points, x, y);
      offer(n.p, n.d, PATH_SNAP);
    }
    for (const b of this.buildings) {
      if (PARKING[b.type]) continue;
      offer(b, Math.hypot(b.x - x, b.y - y), buildingRadius(b.type) + 8);
    }
    for (const l of this.lifts) offer(l.bottom, Math.hypot(l.bottom.x - x, l.bottom.y - y), 22);
    const booth = this.booth();
    offer(booth, Math.hypot(booth.x - x, booth.y - y), 18);
    for (const lot of this.parkingLots()) offer(lot, Math.hypot(lot.x - x, lot.y - y), lot.id === null ? 40 : 30);
    return best;
  }

  pathDraftInfo(): { length: number; cost: number; grade: number } {
    const length = roadLength(this.draft);
    let grade = 0;
    for (let i = 1; i < this.draft.length; i++) grade = Math.max(grade, legGrade(this.draft[i - 1], this.draft[i]));
    return { length, cost: Math.round(length * PATH_COST_PER_M), grade };
  }

  private clickPath(x: number, y: number): "ok" | "shake" | "none" {
    if (x < 12 || x > WORLD_W - 12 || y < 12 || y > WORLD_H - 12) {
      this.toast("That's off the map.", true);
      return "shake";
    }
    const snap = this.snapPath(x, y);
    const p = snap?.p ?? { x, y };
    if (this.draft.length === 0) {
      this.draft.push(p);
      return "ok";
    }
    const last = this.draft[this.draft.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < PATH_MIN_LEG) return "none";
    const g = legGrade(last, p);
    if (g > PATH_MAX_GRADE) {
      this.toast(`Too steep for a footpath (${Math.round(g * 100)}%, max ${Math.round(PATH_MAX_GRADE * 100)}%). Wind it across the slope.`, true);
      return "shake";
    }
    this.draft.push(p);
    // Reaching another path, a building, a lift or the lot finishes it.
    if (snap?.joins) return this.finishPath();
    return "ok";
  }

  finishPath(): "ok" | "shake" | "none" {
    if (this.draft.length < 2) {
      this.toast("Click along the way you want people to walk.", true);
      return "shake";
    }
    const { length, cost } = this.pathDraftInfo();
    if (this.money < cost) {
      this.toast(`Need $${(cost - this.money).toLocaleString()} more for this path.`, true);
      return "shake";
    }
    const points = this.draft.map((p) => ({ ...p }));
    // Join up: split any path an end lands on, so they share a point.
    for (const end of [points[0], points[points.length - 1]]) {
      for (const r of this.paths) {
        const n = nearestOnRoad(r.points, end.x, end.y);
        if (n.d > 0.5) continue;
        const a = r.points[n.seg];
        const b = r.points[n.seg + 1];
        if (b && Math.hypot(a.x - end.x, a.y - end.y) > 0.5 && Math.hypot(b.x - end.x, b.y - end.y) > 0.5) r.points.splice(n.seg + 1, 0, { x: end.x, y: end.y });
        break;
      }
    }
    this.money -= cost;
    this.paths.push({ id: this.id(), points });
    this.pathVersion++;
    this.clearTrees();
    const tail = points[points.length - 1];
    this.float(tail.x, tail.y, `-${cost}`, "#d9785f");
    this.toast(`Footpath laid: ${Math.round(length)} m for $${cost.toLocaleString()}. People on foot will use it.`);
    // Stay on the painter so the next path can start right away.
    this.draft = [];
    return "ok";
  }

  /** Walk toward a spot, along the footpaths when that's the better way. */
  private walkTo(s: Skier, x: number, y: number, step: number, dt: number): void {
    if (!this.paths.length) {
      s.onPath = false;
      this.walkToward(s, x, y, step);
      return;
    }
    const key = `${Math.round(x)},${Math.round(y)}:${this.pathVersion}`;
    if (s.routeFor !== key) {
      s.routeFor = key;
      s.route = this.pathNet().route(s, { x, y }) ?? undefined;
      s.onPath = false;
    }
    const r = s.route;
    if (r && r.length) {
      const wp = r[0];
      this.walkToward(s, wp.x, wp.y, s.onPath ? step * PATH_SPEED : step);
      if (Math.hypot(s.x - wp.x, s.y - wp.y) < 1) {
        r.shift();
        s.onPath = r.length > 0;
      }
      // A cleared walkway beats wading through the drifts.
      if (s.onPath) s.mood = Math.min(100, s.mood + dt * 0.4);
      return;
    }
    s.onPath = false;
    this.walkToward(s, x, y, step);
  }

  // ---------- goals and rewards

  /** Pay out goals as they're reached, and queue a celebration for each. */
  private checkGoals(): void {
    for (const g of this.goals()) {
      if (!g.done || this.goalsPaid.has(g.id)) continue;
      this.goalsPaid.add(g.id);
      const bonus = GOAL_BONUS[g.id] ?? 2000;
      this.money += bonus;
      const tierIdx = g.id.startsWith("tier") ? Number(g.id.slice(4)) : 0;
      const tier = tierIdx ? TIERS[tierIdx] : null;
      this.rewards.push({
        id: this.id(),
        kind: g.id === "all" ? "win" : "goal",
        title: tier ? `You're a ${tier.name.toLowerCase()}!` : g.id === "all" ? "You conquered the mountain!" : "Goal reached",
        text: tier ? `Room for ${tier.capacity.toLocaleString()} skiers and ${tier.maxLifts} lifts.` : g.text.replace(/ \(\$[\d,]+\)$/, ""),
        bonus,
      });
    }
  }

  canPlace(type: BuildingType, x: number, y: number, opts: { ignoreId?: number; cost?: number } = {}): string | null {
    const moving = opts.ignoreId != null;
    const others = this.buildings.filter((b) => b.id !== opts.ignoreId);
    const cost = opts.cost ?? COSTS[type];
    if (!moving && this.tier() < unlockTier(type)) {
      const need = unlockTier(type);
      return need <= 1 ? "Conquer your first peak to unlock this." : `Unlocks at ${TIERS[need].name.toLowerCase()} (${TIERS[need].peaksNeeded} peaks).`;
    }
    if (!moving && this.count(type) >= BUILDING_MAX[type]) return `No more ${BUILDING_LABEL[type].toLowerCase()}s on this hill.`;
    if (PARKING[type]) {
      const err = this.parkingError(type, x, y, others);
      if (err) return err;
      if (this.money < cost) return `Need $${(cost - this.money).toLocaleString()} more.`;
      return null;
    }
    const anywhere = PLACE_ANYWHERE.includes(type);
    const midMountain = PLACE_MOUNTAIN.includes(type);
    if (!anywhere && !midMountain && !this.villageOk(x, y)) {
      return this.inVillage(x, y) ? "Too steep to build here." : "Build in the base village.";
    }
    if (type === "cabin" && !this.has("cabinOffice")) return "Open a cabin rental office in the village first.";
    if (midMountain && !anywhere && this.inVillage(x, y)) return "Put this on the mountain, not in the village.";
    if (type === "cabin" && !this.trails.some((t) => distToTrail(t, x, y) < CABIN_REACH)) {
      return `Cabins are ski-in / ski-out: put it within ${CABIN_REACH} m of a run.`;
    }
    if (x < 12 || x > WORLD_W - 12 || y < 24 || y > WORLD_H - 12) return "That's off the property.";
    const small = TRAILSIDE.includes(type);
    if (type === "waffle" && !this.trails.some((t) => distToTrail(t, x, y) < 60)) return "Put the waffle hut beside a run.";
    const minGap = small ? 22 : type === "cabin" ? 24 : type === "heli" ? 60 : type === "grandHotel" ? 56 : 38;
    if (others.some((b) => Math.hypot(b.x - x, b.y - y) < minGap)) return "Too close to another building.";
    if (!small && this.trails.some((t) => distToTrail(t, x, y) < 18)) return "Don't plant a building on a run.";
    if (small && this.trails.some((t) => distToTrail(t, x, y) < 8)) return `Keep the ${BUILDING_LABEL[type].toLowerCase()} beside the run, not in the fall line.`;
    if (this.nearLift(x, y, 26)) return "Keep clear of the lift line.";
    if (isRock(x, y)) return "That's bare rock.";
    if (this.nearRoad(x, y, small ? 10 : 18)) return "Keep clear of the road.";
    if (this.money < cost) return `Need $${(cost - this.money).toLocaleString()} more.`;
    return null;
  }

  click(x: number, y: number): "ok" | "shake" | "none" {
    if (!this.managing) return "none";
    if (this.tool === "cut") return this.clickCut(x, y);
    if (this.tool === "road") return this.clickRoad(x, y);
    if (this.tool === "path") return this.clickPath(x, y);
    if (this.tool === "demolish") return this.demolishAt(x, y);
    if (this.tool === "clearTrees") return this.paintClearing(x, y);
    if (this.tool === "plantTrees") return this.paintPlanting(x, y);
    if (this.tool === "shape") return "none"; // shaping happens while the button is held
    if (this.tool === "move") return this.clickMove(x, y);
    const ft = this.featureTool();
    if (ft) return this.clickFeature(ft, x, y);
    const lt = this.liftTool();
    if (lt) return this.clickLift(lt, x, y);
    if (this.tool !== "select") return this.clickBuild(this.tool as BuildingType, x, y);
    this.selected = this.pick(x, y);
    return "ok";
  }

  moveHover(x: number, y: number): void {
    this.hover = this.tool === "select" ? this.pick(x, y) : null;
  }

  pick(x: number, y: number): Selection {
    let best: Selection = { kind: "hill", id: 0 };
    let bestD = 28;
    for (const s of this.skiers) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < 14 && d < bestD) {
        bestD = d;
        best = { kind: "skier", id: s.id };
      }
    }
    for (const b of this.buildings) {
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < Math.max(22, buildingRadius(b.type)) && d < bestD) {
        bestD = d;
        best = { kind: "building", id: b.id };
      }
    }
    for (const t of this.trails) {
      const d = distToTrail(t, x, y);
      if (d < 24 && d < bestD) {
        bestD = d;
        best = { kind: "trail", id: t.id };
      }
    }
    for (const l of this.lifts) {
      if (nearSegment(l.bottom.x, l.bottom.y, l.top.x, l.top.y, x, y, 16) && 14 < bestD) {
        best = { kind: "lift", id: l.id };
      }
    }
    return best;
  }

  selectionText(): { title: string; body: string } {
    const sel = this.selected;
    if (!sel || sel.kind === "hill") {
      return {
        title: "Skilandia",
        body: `${TIERS[this.tier()].name} · ${this.conquered.size}/${SUMMITS.length} peaks conquered. Lifetime take $${Math.round(this.lifetimeEarned).toLocaleString()}. Run lifts to the high peaks to grow the resort.`,
      };
    }
    if (sel.kind === "trail") {
      const t = this.trails.find((x) => x.id === sel.id);
      if (!t) return { title: "Trail", body: "" };
      const d = DIFF[t.difficulty];
      const feats = this.features.filter((f) => f.trailId === t.id).length;
      const kind = TRAIL_KIND_SPEC[t.kind];
      return {
        title: `${d.mark} ${t.name}`,
        body: `${kind.label} · ${d.name} · ${Math.round(t.length * UNIT_M)} m long · ${Math.round(t.drop * VERTICAL_M)} m drop${feats ? ` · ${feats} feature${feats === 1 ? "" : "s"}` : ""}. ${kind.blurb}`,
      };
    }
    if (sel.kind === "building") {
      const b = this.buildings.find((x) => x.id === sel.id);
      if (!b) return { title: "Building", body: "" };
      const extra: Partial<Record<BuildingType, string>> = {
        parkingSmall: "Room for 120 cars (300 skiers). Earns parking fees as it fills.",
        parkingLarge: "Room for 400 cars (1,000 skiers). Earns parking fees as it fills.",
        garage: "Five decks, 2,000 cars (5,000 skiers). Earns parking fees as it fills.",
        lodge: "Also unlocks ticket prices.",
        restroom: "Slowest earner, but people stay on the hill.",
        coffee: "Cafe sales. Faster than a shack, slower than a restaurant.",
        sandwich: "Solid lunch money.",
        shack: "Tiny snack hut. Drop it beside a trail or on the summit.",
        cafeteria: "Tray-line meals. Steady lunch traffic.",
        bar: "Après drinks. Guests linger and spend.",
        hotel: "Overnight guests — top earner.",
        restaurant: "Sit-down meals. Faster than sandwiches.",
        shop: "Retail on the village street.",
        condo: "Sold as lodging. Big checks, village only.",
        hostel: "Budget beds. Cheaper than a hotel, still fills the village.",
        spa: "Soaks and massages. Guests leave happier.",
        patrol: "Barely earns. After the first peak you also need hired patrol.",
        clinic: "Bandages and ice packs. Can sit on the mountain.",
        rental: "Boots and boards for day-trippers.",
        school: `Lessons for beginners. Needs instructors: ${this.staff.instructor} hired.`,
        cabinOffice: `Rents out hillside cabins. ${this.count("cabin")} cabin${this.count("cabin") === 1 ? "" : "s"} on the books, ${this.skiInCabins()} ski-in / ski-out.`,
        cabin: this.cabinOnRun(b)
          ? "Ski-in / ski-out: guests step out the door onto a run. Fully booked."
          : `No run within ${CABIN_REACH} m any more, so it rents for a fraction of the price. Cut a run past it.`,
        heli: "",
      };
      if (b.type === "heli") {
        const waiting = this.skiers.filter((k) => k.state === "heliWait").length;
        return {
          title: BUILDING_LABEL.heli,
          body: `Flies ${HELI.seats} experts at a time into the backcountry for $${HELI.fare} a seat. Fuel $${HELI.fuelPerFlight} a flight, upkeep $${OPERATING_COST_PER_MIN.heli}/min. ${this.heli.flying ? "Helicopter is out on a drop." : `${waiting} waiting on the pad.`} Today: ${this.heliFlightsToday} flights, $${Math.round(this.heliTakeToday).toLocaleString()} in fares. Moving it costs ${this.moveFee(b) ? `$${this.moveFee(b).toLocaleString()}` : "nothing"}.`,
        };
      }
      return {
        title: BUILDING_LABEL[b.type],
        body: `Earns $${INCOME_PER_MIN[b.type]}/min when the hill is busy. ${extra[b.type] ?? BUILDING_BLURB[b.type] ?? ""} Moving it costs ${this.moveFee(b) ? `$${this.moveFee(b).toLocaleString()}` : "nothing"}.`,
      };
    }
    if (sel.kind === "lift") {
      const l = this.lifts.find((x) => x.id === sel.id);
      if (!l) return { title: "Lift", body: "" };
      const spec = LIFT_SPECS[l.type];
      const q = this.skiers.filter((s) => s.liftId === l.id && s.state === "queue").length;
      const len = Math.hypot(l.top.x - l.bottom.x, l.top.y - l.bottom.y);
      const rise = (elevation(l.top.x, l.top.y, this.currentMountain) - elevation(l.bottom.x, l.bottom.y, this.currentMountain)) * VERTICAL_M;
      const perHour = Math.round(((spec.seats * spec.speed) / spec.spacing) * 3600 / 6);
      const served = this.trailsFrom(l).length;
      return {
        title: l.name,
        body: `${spec.label} · ${Math.round(len * UNIT_M)} m long · ${Math.round(rise)} m rise · about ${perHour.toLocaleString()} riders/hr. ${q} in line. Serves ${served} run${served === 1 ? "" : "s"} from the top.`,
      };
    }
    const s = this.skiers.find((x) => x.id === sel.id);
    if (!s) return { title: "Skier", body: "" };
    return {
      title: s.name,
      body: `${DIFF[s.skill].name} skier · mood ${Math.round(s.mood)} · ${s.runsDone} run${s.runsDone === 1 ? "" : "s"} today.`,
    };
  }

  /** First rocky spot on a run leg (centre and both sides), or null if it's clear. */
  rockOnLeg(a: Vec2, b: Vec2, width: number): Vec2 | null {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / 7));
    const ux = (b.x - a.x) / (len || 1);
    const uy = (b.y - a.y) / (len || 1);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      for (const side of [0, -0.35, 0.35]) {
        const x = a.x + (b.x - a.x) * t - uy * width * side;
        const y = a.y + (b.y - a.y) * t + ux * width * side;
        if (isRock(x, y)) return { x, y };
      }
    }
    return null;
  }

  private clickCut(x: number, y: number): "ok" | "shake" | "none" {
    if (this.draft.length === 0) {
      if (elevationM(x, y) < elevationM(BASE.x, BASE.y) + 40) {
        this.toast("Start the cut higher on the mountain.", true);
        return "shake";
      }
      if (isRock(x, y)) {
        this.toast("That's bare rock. Start the run on snow.", true);
        return "shake";
      }
      this.draft.push({ x, y });
      return "ok";
    }
    const last = this.draft[this.draft.length - 1];
    const step = Math.hypot(x - last.x, y - last.y);
    if (step < 16) return "none";
    const up = elevation(x, y, this.currentMountain) - elevation(last.x, last.y, this.currentMountain);
    if (up > 0.018) {
      this.toast("Runs have to go downhill.", true);
      return "shake";
    }
    if (this.rockOnLeg(last, { x, y }, TRAIL_KIND_SPEC[this.trailKind].width)) {
      this.toast("Rocks in the way. Route the run around the outcrop.", true);
      return "shake";
    }
    this.draft.push({ x, y });
    return "ok";
  }

  finishTrail(): "ok" | "shake" | "none" {
    if (this.tool === "road") return this.finishRoad();
    if (this.tool === "path") return this.finishPath();
    if (this.draft.length < 2) {
      this.toast("Click a few downhill points first.", true);
      return "shake";
    }
    const kind = this.trailKind;
    const info = measureTrail(this.draft, this.currentMountain, kind);
    if (info.length < 120) {
      this.toast("That run is too short to groom.", true);
      return "shake";
    }
    if (kind === "glades") {
      const inside = this.treesAlong(this.draft, TRAIL_KIND_SPEC.glades.width / 2);
      if (inside < info.length / 20) {
        this.toast("Glades need forest. Draw this one through the trees.", true);
        return "shake";
      }
    }
    if (this.money < info.cost) {
      this.toast(`Need $${(info.cost - this.money).toLocaleString()} more to cut this.`, true);
      return "shake";
    }
    this.money -= info.cost;
    const name = this.freshTrailName(kind);
    const trail = this.makeTrail(name, this.draft.map((p) => ({ ...p })), kind);
    this.trails.push(trail);
    const half = TRAIL_KIND_SPEC[kind].width / 2 + 9;
    this.trails.pop();
    const before = this.treesAlong(trail.points, half);
    this.trails.push(trail);
    const felled = before - this.treesAlong(trail.points, half);
    this.clearTrees();
    this.float(this.draft[0].x, this.draft[0].y, `-${info.cost}`, "#d9785f");
    this.toast(`${DIFF[info.difficulty].name} ${TRAIL_KIND_SPEC[kind].label.toLowerCase()} “${name}” is open. ${felled} trees cleared.`);
    this.draft = [];
    this.tool = "select";
    this.selected = { kind: "trail", id: trail.id };
    return "ok";
  }

  private freshTrailName(kind: TrailKind = "slope"): string {
    const suffix: Record<TrailKind, string[]> = {
      slope: TRAIL_SUFFIX,
      slalom: ["Slalom", "Gates", "Race Course"],
      moguls: ["Bumps", "Moguls", "Washboard"],
      park: ["Park", "Terrain Park", "Jib Park"],
      glades: ["Glades", "Trees", "Woods"],
    };
    for (let i = 0; i < 40; i++) {
      const name = `${pick(TRAIL_PREFIX)} ${pick(suffix[kind])}`;
      if (!this.usedTrailNames.has(name)) {
        this.usedTrailNames.add(name);
        return name;
      }
    }
    return `Run ${this.trails.length + 1}`;
  }

  private clickBuild(type: BuildingType, x: number, y: number): "ok" | "shake" | "none" {
    const err = this.canPlace(type, x, y);
    if (err) {
      this.toast(err, true);
      return "shake";
    }
    this.money -= COSTS[type];
    const b: Building = { id: this.id(), type, x, y, earnAcc: 0, earnTimer: 0 };
    if (PARKING[type]) b.angle = this.parkingAngle(type, x, y);
    this.buildings.push(b);
    this.gradePad(b);
    this.clearTrees();
    this.float(x, y, `-${COSTS[type]}`, "#d9785f");
    this.tool = "select";
    this.selected = { kind: "building", id: b.id };
    if (type === "cabinOffice") {
      this.toast(`Cabin rental office is open. Build ski-in cabins beside your runs (Resort menu); each earns $${INCOME_PER_MIN.cabin}/min.`);
    } else if (type === "lodge") {
      this.toast(`Lodge is open. Earns $${INCOME_PER_MIN.lodge}/min and unlocks ticket prices.`);
    } else {
      this.toast(
        type === "heli"
          ? `Heli-ski base is open. Experts pay $${HELI.fare} a seat; it costs $${OPERATING_COST_PER_MIN.heli}/min to run.`
          : PARKING[type]
            ? `${BUILDING_LABEL[type]} is open: room for ${PARKING[type]!.skiers.toLocaleString()} more skiers (${PARKING[type]!.cars.toLocaleString()} cars).${
                this.parkingLots().find((l) => l.id === b.id)?.connected ? "" : " Connect it to a road so cars can reach it."
              }`
            : `${BUILDING_LABEL[type]} is open. Earns $${INCOME_PER_MIN[type]}/min.`,
      );
    }
    return "ok";
  }

  /** The reachable lot with the most room left (the starter lot if nothing is reachable). */
  private pickLot(): Vec2 {
    const parked = new Map<string, number>();
    for (const s of this.skiers) {
      const k = `${s.lot.x},${s.lot.y}`;
      parked.set(k, (parked.get(k) ?? 0) + 1);
    }
    let best: Vec2 = this.exit();
    let room = -Infinity;
    for (const l of this.parkingLots()) {
      if (!l.connected) continue;
      const free = (l.skiers - (parked.get(`${l.x},${l.y}`) ?? 0)) / l.skiers;
      if (free > room) {
        room = free;
        best = { x: l.x, y: l.y };
      }
    }
    return best;
  }

  spawnSkier(freeTicket: boolean): void {
    const lot = this.pickLot();
    const skillRoll = Math.random();
    let skill: Difficulty = 0;
    const { counts } = this.variety();
    if (skillRoll > 0.82 && (counts[2] + counts[3] > 0 || Math.random() < 0.25)) skill = 3;
    else if (skillRoll > 0.58) skill = 2;
    else if (skillRoll > 0.3) skill = 1;
    const s: Skier = {
      id: this.id(),
      name: pick(NAMES),
      skill,
      color: pick(JACKETS),
      // Out of a car in the parking lot.
      x: lot.x - 30 + Math.random() * 60,
      y: lot.y - 15 + Math.random() * 30,
      lot: { x: lot.x, y: lot.y },
      state: "arriving",
      trailId: null,
      liftId: null,
      rideT: 0,
      heliDone: false,
      joinT: 0,
      likes: likes(),
      air: 0,
      lesson: false,
      dist: 0,
      wait: 0,
      runsLeft: 6 + ((Math.random() * 9) | 0),
      runsDone: 0,
      mood: 70,
      paid: freeTicket,
      needBath: 0.15 + Math.random() * 0.2,
      needFood: 0.1 + Math.random() * 0.2,
      visitType: null,
      bubble: null,
      bubbleT: 0,
    };
    this.skiers.push(s);
  }

  tick(dt: number): void {
    const capped = Math.min(dt, 0.05) * (this.paused ? 0 : this.speed);
    if (capped <= 0) {
      this.ageToasts(dt);
      return;
    }
    if (this.managing) {
      this.goalCheckT -= capped;
      if (this.goalCheckT <= 0) {
        this.goalCheckT = 1;
        this.checkGoals();
      }
      const snowing = this.weather().snow > 0.15;
      this.dayT += capped;
      if (this.dayT >= 52) {
        this.dayT = 0;
        this.day += 1;
        this.ticketsToday = 0;
        this.incomeToday = 0;
        this.shopIncomeToday = 0;
        this.wagesToday = 0;
        this.upkeepToday = 0;
        this.heliFlightsToday = 0;
        this.heliTakeToday = 0;
        this.toast(`Day ${this.day} in Skilandia.`);
      }
      const wNow = this.weather();
      // A day is 52 game seconds: a half-day storm leaves 20-30 cm, which settles and gets skied off over a day or two.
      this.freshSnowCm = Math.max(0, this.freshSnowCm + capped * (wNow.snow * 1.1 - 0.05 - this.freshSnowCm * 0.004));
      const nowSnowing = wNow.snow > 0.15;
      if (nowSnowing !== snowing) this.toast(nowSnowing ? "❄ Snow is falling. Fresh powder on the way!" : "☀ The snow has stopped. The sun is breaking through.");
      // Skiers only come when it looks like the resort can take them:
      // arrivals close the gap to demand over about a minute, then stop.
      const want = this.demand();
      const gap = want - this.skiers.length;
      // Nobody can get here until a road reaches somewhere to park.
      if (gap > 0 && this.parkingCapacity() > 0) this.spawnAcc += capped * Math.min(gap / 45 + 0.05, this.capacity() * 0.003);
      const cap = this.capacity();
      while (this.spawnAcc > 1) {
        this.spawnAcc -= 1;
        if (this.skiers.length < Math.min(cap, want)) this.spawnSkier(false);
      }
      this.boothT += capped;
      if (this.boothT > 2 && this.boothTake > 0) {
        const b = this.booth();
        this.float(b.x, b.y, `+$${Math.round(this.boothTake).toLocaleString()}`);
        this.sfx.push("cash");
        this.boothTake = 0;
        this.boothT = 0;
      }
      this.collectBuildingIncome(capped);
      this.payWages(capped);
      this.payUpkeep(capped);
    }
    this.clock += capped;
    this.buildIndexes();
    this.stepLift(capped);
    this.stepHeli(capped);
    for (const s of this.skiers) {
      this.stepSkier(s, capped);
      s.mood = clamp(s.mood, 0, 100);
    }
    this.skiers = this.skiers.filter((s) => !(s.state === "leaving" && Math.hypot(s.x - s.lot.x, s.y - s.lot.y) < 12 && s.wait <= 0));
    this.peakSkiers = Math.max(this.peakSkiers, this.skiers.length);
    this.thoughtAcc += capped;
    if (this.thoughtAcc > 4.5) {
      this.thoughtAcc = 0;
      this.maybeBubble();
    }
    const avg =
      this.skiers.length === 0
        ? 60
        : this.skiers.reduce((n, s) => n + s.mood, 0) / this.skiers.length;
    this.mood = lerp(this.mood, avg, 0.08);
    for (const f of this.fx) {
      f.life -= capped;
      f.y += capped * 18;
    }
    this.fx = this.fx.filter((f) => f.life > 0);
    this.ageToasts(capped);
  }

  shopRatePerMin(): number {
    if (!this.buildings.length) return 0;
    const busy = clamp(this.skiers.length / 200, 0, 1);
    const util = (0.35 + 0.65 * busy) * this.staffCoverage();
    return Math.round(this.buildings.reduce((n, b) => n + INCOME_PER_MIN[b.type] * this.buildingEarnFactor(b), 0) * util);
  }

  private collectBuildingIncome(dt: number): void {
    if (!this.buildings.length) return;
    const busy = clamp(this.skiers.length / 200, 0, 1);
    const util = (0.35 + 0.65 * busy) * this.staffCoverage();
    for (const b of this.buildings) {
      const gain = (INCOME_PER_MIN[b.type] / 60) * util * this.buildingEarnFactor(b) * dt;
      if (gain <= 0) continue;
      this.money += gain;
      this.incomeToday += gain;
      this.shopIncomeToday += gain;
      this.lifetimeEarned += gain;
      b.earnAcc += gain;
      b.earnTimer += dt;
      if (b.earnTimer >= 2.4 && b.earnAcc >= 1) {
        const shown = Math.max(1, Math.round(b.earnAcc));
        b.earnAcc = 0;
        b.earnTimer = 0;
        this.float(b.x, b.y, `+$${shown}`);
      }
    }
  }

  /** A ski school only runs lessons with instructors on staff. */
  private buildingFactor(type: BuildingType): number {
    if (PARKING[type]) {
      const cap = this.parkingCapacity();
      return cap ? clamp(this.skiers.length / cap, 0, 1) : 0;
    }
    if (type === "cabin") return 1;
    if (type !== "school") return 1;
    const need = Math.max(1, this.staffNeeds().instructor);
    return Math.min(1, this.staff.instructor / need);
  }

  /** Is a run close enough to ski to and from this cabin's door? */
  cabinOnRun(b: Vec2): boolean {
    return this.trails.some((t) => distToTrail(t, b.x, b.y) < CABIN_REACH);
  }

  /** Cabins that are rentable as ski-in / ski-out (an office open and a run at the door). */
  skiInCabins(): number {
    if (!this.has("cabinOffice")) return 0;
    return this.buildings.filter((b) => b.type === "cabin" && this.cabinOnRun(b)).length;
  }

  /** Per-building earnings factor (cabins depend on their office and a run nearby). */
  private buildingEarnFactor(b: Building): number {
    if (b.type !== "cabin") return this.buildingFactor(b.type);
    if (!this.has("cabinOffice")) return 0;
    return this.cabinOnRun(b) ? 1 : 0.3;
  }

  /** Running costs for buildings that have them. */
  upkeepPerMin(): number {
    let n = 0;
    for (const b of this.buildings) n += OPERATING_COST_PER_MIN[b.type] ?? 0;
    return n;
  }

  private payUpkeep(dt: number): void {
    const cost = (this.upkeepPerMin() / 60) * dt;
    this.money -= cost;
    this.upkeepToday += cost;
  }

  helipad(): Building | undefined {
    return this.buildings.find((b) => b.type === "heli");
  }

  /** Load experts on the pad, fly them off the map, bring them back. */
  private stepHeli(dt: number): void {
    const pad = this.helipad();
    const h = this.heli;
    if (!pad) {
      h.flying = false;
      h.riders = [];
      return;
    }
    if (h.flying) {
      h.t += dt;
      if (h.t >= HELI.tripTime) {
        for (const id of h.riders) {
          const s = this.byId.get(id);
          if (!s) continue;
          s.x = pad.x + (Math.random() - 0.5) * 16;
          s.y = pad.y + (Math.random() - 0.5) * 16;
          s.runsDone += 3;
          s.runsLeft -= 1;
          s.mood = Math.min(100, s.mood + 18);
          s.bubble = pick(["Best day ever", "Deep powder!", "Worth every cent", "Untracked!"]);
          s.bubbleT = 2.6;
          if (s.runsLeft <= 0) s.state = "leaving";
          else this.goToLift(s);
        }
        h.flying = false;
        h.riders = [];
        h.t = 0;
        h.wait = 0;
      }
      return;
    }
    const ready = this.skiers.filter((s) => s.state === "heliWait" && Math.hypot(s.x - pad.x, s.y - pad.y) < 36);
    if (!ready.length) {
      h.wait = 0;
      return;
    }
    h.wait += dt;
    if (ready.length < HELI.seats && h.wait < HELI.maxWait) return;
    const load = ready.slice(0, HELI.seats);
    for (const s of load) {
      s.state = "heli";
      s.heliDone = true;
      this.money += HELI.fare;
      this.incomeToday += HELI.fare;
      this.lifetimeEarned += HELI.fare;
      this.heliTakeToday += HELI.fare;
    }
    this.money -= HELI.fuelPerFlight;
    this.upkeepToday += HELI.fuelPerFlight;
    this.heliFlightsToday += 1;
    this.float(pad.x, pad.y, `+$${HELI.fare * load.length - HELI.fuelPerFlight} heli`);
    this.sfx.push("cash");
    h.flying = true;
    h.t = 0;
    h.riders = load.map((s) => s.id);
  }

  /** Experts sometimes book a heli drop instead of riding the lifts. */
  private wantsHeli(s: Skier): boolean {
    return s.skill >= 2 && !s.heliDone && !!this.helipad() && Math.random() < 0.4;
  }

  private payWages(dt: number): void {
    for (const role of STAFF_ROLES) {
      if (!this.staffRequired() && role !== "instructor") continue;
      const w = (STAFF_WAGE_PER_MIN[role] / 60) * this.staff[role] * dt;
      this.money -= w;
      this.wagesToday += w;
    }
  }

  /** Payroll and the bigger buildings start once the resort is a ski area (first peak). */
  staffRequired(): boolean {
    return this.tier() >= 1;
  }

  expansionUnlocked(): boolean {
    return this.tier() >= 1;
  }

  empireCount(type: BuildingType): number {
    return this.count(type);
  }

  staffNeeds(): Record<StaffRole, number> {
    const instructor = this.empireCount("school") * 2;
    if (!this.staffRequired()) {
      return { patrol: 0, food: 0, lift: 0, delivery: 0, maintenance: 0, instructor };
    }
    const foodBuildings = FOOD_BUILDINGS.reduce((n, t) => n + this.empireCount(t), 0);
    const lodgings = LODGING_BUILDINGS.reduce((n, t) => n + this.empireCount(t), 0);
    const trails = this.trails.length;
    return {
      patrol: Math.max(1, Math.ceil(this.skiers.length / 150) + this.tier()),
      food: Math.max(foodBuildings > 0 ? 1 : 0, foodBuildings),
      lift: Math.max(1, Math.ceil(this.lifts.length / 2)),
      delivery: Math.max(foodBuildings + lodgings > 0 ? 1 : 0, Math.ceil((foodBuildings + lodgings) / 2)),
      maintenance: Math.max(1, Math.ceil(trails / 5) + 1),
      instructor,
    };
  }

  staffCoverage(): number {
    if (!this.staffRequired()) return 1;
    const need = this.staffNeeds();
    let got = 0;
    let want = 0;
    for (const role of STAFF_ROLES) {
      if (role === "instructor") continue; // only the ski school depends on them
      want += Math.max(1, need[role]);
      got += Math.min(this.staff[role], Math.max(1, need[role]));
    }
    return want === 0 ? 1 : clamp(got / want, 0.35, 1);
  }

  hire(role: StaffRole): void {
    if (role === "instructor") {
      if (this.empireCount("school") === 0) {
        this.toast("Build a ski school first.", true);
        return;
      }
      this.staff.instructor += 1;
      this.toast("Hired a ski instructor.");
      return;
    }
    if (!this.staffRequired()) {
      this.toast("The local hill is family-run. Payroll starts once you conquer your first peak.", true);
      return;
    }
    this.staff[role] += 1;
    this.toast(`Hired ${STAFF_LABEL[role].toLowerCase()}.`);
  }

  fire(role: StaffRole): void {
    if (this.staff[role] <= 0) return;
    this.staff[role] -= 1;
    this.toast(`Let a ${STAFF_LABEL[role].toLowerCase()} go.`);
  }


  private nearestFood(x: number, y: number): Building | undefined {
    return this.nearestOf(FOOD_BUILDINGS, x, y);
  }

  private nearestOf(types: BuildingType[], x: number, y: number): Building | undefined {
    let best: Building | undefined;
    let bestD = Infinity;
    for (const b of this.buildings) {
      if (!types.includes(b.type)) continue;
      const d = (b.x - x) ** 2 + (b.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  private ageToasts(dt: number): void {
    for (const t of this.toasts) t.life -= dt;
    this.toasts = this.toasts.filter((t) => t.life > 0);
  }

  private stepLift(dt: number): void {
    for (const lift of this.lifts) {
      const spec = LIFT_SPECS[lift.type];
      const len = Math.max(20, Math.hypot(lift.top.x - lift.bottom.x, lift.top.y - lift.bottom.y));
      const dtT = (dt * spec.speed) / len;
      for (const c of lift.carriers) {
        const before = c.t;
        c.t += dtT;
        if (before < 0.04 && c.t >= 0.04 && c.riders.length === 0) {
          const line = this.lines.get(lift.id) ?? [];
          for (const s of line.splice(0, spec.seats)) {
            c.riders.push(s.id);
            s.state = "riding";
            s.wait = 0;
            // Warm bubble chairs and cabins keep people cheerful.
            if (lift.type === "six" || lift.type === "gondola") s.mood = Math.min(100, s.mood + 1.5);
          }
        }
        if (c.t >= 0.97 && c.riders.length) {
          for (const id of c.riders) {
            const s = this.byId.get(id);
            if (!s) continue;
            s.x = lift.top.x + (Math.random() * 10 - 5);
            s.y = lift.top.y + (Math.random() * 6 - 3);
            s.state = "toTrail";
            s.trailId =
              lift.type === "carpet" && this.servedBy(lift).length === 0
                ? -lift.id
                : this.chooseTrail(s, lift)?.id ?? null;
            s.dist = 0;
          }
          c.riders = [];
        }
        if (c.t >= 1) c.t -= 1;
      }
    }
  }

  /**
   * Pick the lift that gets this skier to terrain they like soonest:
   * close by, short line, and runs at the top that fit their skill.
   */
  private chooseLift(s: Skier): Lift | null {
    let best: Lift | null = null;
    let bestScore = Infinity;
    for (const l of this.lifts) {
      const spec = LIFT_SPECS[l.type];
      const served = this.servedBy(l);
      const bunny = l.type === "carpet" && served.length === 0;
      if (bunny && s.skill > 0) continue;
      const fit = bunny ? 1 : served.reduce((m, t) => Math.max(m, trailScore(s.skill, t.difficulty)), 0);
      const line = this.lineLen.get(l.id) ?? 0;
      const perSec = (spec.seats * spec.speed) / spec.spacing;
      const score =
        Math.hypot(s.x - l.bottom.x, s.y - l.bottom.y) * 0.45 +
        (line / perSec) * 6 +
        (1 - fit) * 220 +
        (served.length || bunny ? 0 : 500) +
        (l.type === "carpet" && s.skill === 0 ? -70 : 0) +
        Math.random() * 25;
      if (score < bestScore) {
        bestScore = score;
        best = l;
      }
    }
    return best;
  }

  /** The skier's run: a real trail, or (negative id) the bunny slope beside a carpet. */
  private trailFor(s: Skier): Trail | undefined {
    if (s.trailId == null) return undefined;
    if (s.trailId >= 0) return this.trails.find((t) => t.id === s.trailId);
    const lift = this.lifts.find((l) => l.id === -s.trailId!);
    if (!lift) return undefined;
    const dx = lift.top.x - lift.bottom.x;
    const dy = lift.top.y - lift.bottom.y;
    const l = Math.hypot(dx, dy) || 1;
    const ox = (-dy / l) * 12;
    const oy = (dx / l) * 12;
    const points = [
      { x: lift.top.x + ox, y: lift.top.y + oy },
      { x: lift.bottom.x + ox * 1.4 + (dx / l) * 6, y: lift.bottom.y + oy * 1.4 + (dy / l) * 6 },
    ];
    const drop = elevation(points[0].x, points[0].y, this.currentMountain) - elevation(points[1].x, points[1].y, this.currentMountain);
    return { id: s.trailId, name: "Bunny slope", points, difficulty: 0, length: l, drop: Math.max(0, drop), kind: "slope" };
  }

  private goToLift(s: Skier): void {
    if (s.runsDone > 0 && this.wantsHeli(s) && Math.random() < 0.4) {
      s.state = "heliWait";
      s.wait = 0;
      return;
    }
    s.state = "toLift";
    s.joinT = this.clock;
    s.liftId = null;
  }

  private chooseTrail(s: Skier, lift?: Lift): Trail | null {
    const score = (t: Trail) => trailScore(s.skill, t.difficulty) * (t.kind === s.likes ? 1.6 : 1);
    const ranked = [...this.trails].sort((a, b) => score(b) - score(a));
    const options = ranked.filter((t) => trailScore(s.skill, t.difficulty) > 0.15);
    if (!options.length) return ranked[0] ?? null;
    const from = lift ? this.servedBy(lift) : [];
    const hikeOk = options.filter((t) => from.includes(t));
    if (hikeOk.length) return hikeOk[(Math.random() * Math.min(3, hikeOk.length)) | 0];
    // Nothing served from this lift: take the closest trailhead rather than roam the mountain.
    const at = lift ? lift.top : { x: s.x, y: s.y };
    const pool = from.length ? from : this.trails;
    return [...pool].sort((a, b) => Math.hypot(a.points[0].x - at.x, a.points[0].y - at.y) - Math.hypot(b.points[0].x - at.x, b.points[0].y - at.y))[0] ?? null;
  }

  booth(): Vec2 {
    return { x: BASE.x - 60, y: BASE.y + 90 };
  }

  /** Where skiers park and leave from. */
  exit(): Vec2 {
    return { x: BASE.x - 160, y: BASE.y + 200 };
  }

  private stepSkier(s: Skier, dt: number): void {
    s.needBath = clamp(s.needBath + dt * 0.015, 0, 1.2);
    s.needFood = clamp(s.needFood + dt * 0.012, 0, 1.2);
    if (s.bubbleT > 0) s.bubbleT -= dt;
    else s.bubble = null;
    if (s.air > 0) s.air = Math.max(0, s.air - dt);
    if (s.state === "arriving") {
      const b = this.booth();
      this.walkTo(s, b.x, b.y, 42 * WALK * dt, dt);
      if (Math.hypot(s.x - b.x, s.y - b.y) < 10) s.state = "booth";
      return;
    }
    if (s.state === "booth") {
      if (!s.paid) {
        const fair = this.fairPrice() + (s.skill - 1) * 4;
        if (this.ticketPrice > fair + 14 && Math.random() < 0.55) {
          s.mood -= 25;
          s.state = "leaving";
          s.bubble = "Too pricey";
          s.bubbleT = 2.2;
          return;
        }
        s.paid = true;
        this.money += this.ticketPrice;
        this.ticketsToday += 1;
        this.totalTickets += 1;
        this.incomeToday += this.ticketPrice;
        this.lifetimeEarned += this.ticketPrice;
        this.boothTake += this.ticketPrice;
      }
      if (this.wantsHeli(s)) {
        s.state = "heliWait";
        s.wait = 0;
        return;
      }
      // New skiers sign up for a lesson when the school has instructors.
      if (s.skill === 0 && !s.lesson && this.has("school") && this.staff.instructor > 0 && Math.random() < 0.65) {
        s.state = "visit";
        s.visitType = "school";
        s.lesson = true;
        s.wait = 0;
        return;
      }
      this.goToLift(s);
      return;
    }
    if (s.state === "toLift") {
      if (s.liftId == null || !this.lifts.some((l) => l.id === s.liftId)) {
        s.liftId = this.chooseLift(s)?.id ?? null;
        if (s.liftId == null) {
          s.state = "leaving";
          return;
        }
      }
      const q = this.queueSlot(s);
      const lift = this.lifts.find((l) => l.id === s.liftId)!;
      // Head for the station along the paths, then find a spot in line.
      if (Math.hypot(s.x - lift.bottom.x, s.y - lift.bottom.y) > 40) this.walkTo(s, lift.bottom.x, lift.bottom.y, 46 * WALK * dt, dt);
      else this.walkToward(s, q.x, q.y, 46 * WALK * dt);
      if (Math.hypot(s.x - q.x, s.y - q.y) < 8) s.state = "queue";
      return;
    }
    if (s.state === "queue") {
      if (!this.lifts.some((l) => l.id === s.liftId)) {
        this.goToLift(s);
        return;
      }
      const q = this.queueSlot(s);
      this.walkToward(s, q.x, q.y, 30 * dt);
      s.wait += dt;
      // Patience wears thin after ~40s in line; fed-up skiers go home.
      if (s.wait > 40) {
        s.mood -= 4;
        s.wait = 30;
      }
      if (s.mood < 15) {
        s.state = "leaving";
        s.liftId = null;
        s.bubble = "Line's too long";
        s.bubbleT = 2.4;
      }
      return;
    }
    if (s.state === "riding") {
      const lift = this.lifts.find((l) => l.id === s.liftId);
      const c = lift?.carriers.find((k) => k.riders.includes(s.id));
      if (!lift || !c) {
        s.state = "toTrail";
        return;
      }
      const t = Math.min(c.t, 0.97);
      s.rideT = t;
      // Spread riders across the chair.
      const seat = c.riders.indexOf(s.id) - (c.riders.length - 1) / 2;
      const dx = lift.top.x - lift.bottom.x;
      const dy = lift.top.y - lift.bottom.y;
      const l = Math.hypot(dx, dy) || 1;
      s.x = lerp(lift.bottom.x, lift.top.x, t) - (dy / l) * seat * 1.4;
      s.y = lerp(lift.bottom.y, lift.top.y, t) + (dx / l) * seat * 1.4;
      return;
    }
    if (s.state === "toTrail") {
      const trail = this.trailFor(s) ?? this.chooseTrail(s);
      if (!trail) {
        s.state = "leaving";
        return;
      }
      s.trailId = trail.id;
      const start = trail.points[0];
      this.walkToward(s, start.x, start.y, 50 * WALK * dt);
      if (Math.hypot(s.x - start.x, s.y - start.y) < 10) {
        s.state = "skiing";
        s.x = start.x;
        s.y = start.y;
        s.dist = 0;
        const mismatch = trail.difficulty - s.skill;
        if (mismatch > 1) s.mood -= 12;
        else if (mismatch === 0) s.mood += 4;
        else if (mismatch < 0) s.mood -= 2;
      }
      return;
    }
    if (s.state === "skiing") {
      const trail = this.trailFor(s);
      if (!trail) {
        this.goToLift(s);
        return;
      }
      const grade = (trail.drop * VERTICAL_M) / (Math.max(40, trail.length) * UNIT_M);
      const kind = TRAIL_KIND_SPEC[trail.kind];
      const speed =
        (46 + trail.difficulty * 16 + grade * 90 - Math.max(0, trail.difficulty - s.skill) * 12) * SKI * kind.speedMul;
      const before = s.dist;
      s.dist += speed * dt;
      this.hitFeatures(s, trail, before, s.dist);
      const p = pointOnPolyline(trail.points, s.dist);
      // Slalom skiers carve wide around the gates; others make lazy turns.
      const swing = trail.kind === "slalom" ? 4 : trail.kind === "park" ? 1.5 : 3.2;
      const freq = trail.kind === "slalom" ? Math.PI / 28 : 0.08;
      const phase = trail.kind === "slalom" ? 0 : s.id;
      s.x = p.x + Math.sin(s.dist * freq + phase) * swing * -p.dy;
      s.y = p.y + Math.sin(s.dist * freq + phase) * swing * p.dx;
      if (p.done) {
        s.runsDone += 1;
        s.runsLeft -= 1;
        s.mood += 3;
        if (s.needBath > 0.72) {
          const room = this.buildings.find((b) => b.type === "restroom");
          if (room) {
            s.state = "visit";
            s.visitType = "restroom";
            s.wait = 0;
            return;
          }
          s.mood -= 14;
          s.bubble = "Need a bathroom";
          s.bubbleT = 2.4;
        }
        if (s.needFood > 0.72) {
          const food = this.nearestFood(s.x, s.y);
          if (food) {
            s.state = "visit";
            s.visitType = food.type;
            s.wait = 0;
            return;
          }
          s.mood -= 8;
        }
        // Done for the day: some browse the shops on the way back to the car.
        if (s.runsLeft <= 0 && s.mood >= 28 && Math.random() < 0.4) {
          const shop = this.nearestOf(SHOP_BUILDINGS, s.x, s.y);
          if (shop) {
            s.state = "visit";
            s.visitType = shop.type;
            s.wait = 0;
            return;
          }
        }
        if (s.runsLeft <= 0 || s.mood < 28) s.state = "leaving";
        else this.goToLift(s);
      }
      return;
    }
    if (s.state === "visit") {
      const b = s.visitType ? this.nearestOf([s.visitType], s.x, s.y) : undefined;
      if (!b) {
        this.goToLift(s);
        return;
      }
      this.walkTo(s, b.x, b.y, 44 * WALK * dt, dt);
      if (Math.hypot(s.x - b.x, s.y - b.y) < 12) {
        s.wait += dt;
        if (s.wait > (s.visitType === "school" ? 3 : 1.6)) {
          if (s.visitType === "school") {
            // A lesson: happier, and some beginners graduate to blues.
            const fee = 25;
            this.money += fee;
            this.incomeToday += fee;
            this.shopIncomeToday += fee;
            this.lifetimeEarned += fee;
            s.mood += 6;
            if (Math.random() < 0.35) {
              s.skill = 1;
              s.bubble = "I can ski blues!";
              s.bubbleT = 2.4;
            }
          } else if (s.visitType === "restroom") s.needBath = 0.05;
          else if (FOOD_BUILDINGS.includes(s.visitType!)) s.needFood = 0.08;
          s.mood += 8;
          s.wait = 0;
          s.visitType = null;
          if (s.runsLeft <= 0) s.state = "leaving";
          else this.goToLift(s);
        }
      }
      return;
    }
    if (s.state === "heliWait") {
      const pad = this.helipad();
      if (!pad) {
        this.goToLift(s);
        return;
      }
      const i = this.heliSpot.get(s.id) ?? 0;
      this.walkToward(s, pad.x - 14 + (i % 4) * 6, pad.y - 18 - Math.floor(i / 4) * 6, 46 * WALK * dt);
      s.wait += dt;
      if (s.wait > 60) {
        // Gave up waiting on the helicopter.
        s.mood -= 10;
        s.heliDone = true;
        this.goToLift(s);
      }
      return;
    }
    if (s.state === "heli") return; // off the map, skiing the backcountry
    if (s.state === "leaving") {
      const exit = s.lot;
      this.walkTo(s, exit.x, exit.y, 48 * WALK * dt, dt);
      s.wait = 0;
    }
  }

  /** Rebuild the per-tick indexes (O(skiers)). */
  private buildIndexes(): void {
    this.byId.clear();
    this.lines.clear();
    this.lineSpot.clear();
    this.lineLen.clear();
    this.heliSpot.clear();
    this.served.clear();
    let heli = 0;
    const waiting = new Map<number, Skier[]>();
    for (const s of this.skiers) {
      this.byId.set(s.id, s);
      if (s.state === "heliWait") this.heliSpot.set(s.id, heli++);
      if (s.liftId == null) continue;
      if (s.state === "queue" || (s.state === "toLift" && s.paid)) {
        let w = waiting.get(s.liftId);
        if (!w) waiting.set(s.liftId, (w = []));
        w.push(s);
      }
    }
    // First come, first served: order each line by when people joined it.
    for (const [liftId, w] of waiting) {
      w.sort((a, b) => a.joinT - b.joinT || a.id - b.id);
      this.lineLen.set(liftId, w.length);
      const line: Skier[] = [];
      w.forEach((s, i) => {
        this.lineSpot.set(s.id, i);
        if (s.state === "queue") line.push(s);
      });
      this.lines.set(liftId, line);
    }
  }

  /** Runs served from a lift's top (cached per tick). */
  private servedBy(l: Lift): Trail[] {
    let list = this.served.get(l.id);
    if (!list) {
      list = this.trailsFrom(l);
      this.served.set(l.id, list);
    }
    return list;
  }

  /** Skiers who can handle it hit the jumps and features on their run. */
  private hitFeatures(s: Skier, trail: Trail, from: number, to: number): void {
    for (const f of this.features) {
      if (f.trailId !== trail.id) continue;
      const at = nearestOnTrail(trail, f.x, f.y).along;
      if (at <= from || at > to) continue;
      const keen = s.likes === "park";
      if (s.skill === 0 && !keen) continue; // beginners ski around
      s.air = f.type === "halfpipe" ? 1.1 : f.type === "jump" ? 0.75 : 0.45;
      s.mood = Math.min(100, s.mood + (keen ? 4 : 2));
      if (Math.random() < 0.25) {
        s.bubble = pick(["Sent it!", "Woo!", "Stomped", "Big air"]);
        s.bubbleT = 1.6;
      }
    }
  }

  private walkToward(s: Skier, x: number, y: number, step: number): void {
    const dx = x - s.x;
    const dy = y - s.y;
    const d = Math.hypot(dx, dy) || 1;
    const m = Math.min(step, d);
    s.x += (dx / d) * m;
    s.y += (dy / d) * m;
  }

  private queueSlot(s: Skier): Vec2 {
    const lift = this.lifts.find((l) => l.id === s.liftId) ?? this.lifts[0];
    const i = this.lineSpot.get(s.id) ?? (this.lineLen.get(lift.id) ?? 0);
    // Line up behind the bottom station, facing up the lift.
    let dx = lift.top.x - lift.bottom.x;
    let dy = lift.top.y - lift.bottom.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    // The corral gets wider as the line grows, so big crowds stay near the station.
    const cols = Math.max(8, Math.ceil(Math.sqrt(this.lineLen.get(lift.id) ?? 0) * 1.3));
    const back = 10 + Math.floor(i / cols) * 4;
    const side = ((i % cols) - (cols - 1) / 2) * 3.2;
    return { x: lift.bottom.x - dx * back - dy * side, y: lift.bottom.y - dy * back + dx * side };
  }

  private maybeBubble(): void {
    const talkers = this.skiers.filter((s) => s.state === "queue" || s.state === "skiing");
    if (!talkers.length) return;
    const s = pick(talkers);
    const { counts } = this.variety();
    if (s.skill >= 2 && counts[2] + counts[3] === 0) s.bubble = "Got a black?";
    else if (s.needBath > 0.7 && this.count("restroom") === 0) s.bubble = "Bathroom?";
    else if (s.skill === 0 && counts[0] === 0) s.bubble = "Too steep";
    else if (Math.random() < 0.3) s.bubble = pick(["Nice snow", "One more", "Cold!", "Whee"]);
    else return;
    s.bubbleT = 2.1;
  }
}

function distToTrail(t: Trail, x: number, y: number): number {
  let best = Infinity;
  for (let i = 1; i < t.points.length; i++) {
    const ax = t.points[i - 1].x;
    const ay = t.points[i - 1].y;
    const bx = t.points[i].x;
    const by = t.points[i].y;
    const abx = bx - ax;
    const aby = by - ay;
    const u = Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / (abx * abx + aby * aby || 1)));
    best = Math.min(best, Math.hypot(x - (ax + abx * u), y - (ay + aby * u)));
  }
  return best;
}

function trailScore(skill: Difficulty, diff: Difficulty): number {
  const d = Math.abs(skill - diff);
  if (d === 0) return 1;
  if (d === 1) return 0.55;
  if (skill < diff) return 0.08;
  return 0.22;
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function liftNoun(type: LiftType): string {
  return type === "tbar" ? "T-bar" : LIFT_SPECS[type].label.toLowerCase();
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function likes(): TrailKind {
  const r = Math.random();
  if (r < 0.55) return "slope";
  if (r < 0.75) return "park";
  if (r < 0.88) return "moguls";
  return "slalom";
}

/** Closest point on a run: distance along it and the direction of travel there. */
export function nearestOnTrail(t: Trail, x: number, y: number): { along: number; dx: number; dy: number; d: number } {
  let best = { along: 0, dx: 0, dy: -1, d: Infinity };
  let acc = 0;
  for (let i = 1; i < t.points.length; i++) {
    const a = t.points[i - 1];
    const b = t.points[i];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len = Math.hypot(abx, aby) || 1;
    const u = Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby) / (len * len)));
    const d = Math.hypot(x - (a.x + abx * u), y - (a.y + aby * u));
    if (d < best.d) best = { along: acc + len * u, dx: abx / len, dy: aby / len, d };
    acc += len;
  }
  return best;
}

/** Shaping: metres a second the brush raises or lowers at its centre, and what earthworks cost. */
export const SHAPE_RATE_M = 4;
export const EARTH_COST_PER_M3 = 0.06;
export const SHAPE_SIZES = [30, 60, 110];

/** How far beyond its edge a lot may sit from the road it opens onto. */
const PARKING_REACH = 30;

/** Share of the price you get back when you demolish something. */
const SALVAGE = 0.4;
/** Radius of the tree-clearing brush, and what each tree costs to fell. */
export const BRUSH_R = 30;
export const TREE_FELL_COST = 4;
/** What a planted sapling costs, how many one brush stamp plants, and how close trees may stand. */
export const TREE_PLANT_COST = 12;
const PLANT_PER_STAMP = 9;
const PLANT_GAP = 6;
const PLANT_CELL = 64;

export type Reward = { id: number; kind: "goal" | "peak" | "win"; title: string; text: string; bonus: number };

/** Cash bonus for reaching each goal on the list. */
const GOAL_BONUS: Record<string, number> = {
  road: 1500,
  lodge: 3000,
  black: 4000,
  patrol: 8000,
  tier1: 25000,
  tier2: 60000,
  tier3: 150000,
  tier4: 400000,
  all: 1000000,
};

/** Higher summits pay more. */
export function peakBonus(elevation: number): number {
  return Math.round((8000 + Math.max(0, elevation - 1800) * 60) / 500) * 500;
}

export type DemolishTarget = {
  kind: "building" | "feature" | "lift" | "trail" | "road" | "path";
  id: number;
  label: string;
  refund: number;
};

type ClearShape = { ax: number; ay: number; bx: number; by: number; r: number; glade: boolean; brush?: boolean };
type ClearIndex = { x0: number; y0: number; cell: number; cols: number; cells: Map<number, ClearShape[]> };

/** Stable, well-mixed 0..1 value per grid cell (and salt). */
function cellHash(gx: number, gy: number, salt: number): number {
  let h = Math.imul(gx | 0, 374761393) ^ Math.imul(gy | 0, 668265263) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Stable 0..1 value per tree position. */
function treeHash(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/** How forested a spot is (0..1): patchy, thinning out toward the treeline. */
export function forestDensity(x: number, y: number): number {
  // Nearly unbroken forest, with the odd small meadow.
  const density = 0.52 + noise2(x / 360, y / 300) * 0.5 + (noise2(x / 90, y / 110) - 0.5) * 0.3;
  const m = elevationM(x, y);
  const treeline = 1 - smoothstep(TREELINE_M - 250, TREELINE_M + 100 + (noise2(x / 500, y / 500) - 0.5) * 200, m);
  return density * treeline;
}

/** One possible tree per forest cell: where it stands, or null for a clearing. */
function forestCell(gx: number, gy: number): Vec2 | null {
  // An independent random spot anywhere in (and a little past) the cell, so
  // neighbours don't line up into rows.
  const x = (gx + 0.5 + (cellHash(gx, gy, 1) - 0.5) * 1.35) * TREE_CELL;
  const y = (gy + 0.5 + (cellHash(gx, gy, 2) - 0.5) * 1.35) * TREE_CELL;
  if (x < 4 || y < 4 || x > WORLD_W - 4 || y > WORLD_H - 4) return null;
  const density = forestDensity(x, y);
  if (density < 0.42) return null;
  // Natural gaps and clumps: thinner stands drop more trees, and small
  // clumping noise keeps even dense forest from looking planted.
  const clump = noise2(x / 38, y / 38);
  if (cellHash(gx, gy, 3) > 0.35 + (density - 0.42) * 1.4 + clump * 0.45) return null;
  if (rockAt(x, y) > 0.3) return null;
  if (gradeAt(x, y) > 0.9) return null; // cliffs
  return { x, y };
}
