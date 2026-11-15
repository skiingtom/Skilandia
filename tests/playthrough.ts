/**
 * Headless playthrough on the real map: build one of everything around the
 * starter T-bar, run the sim for 30 game minutes checking invariants every
 * tick, then make sure every peak can be conquered and the game can be won.
 *
 * Run with: npm test
 */
import { elevationM } from "../src/height";
import { Game, SUMMITS, nearestOnTrail } from "../src/sim";
import { BASE, TIERS, TRAIL_KIND_SPEC, Vec2 } from "../src/types";

const g = new Game();
g.startManaging();
g.money = 1e9;
const problems: string[] = [];
const ok = (cond: boolean, msg: string) => {
  if (!cond && problems.length < 30) problems.push(msg);
};

// --- the starter resort
const tbar = g.lifts[0];
ok(g.lifts.length === 1 && tbar.type === "tbar", "should start with one T-bar");
ok(g.trails.length >= 2, "should start with runs beside the T-bar");
const lift = { a: tbar.bottom, b: tbar.top };
const len = Math.hypot(lift.b.x - lift.a.x, lift.b.y - lift.a.y);
const ux = (lift.b.x - lift.a.x) / len;
const uy = (lift.b.y - lift.a.y) / len;
/** A point along the T-bar line (t: 0 bottom..1 top), pushed sideways by `side` metres. */
const along = (t: number, side: number): Vec2 => ({
  x: lift.a.x + (lift.b.x - lift.a.x) * t - uy * side,
  y: lift.a.y + (lift.b.y - lift.a.y) * t + ux * side,
});

const cut = (kind: string, pts: Vec2[]) => {
  g.setTool(`trail:${kind}` as never);
  for (const p of pts) g.click(p.x, p.y);
  const r = g.finishTrail();
  console.log(`cut ${kind}:`, r, r === "ok" ? "" : g.toasts.at(-1)?.text);
  return r;
};

cut("park", [along(1, 220), along(0.6, 260), along(0.25, 240), along(0.02, 200)]);
cut("slalom", [along(1, -220), along(0.6, -260), along(0.2, -240), along(0.02, -200)]);
cut("moguls", [along(0.95, 380), along(0.5, 400), along(0.05, 360)]);
// Glades: through the forest further out.
const gladesOk = cut("glades", [along(0.95, -420), along(0.6, -460), along(0.25, -440), along(0.05, -380)]);
ok(gladesOk === "ok", "glades should cut through forest");

const park = g.trails.find((t) => t.kind === "park");
ok(!!park, "park run was not created");
if (park) {
  // Upper part of the park, well above the village.
  const a = park.points[0];
  const b = park.points[1];
  for (const [type, u] of [["jump", 0.1], ["rail", 0.3], ["box", 0.45], ["halfpipe", 0.75]] as const) {
    g.setTool(`feature:${type}`);
    const r = g.click(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u);
    ok(r === "ok", `${type} in the park failed: ${g.toasts.at(-1)?.text}`);
  }
}
ok(!!g.canPlaceFeature("jump", BASE.x + 3000, BASE.y - 3000), "off-run jump should be rejected");

// Village buildings around the base
const spots: [string, number, number][] = [
  ["lodge", 150, 120],
  ["restroom", -150, 60],
  ["coffee", 200, -40],
  ["school", -220, -120],
  ["rental", -80, 140],
  ["cafeteria", 80, -160],
  ["heli", 260, 260],
];
for (const [type, dx, dy] of spots) {
  g.setTool(type as never);
  const r = g.click(BASE.x + dx, BASE.y + dy);
  ok(r === "ok", `${type} in the village failed: ${g.toasts.at(-1)?.text}`);
}
// Clinic sits on the mountain, outside the village ring.
{
  const tbar = g.lifts[0];
  const mid = {
    x: (tbar.bottom.x + tbar.top.x) / 2 + 90,
    y: (tbar.bottom.y + tbar.top.y) / 2,
  };
  g.setTool("clinic");
  ok(g.click(mid.x, mid.y) === "ok", `clinic on the mountain failed: ${g.toasts.at(-1)?.text}`);
}
// Expansion buildings unlock after the first peak; conquer Hollin first, then place a few.
{
  const p = SUMMITS.find((s) => s.id === "hollin")!;
  const dx = BASE.x - p.x;
  const dy = BASE.y - p.y;
  const d = Math.hypot(dx, dy);
  const bottom = { x: p.x + (dx / d) * 2500, y: p.y + (dy / d) * 2500 };
  const top = { x: p.x + (dx / d) * 40, y: p.y + (dy / d) * 40 };
  g.setTool("lift:gondola");
  g.click(bottom.x, bottom.y);
  ok(g.click(top.x, top.y) === "ok", `early gondola to Hollin failed: ${g.toasts.at(-1)?.text}`);
  ok(g.conquered.has("hollin"), "Hollin should unlock expansion buildings");
}
const expansionSpots: [string, number, number][] = [
  ["bar", -280, 40],
  ["hostel", 320, -80],
  ["spa", -40, 220],
];
for (const [type, dx, dy] of expansionSpots) {
  g.setTool(type as never);
  const r = g.click(BASE.x + dx, BASE.y + dy);
  ok(r === "ok", `${type} after first peak failed: ${g.toasts.at(-1)?.text}`);
}
g.hire("instructor");
g.hire("instructor");
ok(!!g.helipad(), "heli base not built");

// --- 30 game minutes
const stuck = new Map<number, { state: string; t: number }>();
const liftIdle = new Map<number, number>();
let peakSkiers = 0;
let flights = 0;
let wasFlying = false;
for (let i = 0; i < 36000; i++) {
  g.tick(0.05);
  ok(Number.isFinite(g.money), `money became ${g.money}`);
  peakSkiers = Math.max(peakSkiers, g.skiers.length);
  ok(g.skiers.length <= g.capacity(), `over capacity: ${g.skiers.length} > ${g.capacity()}`);
  ok(g.skiers.length <= g.loadLimits().comfortable + 25, `more skiers (${g.skiers.length}) than the resort can handle (${g.loadLimits().comfortable})`);
  if (i % 200 === 0) ok(g.liftWait() < 90, `lift lines got long: ${g.liftWait().toFixed(0)}s`);
  if (g.heli.flying && !wasFlying) flights++;
  wasFlying = g.heli.flying;
  for (const l of g.lifts) {
    const inLine = g.skiers.some((s) => s.liftId === l.id && s.state === "queue");
    const boarding = g.skiers.some((s) => s.liftId === l.id && s.state === "riding");
    liftIdle.set(l.id, inLine && !boarding ? (liftIdle.get(l.id) ?? 0) + 0.05 : 0);
    ok((liftIdle.get(l.id) ?? 0) < 30, `${l.name} has a line but nobody has boarded for 30s`);
  }
  for (const s of g.skiers) {
    ok(Number.isFinite(s.x) && Number.isFinite(s.y), `skier ${s.id} has NaN position in ${s.state}`);
    ok(s.mood >= 0 && s.mood <= 100, `skier ${s.id} mood out of range: ${s.mood}`);
    if (s.state === "skiing" && s.trailId != null && s.trailId >= 0) {
      const t = g.trails.find((tr) => tr.id === s.trailId)!;
      const d = nearestOnTrail(t, s.x, s.y).d;
      ok(d <= TRAIL_KIND_SPEC[t.kind].width / 2 + 1, `skier ${s.id} is ${d.toFixed(1)} m off ${t.kind} run ${t.name}`);
    }
    const prev = stuck.get(s.id);
    if (!prev || prev.state !== s.state) stuck.set(s.id, { state: s.state, t: 0 });
    else {
      prev.t += 0.05;
      if (s.state !== "queue") ok(prev.t < 150, `skier ${s.id} stuck in ${s.state} for ${prev.t.toFixed(0)}s`);
    }
  }
}
console.log({
  runs: g.trails.length,
  skiers: g.skiers.length,
  peakSkiers,
  comfortable: g.loadLimits().comfortable,
  tickets: g.totalTickets,
  heliFlights: flights,
  mood: Math.round(g.mood),
  forestVersion: g.forestVersion,
});
ok(g.totalTickets > 100, "hardly anyone came");

// --- conquer every remaining peak with a gondola from somewhere below it
for (const p of SUMMITS) {
  if (g.conquered.has(p.id)) continue;
  // Bottom station: out from the summit toward the base, as far as a gondola reaches.
  const dx = BASE.x - p.x;
  const dy = BASE.y - p.y;
  const d = Math.hypot(dx, dy);
  let built = false;
  for (const reach of [6000, 5000, 4000, 3000, 2000]) {
    const r = Math.min(reach, d - 50);
    const bottom = { x: p.x + (dx / d) * r, y: p.y + (dy / d) * r };
    const top = { x: p.x + (dx / d) * 40, y: p.y + (dy / d) * 40 };
    g.setTool("lift:gondola");
    g.click(bottom.x, bottom.y);
    if (g.click(top.x, top.y) === "ok") {
      built = true;
      break;
    }
    g.cancel();
  }
  ok(built, `couldn't run a gondola to ${p.name}: ${g.toasts.at(-1)?.text}`);
  ok(g.conquered.has(p.id), `${p.name} (${p.elevation} m, ground at ${Math.round(elevationM(p.x, p.y))} m) wasn't conquered`);
}
console.log(`conquered ${g.conquered.size}/${SUMMITS.length}, tier ${TIERS[g.tier()].name}, won: ${g.won}`);
ok(g.won, "conquering every peak should win the game");
ok(g.capacity() === TIERS[TIERS.length - 1].capacity, "should reach the top tier");
for (let i = 0; i < 2000; i++) g.tick(0.05);
ok(Number.isFinite(g.money), "money NaN after conquering");

console.log(problems.length ? `PROBLEMS (${problems.length}):\n` + problems.join("\n") : "ALL CHECKS PASSED");
if (problems.length) process.exit(1);
