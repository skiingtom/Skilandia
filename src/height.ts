import { unzlibSync } from "fflate";
import { TERRAIN_CELL_M, TERRAIN_COLS, TERRAIN_DATA, TERRAIN_ROWS } from "./terrain-data";
import { BASE, BASE_ELEV_M, MountainId, UNIT_M, VERTICAL_M } from "./types";

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

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/*
 * The world is one large real landscape: a heightmap built from a colour-
 * tinted topographic map (see tools/terrain/build_heightmap.py). Elevation
 * is returned normalised: 0 = BASE_ELEV_M, 1 = BASE_ELEV_M + VERTICAL_M.
 */
const heights: Float32Array = (() => {
  const packed = base64ToBytes(TERRAIN_DATA);
  const raw = unzlibSync(packed);
  const metres = new Uint16Array(raw.buffer, raw.byteOffset, TERRAIN_COLS * TERRAIN_ROWS);
  const out = new Float32Array(metres.length);
  for (let i = 0; i < metres.length; i++) out[i] = (metres[i] - BASE_ELEV_M) / VERTICAL_M;
  roughen(out);
  return out;
})();

function smoothstepN(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Sharp crests: 1 on the ridge line, falling off either side. */
function ridged(x: number, y: number): number {
  return 1 - Math.abs(2 * noise2(x, y) - 1);
}

/**
 * The source map is smoothed, so the slopes read as soft hills. Away from the
 * base village, add back what the smoothing took out: on steep ground, sharp
 * ridges and gullies, and in rocky patches, stepped cliff bands (flat-ish
 * benches with near-vertical risers). Baked in once so the sim and the
 * picture agree. The valley floor and the gentle ground stay as they were.
 */
function roughen(h: Float32Array): void {
  const src = h.slice();
  const C = TERRAIN_CELL_M;
  const at = (i: number, j: number) =>
    src[Math.min(TERRAIN_ROWS - 1, Math.max(0, j)) * TERRAIN_COLS + Math.min(TERRAIN_COLS - 1, Math.max(0, i))];
  for (let j = 0; j < TERRAIN_ROWS; j++) {
    for (let i = 0; i < TERRAIN_COLS; i++) {
      const x = i * C;
      const y = j * C;
      const k = j * TERRAIN_COLS + i;
      const gx = ((at(i + 1, j) - at(i - 1, j)) * VERTICAL_M) / (2 * C);
      const gy = ((at(i, j + 1) - at(i, j - 1)) * VERTICAL_M) / (2 * C);
      const grade = Math.hypot(gx, gy);
      const keep = smoothstepN(1300, 2300, Math.hypot(x - BASE.x, y - BASE.y));
      if (keep <= 0) continue;
      let m = BASE_ELEV_M + src[k] * VERTICAL_M;
      const steep = smoothstepN(0.1, 0.42, grade);
      const high = smoothstepN(950, 1500, m);
      // Ridges and gullies, strongest on steep high ground.
      const relief = (0.2 + steep * 0.8) * (0.4 + high * 0.6) * keep;
      m += ((ridged(x / 340, y / 300) - 0.5) * 56 + (ridged(x / 170 + 40, y / 150) - 0.5) * 16) * relief;
      // Cliff bands: tall terraces in rocky patches on really steep ground,
      // warped so they don't just trace the contour lines.
      const rocky =
        smoothstepN(0.45, 0.62, noise2(x / 1100 + 11, y / 900 + 5)) * smoothstepN(0.28, 0.55, grade) * high * keep;
      if (rocky > 0) {
        const step = 70 + noise2(x / 600, y / 600) * 50;
        const warp = (noise2(x / 230 + 7, y / 230) - 0.5) * step * 0.9;
        const t = (m + warp) / step;
        const f = t - Math.floor(t);
        // 60% of each step is a sloping bench, the last 40% a steep riser.
        const r = f < 0.6 ? f * (0.3 / 0.6) : 0.3 + smoothstepN(0.6, 1, f) * 0.7;
        m += ((Math.floor(t) + r) * step - warp - m) * rocky * 0.85;
      }
      h[k] = (m - BASE_ELEV_M) / VERTICAL_M;
    }
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const table = new Uint8Array(128);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
  const clean = b64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = table[clean.charCodeAt(i)];
    const b = table[clean.charCodeAt(i + 1)];
    const c = table[clean.charCodeAt(i + 2)] ?? 0;
    const d = table[clean.charCodeAt(i + 3)] ?? 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Normalised elevation (0..1) at map position x, y (metres; y is north). */
export function elevation(x: number, y: number, _id: MountainId = 0): number {
  const u = clampNum(x / TERRAIN_CELL_M, 0, TERRAIN_COLS - 1.001);
  const v = clampNum(y / TERRAIN_CELL_M, 0, TERRAIN_ROWS - 1.001);
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const tx = u - x0;
  const ty = v - y0;
  const i = y0 * TERRAIN_COLS + x0;
  const a = heights[i];
  const b = heights[i + 1];
  const c = heights[i + TERRAIN_COLS];
  const d = heights[i + TERRAIN_COLS + 1];
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

/** Elevation in metres above sea level. */
export function elevationM(x: number, y: number): number {
  return BASE_ELEV_M + elevation(x, y) * VERTICAL_M;
}

function clampNum(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

export function slopeAt(x: number, y: number, id: MountainId = 0): number {
  const e = TERRAIN_CELL_M * 0.5;
  const dx = elevation(x + e, y, id) - elevation(x - e, y, id);
  const dy = elevation(x, y + e, id) - elevation(x, y - e, id);
  return Math.hypot(dx, dy) / (2 * e);
}

/** Fall-line steepness in the same units the trail classifier uses (drop m / run m). */
export function gradeAt(x: number, y: number, id: MountainId = 0): number {
  return (slopeAt(x, y, id) * VERTICAL_M) / UNIT_M;
}

/** Steepest-descent direction (unit vector in map x/y). */
export function downhill(x: number, y: number): { x: number; y: number } {
  const e = TERRAIN_CELL_M * 0.5;
  const gx = elevation(x + e, y) - elevation(x - e, y);
  const gy = elevation(x, y + e) - elevation(x, y - e);
  const l = Math.hypot(gx, gy) || 1;
  return { x: -gx / l, y: -gy / l };
}

void clamp01;

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

/** Above this the forest gives out and bare rock starts to take over. */
export const TREELINE_M = 1950;
const ROCK_START_M = 1880;
const ROCK_FULL_M = 2380;

/**
 * How rocky a spot is (0..1). None below the rock line; above it, outcrops
 * cover more and more of the mountain, plus every cliff. Anything over 0.5 is
 * bare rock: trees don't grow there and runs have to be routed around it.
 */
export function rockAt(x: number, y: number): number {
  const m = elevationM(x, y) + (noise2(x / 600 + 17, y / 600) - 0.5) * 160;
  if (m < ROCK_START_M) return 0;
  const alt = smoothstepN(ROCK_START_M, ROCK_FULL_M, m);
  const n = noise2(x / 240 + 3, y / 200 + 9) * 0.6 + noise2(x / 85, y / 85) * 0.4;
  const thr = 0.74 - 0.22 * alt;
  const patch = smoothstepN(thr, thr + 0.06, n) * smoothstepN(0, 0.15, alt);
  const cliff = smoothstepN(0.8, 1.05, gradeAt(x, y)) * Math.min(1, alt * 3);
  return Math.max(patch, cliff);
}

export function isRock(x: number, y: number): boolean {
  return rockAt(x, y) > 0.5;
}
