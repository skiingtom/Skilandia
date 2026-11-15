import { elevation, lerp, nearSegment, noise2, pointOnPolyline, polylineLength, slopeAt } from "./height";
import {
  BUILDING_LABEL,
  BUILDING_MAX,
  Building,
  BuildingType,
  COSTS,
  DIFF,
  EXPANSION_BUILDINGS,
  INCOME_PER_MIN,
  MOUNTAINS,
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
  Lift,
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
} from "./types";

const NAMES = [
  "Ava", "Bo", "Cora", "Drew", "Eli", "Faye", "Gus", "Hana", "Ivy", "Jed",
  "Kai", "Liv", "Mae", "Ned", "Oli", "Pia", "Quin", "Rio", "Sky", "Tess",
];

const JACKETS = ["#c45c4a", "#3a6ea5", "#d98a2b", "#4f8a5b", "#7a4ea3", "#2c3d4f", "#d15a7c", "#1f6f8b"];

const TRAIL_PREFIX = ["Whisper", "Eagle", "Pine", "Goat", "Ridge", "Frost", "Cedar", "Hawk", "Willow", "Storm", "Fox", "Glacier"];
const TRAIL_SUFFIX = ["Run", "Glade", "Alley", "Line", "Trail", "Chute", "Way", "Bowl"];

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function pick<T>(arr: T[]): T {
  return arr[(Math.random() * arr.length) | 0];
}

export function trailCost(length: number): number {
  return Math.round(60 + length * 0.92);
}

export function classifyGrade(dropM: number, lengthM: number): Difficulty {
  const grade = dropM / Math.max(12, lengthM);
  if (grade < 0.16) return 0;
  if (grade < 0.28) return 1;
  if (grade < 0.42) return 2;
  return 3;
}

export function measureTrail(
  points: Vec2[],
  mountain: MountainId = 0,
): { length: number; drop: number; difficulty: Difficulty; cost: number } {
  const length = polylineLength(points);
  const drop =
    elevation(points[0].x, points[0].y, mountain) -
    elevation(points[points.length - 1].x, points[points.length - 1].y, mountain);
  const difficulty = classifyGrade(drop * VERTICAL_M, length * UNIT_M);
  return { length, drop, difficulty, cost: trailCost(length) };
}

interface Snapshot {
  trails: Trail[];
  lift: Lift;
  buildings: Building[];
  trees: Vec2[];
  ticketPrice: number;
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
  lift: Lift;
  buildings: Building[] = [];
  skiers: Skier[] = [];
  trees: Vec2[] = [];
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
  owned: MountainId[] = [0];
  lifetimeEarned = 0;
  wagesToday = 0;
  staff: Record<StaffRole, number> = { patrol: 0, food: 0, lift: 0, delivery: 0, maintenance: 0 };
  private snapshots: Partial<Record<MountainId, Snapshot>> = {};

  constructor() {
    this.lift = {
      name: "Little Hawk T-Bar",
      bottom: { x: 328, y: 118 },
      top: { x: 312, y: 628 },
      carriers: Array.from({ length: 8 }, (_, i) => ({ t: i / 8, skierId: null })),
    };
    this.trails = [
      this.makeTrail("Sunnyside", [
        { x: 328, y: 618 },
        { x: 392, y: 500 },
        { x: 438, y: 360 },
        { x: 412, y: 220 },
        { x: 356, y: 128 },
      ]),
      this.makeTrail("Little Elk", [
        { x: 298, y: 612 },
        { x: 248, y: 490 },
        { x: 236, y: 340 },
        { x: 268, y: 210 },
        { x: 304, y: 126 },
      ]),
      this.makeTrail("Blue Spruce", [
        { x: 500, y: 650 },
        { x: 550, y: 480 },
        { x: 530, y: 320 },
        { x: 460, y: 200 },
        { x: 372, y: 128 },
      ]),
    ];
    this.seedTrees();
    for (let i = 0; i < 7; i++) this.spawnSkier(true);
    this.saveCurrent();
  }

  private makeTrail(name: string, points: Vec2[]): Trail {
    const m = measureTrail(points, this.currentMountain);
    this.usedTrailNames.add(name);
    return { id: this.nextId++, name, points, ...m };
  }

  private seedTrees(): void {
    this.trees = [];
    const mid = this.currentMountain;
    for (let i = 0; i < 420; i++) {
      const x = 18 + noise2(i * 0.37 + mid * 9, 2.2) * (WORLD_W - 36);
      const y = 90 + noise2(i * 0.19 + mid * 4, 8.1) * (WORLD_H - 130);
      const h = elevation(x, y, mid);
      const s = slopeAt(x, y, mid);
      if (h < 0.07 || h > 0.9 || s > 0.012) continue;
      if (this.trails.some((t) => distToTrail(t, x, y) < 16)) continue;
      if (nearSegment(this.lift.bottom.x, this.lift.bottom.y, this.lift.top.x, this.lift.top.y, x, y, 22)) continue;
      this.trees.push({ x, y });
    }
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

  variety(): { counts: number[]; score: number } {
    const counts = [0, 0, 0, 0];
    for (const t of this.trails) counts[t.difficulty]++;
    const score =
      Math.min(counts[0], 2) / 2 * 0.28 +
      Math.min(counts[1], 2) / 2 * 0.26 +
      Math.min(counts[2], 1) * 0.24 +
      Math.min(counts[3], 1) * 0.22;
    return { counts, score };
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
    return Math.min(1.4, n);
  }

  fairPrice(): number {
    return Math.round(34 + this.amenityScore() * 38 + this.variety().score * 22);
  }

  attraction(): number {
    const fair = this.fairPrice();
    const priceFactor =
      this.ticketPrice <= fair ? 1 : clamp(1 - (this.ticketPrice - fair) / (fair + 8), 0.18, 1);
    const queue = this.skiers.filter((s) => s.state === "queue").length;
    const queueFactor = queue > 9 ? 0.72 : queue > 6 ? 0.88 : 1;
    return clamp(0.32 + this.variety().score * 0.42 + this.amenityScore() * 0.34, 0.15, 1.15) * priceFactor * queueFactor;
  }

  has(type: BuildingType): boolean {
    return this.buildings.some((b) => b.type === type);
  }

  count(type: BuildingType): number {
    return this.buildings.filter((b) => b.type === type).length;
  }

  goals(): Goal[] {
    const ridge = MOUNTAINS[1];
    const twin = MOUNTAINS[2];
    return [
      { id: "lodge", text: `Build a lodge ($${COSTS.lodge.toLocaleString()})`, done: this.has("lodge") },
      { id: "shack", text: "Place a sugar shack on a run", done: this.empireCount("shack") > 0 },
      { id: "black", text: "Cut a black-diamond run", done: this.trails.some((t) => t.difficulty >= 2) },
      {
        id: "ridge",
        text: `Earn $${ridge.profitToUnlock.toLocaleString()} then buy Cedar Ridge`,
        done: this.owned.includes(1),
      },
      {
        id: "patrol",
        text: "Hire ski patrol (required after the starter hill)",
        done: this.staff.patrol > 0 || !this.staffRequired(),
      },
      {
        id: "twin",
        text: `Grow into Twin Peaks ($${twin.profitToUnlock.toLocaleString()} earned)`,
        done: this.owned.includes(2),
      },
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
    if (this.ticketPrice > this.fairPrice() + 8) out.push("Tickets feel expensive for what is here.");
    if (this.has("lodge") && !this.has("coffee") && !this.has("sandwich") && this.count("shack") === 0) {
      out.push("Hungry skiers wish there was food.");
    }
    if (this.staffRequired()) {
      const need = this.staffNeeds();
      for (const role of STAFF_ROLES) {
        if (this.staff[role] < need[role]) {
          out.push(`Short on ${role === "patrol" ? "ski patrol" : role}. Hire more staff.`);
          break;
        }
      }
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
    if (tool !== "select" && tool !== "cut" && EXPANSION_BUILDINGS.includes(tool) && !this.expansionUnlocked()) {
      this.toast("Hotels, shops, condos and patrol unlock after you buy the next mountain.", true);
      return;
    }
    if (tool !== "select" && tool !== "cut" && this.count(tool) >= BUILDING_MAX[tool]) {
      this.toast(`That's as many ${BUILDING_LABEL[tool].toLowerCase()}s as this hill needs.`, true);
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
  }

  draftInfo(): { length: number; drop: number; difficulty: Difficulty; cost: number } | null {
    if (this.draft.length < 2) return this.draft.length === 1 ? { length: 0, drop: 0, difficulty: 0, cost: 60 } : null;
    return measureTrail(this.draft, this.currentMountain);
  }

  private villageOk(x: number, y: number): boolean {
    return y > 46 && y < 168 && x > 150 && x < 500;
  }

  canPlace(type: BuildingType, x: number, y: number): string | null {
    if (EXPANSION_BUILDINGS.includes(type) && !this.expansionUnlocked()) {
      return "Buy the next mountain to unlock this.";
    }
    if (this.count(type) >= BUILDING_MAX[type]) return `No more ${BUILDING_LABEL[type].toLowerCase()}s on this hill.`;
    const anywhere = PLACE_ANYWHERE.includes(type);
    const midMountain = PLACE_MOUNTAIN.includes(type);
    if (!anywhere && !midMountain && !this.villageOk(x, y)) return "Build down in the base village.";
    if (midMountain && !anywhere && y < 70) return "Put this on the mountain, not in the parking lot.";
    if (x < 12 || x > WORLD_W - 12 || y < 24 || y > WORLD_H - 12) return "That's off the property.";
    const minGap = type === "shack" ? 22 : 38;
    if (this.buildings.some((b) => Math.hypot(b.x - x, b.y - y) < minGap)) return "Too close to another building.";
    if (type !== "shack" && this.trails.some((t) => distToTrail(t, x, y) < 18)) return "Don't plant a building on a run.";
    if (type === "shack" && this.trails.some((t) => distToTrail(t, x, y) < 8)) return "Keep the shack beside the run, not in the fall line.";
    if (nearSegment(this.lift.bottom.x, this.lift.bottom.y, this.lift.top.x, this.lift.top.y, x, y, 26)) {
      return "Keep clear of the T-bar.";
    }
    if (this.money < COSTS[type]) return `Need $${(COSTS[type] - this.money).toLocaleString()} more.`;
    return null;
  }

  click(x: number, y: number): "ok" | "shake" | "none" {
    if (!this.managing) return "none";
    if (this.tool === "cut") return this.clickCut(x, y);
    if (this.tool !== "select") return this.clickBuild(this.tool, x, y);
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
    if (nearSegment(this.lift.bottom.x, this.lift.bottom.y, this.lift.top.x, this.lift.top.y, x, y, 16) && 14 < bestD) {
      best = { kind: "lift", id: 0 };
    }
    return best;
  }

  selectionText(): { title: string; body: string } {
    const sel = this.selected;
    if (!sel || sel.kind === "hill") {
      return {
        title: "Little Hawk Hill",
        body: `${MOUNTAINS[this.currentMountain].name}. Lifetime take $${Math.round(this.lifetimeEarned).toLocaleString()}. Tickets plus shops; sugar shacks can sit beside the runs.`,
      };
    }
    if (sel.kind === "trail") {
      const t = this.trails.find((x) => x.id === sel.id);
      if (!t) return { title: "Trail", body: "" };
      const d = DIFF[t.difficulty];
      return {
        title: `${d.mark} ${t.name}`,
        body: `${d.name} · ${Math.round(t.length * UNIT_M)} m long · ${Math.round(t.drop * VERTICAL_M)} m drop. Skiers pick runs that match their nerve.`,
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
      };
      return {
        title: BUILDING_LABEL[b.type],
        body: `Earns $${INCOME_PER_MIN[b.type]}/min when the hill is busy. ${extra[b.type]}`,
      };
    }
    if (sel.kind === "lift") {
      const q = this.skiers.filter((s) => s.state === "queue").length;
      return {
        title: this.lift.name,
        body: `Carries skiers to the unload. ${q} waiting in line. This slice has one lift.`,
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
      if (y < 240) {
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
    const info = measureTrail(this.draft, this.currentMountain);
    if (info.length < 90) {
      this.toast("That run is too short to groom.", true);
      return "shake";
    }
    if (this.money < info.cost) {
      this.toast(`Need $${(info.cost - this.money).toLocaleString()} more to cut this.`, true);
      return "shake";
    }
    this.money -= info.cost;
    const name = this.freshTrailName();
    const trail = this.makeTrail(name, this.draft.map((p) => ({ ...p })));
    this.trails.push(trail);
    this.trees = this.trees.filter((t) => distToTrail(trail, t.x, t.y) >= 15);
    this.float(this.draft[0].x, this.draft[0].y, `-${info.cost}`, "#d9785f");
    this.toast(`${DIFF[info.difficulty].name} run “${name}” is open.`);
    this.draft = [];
    this.tool = "select";
    this.selected = { kind: "trail", id: trail.id };
    return "ok";
  }

  private freshTrailName(): string {
    for (let i = 0; i < 40; i++) {
      const name = `${pick(TRAIL_PREFIX)} ${pick(TRAIL_SUFFIX)}`;
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
    this.float(x, y, `-${COSTS[type]}`, "#d9785f");
    this.tool = "select";
    this.selected = { kind: "building", id: b.id };
    if (type === "lodge") {
      this.toast(`Lodge is open. Earns $${INCOME_PER_MIN.lodge}/min and unlocks ticket prices.`);
    } else {
      this.toast(`${BUILDING_LABEL[type]} is open. Earns $${INCOME_PER_MIN[type]}/min.`);
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
      x: 220 + Math.random() * 200,
      y: 18 + Math.random() * 16,
      state: "arriving",
      trailId: null,
      dist: 0,
      wait: 0,
      runsLeft: 2 + ((Math.random() * 3) | 0),
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
        this.toast(`Day ${this.day} on Little Hawk Hill.`);
      }
      this.spawnAcc += capped * (0.042 + this.attraction() * 0.14);
      while (this.spawnAcc > 1) {
        this.spawnAcc -= 1;
        if (this.skiers.length < 36) this.spawnSkier(false);
      }
      this.collectBuildingIncome(capped);
      this.collectRemoteIncome(capped);
      this.payWages(capped);
    }
    this.stepLift(capped);
    for (const s of this.skiers) this.stepSkier(s, capped);
    this.skiers = this.skiers.filter((s) => !(s.state === "leaving" && s.y < 8 && s.wait <= 0));
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
    const busy = clamp(this.skiers.length / 16, 0, 1);
    const util = (0.35 + 0.65 * busy) * this.staffCoverage();
    return Math.round(this.buildings.reduce((n, b) => n + INCOME_PER_MIN[b.type], 0) * util);
  }

  private collectBuildingIncome(dt: number): void {
    if (!this.buildings.length) return;
    const busy = clamp(this.skiers.length / 16, 0, 1);
    const util = (0.35 + 0.65 * busy) * this.staffCoverage();
    for (const b of this.buildings) {
      const gain = (INCOME_PER_MIN[b.type] / 60) * util * dt;
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

  private collectRemoteIncome(dt: number): void {
    const factor = 0.55 * this.staffCoverage();
    for (const id of this.owned) {
      if (id === this.currentMountain) continue;
      const snap = this.snapshots[id];
      if (!snap) continue;
      for (const b of snap.buildings) {
        const gain = (INCOME_PER_MIN[b.type] / 60) * factor * dt;
        this.money += gain;
        this.shopIncomeToday += gain;
        this.incomeToday += gain;
        this.lifetimeEarned += gain;
      }
    }
  }

  private payWages(dt: number): void {
    if (!this.staffRequired()) return;
    for (const role of STAFF_ROLES) {
      const w = (STAFF_WAGE_PER_MIN[role] / 60) * this.staff[role] * dt;
      this.money -= w;
      this.wagesToday += w;
    }
  }

  staffRequired(): boolean {
    return this.owned.length > 1;
  }

  expansionUnlocked(): boolean {
    return this.owned.length > 1;
  }

  empireCount(type: BuildingType): number {
    let n = this.count(type);
    for (const id of this.owned) {
      if (id === this.currentMountain) continue;
      n += this.snapshots[id]?.buildings.filter((b) => b.type === type).length ?? 0;
    }
    return n;
  }

  staffNeeds(): Record<StaffRole, number> {
    if (!this.staffRequired()) {
      return { patrol: 0, food: 0, lift: 0, delivery: 0, maintenance: 0 };
    }
    const foodBuildings =
      this.empireCount("coffee") +
      this.empireCount("sandwich") +
      this.empireCount("shack") +
      this.empireCount("restaurant");
    const lodgings = this.empireCount("hotel") + this.empireCount("condo") + this.empireCount("shop");
    const trails = this.trails.length + Object.values(this.snapshots).reduce((n, s) => n + (s?.trails.length ?? 0), 0);
    return {
      patrol: Math.max(1, Math.ceil(this.skiers.length / 10) + this.owned.length - 1),
      food: Math.max(foodBuildings > 0 ? 1 : 0, foodBuildings),
      lift: this.owned.length,
      delivery: Math.max(foodBuildings + lodgings > 0 ? 1 : 0, Math.ceil((foodBuildings + lodgings) / 2)),
      maintenance: Math.max(1, Math.ceil(trails / 5) + this.owned.length),
    };
  }

  staffCoverage(): number {
    if (!this.staffRequired()) return 1;
    const need = this.staffNeeds();
    let got = 0;
    let want = 0;
    for (const role of STAFF_ROLES) {
      want += Math.max(1, need[role]);
      got += Math.min(this.staff[role], Math.max(1, need[role]));
    }
    return want === 0 ? 1 : clamp(got / want, 0.35, 1);
  }

  hire(role: StaffRole): void {
    if (!this.staffRequired()) {
      this.toast("Little Hawk is family-run. Staff starts when you buy the next mountain.", true);
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

  mountainStatus(id: MountainId): { owned: boolean; canUnlock: boolean; canBuy: boolean; missing: number } {
    const spec = MOUNTAINS[id];
    const owned = this.owned.includes(id);
    const canUnlock = this.lifetimeEarned >= spec.profitToUnlock;
    const canBuy = !owned && canUnlock && this.money >= spec.buyCost && (id === 0 || this.owned.includes((id - 1) as MountainId));
    const missing = Math.max(0, spec.profitToUnlock - this.lifetimeEarned);
    return { owned, canUnlock, canBuy, missing };
  }

  buyMountain(id: MountainId): boolean {
    const spec = MOUNTAINS[id];
    const st = this.mountainStatus(id);
    if (st.owned) {
      this.switchMountain(id);
      return true;
    }
    if (id > 0 && !this.owned.includes((id - 1) as MountainId)) {
      this.toast("Grow the current mountain first.", true);
      return false;
    }
    if (!st.canUnlock) {
      this.toast(`Earn $${st.missing.toLocaleString()} more profit before ${spec.name} is for sale.`, true);
      return false;
    }
    if (this.money < spec.buyCost) {
      this.toast(`Need $${(spec.buyCost - this.money).toLocaleString()} more to buy ${spec.name}.`, true);
      return false;
    }
    this.money -= spec.buyCost;
    this.saveCurrent();
    this.owned.push(id);
    this.currentMountain = id;
    this.installMountain(id);
    this.toast(`${spec.name} is yours. Hire ski patrol and a crew — this is a real ski area now.`);
    return true;
  }

  switchMountain(id: MountainId): void {
    if (!this.owned.includes(id) || id === this.currentMountain) return;
    this.saveCurrent();
    this.currentMountain = id;
    const snap = this.snapshots[id];
    if (!snap) return;
    this.trails = snap.trails;
    this.lift = snap.lift;
    this.buildings = snap.buildings;
    this.trees = snap.trees;
    this.ticketPrice = snap.ticketPrice;
    this.skiers = [];
    this.draft = [];
    this.tool = "select";
    this.selected = null;
    for (let i = 0; i < 8; i++) this.spawnSkier(true);
    this.toast(`Now managing ${MOUNTAINS[id].name}.`);
  }

  private saveCurrent(): void {
    this.snapshots[this.currentMountain] = {
      trails: this.trails,
      lift: this.lift,
      buildings: this.buildings,
      trees: this.trees,
      ticketPrice: this.ticketPrice,
    };
  }

  private installMountain(id: MountainId): void {
    this.buildings = [];
    this.skiers = [];
    this.draft = [];
    this.tool = "select";
    this.selected = null;
    this.ticketPrice = START_TICKET;
    if (id === 1) {
      this.lift = {
        name: "Cedar Ridge T-Bar",
        bottom: { x: 330, y: 112 },
        top: { x: 300, y: 660 },
        carriers: Array.from({ length: 9 }, (_, i) => ({ t: i / 9, skierId: null })),
      };
      this.trails = [
        this.makeTrail("Cabin Run", [
          { x: 318, y: 648 },
          { x: 400, y: 480 },
          { x: 430, y: 300 },
          { x: 360, y: 130 },
        ]),
        this.makeTrail("Hemlock", [
          { x: 288, y: 650 },
          { x: 220, y: 470 },
          { x: 210, y: 280 },
          { x: 290, y: 124 },
        ]),
        this.makeTrail("Upper Pitch", [
          { x: 250, y: 700 },
          { x: 180, y: 520 },
          { x: 150, y: 330 },
          { x: 240, y: 140 },
        ]),
      ];
    } else {
      this.lift = {
        name: "Saddle T-Bar",
        bottom: { x: 320, y: 108 },
        top: { x: 318, y: 640 },
        carriers: Array.from({ length: 10 }, (_, i) => ({ t: i / 10, skierId: null })),
      };
      this.trails = [
        this.makeTrail("West Peak", [
          { x: 200, y: 700 },
          { x: 170, y: 500 },
          { x: 190, y: 300 },
          { x: 260, y: 130 },
        ]),
        this.makeTrail("East Peak", [
          { x: 460, y: 710 },
          { x: 500, y: 500 },
          { x: 470, y: 300 },
          { x: 380, y: 128 },
        ]),
        this.makeTrail("Saddle Green", [
          { x: 330, y: 620 },
          { x: 350, y: 400 },
          { x: 340, y: 220 },
          { x: 320, y: 122 },
        ]),
        this.makeTrail("Chute", [
          { x: 150, y: 720 },
          { x: 120, y: 480 },
          { x: 160, y: 260 },
          { x: 250, y: 132 },
        ]),
      ];
    }
    this.seedTrees();
    for (let i = 0; i < 10; i++) this.spawnSkier(true);
    this.saveCurrent();
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
    const speed = 0.072;
    for (const c of this.lift.carriers) {
      const before = c.t;
      c.t += dt * speed;
      if (before < 0.06 && c.t >= 0.06 && c.skierId == null) {
        const next = this.skiers.find((s) => s.state === "queue");
        if (next) {
          c.skierId = next.id;
          next.state = "riding";
          next.wait = 0;
        }
      }
      if (c.t >= 0.97 && c.skierId != null) {
        const s = this.skiers.find((k) => k.id === c.skierId);
        if (s) {
          s.x = this.lift.top.x + (Math.random() * 10 - 5);
          s.y = this.lift.top.y;
          s.state = "toTrail";
          s.trailId = this.chooseTrail(s)?.id ?? null;
          s.dist = 0;
        }
        c.skierId = null;
      }
      if (c.t >= 1) c.t -= 1;
    }
  }

  private chooseTrail(s: Skier): Trail | null {
    const ranked = [...this.trails].sort((a, b) => {
      const sa = trailScore(s.skill, a.difficulty);
      const sb = trailScore(s.skill, b.difficulty);
      return sb - sa;
    });
    const options = ranked.filter((t) => trailScore(s.skill, t.difficulty) > 0.15);
    if (!options.length) return ranked[0] ?? null;
    const hikeOk = options.filter((t) => Math.hypot(t.points[0].x - this.lift.top.x, t.points[0].y - this.lift.top.y) < 140);
    const pool = hikeOk.length ? hikeOk : options;
    return pool[(Math.random() * Math.min(3, pool.length)) | 0];
  }

  private booth(): Vec2 {
    return { x: 352, y: 92 };
  }

  private stepSkier(s: Skier, dt: number): void {
    s.needBath = clamp(s.needBath + dt * 0.015, 0, 1.2);
    s.needFood = clamp(s.needFood + dt * 0.012, 0, 1.2);
    if (s.bubbleT > 0) s.bubbleT -= dt;
    else s.bubble = null;
    if (s.state === "arriving") {
      const b = this.booth();
      this.walkToward(s, b.x, b.y, 42 * dt);
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
        this.float(s.x, s.y, `+$${this.ticketPrice}`);
        this.sfx.push("cash");
      }
      s.state = "toLift";
      return;
    }
    if (s.state === "toLift") {
      const q = this.queueSlot(s);
      this.walkToward(s, q.x, q.y, 46 * dt);
      if (Math.hypot(s.x - q.x, s.y - q.y) < 8) s.state = "queue";
      return;
    }
    if (s.state === "queue") {
      const q = this.queueSlot(s);
      this.walkToward(s, q.x, q.y, 30 * dt);
      s.wait += dt;
      if (s.wait > 28) {
        s.mood -= 8;
        s.wait = 20;
      }
      return;
    }
    if (s.state === "riding") {
      const c = this.lift.carriers.find((k) => k.skierId === s.id);
      const t = c?.t ?? 0.5;
      s.x = lerp(this.lift.bottom.x, this.lift.top.x, t);
      s.y = lerp(this.lift.bottom.y, this.lift.top.y, t);
      return;
    }
    if (s.state === "toTrail") {
      const trail = this.trails.find((t) => t.id === s.trailId) ?? this.chooseTrail(s);
      if (!trail) {
        s.state = "leaving";
        return;
      }
      s.trailId = trail.id;
      const start = trail.points[0];
      this.walkToward(s, start.x, start.y, 50 * dt);
      if (Math.hypot(s.x - start.x, s.y - start.y) < 10) {
        s.state = "skiing";
        s.dist = 0;
        const mismatch = trail.difficulty - s.skill;
        if (mismatch > 1) s.mood -= 12;
        else if (mismatch === 0) s.mood += 4;
        else if (mismatch < 0) s.mood -= 2;
      }
      return;
    }
    if (s.state === "skiing") {
      const trail = this.trails.find((t) => t.id === s.trailId);
      if (!trail) {
        s.state = "toLift";
        return;
      }
      const grade = trail.drop / Math.max(40, trail.length);
      const speed = 46 + trail.difficulty * 16 + grade * 220 - Math.max(0, trail.difficulty - s.skill) * 12;
      s.dist += speed * dt;
      const p = pointOnPolyline(trail.points, s.dist);
      s.x = p.x + Math.sin(s.dist * 0.08 + s.id) * 3.2;
      s.y = p.y;
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
        else s.state = "toLift";
      }
      return;
    }
    if (s.state === "visit") {
      const b = this.buildings.find((x) => x.type === s.visitType);
      if (!b) {
        s.state = "toLift";
        return;
      }
      this.walkToward(s, b.x, b.y, 44 * dt);
      if (Math.hypot(s.x - b.x, s.y - b.y) < 12) {
        s.wait += dt;
        if (s.wait > 1.6) {
          if (s.visitType === "restroom") s.needBath = 0.05;
          else s.needFood = 0.08;
          s.mood += 8;
          s.wait = 0;
          s.visitType = null;
          s.state = s.runsLeft <= 0 ? "leaving" : "toLift";
        }
      }
      return;
    }
    if (s.state === "leaving") {
      this.walkToward(s, 200 + (s.id % 7) * 30, 10, 48 * dt);
      s.wait = 0;
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
    const queued = this.skiers.filter((k) => k.state === "queue" || (k.state === "toLift" && k.paid));
    queued.sort((a, b) => a.id - b.id);
    const i = Math.max(0, queued.findIndex((k) => k.id === s.id));
    return { x: this.lift.bottom.x - 8 - (i % 6) * 9, y: this.lift.bottom.y - 8 - Math.floor(i / 6) * 12 };
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
