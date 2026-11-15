/**
 * Headless playthrough: build one of everything, run the sim for a long
 * time, and check invariants every tick.
 */
import { Game, nearestOnTrail } from "../src/sim";
import { MAP_SCALE as K, TRAIL_KIND_SPEC, HELI } from "../src/types";

// Run with: npm test
const g = new Game();
g.startManaging();
g.money = 400000;
const problems: string[] = [];
const ok = (cond: boolean, msg: string) => {
  if (!cond && problems.length < 30) problems.push(msg);
};

const cut = (kind: string, pts: number[][]) => {
  const before = g.trees.length;
  g.setTool(`trail:${kind}` as never);
  for (const [x, y] of pts) g.click(x * K, y * K);
  const r = g.finishTrail();
  console.log(`cut ${kind}:`, r, g.toasts.at(-1)?.text, `(trees ${before} -> ${g.trees.length})`);
  return r;
};

// Glades through open snow should fail; through forest should work and keep trees.
cut("glades", [[330, 140], [340, 135]]);
const forest = (() => {
  // find a dense forest column on the gentle side
  let best = { x: 0, n: 0 };
  for (let x = 120; x < 300; x += 10) {
    const n = g.trees.filter((t) => Math.abs(t.x - x * K) < 30 && t.y > 300 * K && t.y < 560 * K).length;
    if (n > best.n) best = { x, n };
  }
  return best.x;
})();
const gTrees = g.trees.length;
cut("glades", [[forest, 600], [forest, 450], [forest + 10, 300]]);
const glade = g.trails.find((t) => t.kind === "glades");
ok(!!glade, "glades run was not created");
if (glade) {
  const inside = g.trees.filter((t) => nearestOnTrail(glade, t.x, t.y).d < TRAIL_KIND_SPEC.glades.width / 2).length;
  console.log("glade trees still standing inside corridor:", inside, "cleared:", gTrees - g.trees.length);
  ok(inside > 10, "glades should keep trees standing");
}
cut("park", [[345, 625], [420, 470], [430, 300], [380, 180]]);
cut("moguls", [[560, 540], [555, 300]]);
cut("slalom", [[230, 600], [235, 400], [260, 200]]);

// Features: jump off-run must fail now; on glades it's fine.
g.setTool("feature:jump");
console.log("jump off-run:", g.canPlaceFeature("jump", 60 * K, 500 * K));
ok(!!g.canPlaceFeature("jump", 60 * K, 500 * K), "off-run jump should be rejected");
if (glade) {
  const p = glade.points[1];
  console.log("jump in glades:", g.canPlaceFeature("jump", p.x, p.y) ?? "ok");
  g.click(p.x, p.y);
}

// Lifts
g.setTool("lift:quad");
g.click(420 * K, 140 * K);
console.log("quad:", g.click(450 * K, 640 * K), g.toasts.at(-1)?.text);

// Buildings: heli, school, lodge, food, restroom
for (const [type, x, y] of [["heli", 250, 110], ["school", 400, 90], ["lodge", 330, 175], ["restroom", 450, 150], ["coffee", 200, 150]] as const) {
  g.setTool(type);
  const r = g.click(x * K, y * K);
  console.log(type, r, g.toasts.at(-1)?.text);
}
g.hire("instructor");
g.hire("instructor");
const pad = g.helipad();
ok(!!pad, "heli base not built");

let maxWaitSeen = 0;
const stuck = new Map<number, { state: string; t: number }>();
let heliRiders = 0;
let flightsSeen = 0;
let wasFlying = false;
const money0 = g.money;
for (let i = 0; i < 36000; i++) {
  // 30 game minutes at 1x
  g.tick(0.05);
  ok(Number.isFinite(g.money), `money became ${g.money}`);
  if (g.heli.flying && !wasFlying) flightsSeen++;
  wasFlying = g.heli.flying;
  for (const s of g.skiers) {
    ok(Number.isFinite(s.x) && Number.isFinite(s.y), `skier ${s.id} has NaN position in ${s.state}`);
    if (s.state === "skiing" && s.trailId != null && s.trailId >= 0) {
      const t = g.trails.find((tr) => tr.id === s.trailId)!;
      const d = nearestOnTrail(t, s.x, s.y).d;
      ok(d <= TRAIL_KIND_SPEC[t.kind].width / 2 + 1, `skier ${s.id} is ${d.toFixed(1)} off ${t.kind} run ${t.name}`);
    }
    if (s.state === "heli") heliRiders++;
    const prev = stuck.get(s.id);
    if (!prev || prev.state !== s.state) stuck.set(s.id, { state: s.state, t: 0 });
    else {
      prev.t += 0.05;
      if (!["riding", "skiing", "heli", "queue"].includes(s.state)) maxWaitSeen = Math.max(maxWaitSeen, prev.t);
      ok(prev.t < 150, `skier ${s.id} stuck in ${s.state} for ${prev.t.toFixed(0)}s`);
    }
  }
}
console.log({
  days: g.day,
  skiers: g.skiers.length,
  tickets: g.totalTickets,
  heliFlights: flightsSeen,
  heliFare: HELI.fare,
  moneyDelta: Math.round(g.money - money0),
  upkeepPerMin: g.upkeepPerMin(),
  longestNonRideState: maxWaitSeen.toFixed(1),
  mood: Math.round(g.mood),
});
ok(flightsSeen > 0, "heli never flew");

// Mountain switching keeps everything
g.lifetimeEarned = 1e6;
g.money += 1e6;
console.log("buy Cedar:", g.buyMountain(1));
for (let i = 0; i < 2000; i++) g.tick(0.05);
g.switchMountain(0);
console.log("back on Little Hawk: trails", g.trails.length, "features", g.features.length, "heli", !!g.helipad(), "upkeep/min", g.upkeepPerMin());
for (let i = 0; i < 2000; i++) g.tick(0.05);
ok(Number.isFinite(g.money), "money NaN after switching");

console.log(problems.length ? `PROBLEMS (${problems.length}):\n` + problems.join("\n") : "ALL CHECKS PASSED");
if (problems.length) process.exit(1);
