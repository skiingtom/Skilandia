/**
 * The drawn forest: tens of thousands of instanced spruces around the view,
 * split into square chunks so the renderer can skip the ones off screen (and
 * outside the shadow box). Chunks close to the camera use the detailed tree,
 * the rest a light one. Instance buffers are pooled and reused between
 * layouts, so moving around never allocates GPU memory.
 */
import * as THREE from "three";
import { TreeUniforms, makeSpruceGeometry, makeTreeDepthMaterial, makeTreeMaterial, treeGrow } from "./look";

/** Most trees in one chunk, and how many chunks can be drawn at once. */
const CHUNK_CAP = 2600;
const POOL = 72;
/** Chunks nearer the camera than this (metres, to the chunk's edge) get the detailed tree. */
const DETAIL_DIST = 650;

type Chunk = {
  key: number;
  hi: THREE.InstancedMesh;
  lo: THREE.InstancedMesh;
  matrix: THREE.InstancedBufferAttribute;
  color: THREE.InstancedBufferAttribute;
  level: THREE.InstancedBufferAttribute;
  n: number;
  box: THREE.Box3;
  sphere: THREE.Sphere;
  near: boolean;
};

export class Forest {
  readonly group = new THREE.Group();
  private pool: Chunk[] = [];
  private live = new Map<number, Chunk>();
  private hiGeo = makeSpruceGeometry(true);
  private loGeo = makeSpruceGeometry(false);
  private mat: THREE.Material;
  private depth: THREE.Material;
  /** Draws nothing on screen: near chunks cast their shadow from the light tree instead of the detailed one. */
  private shadowOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  private chunkSize = 512;
  private tmpV = new THREE.Vector3();
  /** Trees laid out in the last layout (for tests and the debug overlay). */
  count = 0;

  constructor(private readonly u: TreeUniforms) {
    this.mat = makeTreeMaterial(u);
    this.depth = makeTreeDepthMaterial(u);
    this.group.name = "forest";
  }

  private makeChunk(): Chunk {
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(CHUNK_CAP * 16), 16);
    const color = new THREE.InstancedBufferAttribute(new Float32Array(CHUNK_CAP * 3), 3);
    const level = new THREE.InstancedBufferAttribute(new Float32Array(CHUNK_CAP), 1);
    for (const a of [matrix, color, level]) a.setUsage(THREE.DynamicDrawUsage);
    const sphere = new THREE.Sphere();
    const mk = (base: THREE.BufferGeometry) => {
      const g = new THREE.BufferGeometry();
      for (const [k, a] of Object.entries(base.attributes)) g.setAttribute(k, a);
      g.setAttribute("aLevel", level);
      if (!base.boundingSphere) base.computeBoundingSphere();
      if (!base.boundingBox) base.computeBoundingBox();
      g.boundingSphere = base.boundingSphere!.clone();
      g.boundingBox = base.boundingBox!.clone();
      const m = new THREE.InstancedMesh(g, this.mat, 0);
      const detailed = base === this.hiGeo;
      m.instanceMatrix = matrix;
      m.instanceColor = color;
      m.customDepthMaterial = this.depth;
      m.castShadow = !detailed;
      m.receiveShadow = true;
      // Culled against the chunk's own bounds, set at layout.
      m.boundingSphere = sphere;
      m.visible = false;
      this.group.add(m);
      return m;
    };
    return { key: -1, hi: mk(this.hiGeo), lo: mk(this.loGeo), matrix, color, level, n: 0, box: new THREE.Box3(), sphere, near: false };
  }

  /** Start a new layout; chunks are `size` metres on a side. */
  begin(size: number): void {
    this.chunkSize = size;
    for (const c of this.live.values()) {
      c.n = 0;
      c.box.makeEmpty();
      c.hi.visible = c.lo.visible = false;
      this.pool.push(c);
    }
    this.live.clear();
    this.count = 0;
  }

  /** Add one tree at world position `pos` (its matrix already built). */
  add(pos: THREE.Vector3, matrix: THREE.Matrix4, color: THREE.Color, level: number): boolean {
    const s = this.chunkSize;
    const key = (Math.floor(pos.x / s) + 4096) * 8192 + (Math.floor(pos.z / s) + 4096);
    let c = this.live.get(key);
    if (!c) {
      if (this.live.size >= POOL) return false;
      c = this.pool.pop() ?? this.makeChunk();
      c.key = key;
      this.live.set(key, c);
    }
    if (c.n >= CHUNK_CAP) return false;
    matrix.toArray(c.matrix.array as Float32Array, c.n * 16);
    color.toArray(c.color.array as Float32Array, c.n * 3);
    (c.level.array as Float32Array)[c.n] = level;
    c.box.expandByPoint(pos);
    c.n++;
    this.count++;
    return true;
  }

  end(): void {
    // Tallest tree: scale up to ~1.6, times the most a sparse tree grows; tree origin is 8 m up.
    const reach = 20 * 1.6 * treeGrow(16);
    for (const c of this.live.values()) {
      for (const m of [c.hi, c.lo]) m.count = c.n;
      c.matrix.clearUpdateRanges();
      c.matrix.addUpdateRange(0, c.n * 16);
      c.color.clearUpdateRanges();
      c.color.addUpdateRange(0, c.n * 3);
      c.level.clearUpdateRanges();
      c.level.addUpdateRange(0, c.n);
      c.matrix.needsUpdate = c.color.needsUpdate = c.level.needsUpdate = true;
      c.box.getBoundingSphere(c.sphere);
      c.sphere.radius += reach;
    }
    // Spare pool chunks keep their GPU buffers for the next layout.
  }

  /** Detailed trees near the camera, light ones farther out. Call every frame. */
  update(camera: THREE.Camera): void {
    const cam = camera.position;
    for (const c of this.live.values()) {
      const d = this.tmpV.copy(c.sphere.center).distanceTo(cam) - c.sphere.radius;
      // A little hysteresis so a chunk on the boundary doesn't flicker between models.
      c.near = c.near ? d < DETAIL_DIST * 1.15 : d < DETAIL_DIST;
      c.hi.visible = c.n > 0 && c.near;
      // The light tree is always there: drawn far off, only its shadow up close.
      c.lo.visible = c.n > 0;
      c.lo.material = c.near ? this.shadowOnly : this.mat;
    }
  }

  get uniforms(): TreeUniforms {
    return this.u;
  }
}
