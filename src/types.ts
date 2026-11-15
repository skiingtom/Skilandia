export type Difficulty = 0 | 1 | 2 | 3;
export type MountainId = 0 | 1 | 2;
export type BuildingType =
  | "lodge"
  | "restroom"
  | "coffee"
  | "sandwich"
  | "shack"
  | "hotel"
  | "restaurant"
  | "shop"
  | "condo"
  | "patrol"
  | "school"
  | "heli";
export type LiftType = "carpet" | "tbar" | "double" | "quad" | "six" | "gondola";
export type TrailKind = "slope" | "slalom" | "moguls" | "park" | "glades";
export type FeatureType = "jump" | "rail" | "box" | "halfpipe";
export type Tool =
  | "select"
  | "cut"
  | "move"
  | BuildingType
  | `lift:${LiftType}`
  | `trail:${TrailKind}`
  | `feature:${FeatureType}`;
export type StaffRole = "patrol" | "food" | "lift" | "delivery" | "maintenance" | "instructor";
export type SkierState =
  | "arriving"
  | "booth"
  | "toLift"
  | "queue"
  | "riding"
  | "toTrail"
  | "skiing"
  | "visit"
  | "leaving"
  | "heliWait"
  | "heli";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Trail {
  id: number;
  name: string;
  points: Vec2[];
  difficulty: Difficulty;
  length: number;
  drop: number;
  kind: TrailKind;
}

/** A terrain-park feature or jump sitting on the snow. */
export interface Feature {
  id: number;
  type: FeatureType;
  x: number;
  y: number;
  /** Direction skiers travel over it (radians, in map x/y). */
  angle: number;
  trailId: number | null;
}

export interface Lift {
  id: number;
  type: LiftType;
  name: string;
  bottom: Vec2;
  top: Vec2;
  carriers: Carrier[];
}

export interface Carrier {
  t: number;
  riders: number[];
}

export interface Building {
  id: number;
  type: BuildingType;
  x: number;
  y: number;
  earnAcc: number;
  earnTimer: number;
}

export interface Skier {
  id: number;
  name: string;
  skill: Difficulty;
  color: string;
  x: number;
  y: number;
  state: SkierState;
  trailId: number | null;
  liftId: number | null;
  rideT: number;
  /** Favourite kind of run. */
  likes: TrailKind;
  /** Seconds of airtime left after hitting a jump or feature. */
  air: number;
  lesson: boolean;
  /** Already flown a heli-ski trip today. */
  heliDone: boolean;
  dist: number;
  wait: number;
  runsLeft: number;
  runsDone: number;
  mood: number;
  paid: boolean;
  needBath: number;
  needFood: number;
  visitType: BuildingType | null;
  bubble: string | null;
  bubbleT: number;
}

export interface Fx {
  x: number;
  y: number;
  text: string;
  life: number;
  color: string;
}

export interface Toast {
  id: number;
  text: string;
  bad: boolean;
  life: number;
}

export interface Goal {
  id: string;
  text: string;
  done: boolean;
}

/** The maps were 640 x 820; everything scales from that. */
export const MAP_SCALE = 2.5;
export const WORLD_W = 640 * MAP_SCALE;
export const WORLD_H = 820 * MAP_SCALE;
export const VERTICAL_M = 128 * MAP_SCALE;
export const UNIT_M = 0.62;

export const MOUNTAINS: {
  id: MountainId;
  name: string;
  blurb: string;
  profitToUnlock: number;
  buyCost: number;
  staffRequired: boolean;
}[] = [
  {
    id: 0,
    name: "Little Hawk Hill",
    blurb: "The starter hill. Family-run — no payroll yet.",
    profitToUnlock: 0,
    buyCost: 0,
    staffRequired: false,
  },
  {
    id: 1,
    name: "Cedar Ridge",
    blurb: "A real mountain. Ski patrol and staff are required.",
    profitToUnlock: 6500,
    buyCost: 8500,
    staffRequired: true,
  },
  {
    id: 2,
    name: "Twin Peaks",
    blurb: "The finale: two mountains, one huge ski resort.",
    profitToUnlock: 22000,
    buyCost: 28000,
    staffRequired: true,
  },
];

export const COSTS: Record<BuildingType, number> = {
  lodge: 2900,
  restroom: 480,
  coffee: 920,
  sandwich: 1050,
  shack: 620,
  hotel: 12000,
  restaurant: 4800,
  shop: 3200,
  condo: 9500,
  patrol: 1600,
  school: 3800,
  heli: 45000,
};

/** Dollars per minute at a busy hill, 1× speed. */
export const INCOME_PER_MIN: Record<BuildingType, number> = {
  restroom: 24,
  patrol: 8,
  lodge: 55,
  shack: 42,
  coffee: 95,
  shop: 120,
  sandwich: 140,
  restaurant: 175,
  condo: 200,
  hotel: 220,
  school: 150,
  heli: 0,
};

export const PLACE_ANYWHERE: BuildingType[] = ["shack"];
export const PLACE_MOUNTAIN: BuildingType[] = ["shack", "patrol"];

export const BUILDING_MAX: Record<BuildingType, number> = {
  lodge: 1,
  restroom: 3,
  coffee: 1,
  sandwich: 1,
  shack: 8,
  hotel: 2,
  restaurant: 2,
  shop: 3,
  condo: 3,
  patrol: 2,
  school: 1,
  heli: 1,
};

export const EXPANSION_BUILDINGS: BuildingType[] = ["hotel", "restaurant", "shop", "condo", "patrol"];

export const STAFF_ROLES: StaffRole[] = ["patrol", "instructor", "food", "lift", "delivery", "maintenance"];

export const STAFF_LABEL: Record<StaffRole, string> = {
  patrol: "Ski patrol",
  food: "Food service",
  lift: "Lift attendants",
  delivery: "Delivery",
  maintenance: "Maintenance",
  instructor: "Ski instructors",
};

export const STAFF_WAGE_PER_MIN: Record<StaffRole, number> = {
  patrol: 18,
  food: 14,
  lift: 16,
  delivery: 12,
  maintenance: 15,
  instructor: 15,
};

export const START_MONEY = 2200;
export const START_TICKET = 42;

export const DIFF = [
  { name: "Green", color: "#3cb172", mark: "●" },
  { name: "Blue", color: "#3b82d6", mark: "■" },
  { name: "Black", color: "#1b1b1b", mark: "◆" },
  { name: "Double black", color: "#0d0d0d", mark: "◆◆" },
] as const;

export const BUILDING_LABEL: Record<BuildingType, string> = {
  lodge: "Lodge",
  restroom: "Restroom",
  coffee: "Coffee shop",
  sandwich: "Sandwich shop",
  shack: "Sugar shack",
  hotel: "Hotel",
  restaurant: "Restaurant",
  shop: "Shop",
  condo: "Condo",
  patrol: "Ski patrol hut",
  school: "Ski school",
  heli: "Heli-ski base",
};

/** Height in world units of one unit of elevation, as drawn (true classifier scale × 1.3). */
export const TERRAIN_SCALE = (VERTICAL_M / UNIT_M) * 1.3;

export interface LiftSpec {
  label: string;
  short: string;
  /** Riders per carrier (chair, bar, cabin). A carpet carries one per slot. */
  seats: number;
  /** World units per second. */
  speed: number;
  /** World units between carriers. */
  spacing: number;
  baseCost: number;
  costPerUnit: number;
  minLength: number;
  maxLength: number;
  /** Surface lifts drag skiers over the snow: the ground must climb the whole way. */
  surface: boolean;
  /** Steepest pitch the line may cross (game grade, drop m / run m). */
  maxGrade: number;
  /** Height of cable / chairs above the ground at towers. */
  towerH: number;
  blurb: string;
}

export const LIFT_TYPES: LiftType[] = ["carpet", "tbar", "double", "quad", "six", "gondola"];

export const LIFT_SPECS: Record<LiftType, LiftSpec> = {
  carpet: {
    label: "Magic carpet",
    short: "Carpet",
    seats: 1,
    speed: 20,
    spacing: 7,
    baseCost: 500,
    costPerUnit: 3,
    minLength: 40,
    maxLength: 150,
    surface: true,
    maxGrade: 0.2,
    towerH: 0,
    blurb: "Conveyor belt for beginners. Short, and only up gentle green terrain.",
  },
  tbar: {
    label: "T-bar",
    short: "T-bar",
    seats: 2,
    speed: 60,
    spacing: 30,
    baseCost: 1400,
    costPerUnit: 3,
    minLength: 90,
    maxLength: 1300,
    surface: true,
    maxGrade: 0.45,
    towerH: 9,
    blurb: "Drags two skiers up the snow. The ground has to climb the whole way.",
  },
  double: {
    label: "Double chair",
    short: "Double",
    seats: 2,
    speed: 60,
    spacing: 30,
    baseCost: 3500,
    costPerUnit: 5,
    minLength: 120,
    maxLength: 1900,
    surface: false,
    maxGrade: 9,
    towerH: 15,
    blurb: "Classic two-seat chair. Flies over any terrain.",
  },
  quad: {
    label: "Quad chair",
    short: "Quad",
    seats: 4,
    speed: 80,
    spacing: 36,
    baseCost: 6000,
    costPerUnit: 7,
    minLength: 150,
    maxLength: 2300,
    surface: false,
    maxGrade: 9,
    towerH: 17,
    blurb: "Four across, faster haul. Shorter lift lines.",
  },
  six: {
    label: "Covered six-pack",
    short: "Six-pack",
    seats: 6,
    speed: 95,
    spacing: 42,
    baseCost: 10000,
    costPerUnit: 9,
    minLength: 180,
    maxLength: 2600,
    surface: false,
    maxGrade: 9,
    towerH: 19,
    blurb: "Six-seat chair with a bubble cover. Happy, warm skiers.",
  },
  gondola: {
    label: "8-person gondola",
    short: "Gondola",
    seats: 8,
    speed: 110,
    spacing: 54,
    baseCost: 16000,
    costPerUnit: 12,
    minLength: 220,
    maxLength: 3200,
    surface: false,
    maxGrade: 9,
    towerH: 24,
    blurb: "Enclosed eight-seat cabins. The fastest, longest lift.",
  },
};

export function liftCost(type: LiftType, length: number): number {
  const s = LIFT_SPECS[type];
  return Math.round((s.baseCost + s.costPerUnit * length) / 10) * 10;
}

export const MAX_LIFTS = 6;

export const TRAIL_KINDS: TrailKind[] = ["slope", "slalom", "moguls", "park", "glades"];

export const TRAIL_KIND_SPEC: Record<
  TrailKind,
  { label: string; blurb: string; costMul: number; speedMul: number; width: number; diffBump: number }
> = {
  slope: { label: "Groomed slope", blurb: "A regular groomed run.", costMul: 1, speedMul: 1, width: 10, diffBump: 0 },
  slalom: { label: "Slalom course", blurb: "Gates down the run. Racers love it.", costMul: 1.3, speedMul: 0.9, width: 10, diffBump: 0 },
  moguls: { label: "Mogul run", blurb: "Left ungroomed. Bumps rate it one notch harder.", costMul: 1.15, speedMul: 0.72, width: 10, diffBump: 1 },
  park: { label: "Terrain park", blurb: "Wide run for jumps, rails, boxes and a halfpipe.", costMul: 1.5, speedMul: 0.85, width: 18, diffBump: 0 },
  glades: {
    label: "Glades",
    blurb: "Draw it through the forest: trees are thinned, not cleared. Tree skiing rates one notch harder.",
    costMul: 0.7,
    speedMul: 0.65,
    width: 26,
    diffBump: 1,
  },
};

export const FEATURE_TYPES: FeatureType[] = ["jump", "rail", "box", "halfpipe"];

export const FEATURE_SPEC: Record<FeatureType, { label: string; cost: number; parkOnly: boolean; blurb: string }> = {
  jump: { label: "Jump", cost: 300, parkOnly: false, blurb: "A kicker. Goes on any run — slope, park, glades, anything." },
  rail: { label: "Rail", cost: 450, parkOnly: true, blurb: "Grind rail. Terrain parks only." },
  box: { label: "Box", cost: 350, parkOnly: true, blurb: "Wide fun-box. Terrain parks only." },
  halfpipe: { label: "Halfpipe", cost: 2400, parkOnly: true, blurb: "A big pipe. Terrain parks only." },
};

/** Fee to move a building, as a share of its price. */
export const MOVE_FEE = 0.25;

/** Running costs per minute (fuel, pilots, insurance), charged whether busy or not. */
export const OPERATING_COST_PER_MIN: Partial<Record<BuildingType, number>> = {
  heli: 180,
};

/** Heli-skiing: seats per flight, fare per seat, fuel per flight, minutes are game seconds. */
export const HELI = {
  seats: 4,
  fare: 340,
  fuelPerFlight: 140,
  /** Seconds the drop-and-ski trip lasts (out of sight, off the map). */
  tripTime: 34,
  /** Seconds the pilot waits for a full load before going with fewer. */
  maxWait: 10,
};
