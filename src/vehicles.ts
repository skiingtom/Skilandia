/**
 * Low-poly Tesla-style vehicles: Model 3, Model Y, Cybertruck, Cybercab, a
 * wedge-nosed coupe and the Semi. Each is built from its side profile,
 * extruded across the width with rounded edges, then given a glass
 * greenhouse, light bars and wheels. Body panels are white in the vertex
 * colours so the per-instance colour paints them; glass, tyres and lights
 * keep their own colours. Length runs along +z (the nose), ground at y = 0.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export type VehicleModel = "model3" | "modelY" | "cybertruck" | "cybercab" | "coupe" | "semi";
export const CAR_MODELS: VehicleModel[] = ["model3", "modelY", "model3", "modelY", "cybertruck", "cybercab", "coupe"];

/** Paint colours each model is usually seen in. */
export const MODEL_PAINT: Record<VehicleModel, string[]> = {
  model3: ["#b3121c", "#f2f3f4", "#17191c", "#2b4a8a", "#8e9399"],
  modelY: ["#5b7290", "#f2f3f4", "#17191c", "#a3131b", "#7d838a"],
  cybertruck: ["#b9bec4", "#aab0b6", "#c4c8cc"],
  cybercab: ["#c9a24a", "#d0ac58"],
  coupe: ["#d9dcdf", "#c8ccd0", "#22252a"],
  semi: ["#f4f5f6"],
};

const GLASS = new THREE.Color(0.05, 0.055, 0.065);
const TYRE = new THREE.Color(0.035, 0.035, 0.04);
const RIM = new THREE.Color(0.16, 0.17, 0.19);
const LIGHT = new THREE.Color(2.2, 2.2, 2.3);
const TAIL = new THREE.Color(1.6, 0.08, 0.06);
const TRIM = new THREE.Color(0.08, 0.085, 0.09);
const WHITE = new THREE.Color(1, 1, 1);

function colorize(g: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const n = geo.getAttribute("position").count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(a, 3));
  geo.deleteAttribute("uv");
  return geo;
}

/**
 * Extrude a side profile (points as [along, up], nose at +along) across a
 * width, with rounded edges; returned with length on z, width on x.
 */
function profile(pts: [number, number][], width: number, bevel: number, smooth = true): THREE.BufferGeometry {
  const s = new THREE.Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  s.closePath();
  const inner = width - bevel * 2;
  const g = new THREE.ExtrudeGeometry(s, {
    depth: inner,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: smooth ? 6 : 2,
    curveSegments: 4,
  });
  g.translate(0, 0, -inner / 2);
  // Shape x (length) -> world z; extrusion z (width) -> world x.
  g.rotateY(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

/** Pull the sides in toward the top (tumblehome), from y0 up to y1 by `amount`. */
function taper(g: THREE.BufferGeometry, y0: number, y1: number, amount: number): THREE.BufferGeometry {
  const p = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = Math.max(0, Math.min(1, (p.getY(i) - y0) / (y1 - y0)));
    p.setX(i, p.getX(i) * (1 - t * amount));
  }
  g.computeVertexNormals();
  return g;
}

/** A smooth curve through control points, sampled to a polyline. */
function curve(pts: [number, number][], n = 14): [number, number][] {
  const c = new THREE.SplineCurve(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  return c.getPoints(n * (pts.length - 1)).map((p) => [p.x, p.y] as [number, number]);
}

function wheels(axles: number[], track: number, r: number, w: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const z of axles) {
    for (const side of [-1, 1]) {
      const tyre = new THREE.CylinderGeometry(r, r, w, 24);
      tyre.rotateZ(Math.PI / 2);
      tyre.translate((side * track) / 2, r, z);
      out.push(colorize(tyre, TYRE));
      const rim = new THREE.CylinderGeometry(r * 0.66, r * 0.66, w + 0.04, 14);
      rim.rotateZ(Math.PI / 2);
      rim.translate((side * track) / 2, r, z);
      out.push(colorize(rim, RIM));
    }
  }
  return out;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colorize(g, c);
}

/** Sleek sedan: long low hood, glass roof sweeping into a short tail. */
function model3(): THREE.BufferGeometry {
  const L = 4.72;
  const W = 1.85;
  const h = L / 2;
  const body = profile(
    [
      [-h, 0.32],
      ...curve([[-h + 0.02, 0.62], [-h + 0.25, 0.86], [-h + 0.9, 0.96]], 4),
      ...curve([[h - 1.3, 0.92], [h - 0.55, 0.8], [h - 0.05, 0.6], [h, 0.42]], 4),
      [h - 0.15, 0.24],
      [-h + 0.15, 0.24],
    ],
    W,
    0.16,
  );
  const glass = profile(
    curve([[-h + 0.85, 0.93], [-h + 1.3, 1.3], [-0.2, 1.43], [0.55, 1.36], [h - 1.3, 0.93]], 5),
    W - 0.3,
    0.08,
  );
  taper(glass, 0.93, 1.43, 0.3);
  return mergeGeometries([
    colorize(body, WHITE),
    colorize(glass, GLASS),
    box(W - 0.5, 0.05, 0.08, 0, 0.78, h - 0.17, LIGHT),
    box(W - 0.4, 0.06, 0.06, 0, 0.86, -h + 0.03, TAIL),
    box(W - 0.2, 0.08, 0.3, 0, 0.3, h - 0.25, TRIM),
    ...wheels([h - 1.05, -h + 1.0], W - 0.22, 0.34, 0.24),
  ])!;
}

/** Crossover: same family face, taller body and a roof that runs further back. */
function modelY(): THREE.BufferGeometry {
  const L = 4.79;
  const W = 1.92;
  const h = L / 2;
  const body = profile(
    [
      [-h, 0.38],
      ...curve([[-h + 0.03, 0.7], [-h + 0.3, 1.0], [-h + 1.0, 1.08]], 4),
      ...curve([[h - 1.35, 1.02], [h - 0.6, 0.92], [h - 0.06, 0.72], [h, 0.5]], 4),
      [h - 0.15, 0.3],
      [-h + 0.15, 0.3],
    ],
    W,
    0.18,
  );
  const glass = profile(
    curve([[-h + 0.75, 1.05], [-h + 1.05, 1.45], [-0.3, 1.62], [0.6, 1.55], [h - 1.35, 1.03]], 5),
    W - 0.3,
    0.08,
  );
  taper(glass, 1.03, 1.62, 0.28);
  return mergeGeometries([
    colorize(body, WHITE),
    colorize(glass, GLASS),
    // The full-width light bar across the nose.
    box(W - 0.3, 0.05, 0.08, 0, 0.92, h - 0.12, LIGHT),
    box(W - 0.4, 0.06, 0.06, 0, 1.0, -h + 0.06, TAIL),
    box(W - 0.1, 0.32, 0.3, 0, 0.36, h - 0.3, TRIM),
    // Black wheel-arch cladding along the sills.
    box(W + 0.02, 0.18, L - 0.6, 0, 0.36, 0, TRIM),
    ...wheels([h - 1.1, -h + 1.05], W - 0.22, 0.37, 0.26),
  ])!;
}

/** Faceted stainless wedge: one ridge line, a flat bed under a sloping tonneau. */
function cybertruck(): THREE.BufferGeometry {
  const L = 5.68;
  const W = 2.03;
  const h = L / 2;
  const body = profile(
    [
      [-h, 0.55],
      [-h, 1.15],
      [0.35, 1.79],
      [h - 0.25, 1.1],
      [h, 1.02],
      [h, 0.7],
      [h - 0.3, 0.42],
      [-h + 0.3, 0.42],
    ],
    W,
    0.03,
    false,
  );
  // Windows: a darker band cut along the upper flanks.
  const glass = profile(
    [
      [-0.75, 1.47],
      [0.3, 1.76],
      [1.55, 1.36],
      [-0.75, 1.36],
    ],
    W + 0.02,
    0,
    false,
  );
  const windshield = profile(
    [
      [0.35, 1.78],
      [2.15, 1.17],
      [1.95, 1.22],
      [0.4, 1.74],
    ],
    W - 0.2,
    0,
    false,
  );
  return mergeGeometries([
    colorize(body, WHITE),
    colorize(glass, GLASS),
    colorize(windshield, GLASS),
    box(W - 0.08, 0.04, 0.06, 0, 1.06, h + 0.01, LIGHT),
    box(W - 0.08, 0.05, 0.06, 0, 1.13, -h - 0.01, TAIL),
    // Chunky black arches and sills.
    box(W + 0.06, 0.26, L - 0.4, 0, 0.55, 0, TRIM),
    ...wheels([h - 1.15, -h + 1.15], W - 0.18, 0.43, 0.32),
  ])!;
}

/** Two-seat robotaxi: a smooth teardrop with a big wraparound canopy. */
function cybercab(): THREE.BufferGeometry {
  const L = 4.3;
  const W = 1.92;
  const h = L / 2;
  const body = profile(
    [
      [-h, 0.32],
      ...curve([[-h + 0.03, 0.66], [-h + 0.5, 0.86], [-0.6, 0.94]], 4),
      ...curve([[0.6, 0.92], [h - 0.5, 0.78], [h - 0.04, 0.56], [h, 0.4]], 4),
      [h - 0.12, 0.24],
      [-h + 0.12, 0.24],
    ],
    W,
    0.2,
  );
  const glass = taper(profile(curve([[-h + 0.55, 0.88], [-0.6, 1.36], [0.3, 1.4], [h - 0.75, 0.88]], 6), W - 0.28, 0.12), 0.88, 1.4, 0.32);
  return mergeGeometries([
    colorize(body, WHITE),
    colorize(glass, GLASS),
    box(W - 0.2, 0.04, 0.06, 0, 0.72, h - 0.06, LIGHT),
    box(W - 0.2, 0.05, 0.06, 0, 0.78, -h + 0.05, TAIL),
    ...wheels([h - 0.95, -h + 0.95], W - 0.24, 0.36, 0.24),
  ])!;
}

/** Low wedge coupe: a creased bonnet, sharp nose and a dark glass canopy. */
function coupe(): THREE.BufferGeometry {
  const L = 4.6;
  const W = 2.0;
  const h = L / 2;
  const body = profile(
    [
      [-h, 0.3],
      [-h, 0.86],
      [-0.4, 0.96],
      [h - 1.0, 0.8],
      [h - 0.05, 0.6],
      [h, 0.42],
      [h - 0.2, 0.18],
      [-h + 0.2, 0.18],
    ],
    W,
    0.06,
    false,
  );
  const glass = profile(
    [
      [-h + 0.6, 0.9],
      [-0.6, 1.22],
      [0.4, 1.2],
      [h - 1.05, 0.82],
    ],
    W - 0.3,
    0.05,
    false,
  );
  return mergeGeometries([
    colorize(body, WHITE),
    colorize(glass, GLASS),
    box(W - 0.1, 0.03, 0.06, 0, 0.58, h - 0.02, LIGHT),
    box(W - 0.1, 0.05, 0.06, 0, 0.8, -h - 0.01, TAIL),
    box(W - 0.1, 0.18, 0.3, 0, 0.26, h - 0.2, TRIM),
    ...wheels([h - 1.15, -h + 1.0], W - 0.2, 0.36, 0.28),
  ])!;
}

/** Semi tractor with its rounded cab and a long box trailer behind. */
function semi(): THREE.BufferGeometry {
  const W = 2.5;
  const cab = profile(
    [
      [-0.9, 0.8],
      [-0.9, 3.9],
      ...curve([[0.3, 3.85], [1.5, 3.2], [2.05, 2.1], [2.15, 1.2]], 4),
      [2.15, 0.6],
      [-0.9, 0.6],
    ],
    W,
    0.25,
  );
  cab.translate(0, 0, 6.2);
  const glass = profile(curve([[1.0, 3.25], [1.6, 2.75], [1.95, 2.2]], 4).concat([[1.65, 2.2], [0.95, 3.1]]), W - 0.2, 0.05);
  glass.translate(0, 0, 6.24);
  const trailer = box(W, 2.9, 14.5, 0, 2.55, -2.2, WHITE);
  return mergeGeometries([
    colorize(cab, WHITE),
    colorize(glass, GLASS),
    box(W - 0.4, 0.06, 0.08, 0, 1.25, 8.37, LIGHT),
    box(W - 0.3, 0.45, 5.0, 0, 0.75, 5.2, TRIM),
    trailer,
    box(W - 0.2, 0.1, 0.06, 0, 1.4, -9.47, TAIL),
    ...wheels([7.4, 5.0, 3.6], W - 0.3, 0.52, 0.5),
    ...wheels([-7.0, -8.3], W - 0.3, 0.52, 0.5),
  ])!;
}

const BUILDERS: Record<VehicleModel, () => THREE.BufferGeometry> = { model3, modelY, cybertruck, cybercab, coupe, semi };
const cache = new Map<VehicleModel, THREE.BufferGeometry>();

export function vehicleGeometry(m: VehicleModel): THREE.BufferGeometry {
  let g = cache.get(m);
  if (!g) cache.set(m, (g = BUILDERS[m]()));
  return g;
}

export function vehicleMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.35 });
}

/**
 * A set of instanced meshes, one per model, filled like a single list:
 * begin(), add() each vehicle, end().
 */
export class Fleet {
  readonly group = new THREE.Group();
  private meshes = new Map<VehicleModel, THREE.InstancedMesh>();
  private counts = new Map<VehicleModel, number>();

  constructor(models: VehicleModel[], max: number, opts: { dynamic?: boolean; shadow?: boolean } = {}) {
    const mat = vehicleMaterial();
    for (const m of new Set(models)) {
      const mesh = new THREE.InstancedMesh(vehicleGeometry(m), mat, max);
      if (opts.dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = opts.shadow ?? true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.setColorAt(0, new THREE.Color(1, 1, 1));
      mesh.frustumCulled = false;
      this.meshes.set(m, mesh);
      this.group.add(mesh);
    }
  }

  begin(): void {
    for (const k of this.meshes.keys()) this.counts.set(k, 0);
  }

  add(model: VehicleModel, matrix: THREE.Matrix4, color: THREE.Color): void {
    const mesh = this.meshes.get(model);
    if (!mesh) return;
    const n = this.counts.get(model) ?? 0;
    if (n >= mesh.instanceMatrix.count) return;
    mesh.setMatrixAt(n, matrix);
    mesh.setColorAt(n, color);
    this.counts.set(model, n + 1);
  }

  end(): void {
    for (const [k, mesh] of this.meshes) {
      mesh.count = this.counts.get(k) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}

/** A stable model and paint for vehicle number i. */
export function pickVehicle(i: number, models: VehicleModel[] = CAR_MODELS): { model: VehicleModel; color: string } {
  const h = (k: number) => {
    let x = Math.imul((i | 0) + k * 7919, 2654435761);
    x ^= x >>> 15;
    x = Math.imul(x, 2246822519);
    x ^= x >>> 13;
    return (x >>> 0) / 4294967296;
  };
  const model = models[Math.floor(h(1) * models.length)];
  const paints = MODEL_PAINT[model];
  return { model, color: paints[Math.floor(h(2) * paints.length)] };
}
