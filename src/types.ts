import { TERRAIN_CELL_M, TERRAIN_COLS, TERRAIN_ROWS } from "./terrain-data";

export type Difficulty = 0 | 1 | 2 | 3;
export type MountainId = 0 | 1 | 2;
export type BuildingType =
  | "parkingSmall"
  | "parkingLarge"
  | "garage"
  | "lodge"
  | "restroom"
  | "coffee"
  | "sandwich"
  | "shack"
  | "cafeteria"
  | "bar"
  | "hotel"
  | "restaurant"
  | "shop"
  | "condo"
  | "hostel"
  | "spa"
  | "patrol"
  | "clinic"
  | "rental"
  | "school"
  | "cabinOffice"
  | "cabin"
  | "heli";
export type LiftType = "carpet" | "tbar" | "double" | "quad" | "six" | "gondola";
export type TrailKind = "slope" | "slalom" | "moguls" | "park" | "glades";
export type FeatureType = "jump" | "rail" | "box" | "halfpipe";
export type Tool =
  | "select"
  | "cut"
  | "road"
  | "demolish"
  | "clearTrees"
  | "plantTrees"
  | "shape"
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
  /** Facing (radians in map x/y): parking lines up with the road it opens onto. */
  angle?: number;
}

export interface Skier {
  id: number;
  /** Where this skier parked: they arrive from here and walk back to leave. */
  lot: Vec2;
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
  /** Game time the skier joined their current lift line (lines are first come, first served). */
  joinT: number;
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
/**
 * One big real landscape, built from a topographic map (src/terrain-data.ts).
 * 1 world unit = 1 metre; x runs east, y runs north.
 */
export const MAP_SCALE = 1;
export const UNIT_M = 1;
export const WORLD_W = TERRAIN_COLS * TERRAIN_CELL_M;
export const WORLD_H = TERRAIN_ROWS * TERRAIN_CELL_M;
/** Elevation 0 in normalised units is this many metres above sea level... */
export const BASE_ELEV_M = 500;
/** ...and elevation 1 is this much higher. */
export const VERTICAL_M = 2300;

/** Where the resort starts: the valley floor by the lake. */
export const BASE = { x: 13650, y: 7672 };

/**
 * The goal: conquer the mountain. Each peak is conquered when a lift's top
 * station reaches its summit. Positions are approximate (from the map
 * labels); the sim snaps each one to the true high point nearby.
 */
export const PEAKS: { id: string; name: string; x: number; y: number }[] = [
  { id: "hollin", name: "Hollin Knob", x: 590 * 14, y: (1188 - 535) * 14 },
  { id: "ravenhorn", name: "Ravenhorn", x: 962 * 14, y: (1188 - 1052) * 14 },
  { id: "ember", name: "Little Ember", x: 1030 * 14, y: (1188 - 1150) * 14 },
  { id: "corvid", name: "Corvid Peak", x: 1383 * 14, y: (1188 - 873) * 14 },
  { id: "lance", name: "The Lance", x: 1418 * 14, y: (1188 - 840) * 14 },
  { id: "frostmere", name: "Frostmere", x: 1462 * 14, y: (1188 - 968) * 14 },
  { id: "halcyon", name: "Halcyon Dome", x: 468 * 14, y: (1188 - 106) * 14 },
  { id: "kingsfang", name: "Kingsfang", x: 1768 * 14, y: (1188 - 478) * 14 },
];

/** A lift top this close to a summit (and nearly as high) conquers it. */
export const CONQUER_RADIUS_M = 350;
export const CONQUER_DROP_M = 150;

/**
 * Resort tiers. You start small; conquering peaks grows how many skiers the
 * resort can hold (each tier at least triples) and how many lifts it can run.
 */
export const TIERS: { name: string; peaksNeeded: number; capacity: number; maxLifts: number; villageRadius: number }[] = [
  { name: "Local hill", peaksNeeded: 0, capacity: 2000, maxLifts: 10, villageRadius: 500 },
  { name: "Ski area", peaksNeeded: 1, capacity: 6000, maxLifts: 25, villageRadius: 800 },
  { name: "Regional resort", peaksNeeded: 3, capacity: 18000, maxLifts: 40, villageRadius: 1050 },
  { name: "Destination resort", peaksNeeded: 5, capacity: 54000, maxLifts: 70, villageRadius: 1400 },
  { name: "World-class resort", peaksNeeded: 7, capacity: 162000, maxLifts: 110, villageRadius: 1800 },
];

/**
 * Money scale. Hills hold thousands of skiers, so ticket money is large;
 * every price, wage, running cost and unlock goal is multiplied by this so
 * the game keeps the same pace. (Per-person prices — tickets, lessons,
 * heli seats — are not scaled.)
 */
export const ECON = 10;


export const COSTS: Record<BuildingType, number> = {
  parkingSmall: 450,
  parkingLarge: 1300,
  garage: 9000,
  lodge: 2900,
  restroom: 480,
  coffee: 920,
  sandwich: 1050,
  shack: 620,
  cafeteria: 1600,
  bar: 2800,
  hotel: 12000,
  restaurant: 4800,
  shop: 3200,
  condo: 9500,
  hostel: 5200,
  spa: 8500,
  patrol: 1600,
  clinic: 2100,
  rental: 2400,
  school: 3800,
  cabinOffice: 3400,
  cabin: 1500,
  heli: 45000,
};

/** Dollars per minute at a busy hill, 1× speed. */
export const INCOME_PER_MIN: Record<BuildingType, number> = {
  parkingSmall: 18,
  parkingLarge: 45,
  garage: 140,
  restroom: 24,
  patrol: 8,
  clinic: 30,
  lodge: 55,
  shack: 42,
  coffee: 95,
  cafeteria: 115,
  shop: 120,
  sandwich: 140,
  rental: 130,
  bar: 165,
  restaurant: 175,
  hostel: 155,
  spa: 185,
  condo: 200,
  hotel: 220,
  school: 150,
  cabinOffice: 60,
  cabin: 75,
  heli: 0,
};

export const PLACE_ANYWHERE: BuildingType[] = ["shack"];
export const PLACE_MOUNTAIN: BuildingType[] = ["shack", "patrol", "clinic", "cabin"];

export const BUILDING_MAX: Record<BuildingType, number> = {
  parkingSmall: 20,
  parkingLarge: 20,
  garage: 40,
  lodge: 1,
  restroom: 3,
  coffee: 1,
  sandwich: 1,
  shack: 8,
  cafeteria: 2,
  bar: 2,
  hotel: 2,
  restaurant: 2,
  shop: 3,
  condo: 3,
  hostel: 2,
  spa: 1,
  patrol: 2,
  clinic: 2,
  rental: 2,
  school: 1,
  cabinOffice: 1,
  cabin: 30,
  heli: 1,
};

/**
 * Parking: how many skiers' cars each holds (about 2.5 skiers a car), its
 * footprint (w x d metres, long side along the road), how far it reaches
 * (radius) and the steepest ground it can be graded into.
 */
export const PARKING: Partial<Record<BuildingType, { cars: number; skiers: number; w: number; d: number; radius: number; maxGrade: number }>> = {
  parkingSmall: { cars: 120, skiers: 300, w: 44, d: 30, radius: 27, maxGrade: 0.12 },
  parkingLarge: { cars: 400, skiers: 1000, w: 84, d: 52, radius: 48, maxGrade: 0.1 },
  garage: { cars: 2000, skiers: 5000, w: 62, d: 42, radius: 37, maxGrade: 0.2 },
};
export const PARKING_TYPES: BuildingType[] = ["parkingSmall", "parkingLarge", "garage"];
/** The lot the resort starts with, by the ticket booth. */
export const STARTER_LOT_SKIERS = 400;

/** How far around a building trees are cleared and other things kept off. */
export function buildingRadius(type: BuildingType): number {
  return PARKING[type]?.radius ?? (type === "heli" ? 40 : type === "cabin" ? 24 : 22);
}

/** Places skiers visit when hungry. */
export const FOOD_BUILDINGS: BuildingType[] = ["coffee", "sandwich", "shack", "cafeteria", "bar", "restaurant"];

/** Overnight / lodging stock that drives delivery staffing. */
export const LODGING_BUILDINGS: BuildingType[] = ["hotel", "condo", "hostel", "shop", "spa", "cabin"];

/** A cabin is ski-in / ski-out when a run passes this close (m). */
export const CABIN_REACH = 60;

export const EXPANSION_BUILDINGS: BuildingType[] = [
  "garage",
  "hotel",
  "restaurant",
  "shop",
  "condo",
  "hostel",
  "spa",
  "bar",
  "patrol",
];

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

export const START_MONEY = 2200 * ECON;
export const START_TICKET = 42;

export const DIFF = [
  { name: "Green", color: "#3cb172", mark: "●" },
  { name: "Blue", color: "#3b82d6", mark: "■" },
  { name: "Black", color: "#1b1b1b", mark: "◆" },
  { name: "Double black", color: "#0d0d0d", mark: "◆◆" },
] as const;

export const BUILDING_LABEL: Record<BuildingType, string> = {
  parkingSmall: "Small parking lot",
  parkingLarge: "Large parking lot",
  garage: "Parking garage",
  lodge: "Lodge",
  restroom: "Restroom",
  coffee: "Coffee shop",
  sandwich: "Sandwich shop",
  shack: "Sugar shack",
  cafeteria: "Cafeteria",
  bar: "Après bar",
  hotel: "Hotel",
  restaurant: "Restaurant",
  shop: "Shop",
  condo: "Condo",
  hostel: "Hostel",
  spa: "Spa",
  patrol: "Ski patrol hut",
  clinic: "First-aid clinic",
  rental: "Ski rental",
  school: "Ski school",
  cabinOffice: "Cabin rental office",
  cabin: "Ski-in cabin",
  heli: "Heli-ski base",
};

/** Height in world units of one unit of elevation, as drawn (true classifier scale × 1.3). */
export const TERRAIN_SCALE = (VERTICAL_M / UNIT_M) * 1.15;

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
    minLength: 150,
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
    speed: 75,
    spacing: 30,
    baseCost: 3500,
    costPerUnit: 5,
    minLength: 200,
    maxLength: 2200,
    surface: false,
    maxGrade: 9,
    towerH: 15,
    blurb: "Classic two-seat chair. Flies over any terrain.",
  },
  quad: {
    label: "Quad chair",
    short: "Quad",
    seats: 4,
    speed: 95,
    spacing: 36,
    baseCost: 6000,
    costPerUnit: 7,
    minLength: 250,
    maxLength: 2800,
    surface: false,
    maxGrade: 9,
    towerH: 17,
    blurb: "Four across, faster haul. Shorter lift lines.",
  },
  six: {
    label: "Covered six-pack",
    short: "Six-pack",
    seats: 6,
    speed: 115,
    spacing: 42,
    baseCost: 10000,
    costPerUnit: 9,
    minLength: 300,
    maxLength: 3500,
    surface: false,
    maxGrade: 9,
    towerH: 19,
    blurb: "Six-seat chair with a bubble cover. Happy, warm skiers.",
  },
  gondola: {
    label: "8-person gondola",
    short: "Gondola",
    seats: 8,
    speed: 140,
    spacing: 54,
    baseCost: 16000,
    costPerUnit: 12,
    minLength: 400,
    maxLength: 6500,
    surface: false,
    maxGrade: 9,
    towerH: 24,
    blurb: "Enclosed eight-seat cabins. The fastest, longest lift.",
  },
};

export function liftCost(type: LiftType, length: number): number {
  const s = LIFT_SPECS[type];
  return Math.round(((s.baseCost + s.costPerUnit * length) * ECON) / 100) * 100;
}


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
  heli: 150 * ECON,
};

/** Heli-skiing: seats per flight, fare per seat, fuel per flight, minutes are game seconds. */
export const HELI = {
  seats: 8,
  fare: 650,
  fuelPerFlight: 600,
  /** Seconds the drop-and-ski trip lasts (out of sight, off the map). */
  tripTime: 30,
  /** Seconds the pilot waits for a full load before going with fewer. */
  maxWait: 10,
};

for (const k of Object.keys(COSTS) as BuildingType[]) COSTS[k] *= ECON;
for (const k of Object.keys(INCOME_PER_MIN) as BuildingType[]) INCOME_PER_MIN[k] *= ECON;
for (const k of Object.keys(STAFF_WAGE_PER_MIN) as StaffRole[]) STAFF_WAGE_PER_MIN[k] *= ECON;
for (const k of Object.keys(FEATURE_SPEC) as FeatureType[]) FEATURE_SPEC[k].cost *= ECON;
