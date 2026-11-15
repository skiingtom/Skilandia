import { Vec2 } from "./types";

/**
 * Footpaths: cleared, packed walkways the player paints between buildings,
 * lift stations and the parking lot. People on foot route along them (they
 * walk faster and happier on a path than wading through the snow).
 */

/** Dollars per metre of path. */
export const PATH_COST_PER_M = 2;
/** Walkway width in metres. */
export const PATH_WIDTH = 4.5;
/** Steepest a path leg may climb (steps and switchbacks beyond that). */
export const PATH_MAX_GRADE = 0.3;
/** Shortest leg you can click. */
export const PATH_MIN_LEG = 6;
/** How close a click has to be to join an existing path. */
export const PATH_SNAP = 16;
/** How much faster people walk on a path than through the snow. */
export const PATH_SPEED = 1.7;
/** Path nodes are at most this far apart. */
const NODE_GAP = 14;

export interface Path {
  id: number;
  points: Vec2[];
}

type Tree = { d: Float64Array; next: Int32Array };

/**
 * The walkable network: path polylines cut into nodes no more than a few
 * metres apart, joined wherever two paths meet. Shortest walks are found
 * backwards from each destination once and cached, since everyone heads for
 * the same handful of places (the ticket booth, lifts, buildings, the lot).
 */
export class PathNet {
  readonly nodes: Vec2[] = [];
  private adj: { to: number; w: number }[][] = [];
  private trees = new Map<string, Tree>();
  private grid = new Map<string, number[]>();
  private readonly cell = 60;

  constructor(paths: Path[]) {
    const link = (a: number, b: number) => {
      const w = Math.hypot(this.nodes[a].x - this.nodes[b].x, this.nodes[a].y - this.nodes[b].y) / PATH_SPEED;
      this.adj[a].push({ to: b, w });
      this.adj[b].push({ to: a, w });
    };
    const addNode = (p: Vec2) => {
      this.nodes.push({ x: p.x, y: p.y });
      this.adj.push([]);
      return this.nodes.length - 1;
    };
    for (const path of paths) {
      let prev = -1;
      for (let i = 0; i < path.points.length; i++) {
        const p = path.points[i];
        if (i > 0) {
          const a = path.points[i - 1];
          const len = Math.hypot(p.x - a.x, p.y - a.y);
          const n = Math.max(1, Math.ceil(len / NODE_GAP));
          for (let k = 1; k < n; k++) {
            const q = addNode({ x: a.x + ((p.x - a.x) * k) / n, y: a.y + ((p.y - a.y) * k) / n });
            link(prev, q);
            prev = q;
          }
        }
        const id = addNode(p);
        if (prev >= 0) link(prev, id);
        prev = id;
      }
    }
    // Spatial grid, then join nodes of different stretches that touch.
    this.nodes.forEach((p, i) => {
      const k = this.key(p.x, p.y);
      const list = this.grid.get(k);
      if (list) list.push(i);
      else this.grid.set(k, [i]);
    });
    for (let i = 0; i < this.nodes.length; i++) {
      const p = this.nodes[i];
      for (const j of this.near(p.x, p.y)) {
        if (j <= i) continue;
        const q = this.nodes[j];
        if (Math.hypot(p.x - q.x, p.y - q.y) < 3 && !this.adj[i].some((e) => e.to === j)) link(i, j);
      }
    }
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }

  private near(x: number, y: number): number[] {
    const out: number[] = [];
    const ci = Math.floor(x / this.cell);
    const cj = Math.floor(y / this.cell);
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) out.push(...(this.grid.get(`${i},${j}`) ?? []));
    return out;
  }

  /** Shortest walk to `to` from every node (in metres of snow-walking time), cached per destination. */
  private treeTo(to: Vec2): Tree {
    const k = `${Math.round(to.x / 3)},${Math.round(to.y / 3)}`;
    let t = this.trees.get(k);
    if (t) return t;
    const n = this.nodes.length;
    const d = new Float64Array(n);
    const next = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    // Every node can always step off the path and wade straight there.
    const heap: [number, number][] = [];
    const push = (w: number, i: number) => {
      heap.push([w, i]);
      let c = heap.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (heap[p][0] <= heap[c][0]) break;
        [heap[p], heap[c]] = [heap[c], heap[p]];
        c = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let c = 0;
        for (;;) {
          const l = c * 2 + 1;
          const r = l + 1;
          let m = c;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c], heap[m]];
          c = m;
        }
      }
      return top;
    };
    for (let i = 0; i < n; i++) {
      d[i] = Math.hypot(this.nodes[i].x - to.x, this.nodes[i].y - to.y);
      push(d[i], i);
    }
    while (heap.length) {
      const [w, i] = pop();
      if (done[i] || w > d[i]) continue;
      done[i] = 1;
      for (const e of this.adj[i]) {
        const nw = w + e.w;
        if (nw < d[e.to]) {
          d[e.to] = nw;
          next[e.to] = i;
          push(nw, e.to);
        }
      }
    }
    t = { d, next };
    if (this.trees.size > 400) this.trees.clear();
    this.trees.set(k, t);
    return t;
  }

  /**
   * Waypoints along the paths from `from` toward `to` (the walker heads
   * straight for `to` after the last one), or null if wading straight there
   * is quicker.
   */
  route(from: Vec2, to: Vec2): Vec2[] | null {
    if (!this.nodes.length) return null;
    const direct = Math.hypot(to.x - from.x, to.y - from.y);
    if (direct < 20) return null;
    const tree = this.treeTo(to);
    let best = -1;
    let bestW = direct * 0.95;
    for (let i = 0; i < this.nodes.length; i++) {
      const p = this.nodes[i];
      const off = Math.hypot(p.x - from.x, p.y - from.y);
      if (off >= bestW) continue;
      const w = off + tree.d[i];
      if (w < bestW) {
        bestW = w;
        best = i;
      }
    }
    if (best < 0 || tree.next[best] < 0) return null;
    const out: Vec2[] = [];
    for (let i = best, guard = 0; i >= 0 && guard < 5000; i = tree.next[i], guard++) out.push(this.nodes[i]);
    return out;
  }
}
