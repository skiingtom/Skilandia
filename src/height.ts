import { MountainId, UNIT_M, VERTICAL_M, WORLD_H, WORLD_W } from "./types";

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

function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Ridged noise: sharp spines and gullies, 0..1. */
function ridged(x: number, y: number): number {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    const n = 1 - Math.abs(noise2(x * f, y * f) * 2 - 1);
    v += a * n * n;
    a *= 0.5;
    f *= 2.1;
  }
  return v;
}

/**
 * Fall-line gullies: noise stretched along the slope so steep faces read as
 * chutes and rock ribs rather than blobs.
 */
function chutes(nx: number, ny: number, seed: number): number {
  return ridged(nx * 15 + seed, ny * 3.2 + seed * 0.7) - 0.45;
}

/** Village flat at the bottom of the hill. */
function finish(h: number, nx: number, ny: number, villageTop: number): number {
  const village = 1 - smooth(0.04, villageTop, ny);
  h *= 1 - village * 0.86;
  // Ease the outer flanks down so the hill sits in the valley instead of
  // ending in a tall wall.
  const side = smooth(0, 0.09, nx) * smooth(0, 0.09, 1 - nx);
  h *= 0.45 + 0.55 * side;
  return clamp01(h);
}

function smax(a: number, b: number, k: number): number {
  const h = clamp01(0.5 + (0.5 * (a - b)) / k);
  return b + (a - b) * h + k * h * (1 - h);
}

/*
 * Each mountain blends a gentle "groomer" profile with a steep "headwall"
 * profile using a side mask R, so greens, blues and blacks live in visibly
 * different terrain instead of on one smooth cone. Surface noise is kept
 * light where R is low so beginner zones stay smooth.
 */

function littleHawk(x: number, y: number): number {
  const nx = x / WORLD_W;
  const ny = y / WORLD_H;
  const dx = (nx - 0.5) * 2;
  const ridge = Math.exp(-dx * dx * 0.4);
  // Rolling beginner terrain through the middle and left.
  const gentle = ny * 0.45 + ny * ny * 0.17 + Math.sin(ny * 17) * 0.01;
  // Right shoulder: flat run-out, then a sharp headwall, then a cornice lip.
  const steep = ny * 0.08 + 0.6 * smooth(0.36, 0.58, ny) + 0.16 * smooth(0.68, 0.86, ny);
  const R = smooth(0.7, 0.86, nx);
  let h = (gentle + (steep - gentle) * R) * ridge;
  // Summit cap above the lift: short steep pitch.
  h += Math.exp(-((nx - 0.5) ** 2 * 10 + (ny - 0.99) ** 2 * 90)) * 0.2;
  h += (fbm(nx * 3.2, ny * 3.4) - 0.48) * (0.03 + 0.05 * R) * (0.25 + ny);
  h += chutes(nx, ny, 3) * 0.08 * R * smooth(0.3, 0.6, ny);
  return finish(h, nx, ny, 0.17);
}

function cedarRidge(x: number, y: number): number {
  const nx = x / WORLD_W;
  const ny = y / WORLD_H;
  const dx = (nx - 0.5) * 2;
  const ridge = Math.exp(-dx * dx * 0.4);
  // Right side: long cruisers.
  const gentle = ny * 0.38 + ny * ny * 0.24;
  // Left side: a cirque bowl — flat floor, tall cliff-banded headwall.
  const steep = ny * 0.12 + 0.36 * smooth(0.3, 0.48, ny) + 0.34 * smooth(0.56, 0.74, ny) + 0.1 * smooth(0.8, 0.92, ny);
  const R = 1 - smooth(0.2, 0.34, nx);
  let h = (gentle + (steep - gentle) * R) * ridge;
  h += Math.exp(-((nx - 0.22) ** 2 * 14 + (ny - 0.94) ** 2 * 30)) * 0.18;
  h += (fbm(nx * 3.6 + 4, ny * 3.4) - 0.48) * (0.03 + 0.06 * R) * (0.3 + ny);
  h += chutes(nx, ny, 11) * 0.1 * R * smooth(0.25, 0.55, ny);
  return finish(h, nx, ny, 0.16);
}

function twinPeaks(x: number, y: number): number {
  const nx = x / WORLD_W;
  const ny = y / WORLD_H;
  const left = Math.exp(-((nx - 0.26) ** 2) * 9);
  const right = Math.exp(-((nx - 0.74) ** 2) * 5);
  const saddle = Math.exp(-((nx - 0.5) ** 2) * 2.5);
  // West peak: sheer north face full of chutes.
  let west = (ny * 0.14 + 0.36 * smooth(0.34, 0.54, ny) + 0.34 * smooth(0.62, 0.8, ny)) * left;
  west += Math.exp(-((nx - 0.26) ** 2 * 18 + (ny - 0.93) ** 2 * 26)) * 0.16;
  west += chutes(nx, ny, 21) * 0.12 * left * smooth(0.3, 0.6, ny);
  // East peak: steady blue/black pitch.
  let east = (ny * 0.4 + ny * ny * 0.38) * right;
  east += chutes(nx, ny, 27) * 0.04 * right * ny;
  // Saddle: wide gentle beginner valley between them.
  const mid = (ny * 0.42 + ny * ny * 0.08) * saddle;
  let h = smax(smax(west, east, 0.08), mid, 0.1);
  h += (fbm(nx * 3.6 + 9, ny * 3.6) - 0.5) * 0.04 * ny;
  return finish(h, nx, ny, 0.17);
}

function rawElevation(x: number, y: number, id: MountainId): number {
  if (id === 1) return cedarRidge(x, y);
  if (id === 2) return twinPeaks(x, y);
  return littleHawk(x, y);
}

const GW = 256;
const GH = 328;
/** Heightfields, built the first time each mountain is visited. */
const grids: (Float32Array | undefined)[] = [];

function gridFor(id: MountainId): Float32Array {
  let grid = grids[id];
  if (!grid) {
    grid = new Float32Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        grid[gy * GW + gx] = rawElevation((gx / (GW - 1)) * WORLD_W, (gy / (GH - 1)) * WORLD_H, id);
      }
    }
    grids[id] = grid;
  }
  return grid;
}

export function elevation(x: number, y: number, id: MountainId = 0): number {
  const grid = gridFor(id);
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

/** Fall-line steepness in the same units the trail classifier uses (drop m / run m). */
export function gradeAt(x: number, y: number, id: MountainId = 0): number {
  return (slopeAt(x, y, id) * VERTICAL_M) / UNIT_M;
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
