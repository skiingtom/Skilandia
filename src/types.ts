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
  | "patrol";
export type Tool = "select" | "cut" | BuildingType;
export type StaffRole = "patrol" | "food" | "lift" | "delivery" | "maintenance";
export type SkierState =
  | "arriving"
  | "booth"
  | "toLift"
  | "queue"
  | "riding"
  | "toTrail"
  | "skiing"
  | "visit"
  | "leaving";

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
}

export interface Lift {
  name: string;
  bottom: Vec2;
  top: Vec2;
  carriers: Carrier[];
}

export interface Carrier {
  t: number;
  skierId: number | null;
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

export const WORLD_W = 640;
export const WORLD_H = 820;
export const VERTICAL_M = 128;
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
};

export const EXPANSION_BUILDINGS: BuildingType[] = ["hotel", "restaurant", "shop", "condo", "patrol"];

export const STAFF_ROLES: StaffRole[] = ["patrol", "food", "lift", "delivery", "maintenance"];

export const STAFF_LABEL: Record<StaffRole, string> = {
  patrol: "Ski patrol",
  food: "Food service",
  lift: "Lift attendants",
  delivery: "Delivery",
  maintenance: "Maintenance",
};

export const STAFF_WAGE_PER_MIN: Record<StaffRole, number> = {
  patrol: 18,
  food: 14,
  lift: 16,
  delivery: 12,
  maintenance: 15,
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
};
