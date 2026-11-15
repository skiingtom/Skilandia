import {
  BUILDING_LABEL,
  BuildingType,
  EXPANSION_BUILDINGS,
  FEATURE_SPEC,
  FEATURE_TYPES,
  FeatureType,
  TRAIL_KINDS,
  TRAIL_KIND_SPEC,
  TrailKind,
  LIFT_SPECS,
  LIFT_TYPES,
  LiftType,
  Tool,
  UNIT_M,
  liftCost,
  PARKING,
} from "./types";
import { ROAD_COST_PER_M, ROAD_MAX_GRADE } from "./roads";
import { BRUSH_R, TREE_FELL_COST } from "./sim";

const SALVAGE_SHARE = 0.4;

/** Compact build bar: one icon per category; categories with options open a submenu. */

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  edit: svg('<path d="M14 4l6 6"/><path d="M17 7L7 17"/><path d="M4 20l3-3"/><path d="M12 2l2 2-4 4-2-2z"/>'),
  road: svg('<path d="M8 3L4 21"/><path d="M16 3l4 18"/><path d="M12 4v3M12 10v3M12 16v3"/>'),
  look: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  trail: svg('<path d="M6 3c5 2 8 4 3 7s-3 6 3 7 6 3 5 4"/><path d="M6 3v5"/><path d="M6 3l4 1.4L6 6"/>'),
  lifts: svg('<path d="M2 5l20 6"/><path d="M12 8v6"/><path d="M8 14h8v3H8z"/><path d="M8 17v3M16 17v3"/>'),
  base: svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>'),
  food: svg('<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3"/>'),
  park: svg('<path d="M2 19h20"/><path d="M4 19l9-6h3v6"/><path d="M16 13l3-3"/><circle cx="19.5" cy="6.5" r="1.6"/>'),
  resort: svg('<path d="M4 21V5l8-2v18"/><path d="M12 9h8v12"/><path d="M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2"/><path d="M2 21h20"/>'),
};

export interface DockGroup {
  id: keyof typeof ICONS;
  label: string;
  /** A direct tool (no submenu). */
  tool?: Tool;
  items?: Tool[];
}

export const DOCK_GROUPS: DockGroup[] = [
  { id: "look", label: "Look", tool: "select" },
  { id: "road", label: "Roads", items: ["road", "parkingSmall", "parkingLarge", "garage"] },
  { id: "trail", label: "Trails", items: TRAIL_KINDS.map((k) => `trail:${k}` as Tool) },
  { id: "park", label: "Park", items: FEATURE_TYPES.map((f) => `feature:${f}` as Tool) },
  { id: "lifts", label: "Lifts", items: LIFT_TYPES.map((t) => `lift:${t}` as Tool) },
  { id: "base", label: "Base", items: ["lodge", "restroom", "rental", "school", "clinic", "patrol"] },
  { id: "food", label: "Food", items: ["shack", "coffee", "cafeteria", "sandwich", "bar", "restaurant"] },
  { id: "resort", label: "Resort", items: ["shop", "hostel", "condo", "spa", "hotel", "heli"] },
  { id: "edit", label: "Edit", items: ["clearTrees", "demolish"] },
];

export function groupOf(tool: Tool): string | null {
  if (tool === "cut") return "trail";
  return DOCK_GROUPS.find((g) => g.tool === tool || g.items?.includes(tool))?.id ?? null;
}

const LIFT_UNIT: Record<LiftType, string> = {
  carpet: "slot",
  tbar: "bar",
  double: "chair",
  quad: "chair",
  six: "chair",
  gondola: "cabin",
};

function itemHtml(tool: Tool): string {
  if (tool === "road") {
    return `<button type="button" class="tool item" data-tool="road">
      <b>Road</b>
      <small>$${ROAD_COST_PER_M}/m · ≤${Math.round(ROAD_MAX_GRADE * 100)}% grade</small>
      <em>From the highway or another road to wherever cars need to go.</em>
    </button>`;
  }
  const lot = PARKING[tool as BuildingType];
  if (lot) {
    const b = tool as BuildingType;
    const exp = EXPANSION_BUILDINGS.includes(b) ? " expansion" : "";
    return `<button type="button" class="tool item${exp}" data-tool="${b}">
      <b>${BUILDING_LABEL[b]}</b>
      <small id="cost-${b}"></small>
      <em>${exp ? "Unlocks after your first peak. " : ""}${lot.cars.toLocaleString()} cars, room for ${lot.skiers.toLocaleString()} more skiers. Goes right beside a road.</em>
    </button>`;
  }
  if (tool === "demolish") {
    return `<button type="button" class="tool item" data-tool="demolish">
      <b>Demolish</b>
      <small>${Math.round(SALVAGE_SHARE * 100)}% back · roads 25% · runs free</small>
      <em>Click a building, lift, run, park feature or road to take it down.</em>
    </button>`;
  }
  if (tool === "clearTrees") {
    return `<button type="button" class="tool item" data-tool="clearTrees">
      <b>Clear trees</b>
      <small>$${TREE_FELL_COST} a tree · ${BRUSH_R * 2} m brush</small>
      <em>Click or drag over the forest to fell it.</em>
    </button>`;
  }
  if (tool.startsWith("trail:")) {
    const k = tool.slice(6) as TrailKind;
    const spec = TRAIL_KIND_SPEC[k];
    return `<button type="button" class="tool item" data-tool="${tool}">
      <b>${spec.label}</b>
      <small>${spec.costMul === 1 ? "length fee" : `length fee × ${spec.costMul}`}</small>
      <em>${spec.blurb}</em>
    </button>`;
  }
  if (tool.startsWith("feature:")) {
    const f = tool.slice(8) as FeatureType;
    const spec = FEATURE_SPEC[f];
    return `<button type="button" class="tool item" data-tool="${tool}">
      <b>${spec.label}</b>
      <small>$${spec.cost.toLocaleString()}</small>
      <em>${spec.blurb}</em>
    </button>`;
  }
  if (tool.startsWith("lift:")) {
    const t = tool.slice(5) as LiftType;
    const spec = LIFT_SPECS[t];
    const rule = spec.surface
      ? t === "carpet"
        ? "Gentle ground only · uphill the whole way"
        : "Ground must climb the whole way"
      : "Any terrain · top above bottom";
    return `<button type="button" class="tool item" data-tool="${tool}" title="${spec.blurb}">
      <b>${spec.label}</b>
      <small>from $${liftCost(t, spec.minLength).toLocaleString()} · ${spec.seats}/${LIFT_UNIT[t]} · ≤${Math.round(spec.maxLength * UNIT_M)} m</small>
      <em>${rule}</em>
    </button>`;
  }
  const b = tool as BuildingType;
  const exp = EXPANSION_BUILDINGS.includes(b) ? " expansion" : "";
  return `<button type="button" class="tool item${exp}" data-tool="${b}">
      <b>${BUILDING_LABEL[b]}</b>
      <small id="cost-${b}"></small>
      ${exp ? '<em class="lock">Unlocks after your first peak</em>' : ""}
    </button>`;
}

export function buildDock(dock: HTMLElement, menus: HTMLElement): void {
  dock.innerHTML = DOCK_GROUPS.map(
    (g) => `<button type="button" class="dock-btn" data-group="${g.id}" title="${g.label}"${g.items ? ' aria-expanded="false"' : ""}>
      ${ICONS[g.id]}<span>${g.label}</span>${g.items ? '<i class="caret" aria-hidden="true"></i>' : ""}
    </button>`,
  ).join("");
  menus.innerHTML = DOCK_GROUPS.filter((g) => g.items)
    .map(
      (g) => `<div class="dock-panel hidden${g.id === "lifts" || g.id === "trail" || g.id === "park" || g.id === "edit" || g.id === "road" ? " wide" : ""}" data-group="${g.id}" role="menu" aria-label="${g.label}">
        ${g.items!.map(itemHtml).join("")}
      </div>`,
    )
    .join("");
}
