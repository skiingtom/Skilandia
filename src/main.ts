import { AudioBus } from "./audio";
import { DOCK_GROUPS, buildDock, groupOf } from "./dock";
import { ROAD_COST_PER_M, ROAD_MAX_GRADE } from "./roads";
import { World3D } from "./scene";
import { EARTH_COST_PER_M3, Game, SUMMITS, TREE_FELL_COST } from "./sim";
import { MAX_EARTHWORK_M, SculptMode, earthworkAt } from "./height";
let brushHint = "";
const SHAPE_LABEL: Record<SculptMode, string> = { raise: "Raise", lower: "Lower", flatten: "Flatten", smooth: "Smooth" };
const SHAPE_HELP: Record<SculptMode, string> = {
  raise: "Raise: build the ground up.",
  lower: "Lower: dig the ground down.",
  flatten: "Flatten: level everything to the height where the stroke starts.",
  smooth: "Smooth: round off bumps, ridges and sharp edges.",
};
import {
  BUILDING_LABEL,
  BUILDING_MAX,
  FEATURE_SPEC,
  HELI,
  OPERATING_COST_PER_MIN,
  TRAIL_KIND_SPEC,
  BuildingType,
  COSTS,
  DIFF,
  INCOME_PER_MIN,
  LIFT_SPECS,
  TIERS,
  STAFF_LABEL,
  STAFF_ROLES,
  Tool,
  UNIT_M,
  PARKING,
} from "./types";
import "@fontsource/nunito/500.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/700.css";
import "./style.css";

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const game = new Game();
const welcome = document.querySelector("#welcome")!;
const startBtn = document.querySelector<HTMLButtonElement>("#btn-start")!;
document.body.classList.add("welcome-open");
const audio = new AudioBus();

let world!: World3D;
let started = false;

function beginPlay(): void {
  if (started) return;
  started = true;
  game.startManaging();
  world?.startPlay();
  audio.click();
  welcome.classList.add("hidden");
  document.body.classList.remove("welcome-open");
  paintHud(true);
}

startBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  beginPlay();
});

world = new World3D(canvas);
// Dev-only handle for poking at the game from the console.
if ((import.meta as unknown as { env: { DEV: boolean } }).env.DEV) Object.assign(window, { skilandia: { game, world } });

let last = performance.now();
let pointer = { x: 0, y: 0, downX: 0, downY: 0, over: false, held: false };

const moneyEl = document.querySelector("#stat-money")!;
const skiersEl = document.querySelector("#stat-skiers")!;
const moodEl = document.querySelector("#stat-mood")!;
const ticketsEl = document.querySelector("#stat-tickets")!;
const earnedEl = document.querySelector("#stat-earned")!;
const mountainsEl = document.querySelector("#mountains")!;
const staffSection = document.querySelector("#staff-section")!;
const staffList = document.querySelector("#staff-list")!;
const staffLock = document.querySelector("#staff-lock")!;
const clockTime = document.querySelector("#clock-time")!;
const clockDay = document.querySelector("#clock-day")!;
const clockFill = document.querySelector<HTMLElement>("#clock-fill")!;
const wxIcon = document.querySelector("#wx-icon")!;
const wxCond = document.querySelector("#wx-cond")!;
const wxMeta = document.querySelector("#wx-meta")!;
const wxSnow = document.querySelector<HTMLElement>("#wx-snow")!;
const wxForecast = document.querySelector<HTMLElement>("#wx-forecast")!;
const goalsEl = document.querySelector("#goals")!;
const complaintsEl = document.querySelector("#complaints")!;
const selTitle = document.querySelector("#sel-title")!;
const selBody = document.querySelector("#sel-body")!;
const ticketSection = document.querySelector("#ticket-section")!;
const ticketRange = document.querySelector<HTMLInputElement>("#ticket-range")!;
const ticketValue = document.querySelector("#ticket-value")!;
const ticketFair = document.querySelector("#ticket-fair")!;
const shopRate = document.querySelector("#shop-rate")!;
const shapeBanner = document.querySelector<HTMLElement>("#shape-banner")!;
const shapeText = document.querySelector("#shape-text")!;
const cutBanner = document.querySelector("#cut-banner")!;
const cutDiff = document.querySelector("#cut-diff")!;
const cutCost = document.querySelector("#cut-cost")!;
const finishBtn = document.querySelector<HTMLButtonElement>("#btn-finish-trail")!;
const toastsEl = document.querySelector("#toasts")!;
const placeHint = document.querySelector("#place-hint")!;
const cutText = document.querySelector("#cut-text")!;
const moveBtn = document.querySelector<HTMLButtonElement>("#btn-move-building")!;
const settingsBtn = document.querySelector<HTMLButtonElement>("#btn-settings")!;
const settingsEl = document.querySelector<HTMLElement>("#settings")!;
const moveFeeOpt = document.querySelector<HTMLInputElement>("#opt-move-fee")!;
const freeTreesOpt = document.querySelector<HTMLInputElement>("#opt-free-trees")!;
const freeShapingOpt = document.querySelector<HTMLInputElement>("#opt-free-shaping")!;
const dockEl = document.querySelector<HTMLElement>("#dock")!;
const dockMenus = document.querySelector<HTMLElement>("#dock-menus")!;
buildDock(dockEl, dockMenus);
let openGroup: string | null = null;

function closeMenus(): void {
  openGroup = null;
  dockMenus.querySelectorAll(".dock-panel").forEach((p) => p.classList.add("hidden"));
  dockEl.querySelectorAll(".dock-btn[aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

function openMenu(id: string, btn: HTMLElement): void {
  closeMenus();
  const panel = dockMenus.querySelector<HTMLElement>(`.dock-panel[data-group="${id}"]`);
  if (!panel) return;
  openGroup = id;
  btn.setAttribute("aria-expanded", "true");
  panel.classList.remove("hidden");
  // Sit the submenu right above its icon, kept on screen.
  const r = btn.getBoundingClientRect();
  const w = panel.offsetWidth;
  const left = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2));
  panel.style.left = `${left}px`;
}
const removeLiftBtn = document.querySelector<HTMLButtonElement>("#btn-remove-lift")!;
const fxRoot = document.createElement("div");
fxRoot.className = "world-fx";
document.querySelector("#hud")!.appendChild(fxRoot);

function moodWord(n: number): string {
  if (n >= 78) return "Buzzing";
  if (n >= 64) return "Happy";
  if (n >= 48) return "Okay";
  if (n >= 34) return "Grumbly";
  return "Sour";
}

let hudAcc = 0;
let lastToastId = 0;

/** Top-bar money: exact below a million, then $1.92M style so it fits. */
function shortMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a < 1e6) return `${sign}$${Math.round(a).toLocaleString()}`;
  return `${sign}$${(a / 1e6).toFixed(a < 1e7 ? 2 : 1)}M`;
}

/** The clock card: time, day, how far through the open day, and the weather report. */
function paintClock(): void {
  clockTime.textContent = game.timeOfDay();
  clockDay.textContent = `Day ${game.day}`;
  clockFill.style.width = `${(game.dayFraction() * 100).toFixed(1)}%`;
  const w = game.weatherReport();
  wxIcon.textContent = w.icon;
  wxCond.textContent = w.condition;
  wxMeta.textContent = `${w.tempC}°C · wind ${w.windKmh} km/h`;
  wxSnow.textContent = w.freshCm > 0 ? `${w.freshCm} cm fresh` : "No new snow";
  wxSnow.classList.toggle("deep", w.freshCm >= 10);
  wxForecast.textContent = w.forecast;
  wxForecast.title = w.forecast;
}

function paintHud(force = false): void {
  moneyEl.textContent = shortMoney(game.money);
  const load = game.loadLimits();
  skiersEl.textContent = `${game.skiers.length.toLocaleString()} / ${load.comfortable.toLocaleString()}`;
  skiersEl.parentElement!.title =
    `The resort can comfortably handle ${load.comfortable.toLocaleString()} skiers right now ` +
    `(lifts ${load.lifts.toLocaleString()}, runs ${load.runs.toLocaleString()}, parking ${load.parking.toLocaleString()}, mountain max ${load.cap.toLocaleString()}).`;
  moodEl.textContent = moodWord(game.mood);
  ticketsEl.textContent = String(game.ticketsToday);
  earnedEl.textContent = shortMoney(game.lifetimeEarned);
  paintClock();
  paintMountains();
  paintStaff();
  goalsEl.innerHTML = game
    .goals()
    .map((g) => `<li class="${g.done ? "done" : ""}">${g.text}</li>`)
    .join("");
  complaintsEl.innerHTML = game.complaints().map((c) => `<li>${c}</li>`).join("");
  const sel = game.selectionText();
  selTitle.textContent = sel.title;
  selBody.textContent = sel.body;
  const lodge = game.has("lodge");
  ticketSection.classList.toggle("locked", !lodge);
  ticketRange.disabled = !lodge;
  if (force || document.activeElement !== ticketRange) ticketRange.value = String(game.ticketPrice);
  ticketValue.textContent = `$${game.ticketPrice}`;
  ticketFair.textContent = `Guests will pay about $${game.fairPrice()}`;
  if (!game.buildings.length) {
    shopRate.textContent = `Shacks $${INCOME_PER_MIN.shack}/min · coffee $${INCOME_PER_MIN.coffee} · hotel $${INCOME_PER_MIN.hotel}. Sugar shacks go beside trails.`;
  } else {
    const upkeep = game.upkeepPerMin() ? ` Running costs today $${Math.round(game.upkeepToday)}.` : "";
    const wages = (game.staffRequired() || game.staff.instructor ? ` Wages today $${Math.round(game.wagesToday)}.` : "") + upkeep;
    shopRate.textContent = `About $${game.shopRatePerMin()}/min here. Take today $${Math.round(game.shopIncomeToday)}.${wages}`;
  }
  const expand = game.expansionUnlocked();
  document.querySelectorAll<HTMLButtonElement>(".tool[data-tool]").forEach((btn) => {
    const tool = btn.dataset.tool as Tool;
    btn.classList.toggle("on", game.tool === tool || (game.tool === "cut" && tool === `trail:${game.trailKind}`));
    if (tool === "select" || tool === "cut" || tool === "road" || tool === "demolish" || tool === "clearTrees" || tool === "shape" || tool.startsWith("trail:") || tool.startsWith("feature:")) {
      btn.disabled = false;
      return;
    }
    if (tool.startsWith("lift:")) {
      btn.disabled = game.lifts.length >= game.maxLifts();
      return;
    }
    const type = tool as BuildingType;
    const atMax = game.count(type) >= BUILDING_MAX[type];
    btn.disabled = atMax || (btn.classList.contains("expansion") && !expand);
  });
  document.querySelectorAll<HTMLButtonElement>(".speed").forEach((btn) => {
    btn.classList.toggle("on", Number(btn.dataset.speed) === game.speed && !game.paused);
  });
  const pauseBtn = document.querySelector<HTMLButtonElement>("#btn-pause")!;
  pauseBtn.classList.toggle("paused", game.paused);
  pauseBtn.title = game.paused ? "Resume (Space)" : "Pause (Space)";
  pauseBtn.setAttribute("aria-label", game.paused ? "Resume" : "Pause");
  const drafting = game.tool === "cut" || game.tool === "road";
  shapeBanner.classList.toggle("hidden", game.tool !== "shape");
  shapeBanner.querySelectorAll<HTMLButtonElement>(".shape-mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === game.shapeMode));
  shapeBanner.querySelectorAll<HTMLButtonElement>(".shape-size").forEach((b) => b.classList.toggle("on", Number(b.dataset.size) === game.shapeRadius));
  shapeText.textContent = `${SHAPE_HELP[game.shapeMode]} Hold the left button and drag. ${game.freeShaping ? "Free (see Settings)" : `$${EARTH_COST_PER_M3}/m³ of earth moved`}; building pads stay put.`;
  cutBanner.classList.toggle("hidden", !drafting);
  cutText.textContent =
    game.tool === "road"
      ? `Road: start on the highway, another road or the parking lot, click along the way, and end on a road or the lot. $${ROAD_COST_PER_M}/m, at most ${Math.round(ROAD_MAX_GRADE * 100)}% grade, so zig-zag up steep ground.`
      : `${TRAIL_KIND_SPEC[game.trailKind].label}: click downhill to draw it, then Finish. ${TRAIL_KIND_SPEC[game.trailKind].blurb} Trees in the way get cleared.`;
  finishBtn.textContent = game.tool === "road" ? "Finish road" : "Finish trail";
  const picked = game.selected?.kind === "building" ? game.buildings.find((b) => b.id === game.selected!.id) : undefined;
  moveBtn.classList.toggle("hidden", !picked);
  if (picked) {
    const fee = game.moveFee(picked);
    moveBtn.textContent = `Move this ${BUILDING_LABEL[picked.type].toLowerCase()} (${fee ? `$${fee.toLocaleString()}` : "free"})`;
  }
  const info = game.tool === "road" ? null : game.draftInfo();
  if (game.tool === "road") {
    const r = game.roadDraftInfo();
    cutDiff.textContent = game.draft.length ? `${Math.round(r.length)} m · steepest ${Math.round(r.grade * 100)}%` : "Click a road or the lot";
    cutCost.textContent = `$${r.cost.toLocaleString()}`;
    finishBtn.disabled = game.draft.length < 2;
  } else if (info) {
    cutDiff.textContent = info.length < 8 ? "Click downhill" : DIFF[info.difficulty].name;
    cutCost.textContent = `$${info.cost}`;
    finishBtn.disabled = game.draft.length < 2 || info.length < 120;
  } else {
    cutDiff.textContent = "Click to start";
    cutCost.textContent = "$0";
    finishBtn.disabled = true;
  }
  const activeGroup = groupOf(game.tool);
  dockEl.querySelectorAll<HTMLButtonElement>(".dock-btn").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.group === activeGroup);
    btn.classList.toggle("open", btn.dataset.group === openGroup);
  });
  removeLiftBtn.classList.toggle("hidden", game.selected?.kind !== "lift" || game.lifts.length <= 1);
  canvas.classList.toggle("cut", drafting);
  canvas.classList.toggle("place", game.tool !== "select" && !drafting);
  const newest = game.toasts[game.toasts.length - 1];
  if (newest && newest.id !== lastToastId) {
    lastToastId = newest.id;
    const el = document.createElement("div");
    el.className = `toast${newest.bad ? " bad" : ""}`;
    el.textContent = newest.text;
    toastsEl.appendChild(el);
    window.setTimeout(() => el.remove(), 3600);
  }
}

/** Peaks panel: the resort tier, and every summit to conquer (click to fly there). */
function paintMountains(): void {
  const tier = game.tier();
  const next = TIERS[tier + 1];
  const head = `<div class="tier"><b>${TIERS[tier].name}</b><small>${game.conquered.size}/${SUMMITS.length} peaks · holds ${game.capacity().toLocaleString()} skiers${
    next ? ` · ${next.peaksNeeded - game.conquered.size} more peak${next.peaksNeeded - game.conquered.size === 1 ? "" : "s"} to grow` : ""
  }</small></div>`;
  const peaks = [...SUMMITS]
    .sort((a, b) => a.elevation - b.elevation)
    .map((p) => {
      const done = game.conquered.has(p.id);
      return `<button type="button" class="mtn${done ? " on" : ""}" data-peak="${p.id}">
      ${done ? "🚩 " : ""}${p.name}<small>${p.elevation.toLocaleString()} m · ${done ? "conquered" : "run a lift to the top"}</small></button>`;
    })
    .join("");
  const html = head + peaks;
  if (mountainsEl.innerHTML === html) return;
  mountainsEl.innerHTML = html;
  mountainsEl.querySelectorAll<HTMLButtonElement>(".mtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = SUMMITS.find((k) => k.id === btn.dataset.peak);
      if (p) world.focusPoint(p.x, p.y, 3200);
    });
  });
}

function paintStaff(): void {
  const required = game.staffRequired();
  const school = game.empireCount("school") > 0;
  staffSection.classList.toggle("locked", !required && !school);
  staffLock.textContent = required
    ? "You're a real ski area now: staff the place. Short crews slow shop take and sour the mood."
    : school
      ? "The ski school needs instructors (paid from day one). Full payroll starts once you conquer your first peak."
      : "Payroll starts once you conquer your first peak. A ski school needs instructors right away.";
  const need = game.staffNeeds();
  const roles = required ? STAFF_ROLES : school ? (["instructor"] as const) : [];
  staffList.innerHTML = roles.map((role) => {
    return `<div class="staff-row" data-role="${role}">
      <span>${STAFF_LABEL[role]} · ${game.staff[role]}/${need[role]} need</span>
      <button type="button" data-act="fire">−</button>
      <button type="button" data-act="hire">+</button>
    </div>`;
  }).join("");
  staffList.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const role = btn.parentElement?.getAttribute("data-role") as typeof STAFF_ROLES[number];
      if (btn.dataset.act === "hire") game.hire(role);
      else game.fire(role);
      paintHud();
    });
  });
}

function paintFx(): void {
  fxRoot.innerHTML = "";
  for (const f of game.fx) {
    const p = world.project(f.x, f.y);
    if (!p.vis) continue;
    const el = document.createElement("span");
    el.className = "fx";
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.color = f.color;
    el.style.opacity = String(Math.max(0, f.life));
    el.textContent = f.text;
    fxRoot.appendChild(el);
  }
}

function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  game.tick(dt);
  for (const s of game.sfx) {
    if (s === "cash") audio.cash();
    if (s === "build") audio.build();
    if (s === "err") audio.error();
  }
  game.sfx = [];
  hudAcc += dt;
  if (hudAcc > 0.2) {
    hudAcc = 0;
    paintHud();
  }
  const liftType = game.liftTool();
  if (pointer.over && liftType) {
    world.hideGhost();
    const hit = world.hitAt(pointer.x, pointer.y);
    const spec = LIFT_SPECS[liftType];
    game.liftHover = hit && hit.mountain === game.currentMountain ? { x: hit.x, y: hit.y } : null;
    placeHint.classList.remove("hidden");
    const pv = game.liftPreview();
    if (!game.liftStart) {
      placeHint.classList.add("ok");
      placeHint.textContent = `${spec.label}: click the bottom station. ${spec.blurb}`;
    } else if (pv) {
      placeHint.classList.toggle("ok", !pv.error);
      placeHint.textContent =
        pv.error ??
        `Click to set the top · ${Math.round(pv.length * UNIT_M)} m long · ${Math.round(pv.rise)} m rise · $${pv.cost.toLocaleString()}`;
    }
  } else if (pointer.over && game.tool === "demolish") {
    world.hideGhost();
    game.brushHover = null;
    const hit = world.hitAt(pointer.x, pointer.y);
    const t = hit && hit.mountain === game.currentMountain ? game.demolishTarget(hit.x, hit.y) : null;
    placeHint.classList.remove("hidden");
    placeHint.classList.toggle("ok", !!t);
    placeHint.textContent = t
      ? `Click to demolish ${t.kind === "trail" ? `the run “${t.label}”` : t.label.toLowerCase() === "road" ? "this road" : t.label}${t.refund ? ` · salvage $${t.refund.toLocaleString()}` : ""}`
      : "Demolish: point at a building, lift, run, park feature or road.";
  } else if (pointer.over && game.tool === "shape") {
    world.hideGhost();
    const hit = world.hitAt(pointer.x, pointer.y);
    const here = hit && hit.mountain === game.currentMountain ? { x: hit.x, y: hit.y } : null;
    game.brushHover = here;
    if (here && pointer.held) game.shapeStep(here.x, here.y, dt);
    placeHint.classList.remove("hidden");
    placeHint.classList.add("ok");
    if (here) {
      const ew = earthworkAt(here.x, here.y);
      const fill = Math.abs(ew) < 0.5 ? "untouched ground" : `${ew > 0 ? "filled" : "cut"} ${Math.abs(ew).toFixed(0)} m of ${MAX_EARTHWORK_M}`;
      const stroke = game.shapeCost >= 1 ? ` · this stroke $${Math.round(game.shapeCost).toLocaleString()}` : "";
      placeHint.textContent = `${SHAPE_LABEL[game.shapeMode]} · ${game.shapeRadius} m brush · ${fill}${stroke}`;
    } else placeHint.textContent = "Shape: point at the ground.";
  } else if (pointer.over && game.tool === "clearTrees") {
    world.hideGhost();
    const hit = world.hitAt(pointer.x, pointer.y);
    game.brushHover = hit && hit.mountain === game.currentMountain ? { x: hit.x, y: hit.y } : null;
    if (hudAcc === 0 || !brushHint) {
      const n = game.brushHover ? game.treesUnderBrush(game.brushHover.x, game.brushHover.y) : 0;
      const price = game.freeTreeClearing ? "free" : `$${(n * TREE_FELL_COST).toLocaleString()}`;
      brushHint = n ? `Click or drag to clear ${n} trees · ${price}` : "Clear trees: click or drag over the forest.";
    }
    placeHint.classList.remove("hidden");
    placeHint.classList.add("ok");
    placeHint.textContent = `${brushHint} · ${game.treesFelled.toLocaleString()} felled so far`;
  } else if (pointer.over && game.tool !== "select" && game.tool !== "cut" && game.tool !== "road" && game.tool !== "shape") {
    const hit = world.hitAt(pointer.x, pointer.y);
    const feature = game.featureTool();
    const moving = game.movingBuilding();
    if (hit && hit.mountain === game.currentMountain && feature) {
      const err = game.canPlaceFeature(feature, hit.x, hit.y);
      world.showGhost(`feature:${feature}`, hit.x, hit.y, !err, game.featureAngle(hit.x, hit.y));
      placeHint.classList.remove("hidden");
      placeHint.classList.toggle("ok", !err);
      placeHint.textContent = err ?? `Click to build a ${FEATURE_SPEC[feature].label.toLowerCase()} · $${FEATURE_SPEC[feature].cost.toLocaleString()}`;
    } else if (hit && hit.mountain === game.currentMountain && moving) {
      const err = game.canMoveTo(hit.x, hit.y);
      world.showGhost(moving.type, hit.x, hit.y, !err, PARKING[moving.type] ? game.parkingAngle(moving.type, hit.x, hit.y) : 0);
      placeHint.classList.remove("hidden");
      placeHint.classList.toggle("ok", !err);
      const fee = game.moveFee(moving);
      placeHint.textContent = err ?? `Click to move the ${BUILDING_LABEL[moving.type].toLowerCase()} here · ${fee ? `$${fee.toLocaleString()}` : "free"} · Esc to cancel`;
    } else if (hit && hit.mountain === game.currentMountain && !feature && !moving) {
      const type = game.tool as BuildingType;
      const err = game.canPlace(type, hit.x, hit.y);
      world.showGhost(type, hit.x, hit.y, !err, PARKING[type] ? game.parkingAngle(type, hit.x, hit.y) : 0);
      placeHint.classList.remove("hidden");
      placeHint.classList.toggle("ok", !err);
      placeHint.textContent = err ?? `Click to place the ${BUILDING_LABEL[type].toLowerCase()}.`;
    } else {
      world.hideGhost();
      placeHint.classList.add("hidden");
    }
  } else {
    world.hideGhost();
    placeHint.classList.add("hidden");
  }
  world.update(game, dt);
  world.render();
  paintFx();
  requestAnimationFrame(loop);
}

canvas.addEventListener("pointermove", (e) => {
  pointer.over = true;
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  world.setPointer(e.clientX, e.clientY);
  const hit = world.hitAt(e.clientX, e.clientY);
  if (hit && game.tool === "select") game.moveHover(hit.x, hit.y);
});

canvas.addEventListener("pointermove", (e) => {
  // Drag the tree brush with the left button held.
  if (game.tool !== "clearTrees" || !(e.buttons & 1)) return;
  const hit = world.hitAt(e.clientX, e.clientY);
  if (hit && hit.mountain === game.currentMountain && game.click(hit.x, hit.y) === "ok") audio.click();
});

canvas.addEventListener("pointerleave", () => {
  pointer.over = false;
  if (pointer.held && game.tool === "shape") game.endShape();
  pointer.held = false;
  game.brushHover = null;
});

canvas.addEventListener("pointerdown", (e) => {
  pointer.downX = e.clientX;
  pointer.downY = e.clientY;
  if (e.button === 0) pointer.held = true;
});

canvas.addEventListener("pointerup", (e) => {
  if (e.button === 0) pointer.held = false;
  if (!game.managing) return;
  if (game.tool === "shape") {
    game.endShape();
    paintHud();
    return;
  }
  if (game.tool === "clearTrees") {
    if (e.button === 0) {
      const hit = world.hitAt(e.clientX, e.clientY);
      if (hit && hit.mountain === game.currentMountain && game.click(hit.x, hit.y) === "shake") audio.error();
    }
    game.endBrush();
    paintHud();
    return;
  }
  if (e.button !== 0) return;
  if (Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY) > 6) return;
  const hit = world.hitAt(e.clientX, e.clientY);
  if (!hit) return;
  const result = game.click(hit.x, hit.y);
  if (result === "shake") {
    audio.error();
    moneyEl.classList.remove("shake");
    void (moneyEl as HTMLElement).offsetWidth;
    moneyEl.classList.add("shake");
  } else if (result === "ok") {
    if (game.tool === "select") audio.click();
    else audio.build();
  }
  paintHud();
});

canvas.addEventListener("dblclick", (e) => {
  if (game.tool !== "cut" && game.tool !== "road") return;
  e.preventDefault();
  const result = game.finishTrail();
  if (result === "ok") audio.build();
  if (result === "shake") audio.error();
  paintHud();
});

document.querySelectorAll<HTMLButtonElement>(".tool[data-tool]").forEach((btn) => {
  btn.addEventListener("click", () => {
    game.setTool(btn.dataset.tool as Tool);
    closeMenus();
    audio.click();
    paintHud();
  });
});

dockEl.querySelectorAll<HTMLButtonElement>(".dock-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const group = DOCK_GROUPS.find((g) => g.id === btn.dataset.group)!;
    audio.click();
    if (group.tool) {
      closeMenus();
      game.setTool(group.tool);
    } else if (openGroup === group.id) {
      closeMenus();
    } else {
      openMenu(group.id, btn);
    }
    paintHud();
  });
});
canvas.addEventListener("pointerdown", () => {
  if (openGroup) {
    closeMenus();
    paintHud();
  }
});

document.querySelectorAll<HTMLButtonElement>(".speed").forEach((btn) => {
  btn.addEventListener("click", () => {
    game.setSpeed(Number(btn.dataset.speed));
    paintHud();
  });
});

document.querySelector("#btn-pause")!.addEventListener("click", () => {
  game.togglePause();
  paintHud();
});

document.querySelector("#btn-mute")!.addEventListener("click", () => {
  const muted = audio.toggle();
  const muteBtn = document.querySelector<HTMLButtonElement>("#btn-mute")!;
  muteBtn.setAttribute("aria-pressed", String(muted));
  muteBtn.title = muted ? "Sound off (click to unmute)" : "Sound on (click to mute)";
  muteBtn.setAttribute("aria-label", muted ? "Unmute sound" : "Mute sound");
});

document.querySelector("#btn-cancel-cut")!.addEventListener("click", () => {
  game.cancel();
  paintHud();
});

finishBtn.addEventListener("click", () => {
  const result = game.finishTrail();
  if (result === "ok") audio.build();
  if (result === "shake") audio.error();
  paintHud();
});

ticketRange.addEventListener("input", () => {
  game.setTicketPrice(Number(ticketRange.value));
  paintHud(true);
});


window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeMenus();
    settingsEl.classList.add("hidden");
    settingsBtn.classList.remove("on");
    game.cancel();
    paintHud();
  }
  if (e.key === "Enter" && (game.tool === "cut" || game.tool === "road")) {
    const result = game.finishTrail();
    if (result === "ok") audio.build();
    if (result === "shake") audio.error();
    paintHud();
  }
  if (e.key === " " && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    game.togglePause();
    paintHud();
  }
  if (e.key === "1" || e.key === "2" || e.key === "3") game.setSpeed(Number(e.key));
  if ((e.key === "g" || e.key === "G") && !(e.target instanceof HTMLInputElement)) toggleSlopeView();
});

function moneyLine(type: keyof typeof COSTS): string {
  const lot = PARKING[type];
  if (lot) return `$${COSTS[type].toLocaleString()} · up to $${INCOME_PER_MIN[type]}/min in fees`;
  if (type === "heli") {
    return `$${COSTS.heli.toLocaleString()} · $${HELI.fare}/seat · upkeep $${OPERATING_COST_PER_MIN.heli}/min`;
  }
  return `$${COSTS[type].toLocaleString()} · earns $${INCOME_PER_MIN[type]}/min`;
}

(Object.keys(COSTS) as Array<keyof typeof COSTS>).forEach((type) => {
  const el = document.querySelector(`#cost-${type}`);
  if (el) el.textContent = moneyLine(type);
});

const slopeBtn = document.querySelector<HTMLButtonElement>("#btn-slope")!;
function toggleSlopeView(): void {
  const on = !world.slopeViewOn;
  world.setSlopeView(on);
  slopeBtn.setAttribute("aria-pressed", String(on));
  slopeBtn.firstChild!.textContent = on ? "Hide steepness " : "Show steepness ";
  document.querySelector(".legend")!.classList.toggle("slope-on", on);
}
slopeBtn.addEventListener("click", toggleSlopeView);

moveBtn.addEventListener("click", () => {
  if (game.selected?.kind !== "building") return;
  game.startMove(game.selected.id);
  audio.click();
  paintHud();
});
settingsBtn.addEventListener("click", () => {
  const open = settingsEl.classList.toggle("hidden") === false;
  settingsBtn.setAttribute("aria-expanded", String(open));
  settingsBtn.classList.toggle("on", open);
});
freeTreesOpt.addEventListener("change", () => {
  game.freeTreeClearing = freeTreesOpt.checked;
  game.toast(game.freeTreeClearing ? "Tree clearing is free." : `Tree clearing costs $${TREE_FELL_COST} a tree.`);
  paintHud();
});
freeShapingOpt.addEventListener("change", () => {
  game.freeShaping = freeShapingOpt.checked;
  game.toast(game.freeShaping ? "Terrain shaping is free." : `Terrain shaping costs $${EARTH_COST_PER_M3} per m³ of earth moved.`);
  paintHud();
});
moveFeeOpt.addEventListener("change", () => {
  game.moveFeeOn = moveFeeOpt.checked;
  game.toast(game.moveFeeOn ? "Moving buildings costs 25% of their price." : "Moving buildings is free.");
  paintHud();
});

removeLiftBtn.addEventListener("click", () => {
  if (game.selected?.kind !== "lift") return;
  game.removeLift(game.selected.id);
  audio.build();
  paintHud();
});

window.addEventListener("resize", () => world.resize());
world.resize();
paintHud(true);
requestAnimationFrame(loop);
document.querySelectorAll<HTMLButtonElement>(".shape-mode").forEach((b) =>
  b.addEventListener("click", () => {
    game.setShapeMode(b.dataset.mode as SculptMode);
    audio.click();
    paintHud();
  }),
);
document.querySelectorAll<HTMLButtonElement>(".shape-size").forEach((b) =>
  b.addEventListener("click", () => {
    game.shapeRadius = Number(b.dataset.size);
    audio.click();
    paintHud();
  }),
);
document.querySelector("#btn-shape-done")!.addEventListener("click", () => {
  game.cancel();
  paintHud();
});
