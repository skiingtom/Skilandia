import { elevationM } from "./height";
import { BASE, Vec2, WORLD_H, WORLD_W } from "./types";

/** Roads: the highway down the valley, and the rules for roads the player builds. */

/** Dollars per metre of road. */
export const ROAD_COST_PER_M = 6;
/** Steepest a road leg may climb (rise / run). */
export const ROAD_MAX_GRADE = 0.14;
/** Shortest leg you can click. */
export const ROAD_MIN_LEG = 20;
/** How close a click has to be to snap onto a road or the parking lot. */
export const ROAD_SNAP = 34;
/** Asphalt width in metres (trees are cleared a little wider). */
export const ROAD_WIDTH = 9;

export interface Road {
  id: number;
  points: Vec2[];
  /** The highway that brings skiers in from out of the valley. */
  highway?: boolean;
}

/** Average grade of a road leg, sampled so a hump in the middle counts. */
export function legGrade(a: Vec2, b: Vec2): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1) return 0;
  const steps = Math.max(1, Math.ceil(len / 40));
  let worst = 0;
  let prev = elevationM(a.x, a.y);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const m = elevationM(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    worst = Math.max(worst, Math.abs(m - prev) / (len / steps));
    prev = m;
  }
  // Short humps are graded out: blend the worst stretch with the overall pitch.
  const overall = Math.abs(elevationM(b.x, b.y) - elevationM(a.x, a.y)) / len;
  return overall * 0.5 + worst * 0.5;
}

export function roadLength(points: Vec2[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return n;
}

/** Nearest point on a polyline, with the segment index it falls on. */
export function nearestOnRoad(points: Vec2[], x: number, y: number): { p: Vec2; seg: number; d: number; t: number } {
  let best = { p: points[0], seg: 0, d: Infinity, t: 0 };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (y - a.y) * aby) / (abx * abx + aby * aby || 1)));
    const p = { x: a.x + abx * t, y: a.y + aby * t };
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < best.d) best = { p, seg: i - 1, d, t };
  }
  return best;
}

const key = (p: Vec2) => `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;

/**
 * Shortest drive over the road network from either end of the highway to
 * `goal`. Roads join where a point is shared exactly (building a road splits
 * the one it joins), so the network is just the shared vertices.
 * Returns null if the goal isn't reachable.
 */
export function routeTo(roads: Road[], goal: Vec2): Vec2[] | null {
  const pts = new Map<string, Vec2>();
  const adj = new Map<string, { to: string; w: number }[]>();
  const link = (a: Vec2, b: Vec2) => {
    const ka = key(a);
    const kb = key(b);
    pts.set(ka, a);
    pts.set(kb, b);
    const w = Math.hypot(b.x - a.x, b.y - a.y);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka)!.push({ to: kb, w });
    adj.get(kb)!.push({ to: ka, w });
  };
  for (const r of roads) for (let i = 1; i < r.points.length; i++) link(r.points[i - 1], r.points[i]);
  const goalKey = key(goal);
  if (!adj.has(goalKey)) return null;
  const highway = roads.find((r) => r.highway);
  if (!highway) return null;
  const starts = [highway.points[0], highway.points[highway.points.length - 1]].map(key);
  // Dijkstra from the goal outwards (the graph is small: a few hundred vertices).
  const dist = new Map<string, number>([[goalKey, 0]]);
  const prev = new Map<string, string>();
  const open = new Set<string>([goalKey]);
  while (open.size) {
    let cur = "";
    let cd = Infinity;
    for (const k of open) {
      const d = dist.get(k)!;
      if (d < cd) {
        cd = d;
        cur = k;
      }
    }
    open.delete(cur);
    for (const e of adj.get(cur) ?? []) {
      const nd = cd + e.w;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, cur);
        open.add(e.to);
      }
    }
  }
  const from = starts.filter((s) => dist.has(s)).sort((a, b) => dist.get(a)! - dist.get(b)!)[0];
  if (!from) return null;
  const out: Vec2[] = [];
  for (let k: string | undefined = from; k; k = prev.get(k)) out.push(pts.get(k)!);
  return out;
}

/**
 * The highway follows the valley floor between the two lowest ways out of
 * the map: a least-cost path that prefers low, level ground, keeping its
 * distance from the village so you build the access road yourself.
 */
export const HIGHWAY: Vec2[] = (() => {
  const S = 84;
  const W = Math.floor(WORLD_W / S);
  const H = Math.floor(WORLD_H / S);
  const elev = new Float32Array((W + 1) * (H + 1));
  for (let j = 0; j <= H; j++) for (let i = 0; i <= W; i++) elev[j * (W + 1) + i] = elevationM(i * S + 1, j * S + 1);
  const at = (i: number, j: number) => elev[j * (W + 1) + i];

  // Exits: the lowest point on the map edge, then the lowest edge point far from it.
  const edge: { i: number; j: number; m: number }[] = [];
  for (let i = 0; i <= W; i++) edge.push({ i, j: 0, m: at(i, 0) }, { i, j: H, m: at(i, H) });
  for (let j = 0; j <= H; j++) edge.push({ i: 0, j, m: at(0, j) }, { i: W, j, m: at(W, j) });
  edge.sort((a, b) => a.m - b.m);
  const s = edge[0];
  const e = edge.find((p) => Math.hypot(p.i - s.i, p.j - s.j) * S > WORLD_W * 0.45)!;

  const N = (W + 1) * (H + 1);
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  // Binary heap of [cost, index].
  const heap: number[][] = [];
  const push = (c: number, n: number) => {
    heap.push([c, n]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  const start = s.j * (W + 1) + s.i;
  const goal = e.j * (W + 1) + e.i;
  dist[start] = 0;
  push(0, start);
  const floor = s.m;
  while (heap.length) {
    const [c, n] = pop();
    if (c > dist[n]) continue;
    if (n === goal) break;
    const i = n % (W + 1);
    const j = (n / (W + 1)) | 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni > W || nj > H) continue;
        const d = Math.hypot(di, dj) * S;
        const g = Math.abs(at(ni, nj) - at(i, j)) / d;
        const x = ni * S;
        const y = nj * S;
        const db = Math.hypot(x - BASE.x, y - BASE.y);
        // Stay out of the village, but swing past it like a resort road would.
        const near = Math.max(0, 1 - Math.max(0, db - 420) / 300);
        const pass = Math.exp(-(((db - 750) / 700) ** 2));
        const w = d * (1 + 90 * g * g + Math.max(0, at(ni, nj) - floor) / 220 + near * 12) * (1 - 0.55 * pass);
        const m = nj * (W + 1) + ni;
        if (c + w < dist[m]) {
          dist[m] = c + w;
          prev[m] = n;
          push(c + w, m);
        }
      }
    }
  }
  let path: Vec2[] = [];
  for (let n = goal; n >= 0; n = prev[n]) path.push({ x: (n % (W + 1)) * S, y: ((n / (W + 1)) | 0) * S });
  path = simplify(path, 22);
  // Round the corners off.
  for (let k = 0; k < 2; k++) {
    const out: Vec2[] = [path[0]];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(path[path.length - 1]);
    path = out;
  }
  return path.map((p) => ({ x: Math.min(WORLD_W - 1, Math.max(1, p.x)), y: Math.min(WORLD_H - 1, Math.max(1, p.y)) }));
})();

/** Ramer–Douglas–Peucker. */
function simplify(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 3) return pts;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let worst = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = nearestOnRoad([a, b], pts[i].x, pts[i].y).d;
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst < tol) return [a, b];
  const left = simplify(pts.slice(0, at + 1), tol);
  const right = simplify(pts.slice(at), tol);
  return [...left.slice(0, -1), ...right];
}
