import {
  BUILDING_LABEL,
  BuildingType,
  EXPANSION_BUILDINGS,
  LIFT_SPECS,
  LIFT_TYPES,
  LiftType,
  Tool,
  UNIT_M,
  liftCost,
} from "./types";

/** Compact build bar: one icon per category; categories with options open a submenu. */

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  look: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  trail: svg('<path d="M6 3c5 2 8 4 3 7s-3 6 3 7 6 3 5 4"/><path d="M6 3v5"/><path d="M6 3l4 1.4L6 6"/>'),
  lifts: svg('<path d="M2 5l20 6"/><path d="M12 8v6"/><path d="M8 14h8v3H8z"/><path d="M8 17v3M16 17v3"/>'),
  base: svg('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>'),
  food: svg('<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16"/><path d="M8 3c0 1.5 1 1.5 1 3M12 3c0 1.5 1 1.5 1 3"/>'),
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
  { id: "trail", label: "Trail", tool: "cut" },
  { id: "lifts", label: "Lifts", items: LIFT_TYPES.map((t) => `lift:${t}` as Tool) },
  { id: "base", label: "Base", items: ["lodge", "restroom", "patrol"] },
  { id: "food", label: "Food", items: ["shack", "coffee", "sandwich", "restaurant"] },
  { id: "resort", label: "Resort", items: ["shop", "condo", "hotel"] },
];

export function groupOf(tool: Tool): string | null {
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
      ${exp ? '<em class="lock">Unlocks with the next mountain</em>' : ""}
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
      (g) => `<div class="dock-panel hidden${g.id === "lifts" ? " wide" : ""}" data-group="${g.id}" role="menu" aria-label="${g.label}">
        ${g.items!.map(itemHtml).join("")}
      </div>`,
    )
    .join("");
}
