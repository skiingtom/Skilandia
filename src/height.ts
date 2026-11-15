import { MountainId, WORLD_H, WORLD_W } from "./types";

function hash2(x: number, y: number): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function noise2(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number): number {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < 5; i++) {
    v += a * noise2(x * f, y * f);
    a *= 0.5;
    f *= 2.05;
  }
  return v;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function littleHawk(x: number, y: number): number {
  const nx = x / WORLD_W;
  const ny = y / WORLD_H;
  const dx = (nx - 0.5) * 2;
  const ridge = Math.exp(-dx * dx * 1.45);
  let h = ny * 0.4 * ridge + ny * ny * 0.36 * ridge;
  h += Math.exp(-((nx - 0.26) ** 2) * 11) * ny * ny * 0.42;
  h += Math.exp(-((nx - 0.72) ** 2) * 7.5) * ny * 0.16;
  h += Math.exp(-((nx - 0.5) ** 2 + (ny - 0.93) ** 2) * 16) * 0.2;
  h += (fbm(nx * 4.2, ny * 4.6) - 0.48) * 0.1 * (0.25 + ny);
  h += (noise2(nx * 21, ny * 18) - 0.5) * 0.03 * ny;
  const village = 1 - clamp01((ny - 0.05) / 0.12);
  h *= 1 - village * 0.82;
  return clamp01(h);
}

function cedarRidge(x: number, y: number): number {
  const nx = x / WORLD_W;
  const ny = y / WORLD_H;
  const dx = (nx - 0.48) * 2;
  const ridge = Math.exp(-dx * dx * 1.15);
  let h = ny * 0.46 * ridge + ny * ny * 0.44 * ridge;
  h += Math.exp(-((nx - 0.22) ** 2) * 9) * ny * ny * 0.5;
  h += Math.exp(-((nx - 0.78) ** 2) * 8) * ny * 0.22;
  h += Math.exp(-((nx - 0.5) ** 2 + (ny - 0.94) ** 2) * 14) * 0.22;
  h += (fbm(nx * 5.1 + 4, ny * 4.8) - 0.48) * 0.12 * (0.3 + ny);
  const village = 1 - clamp01((ny - 0.04) / 0.11);
  h *= 1 - village * 0.8;
  return clamp01(h);
}

function twinPeaks(x: number, y: number): number {
  const nx = x / WORLD_W;
  const ny = y / WORLD_H;
  const left = Math.exp(-((nx - 0.3) ** 2) * 7.5);
  const right = Math.exp(-((nx - 0.72) ** 2) * 7.5);
  let h = 0;
  h += (ny * 0.38 + ny * ny * 0.5) * left;
  h += (ny * 0.36 + ny * ny * 0.52) * right;
  h += Math.exp(-((nx - 0.5) ** 2) * 18) * ny * 0.12;
  h += Math.exp(-((nx - 0.28) ** 2 + (ny - 0.92) ** 2) * 14) * 0.2;
  h += Math.exp(-((nx - 0.74) ** 2 + (ny - 0.93) ** 2) * 14) * 0.22;
  h += (fbm(nx * 4.6 + 9, ny * 5.2) - 0.5) * 0.1 * ny;
  const village = 1 - clamp01((ny - 0.04) / 0.13);
  h *= 1 - village * 0.78;
  return clamp01(h);
}

function rawElevation(x: number, y: number, id: MountainId): number {
  if (id === 1) return cedarRidge(x, y);
  if (id === 2) return twinPeaks(x, y);
  return littleHawk(x, y);
}

const GW = 160;
const GH = 205;
const grids: Float32Array[] = [0, 1, 2].map((id) => {
  const grid = new Float32Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      grid[gy * GW + gx] = rawElevation((gx / (GW - 1)) * WORLD_W, (gy / (GH - 1)) * WORLD_H, id as MountainId);
    }
  }
  return grid;
});

export function elevation(x: number, y: number, id: MountainId = 0): number {
  const grid = grids[id];
  const u = (x / WORLD_W) * (GW - 1);
  const v = (y / WORLD_H) * (GH - 1);
  const x0 = Math.max(0, Math.min(GW - 2, Math.floor(u)));
  const y0 = Math.max(0, Math.min(GH - 2, Math.floor(v)));
  const tx = clamp01(u - x0);
  const ty = clamp01(v - y0);
  const a = grid[y0 * GW + x0];
  const b = grid[y0 * GW + x0 + 1];
  const c = grid[(y0 + 1) * GW + x0];
  const d = grid[(y0 + 1) * GW + x0 + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

export function slopeAt(x: number, y: number, id: MountainId = 0): number {
  const e = 3;
  const dx = elevation(x + e, y, id) - elevation(x - e, y, id);
  const dy = elevation(x, y + e, id) - elevation(x, y - e, id);
  return Math.hypot(dx, dy) / (2 * e);
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function polylineLength(points: { x: number; y: number }[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    n += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return n;
}

export function pointOnPolyline(
  points: { x: number; y: number }[],
  dist: number,
): { x: number; y: number; dx: number; dy: number; done: boolean } {
  if (points.length < 2) {
    const p = points[0] ?? { x: 0, y: 0 };
    return { x: p.x, y: p.y, dx: 0, dy: -1, done: true };
  }
  let left = dist;
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1].x;
    const ay = points[i - 1].y;
    const bx = points[i].x;
    const by = points[i].y;
    const seg = Math.hypot(bx - ax, by - ay) || 0.001;
    if (left <= seg) {
      const t = left / seg;
      const dx = (bx - ax) / seg;
      const dy = (by - ay) / seg;
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, dx, dy, done: false };
    }
    left -= seg;
  }
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const seg = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
  return {
    x: last.x,
    y: last.y,
    dx: (last.x - prev.x) / seg,
    dy: (last.y - prev.y) / seg,
    done: true,
  };
}

export function distToPolyline(
  points: { x: number; y: number }[],
  x: number,
  y: number,
): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1].x;
    const ay = points[i - 1].y;
    const bx = points[i].x;
    const by = points[i].y;
    const abx = bx - ax;
    const aby = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / (abx * abx + aby * aby || 1)));
    best = Math.min(best, Math.hypot(x - (ax + abx * t), y - (ay + aby * t)));
  }
  return best;
}

export function nearSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  x: number,
  y: number,
  pad: number,
): boolean {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / (abx * abx + aby * aby || 1)));
  return Math.hypot(x - (ax + abx * t), y - (ay + aby * t)) < pad;
}
