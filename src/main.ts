import { AudioBus } from "./audio";
import { World3D } from "./scene";
import { Game } from "./sim";
import {
  BUILDING_MAX,
  BuildingType,
  COSTS,
  DIFF,
  INCOME_PER_MIN,
  MOUNTAINS,
  STAFF_LABEL,
  STAFF_ROLES,
  Tool,
} from "./types";
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

let last = performance.now();
let pointer = { x: 0, y: 0, downX: 0, downY: 0, over: false };

const moneyEl = document.querySelector("#stat-money")!;
const skiersEl = document.querySelector("#stat-skiers")!;
const moodEl = document.querySelector("#stat-mood")!;
const ticketsEl = document.querySelector("#stat-tickets")!;
const earnedEl = document.querySelector("#stat-earned")!;
const mountainsEl = document.querySelector("#mountains")!;
const staffSection = document.querySelector("#staff-section")!;
const staffList = document.querySelector("#staff-list")!;
const staffLock = document.querySelector("#staff-lock")!;
const dayEl = document.querySelector("#dayline")!;
const goalsEl = document.querySelector("#goals")!;
const complaintsEl = document.querySelector("#complaints")!;
const selTitle = document.querySelector("#sel-title")!;
const selBody = document.querySelector("#sel-body")!;
const ticketSection = document.querySelector("#ticket-section")!;
const ticketRange = document.querySelector<HTMLInputElement>("#ticket-range")!;
const ticketValue = document.querySelector("#ticket-value")!;
const ticketFair = document.querySelector("#ticket-fair")!;
const shopRate = document.querySelector("#shop-rate")!;
const cutBanner = document.querySelector("#cut-banner")!;
const cutDiff = document.querySelector("#cut-diff")!;
const cutCost = document.querySelector("#cut-cost")!;
const finishBtn = document.querySelector<HTMLButtonElement>("#btn-finish-trail")!;
const toastsEl = document.querySelector("#toasts")!;
const placeHint = document.querySelector("#place-hint")!;
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

function paintHud(force = false): void {
  moneyEl.textContent = `$${Math.round(game.money).toLocaleString()}`;
  skiersEl.textContent = String(game.skiers.length);
  moodEl.textContent = moodWord(game.mood);
  ticketsEl.textContent = String(game.ticketsToday);
  earnedEl.textContent = `$${Math.round(game.lifetimeEarned).toLocaleString()}`;
  dayEl.textContent = game.clockLabel();
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
    const wages = game.staffRequired() ? ` Wages today $${Math.round(game.wagesToday)}.` : "";
    shopRate.textContent = `About $${game.shopRatePerMin()}/min here. Take today $${Math.round(game.shopIncomeToday)}.${wages}`;
  }
  const expand = game.expansionUnlocked();
  document.querySelectorAll<HTMLButtonElement>(".tool").forEach((btn) => {
    const tool = btn.dataset.tool as Tool;
    btn.classList.toggle("on", game.tool === tool);
    if (tool === "select" || tool === "cut") {
      btn.disabled = false;
      return;
    }
    const type = tool as BuildingType;
    const atMax = game.count(type) >= BUILDING_MAX[type];
    btn.disabled = atMax || (btn.classList.contains("expansion") && !expand);
  });
  document.querySelectorAll<HTMLButtonElement>(".speed").forEach((btn) => {
    btn.classList.toggle("on", Number(btn.dataset.speed) === game.speed && !game.paused);
  });
  document.querySelector("#btn-pause")!.textContent = game.paused ? "Resume" : "Pause";
  cutBanner.classList.toggle("hidden", game.tool !== "cut");
  const info = game.draftInfo();
  if (info) {
    cutDiff.textContent = info.length < 8 ? "Click downhill" : DIFF[info.difficulty].name;
    cutCost.textContent = `$${info.cost}`;
    finishBtn.disabled = game.draft.length < 2 || info.length < 90;
  } else {
    cutDiff.textContent = "Click to start";
    cutCost.textContent = "$0";
    finishBtn.disabled = true;
  }
  canvas.classList.toggle("cut", game.tool === "cut");
  canvas.classList.toggle("place", game.tool !== "select" && game.tool !== "cut");
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

function paintMountains(): void {
  mountainsEl.innerHTML = MOUNTAINS.map((m) => {
    const st = game.mountainStatus(m.id);
    let note = m.blurb;
    if (st.owned) note = m.id === game.currentMountain ? "Managing this hill" : "Owned · click to fly over";
    else if (!st.canUnlock) note = `Earn $${st.missing.toLocaleString()} more to list it`;
    else note = `For sale · $${m.buyCost.toLocaleString()}`;
    return `<button type="button" class="mtn${st.owned && m.id === game.currentMountain ? " on" : ""}" data-mountain="${m.id}">
      ${m.name}<small>${note}</small></button>`;
  }).join("");
  mountainsEl.querySelectorAll<HTMLButtonElement>(".mtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.mountain) as 0 | 1 | 2;
      if (game.owned.includes(id)) game.switchMountain(id);
      else game.buyMountain(id);
      paintHud();
    });
  });
}

function paintStaff(): void {
  const required = game.staffRequired();
  staffSection.classList.toggle("locked", !required);
  staffLock.textContent = required
    ? "After Little Hawk you must staff the place. Short crews slow shop take and sour the mood."
    : "Payroll starts when you buy the next mountain. Then you need ski patrol, food, lifts, delivery, and maintenance.";
  const need = game.staffNeeds();
  staffList.innerHTML = STAFF_ROLES.map((role) => {
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
  if (pointer.over && game.tool !== "select" && game.tool !== "cut") {
    const hit = world.hitAt(pointer.x, pointer.y);
    if (hit && hit.mountain === game.currentMountain) {
      const type = game.tool as BuildingType;
      const err = game.canPlace(type, hit.x, hit.y);
      world.showGhost(type, hit.x, hit.y, !err);
      placeHint.classList.remove("hidden");
      placeHint.classList.toggle("ok", !err);
      placeHint.textContent = err ?? `Click to place ${type} in the village (sugar shacks can go on the hill).`;
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

canvas.addEventListener("pointerleave", () => {
  pointer.over = false;
});

canvas.addEventListener("pointerdown", (e) => {
  pointer.downX = e.clientX;
  pointer.downY = e.clientY;
});

canvas.addEventListener("pointerup", (e) => {
  if (!game.managing) return;
  if (e.button !== 0) return;
  if (Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY) > 6) return;
  const hit = world.hitAt(e.clientX, e.clientY);
  if (!hit) return;
  if (hit.mountain !== game.currentMountain) {
    if (game.owned.includes(hit.mountain)) game.switchMountain(hit.mountain);
    else game.buyMountain(hit.mountain);
    paintHud();
    return;
  }
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
  if (game.tool !== "cut") return;
  e.preventDefault();
  const result = game.finishTrail();
  if (result === "ok") audio.build();
  if (result === "shake") audio.error();
  paintHud();
});

document.querySelectorAll<HTMLButtonElement>(".tool").forEach((btn) => {
  btn.addEventListener("click", () => {
    game.setTool(btn.dataset.tool as Tool);
    audio.click();
    paintHud();
  });
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
  document.querySelector("#btn-mute")!.textContent = muted ? "Muted" : "Sound";
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
    game.cancel();
    paintHud();
  }
  if (e.key === "Enter" && game.tool === "cut") {
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
  return `$${COSTS[type].toLocaleString()} · $${INCOME_PER_MIN[type]}/min`;
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

window.addEventListener("resize", () => world.resize());
world.resize();
paintHud(true);
requestAnimationFrame(loop);
