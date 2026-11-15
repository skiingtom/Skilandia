/**
 * Headless playthrough on the real map: build one of everything around the
 * starter T-bar, run the sim for 30 game minutes checking invariants every
 * tick, then make sure every peak can be conquered and the game can be won.
 *
 * Run with: npm test
 */
import { MAX_EARTHWORK_M, earthworkAt, elevationM, gradeAt, isRock } from "../src/height";
import { nearestOnRoad } from "../src/roads";
import { Game, SUMMITS, nearestOnTrail } from "../src/sim";
import { BASE, BuildingType, PARKING, STARTER_LOT_SKIERS, TIERS, TRAIL_KIND_SPEC, Vec2 } from "../src/types";

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

// --- the access road: nobody drives in until the parking lot reaches the highway
ok(!g.roadConnected(), "parking lot should start unconnected");
const before = g.skiers.length;
for (let i = 0; i < 600; i++) g.tick(0.05);
ok(g.skiers.length <= before, "skiers arrived with no road");
{
  const exit = g.exit();
  const hw = nearestOnRoad(g.roads[0].points, exit.x, exit.y).p;
  g.setTool("road");
  ok(g.click(hw.x, hw.y) === "ok", "road should start on the highway");
  // Two legs: halfway, then the parking lot (which finishes it).
  g.click((hw.x + exit.x) / 2, (hw.y + exit.y) / 2);
  const r = g.click(exit.x, exit.y);
  ok(r === "ok" && g.roadConnected(), `access road failed: ${g.toasts.at(-1)?.text}`);
  console.log("access road:", g.toasts.at(-1)?.text, "route pts", g.carRoute()?.length);
}

// --- parking: lots go beside a connected road and add room for skiers
{
  ok(g.parkingCapacity() === STARTER_LOT_SKIERS, `starter parking should hold ${STARTER_LOT_SKIERS}, got ${g.parkingCapacity()}`);
  /** Somewhere beside a road (either side) where this type can go. */
  const spotBeside = (type: BuildingType, roadIndex: number): Vec2 | null => {
    const r = g.roads[roadIndex];
    const R = PARKING[type]!.radius;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1];
      const b = r.points[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      for (const t of [0.5, 0.25, 0.75]) {
        for (const side of [1, -1]) {
          const p = { x: a.x + (b.x - a.x) * t - ((b.y - a.y) / len) * (R + 8) * side, y: a.y + (b.y - a.y) * t + ((b.x - a.x) / len) * (R + 8) * side };
          if (!g.canPlace(type, p.x, p.y)) return p;
        }
      }
    }
    return null;
  };
  const access = g.roads.findIndex((r) => !r.highway);
  let spot = spotBeside("parkingSmall", access) ?? spotBeside("parkingSmall", 0);
  ok(!!spot, "no room for a small lot beside the roads");
  if (spot) {
    g.setTool("parkingSmall");
    ok(g.click(spot.x, spot.y) === "ok", `small lot failed: ${g.toasts.at(-1)?.text}`);
    ok(g.parkingCapacity() === STARTER_LOT_SKIERS + PARKING.parkingSmall!.skiers, `parking didn't grow: ${g.parkingCapacity()}`);
    const lot = g.buildings.at(-1)!;
    ok(lot.angle !== undefined, "lot should line up with the road");
  }
  // Away from any road: refused.
  const far = { x: BASE.x + 2500, y: BASE.y - 2500 };
  ok(g.canPlace("parkingSmall", far.x, far.y) !== null, "a lot with no road beside it should be refused");
  // On top of the road: refused.
  const onRoad = g.roads[access].points[1];
  ok(g.canPlace("parkingLarge", onRoad.x, onRoad.y) !== null, "a lot on the road itself should be refused");
  // The garage waits for the first peak.
  ok(!g.expansionUnlocked() && g.canPlace("garage", BASE.x, BASE.y) !== null, "garage should be locked at first");
  // Skiers park at the new lot too, and the limit holds.
  for (let i = 0; i < 3000; i++) g.tick(0.05);
  ok(g.skiers.length <= g.loadLimits().parking + 25, `more skiers (${g.skiers.length}) than parking (${g.loadLimits().parking})`);
  if (spot) {
    ok(g.skiers.some((s) => Math.hypot(s.lot.x - spot!.x, s.lot.y - spot!.y) < 1), "nobody parked in the new lot");
    // Demolish it: capacity drops back, and its parkers still find their car.
    g.setTool("demolish");
    ok(g.click(spot.x, spot.y) === "ok", `couldn't demolish the lot: ${g.toasts.at(-1)?.text}`);
    ok(g.parkingCapacity() === STARTER_LOT_SKIERS, "capacity didn't drop after demolishing the lot");
  }
}
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
// Cabins: need the rental office, and a run at the door.
{
  g.setTool("cabin");
  ok(g.canPlace("cabin", BASE.x + 3000, BASE.y - 3000)?.includes("office") === true, "cabin should need the rental office first");
  g.setTool("cabinOffice");
  ok(g.click(BASE.x + 60, BASE.y - 230) === "ok", `cabin office failed: ${g.toasts.at(-1)?.text}`);
  // Find a spot beside a run, out of the village.
  let spot: Vec2 | null = null;
  for (const t of g.trails) {
    for (let i = 1; i < t.points.length && !spot; i++) {
      const a = t.points[i - 1];
      const b = t.points[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      for (const u of [0.2, 0.5, 0.8]) {
        for (const off of [25, 35, 45, -25, -35, -45]) {
          const p = { x: a.x + (b.x - a.x) * u - ((b.y - a.y) / len) * off, y: a.y + (b.y - a.y) * u + ((b.x - a.x) / len) * off };
          if (!spot && g.canPlace("cabin", p.x, p.y) === null) spot = p;
        }
      }
    }
  }
  ok(!!spot, "no hillside spot for a cabin");
  if (spot) {
    g.setTool("cabin");
    ok(g.click(spot.x, spot.y) === "ok", `ski-in cabin failed: ${g.toasts.at(-1)?.text}`);
    ok(g.skiInCabins() === 1, "the cabin should count as ski-in / ski-out");
  }
  ok(g.canPlace("cabin", BASE.x + 3000, BASE.y - 3000) !== null, "a cabin far from any run should be refused");
  g.setTool("select");
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
// New food, restaurants, shops and hotels: find room for each one in the village.
{
  const place = (type: BuildingType): boolean => {
    for (let r = 120; r <= 480; r += 30) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 16) {
        const x = BASE.x + Math.cos(a) * r;
        const y = BASE.y + Math.sin(a) * r;
        if (g.canPlace(type, x, y) === null) {
          g.setTool(type as never);
          return g.click(x, y) === "ok";
        }
      }
    }
    return false;
  };
  for (const type of ["pizza", "burger", "bakery", "noodle", "foodTruck", "fondue", "brewpub", "sushi", "skiShop", "gifts", "grocery", "boutique", "motel", "bnb", "inn"] as BuildingType[]) {
    ok(place(type), `${type} in the village failed: ${g.toasts.at(-1)?.text}`);
  }
  ok(g.canPlace("grandHotel", BASE.x, BASE.y)?.includes("peaks") === true, "the grand hotel should wait for a regional resort");
  ok(g.canPlace("summit", BASE.x + 150, BASE.y)?.includes("peaks") === true, "the summit restaurant should wait for more peaks");
  ok(g.canPlace("waffle", BASE.x + 3000, BASE.y - 3000)?.includes("beside a run") === true, "a waffle hut needs a run nearby");
  ok(g.amenityScore() > 1.65, `new places should raise appeal past the old cap (${g.amenityScore().toFixed(2)})`);
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

// --- the tree brush: fells standing trees, charges per tree, and they stay gone
{
  let spot: Vec2 | null = null;
  for (let a = 0; a < 36 && !spot; a++) {
    for (const d of [700, 900, 1200]) {
      const p = { x: BASE.x + Math.cos(a / 5.7) * d, y: BASE.y + Math.sin(a / 5.7) * d };
      if (g.treesUnderBrush(p.x, p.y) > 10) {
        spot = p;
        break;
      }
    }
  }
  ok(!!spot, "no forest to test the brush on");
  if (spot) {
    const n = g.treesUnderBrush(spot.x, spot.y);
    const money = g.money;
    g.setTool("clearTrees");
    ok(g.click(spot.x, spot.y) === "ok", "brush should fell trees");
    ok(g.treesUnderBrush(spot.x, spot.y) === 0, "trees still standing under the brush");
    ok(Math.abs(money - g.money - n * 4) < 1, `brush charged ${money - g.money} for ${n} trees`);
    g.endBrush();

    // Replant the clearing: the area brush scatters saplings, a single click plants one.
    g.setTool("plantTrees");
    g.plantMode = "brush";
    const before = g.money;
    ok(g.click(spot.x, spot.y) === "ok", `planting brush failed: ${g.toasts.at(-1)?.text}`);
    const planted = g.treesUnderBrush(spot.x, spot.y);
    ok(planted > 0, "planting brush planted nothing");
    ok(Math.abs(before - g.money - planted * 12) < 1, `planting charged ${before - g.money} for ${planted} trees`);
    g.endBrush();
    g.plantMode = "single";
    const free = { x: spot.x + 22, y: spot.y + 22 };
    const nearBefore = g.treesIn(free.x - 3, free.y - 3, free.x + 3, free.y + 3).length;
    const single = g.click(free.x, free.y);
    if (single === "ok") ok(g.treesIn(free.x - 3, free.y - 3, free.x + 3, free.y + 3).length === nearBefore + 1, "single plant should add one tree");
    // Clearing again digs the planted trees back up.
    g.setTool("clearTrees");
    g.click(spot.x, spot.y);
    g.endBrush();
    ok(g.treesUnderBrush(spot.x, spot.y) === 0, "planted trees survived the clearing brush");
    g.setTool("select");
  }
}

// --- the forest isn't laid out on a grid: tree spacing along a row varies widely
{
  const xs = g.treesIn(BASE.x + 2000, BASE.y - 2006, BASE.x + 2600, BASE.y - 1994).map((t) => t.x).sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, gaps.length));
  ok(gaps.length < 5 || sd / mean > 0.5, `forest looks gridded (spacing sd/mean ${(sd / mean).toFixed(2)})`);
}

// --- rocks: above the rock line, a run can't be cut straight through an outcrop
{
  let found = false;
  for (let x = 2000; x < 26000 && !found; x += 97) {
    for (let y = 2000; y < 15000 && !found; y += 89) {
      if (!isRock(x, y) || elevationM(x, y) < 2100) continue;
      // Snow above and below the outcrop, along the fall line.
      const a = { x, y: y - 90 };
      const b = { x, y: y + 90 };
      if (isRock(a.x, a.y) || isRock(b.x, b.y)) continue;
      const [hi, lo] = elevationM(a.x, a.y) > elevationM(b.x, b.y) ? [a, b] : [b, a];
      if (elevationM(hi.x, hi.y) - elevationM(lo.x, lo.y) < 15) continue;
      found = true;
      g.setTool("trail:slope");
      ok(g.click(hi.x, hi.y) === "ok", "run should start on snow");
      ok(g.click(lo.x, lo.y) === "shake", "run went straight through rock");
      g.cancel();
    }
  }
  ok(found, "found no outcrop to test against");
}

// --- demolish: one of each kind, with salvage, and the hill keeps working
{
  const pickOne = <T,>(xs: T[]) => xs[xs.length - 1];
  const demolish = (x: number, y: number, kind: string) => {
    g.setTool("demolish");
    const t = g.demolishTarget(x, y);
    ok(t?.kind === kind, `demolish at ${kind} found ${t?.kind}`);
    const money = g.money;
    const r = g.click(x, y);
    ok(r === "ok", `demolish ${kind} failed: ${g.toasts.at(-1)?.text}`);
    ok(g.money - money === (t?.refund ?? 0), `${kind} salvage mismatch`);
  };
  const shop = pickOne(g.buildings.filter((b) => b.type !== "heli"));
  ok(!!shop, "no building to demolish");
  if (shop) {
    demolish(shop.x, shop.y, "building");
    ok(!g.buildings.includes(shop), "building still there");
  }
  const jump = g.features.find((f) => f.type === "jump");
  if (jump) demolish(jump.x, jump.y, "feature");
  const moguls = g.trails.find((t) => t.kind === "moguls")!;
  const mid = moguls.points[1];
  demolish(mid.x, mid.y, "trail");
  ok(!g.trails.includes(moguls), "trail still there");
  ok(g.treesIn(mid.x - 5, mid.y - 5, mid.x + 5, mid.y + 5).length === 0, "trees sprang back on a demolished run");
  const lastLift = g.lifts[g.lifts.length - 1];
  const lm = { x: (lastLift.bottom.x + lastLift.top.x) / 2, y: (lastLift.bottom.y + lastLift.top.y) / 2 };
  demolish(lm.x, lm.y, "lift");
  ok(!g.lifts.includes(lastLift), "lift still there");
  // The access road: tearing it out cuts off the lot; rebuilding reconnects it.
  const road = g.roads.find((r) => !r.highway)!;
  const rp = { x: (road.points[0].x + road.points[1].x) / 2, y: (road.points[0].y + road.points[1].y) / 2 };
  demolish(rp.x, rp.y, "road");
  ok(!g.roadConnected(), "lot still connected after its road was demolished");
  g.setTool("demolish");
  const hw = g.roads[0].points[5];
  ok(g.demolishTarget(hw.x, hw.y) === null, "the highway shouldn't be demolishable");
  const exit = g.exit();
  const hp = nearestOnRoad(g.roads[0].points, exit.x, exit.y).p;
  g.setTool("road");
  g.click(hp.x, hp.y);
  g.click((hp.x + exit.x) / 2, (hp.y + exit.y) / 2);
  g.click(exit.x, exit.y);
  ok(g.roadConnected(), "couldn't reconnect the lot");
  for (let i = 0; i < 2000; i++) g.tick(0.05);
  ok(Number.isFinite(g.money), "money broke after demolishing");
  ok(g.skiers.every((s) => s.trailId === null || s.trailId < 0 || g.trails.some((t) => t.id === s.trailId)), "skier left on a demolished run");
}

// --- terrain: buildings level their pad, and the shaping brush moves earth
{
  // A restroom on the gentle ground of the village sits on a level pad at the median height.
  let spot: Vec2 | null = null;
  for (let a = 0; a < 72 && !spot; a++) {
    for (const d of [150, 250, 350]) {
      const p = { x: BASE.x + Math.cos(a / 11.4) * d, y: BASE.y + Math.sin(a / 11.4) * d };
      if (!g.canPlace("restroom", p.x, p.y) && gradeAt(p.x, p.y) > 0.05) {
        spot = p;
        break;
      }
    }
  }
  ok(!!spot, "no sloping village spot for a restroom");
  if (spot) {
    g.setTool("restroom");
    ok(g.click(spot.x, spot.y) === "ok", `restroom failed: ${g.toasts.at(-1)?.text}`);
    const hs = [-8, 0, 8].flatMap((dx) => [-8, 0, 8].map((dy) => elevationM(spot!.x + dx, spot!.y + dy)));
    ok(Math.max(...hs) - Math.min(...hs) < 0.6, `pad isn't level: ${(Math.max(...hs) - Math.min(...hs)).toFixed(2)} m`);
  }

  // Raise somewhere open: the ground comes up, money goes down, and it stops at the limit.
  const open = { x: BASE.x + 2600, y: BASE.y + 1800 };
  const h0 = elevationM(open.x, open.y);
  const money = g.money;
  g.setTool("shape");
  g.setShapeMode("raise");
  g.shapeRadius = 60;
  for (let i = 0; i < 20; i++) g.shapeStep(open.x, open.y, 0.05);
  const h1 = elevationM(open.x, open.y);
  ok(h1 > h0 + 2, `raise barely moved the ground (${(h1 - h0).toFixed(2)} m)`);
  ok(g.money < money, "shaping should cost money");
  g.endShape();
  for (let i = 0; i < 600; i++) g.shapeStep(open.x, open.y, 0.05);
  g.endShape();
  ok(Math.abs(earthworkAt(open.x, open.y) - MAX_EARTHWORK_M) < 0.5, `fill limit not held: ${earthworkAt(open.x, open.y).toFixed(1)} m`);
  // Smooth and flatten pull it back toward the surroundings / a level.
  g.setShapeMode("smooth");
  for (let i = 0; i < 40; i++) g.shapeStep(open.x, open.y, 0.05);
  g.endShape();
  ok(elevationM(open.x, open.y) < h0 + MAX_EARTHWORK_M - 1, "smooth didn't round the mound off");
  g.setShapeMode("lower");
  for (let i = 0; i < 1200; i++) g.shapeStep(open.x, open.y, 0.05);
  g.endShape();
  ok(Math.abs(earthworkAt(open.x, open.y) + MAX_EARTHWORK_M) < 0.5, `cut limit not held: ${earthworkAt(open.x, open.y).toFixed(1)} m`);

  // Shaping right over a building leaves its pad alone.
  if (spot) {
    const before = elevationM(spot.x, spot.y);
    g.setShapeMode("raise");
    for (let i = 0; i < 40; i++) g.shapeStep(spot.x, spot.y, 0.05);
    g.endShape();
    ok(Math.abs(elevationM(spot.x, spot.y) - before) < 0.01, "shaping moved the ground under a building");
  }
  g.cancel();
}

// --- settings: free tree clearing and free shaping cost nothing (and still work)
{
  g.freeTreeClearing = true;
  g.freeShaping = true;
  let spot: Vec2 | null = null;
  for (let a = 0; a < 36 && !spot; a++) {
    const p = { x: BASE.x + Math.cos(a / 5.7) * 1500, y: BASE.y + Math.sin(a / 5.7) * 1500 };
    if (g.treesUnderBrush(p.x, p.y) > 10) spot = p;
  }
  ok(!!spot, "no forest for the free-clearing test");
  if (spot) {
    const money = g.money;
    g.setTool("clearTrees");
    ok(g.click(spot.x, spot.y) === "ok" && g.treesUnderBrush(spot.x, spot.y) === 0, "free clearing didn't fell the trees");
    g.endBrush();
    g.setTool("shape");
    g.setShapeMode("raise");
    const h0 = elevationM(spot.x + 300, spot.y);
    for (let i = 0; i < 20; i++) g.shapeStep(spot.x + 300, spot.y, 0.05);
    g.endShape();
    ok(elevationM(spot.x + 300, spot.y) > h0 + 1, "free shaping didn't move the ground");
    ok(g.money === money, `free tools still charged $${(money - g.money).toFixed(2)}`);
    // Free shaping works even when broke.
    g.money = 0;
    const h1 = elevationM(spot.x - 300, spot.y);
    for (let i = 0; i < 20; i++) g.shapeStep(spot.x - 300, spot.y, 0.05);
    g.endShape();
    ok(elevationM(spot.x - 300, spot.y) > h1 + 1, "free shaping refused with no money");
    g.money = money;
  }
  g.freeTreeClearing = false;
  g.freeShaping = false;
  g.cancel();
}

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

// --- once unlocked, a parking garage goes up beside the highway or a road
{
  let placed = false;
  for (const r of g.roads) {
    for (let i = 1; i < r.points.length && !placed; i++) {
      const a = r.points[i - 1];
      const b = r.points[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      for (const side of [1, -1]) {
        const R = PARKING.garage!.radius + 8;
        const p = { x: (a.x + b.x) / 2 - ((b.y - a.y) / len) * R * side, y: (a.y + b.y) / 2 + ((b.x - a.x) / len) * R * side };
        if (g.canPlace("garage", p.x, p.y)) continue;
        const before = g.parkingCapacity();
        g.setTool("garage");
        placed = g.click(p.x, p.y) === "ok" && g.parkingCapacity() === before + PARKING.garage!.skiers;
        break;
      }
    }
    if (placed) break;
  }
  ok(placed, "couldn't build a parking garage anywhere beside a road");
}
ok(g.capacity() === TIERS[TIERS.length - 1].capacity, "should reach the top tier");
for (let i = 0; i < 2000; i++) g.tick(0.05);
ok(Number.isFinite(g.money), "money NaN after conquering");

console.log(problems.length ? `PROBLEMS (${problems.length}):\n` + problems.join("\n") : "ALL CHECKS PASSED");
if (problems.length) process.exit(1);
