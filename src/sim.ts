import { elevation, elevationM, gradeAt, lerp, nearSegment, noise2, pointOnPolyline, polylineLength } from "./height";
import {
  BUILDING_LABEL,
  BUILDING_MAX,
  Building,
  BuildingType,
  COSTS,
  DIFF,
  EXPANSION_BUILDINGS,
  FEATURE_SPEC,
  Feature,
  HELI,
  OPERATING_COST_PER_MIN,
  FeatureType,
  INCOME_PER_MIN,
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
const TREELINE_M = 1800;
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
  speed = 1;
  paused = false;
  managing = false;
  tool: Tool = "select";
  trails: Trail[] = [];
  lifts: Lift[] = [];
  /** Bottom station picked while placing a lift, and the pointer for the preview. */
  liftStart: Vec2 | null = null;
  liftHover: Vec2 | null = null;
  buildings: Building[] = [];
  skiers: Skier[] = [];
  features: Feature[] = [];
  /** Kind of run the Trail tool cuts. */
  trailKind: TrailKind = "slope";
  /** Building being moved with the Move tool. */
  moveId: number | null = null;
  /** Settings: charge a fee to move buildings. */
  moveFeeOn = true;
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
  private clock = 0;
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
  treesIn(x0: number, y0: number, x1: number, y1: number, cleared = true): Vec2[] {
    const out: Vec2[] = [];
    const gx0 = Math.max(0, Math.floor(x0 / TREE_CELL));
    const gy0 = Math.max(0, Math.floor(y0 / TREE_CELL));
    const gx1 = Math.min(Math.floor(WORLD_W / TREE_CELL), Math.ceil(x1 / TREE_CELL));
    const gy1 = Math.min(Math.floor(WORLD_H / TREE_CELL), Math.ceil(y1 / TREE_CELL));
    const near = cleared ? this.clearersIn(x0 - 40, y0 - 40, x1 + 40, y1 + 40) : null;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const t = forestCell(gx, gy);
        if (!t) continue;
        if (this.inVillage(t.x, t.y)) continue;
        if (near && this.isCleared(t.x, t.y, near)) continue;
        out.push(t);
      }
    }
    return out;
  }

  /** Runs, lifts, buildings and features near a box (to keep clearing checks cheap). */
  private clearersIn(x0: number, y0: number, x1: number, y1: number) {
    const hit = (ax: number, ay: number, bx: number, by: number) =>
      Math.max(ax, bx) >= x0 && Math.min(ax, bx) <= x1 && Math.max(ay, by) >= y0 && Math.min(ay, by) <= y1;
    return {
      trails: this.trails.filter((t) => {
        let mx = Infinity, my = Infinity, Mx = -Infinity, My = -Infinity;
        for (const p of t.points) {
          mx = Math.min(mx, p.x); my = Math.min(my, p.y); Mx = Math.max(Mx, p.x); My = Math.max(My, p.y);
        }
        return hit(mx, my, Mx, My);
      }),
      lifts: this.lifts.filter((l) => hit(l.bottom.x, l.bottom.y, l.top.x, l.top.y)),
      buildings: this.buildings.filter((b) => hit(b.x, b.y, b.x, b.y)),
      features: this.features.filter((f) => hit(f.x, f.y, f.x, f.y)),
    };
  }

  private isCleared(x: number, y: number, near: ReturnType<Game["clearersIn"]>): boolean {
    for (const tr of near.trails) {
      const d = distToTrail(tr, x, y);
      if (tr.kind === "glades") {
        if (d < TRAIL_KIND_SPEC.glades.width / 2 && (d < 2.5 || treeHash(x, y) < 0.5)) return true;
      } else if (d < TRAIL_KIND_SPEC[tr.kind].width / 2 + 9) return true;
    }
    for (const l of near.lifts) if (nearSegment(l.bottom.x, l.bottom.y, l.top.x, l.top.y, x, y, 16)) return true;
    for (const b of near.buildings) if (Math.hypot(b.x - x, b.y - y) < (b.type === "heli" ? 40 : 22)) return true;
    for (const f of near.features) if (Math.hypot(f.x - x, f.y - y) < (f.type === "halfpipe" ? 40 : 12)) return true;
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
    return `Day ${this.day} · ${h}:${m.toString().padStart(2, "0")} ${ap}`;
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
    n += Math.min(3, this.count("shack")) * 0.08;
    if (this.has("hotel")) n += 0.16;
    if (this.has("restaurant")) n += 0.14;
    if (this.has("shop")) n += 0.1;
    if (this.has("condo")) n += 0.14;
    if (this.has("patrol")) n += 0.08;
    if (this.has("school")) n += 0.12;
    if (this.has("heli")) n += 0.15;
    return Math.min(1.5, n);
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
      this.toast(`🚩 ${p.name} (${p.elevation.toLocaleString()} m) conquered! ${this.conquered.size}/${SUMMITS.length} peaks.`);
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
  loadLimits(): { lifts: number; runs: number; cap: number; comfortable: number; limitedBy: "lifts" | "runs" | "capacity" } {
    const key = `${this.currentMountain}:${this.lifts.length}:${this.trails.length}`;
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
    const comfortable = Math.round(Math.min(lifts, runs, cap));
    const limitedBy = comfortable === cap ? "capacity" : lifts <= runs ? "lifts" : "runs";
    this.loadCache = { lifts: Math.round(lifts), runs: Math.round(runs), cap, comfortable, limitedBy };
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
    if (this.has("lodge") && !this.has("coffee") && !this.has("sandwich") && this.count("shack") === 0) {
      out.push("Hungry skiers wish there was food.");
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
      if (load.limitedBy === "lifts") out.push("The lifts are maxed out. Add or upgrade lifts to draw more skiers.");
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
  }

  setTool(tool: Tool): void {
    this.liftStart = null;
    this.moveId = null;
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
    if (build !== "select" && build !== "cut" && EXPANSION_BUILDINGS.includes(build) && !this.expansionUnlocked()) {
      this.toast("Hotels, shops, condos and patrol unlock after you buy the next mountain.", true);
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

  canPlace(type: BuildingType, x: number, y: number, opts: { ignoreId?: number; cost?: number } = {}): string | null {
    const moving = opts.ignoreId != null;
    const others = this.buildings.filter((b) => b.id !== opts.ignoreId);
    const cost = opts.cost ?? COSTS[type];
    if (!moving && EXPANSION_BUILDINGS.includes(type) && !this.expansionUnlocked()) {
      return "Buy the next mountain to unlock this.";
    }
    if (!moving && this.count(type) >= BUILDING_MAX[type]) return `No more ${BUILDING_LABEL[type].toLowerCase()}s on this hill.`;
    const anywhere = PLACE_ANYWHERE.includes(type);
    const midMountain = PLACE_MOUNTAIN.includes(type);
    if (!anywhere && !midMountain && !this.villageOk(x, y)) {
      return this.inVillage(x, y) ? "Too steep to build here." : "Build in the base village.";
    }
    if (midMountain && !anywhere && this.inVillage(x, y)) return "Put this on the mountain, not in the village.";
    if (x < 12 || x > WORLD_W - 12 || y < 24 || y > WORLD_H - 12) return "That's off the property.";
    const minGap = type === "shack" ? 22 : type === "heli" ? 60 : 38;
    if (others.some((b) => Math.hypot(b.x - x, b.y - y) < minGap)) return "Too close to another building.";
    if (type !== "shack" && this.trails.some((t) => distToTrail(t, x, y) < 18)) return "Don't plant a building on a run.";
    if (type === "shack" && this.trails.some((t) => distToTrail(t, x, y) < 8)) return "Keep the shack beside the run, not in the fall line.";
    if (this.nearLift(x, y, 26)) return "Keep clear of the lift line.";
    if (this.money < cost) return `Need $${(cost - this.money).toLocaleString()} more.`;
    return null;
  }

  click(x: number, y: number): "ok" | "shake" | "none" {
    if (!this.managing) return "none";
    if (this.tool === "cut") return this.clickCut(x, y);
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
      if (d < 22 && d < bestD) {
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
      const extra: Record<BuildingType, string> = {
        lodge: "Also unlocks ticket prices.",
        restroom: "Slowest earner, but people stay on the hill.",
        coffee: "Cafe sales. Faster than a shack, slower than a restaurant.",
        sandwich: "Solid lunch money.",
        shack: "Tiny snack hut. Drop it beside a trail or on the summit.",
        hotel: "Overnight guests — top earner.",
        restaurant: "Sit-down meals. Faster than sandwiches.",
        shop: "Retail on the village street.",
        condo: "Sold as lodging. Big checks, village only.",
        patrol: "Barely earns. After the starter hill you also need hired patrol.",
        school: `Lessons for beginners. Needs instructors: ${this.staff.instructor} hired.`,
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
        body: `Earns $${INCOME_PER_MIN[b.type]}/min when the hill is busy. ${extra[b.type]} Moving it costs ${this.moveFee(b) ? `$${this.moveFee(b).toLocaleString()}` : "nothing"}.`,
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

  private clickCut(x: number, y: number): "ok" | "shake" | "none" {
    if (this.draft.length === 0) {
      if (elevationM(x, y) < elevationM(BASE.x, BASE.y) + 40) {
        this.toast("Start the cut higher on the mountain.", true);
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
    this.draft.push({ x, y });
    return "ok";
  }

  finishTrail(): "ok" | "shake" | "none" {
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
    this.buildings.push(b);
    this.clearTrees();
    this.float(x, y, `-${COSTS[type]}`, "#d9785f");
    this.tool = "select";
    this.selected = { kind: "building", id: b.id };
    if (type === "lodge") {
      this.toast(`Lodge is open. Earns $${INCOME_PER_MIN.lodge}/min and unlocks ticket prices.`);
    } else {
      this.toast(
        type === "heli"
          ? `Heli-ski base is open. Experts pay $${HELI.fare} a seat; it costs $${OPERATING_COST_PER_MIN.heli}/min to run.`
          : `${BUILDING_LABEL[type]} is open. Earns $${INCOME_PER_MIN[type]}/min.`,
      );
    }
    return "ok";
  }

  spawnSkier(freeTicket: boolean): void {
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
      x: BASE.x - 260 + Math.random() * 200,
      y: BASE.y + 140 + Math.random() * 60,
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
      // Skiers only come when it looks like the resort can take them:
      // arrivals close the gap to demand over about a minute, then stop.
      const want = this.demand();
      const gap = want - this.skiers.length;
      if (gap > 0) this.spawnAcc += capped * Math.min(gap / 45 + 0.05, this.capacity() * 0.003);
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
    this.skiers = this.skiers.filter((s) => !(s.state === "leaving" && Math.hypot(s.x - this.exit().x, s.y - this.exit().y) < 12 && s.wait <= 0));
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
    return Math.round(this.buildings.reduce((n, b) => n + INCOME_PER_MIN[b.type] * this.buildingFactor(b.type), 0) * util);
  }

  private collectBuildingIncome(dt: number): void {
    if (!this.buildings.length) return;
    const busy = clamp(this.skiers.length / 200, 0, 1);
    const util = (0.35 + 0.65 * busy) * this.staffCoverage();
    for (const b of this.buildings) {
      const gain = (INCOME_PER_MIN[b.type] / 60) * util * this.buildingFactor(b.type) * dt;
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
    if (type !== "school") return 1;
    const need = Math.max(1, this.staffNeeds().instructor);
    return Math.min(1, this.staff.instructor / need);
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
    const foodBuildings =
      this.empireCount("coffee") +
      this.empireCount("sandwich") +
      this.empireCount("shack") +
      this.empireCount("restaurant");
    const lodgings = this.empireCount("hotel") + this.empireCount("condo") + this.empireCount("shop");
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
    const foods = this.buildings.filter((b) => ["coffee", "sandwich", "shack", "restaurant"].includes(b.type));
    foods.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
    return foods[0];
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
      this.walkToward(s, b.x, b.y, 42 * WALK * dt);
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
      this.walkToward(s, q.x, q.y, 46 * WALK * dt);
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
        if (s.runsLeft <= 0 || s.mood < 28) s.state = "leaving";
        else this.goToLift(s);
      }
      return;
    }
    if (s.state === "visit") {
      const b = this.buildings.find((x) => x.type === s.visitType);
      if (!b) {
        this.goToLift(s);
        return;
      }
      this.walkToward(s, b.x, b.y, 44 * WALK * dt);
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
          else s.needFood = 0.08;
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
      const exit = this.exit();
      this.walkToward(s, exit.x, exit.y, 48 * WALK * dt);
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

/** Stable 0..1 value per tree position. */
function treeHash(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/** How forested a spot is (0..1): patchy, thinning out toward the treeline. */
export function forestDensity(x: number, y: number): number {
  const density = noise2(x / 360, y / 300) * 0.75 + noise2(x / 90, y / 110) * 0.35;
  const m = elevationM(x, y);
  const treeline = 1 - smoothstep(TREELINE_M - 250, TREELINE_M + 100 + (noise2(x / 500, y / 500) - 0.5) * 200, m);
  return density * treeline;
}

/** One possible tree per forest cell: where it stands, or null for a clearing. */
function forestCell(gx: number, gy: number): Vec2 | null {
  const x = (gx + noise2(gx * 7.13, gy * 3.71)) * TREE_CELL;
  const y = (gy + noise2(gx * 2.91, gy * 6.37)) * TREE_CELL;
  if (x < 4 || y < 4 || x > WORLD_W - 4 || y > WORLD_H - 4) return null;
  if (forestDensity(x, y) < 0.42) return null;
  if (gradeAt(x, y) > 0.9) return null; // cliffs
  return { x, y };
}
