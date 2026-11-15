import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { HEIGHT_CELL_M, elevation, gradeAt, lerp, noise2, pointOnPolyline, polylineLength, rockAt, takeTerrainDirty, terrainVersion } from "./height";
import { PostFx, SkyUniforms, TerrainUniforms, gableRoof, makeChalet, makeLogCabin, makeSkyDome, makeSpruceGeometry, makeTerrainMaterial, makeTreeDepthMaterial, makeTreeMaterial, rbox } from "./look";
import { CAR_MODELS, Fleet, VehicleModel, pickVehicle } from "./vehicles";
import { ROAD_MAX_GRADE, ROAD_WIDTH, Road, legGrade } from "./roads";
import { PATH_MAX_GRADE, PATH_WIDTH, Path } from "./paths";
import { Game } from "./sim";
import { SUMMITS, classifyGrade, forestDensity } from "./sim";
import {
  BuildingType,
  DIFF,
  Difficulty,
  Feature,
  FeatureType,
  HELI,
  BASE,
  MAP_SCALE,
  TRAIL_KIND_SPEC,
  INCOME_PER_MIN,
  LIFT_SPECS,
  Lift,
  LiftType,
  MountainId,
  TERRAIN_SCALE,
  Trail,
  UNIT_M,
  Vec2,
  VERTICAL_M,
  WORLD_H,
  WORLD_W,
  PARKING,
} from "./types";

/**
 * World units of height per unit of elevation. The trail classifier treats
 * elevation 1 as VERTICAL_M metres over UNIT_M metres per world unit, so
 * VERTICAL_M / UNIT_M is the "true" scale; a little extra exaggeration makes
 * steep pitches read clearly from the orbit camera.
 */
const H = TERRAIN_SCALE;
export const TERRAIN_H = [H, H, H];

/** Slope-overlay colours by difficulty band (green, blue, black, double black). */
const BAND_COLORS = ["#3fb878", "#3d84d8", "#3a3f47", "#b8324b"].map((c) => new THREE.Color(c));

void MAP_SCALE;

/**
 * Each mountain is its own area, loaded on its own and centred in the scene,
 * so there are no offsets between them. (Kept so world <-> map maths stays
 * in one place if areas ever need positions again.)
 */
export const MOUNT_OFF = [
  { x: 0, z: 0 },
  { x: 0, z: 0 },
  { x: 0, z: 0 },
];

export function to3(x: number, y: number, lift = 0, mid: MountainId = 0): THREE.Vector3 {
  const o = MOUNT_OFF[mid];
  return new THREE.Vector3(
    x - WORLD_W / 2 + o.x,
    elevation(x, y, mid) * TERRAIN_H[mid] + lift,
    y - WORLD_H / 2 + o.z,
  );
}

/**
 * Fine relief on top of the heightmap, baked into mesh vertices. Kept small
 * so gameplay objects stay seated, but dense enough that a subdivided mesh
 * reads as real ground instead of flat 28 m facets.
 */
function meshRelief(x: number, y: number): number {
  const m =
    (noise2(x / 22, y / 19) - 0.5) * 3.6 +
    (noise2(x / 9 + 4, y / 8) - 0.5) * 1.5 +
    (noise2(x / 4.5 + 11, y / 4.2) - 0.5) * 0.55;
  return m / VERTICAL_M;
}

/** Elevation used by the drawn mesh (heightfield + fine relief). */
function meshSample(x: number, y: number, mid: MountainId): number {
  return elevation(x, y, mid) + meshRelief(x, y);
}

/**
 * Height of the drawn terrain mesh (flat triangles between TERRAIN_GRID
 * vertices), which on rough ground can sit a few metres off the smooth heightfield.
 */
function meshElevation(x: number, y: number, mid: MountainId): number {
  const wx = Math.round(WORLD_W / TERRAIN_GRID);
  const wy = Math.round(WORLD_H / TERRAIN_GRID);
  const cx = WORLD_W / wx;
  const cy = WORLD_H / wy;
  const u = Math.max(0, Math.min(wx - 1e-6, x / cx));
  const v = Math.max(0, Math.min(wy - 1e-6, y / cy));
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fx = u - i;
  const fy = v - j;
  const h = (a: number, b: number) => meshSample(a * cx, b * cy, mid);
  if (fx + fy <= 1) {
    const ha = h(i, j);
    return ha + (h(i + 1, j) - ha) * fx + (h(i, j + 1) - ha) * fy;
  }
  const hd = h(i + 1, j + 1);
  return hd + (h(i, j + 1) - hd) * (1 - fx) + (h(i + 1, j) - hd) * (1 - fy);
}

/** Like to3, but never below the drawn terrain, so flat things don't sink into it. */
export function onGround(x: number, y: number, lift = 0, mid: MountainId = 0): THREE.Vector3 {
  const p = to3(x, y, lift, mid);
  p.y = Math.max(p.y, meshElevation(x, y, mid) * TERRAIN_H[mid] + lift);
  return p;
}

export function from3(p: THREE.Vector3, mid: MountainId = 0): { x: number; y: number } {
  const o = MOUNT_OFF[mid];
  return { x: p.x - o.x + WORLD_W / 2, y: p.z - o.z + WORLD_H / 2 };
}

type Hit = { x: number; y: number; kind: string; id: number; mountain: MountainId };

export class World3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly canvas: HTMLCanvasElement;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private keys = new Set<string>();
  /** Only the mountain being managed is loaded. */
  private terrain: THREE.Group | null = null;
  private pickProxy: THREE.Mesh | null = null;
  private backdrop: THREE.Group | null = null;
  private loadedId: MountainId | null = null;
  private featureGroup = new THREE.Group();
  private peakGroup = new THREE.Group();
  /** Detailed spruces close in; a lighter model when zoomed out over a wide area. */
  private treesHi!: THREE.InstancedMesh;
  private treesLo!: THREE.InstancedMesh;
  private boulders = makeBoulders(BOULDERS_DRAWN);
  private brushRing = makeBrushRing();
  private lastTreeLayout = 0;
  private terrainSeen = 0;
  private redrapeAt = 0;
  private redrapeBox: { i0: number; i1: number; j0: number; j1: number } | null = null;
  private helicopter = makeHelicopter();
  private rotorSpin = 0;
  private mid: MountainId = 0;
  private trailGroup = new THREE.Group();
  private roadGroup = new THREE.Group();
  private roadStamp = -1;
  private pathGroup = new THREE.Group();
  private pathStamp = -1;
  private cars = new Fleet([...CAR_MODELS, "semi"], MAX_CARS, { dynamic: true });
  private carColor = new THREE.Color();
  private buildingGroup = new THREE.Group();
  private liftGroup = new THREE.Group();
  private liftVis = new Map<number, LiftVis>();
  private liftPreview = new THREE.Group();
  private liftPreviewKey = "";
  /** Everyone on the hill, drawn as instanced meshes (body, head, skis). */
  private crowd = makeCrowd(MAX_SKIERS_DRAWN);
  private jacketColors = new Map<string, THREE.Color>();
  private ghost = new THREE.Group();
  private draft: THREE.Mesh;
  private draftKey = "";
  private slopeView = false;
  private slopeApplied = false;
  private sun!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  /** Unit vector pointing at the sun; moves with the game clock. */
  private sunDir = new THREE.Vector3(0.75, 0.6, 0.3).normalize();
  private sunDisc = makeSunDisc();
  private clouds: CloudPuff[] = [];
  private cloudGroup = new THREE.Group();
  private cloudDrift = new THREE.Vector2();
  private weather = { cover: 0, snow: 0, wind: 0.5 };
  private snow: THREE.Points;
  private snowT = 0;
  private tmpV = new THREE.Vector3();
  private stamp = "";
  private introT = 0;
  private flying = true;
  private tmp = new THREE.Object3D();
  private lastPointer = { x: 0, y: 0 };
  private post: PostFx;
  private sky: { mesh: THREE.Mesh; uniforms: SkyUniforms };
  private terrainUniforms: TerrainUniforms = { uDetail: { value: 1 }, uRock: { value: new THREE.Color("#6d655e") } };
  private treeTime = { value: 0 };
  private treeWind = { value: 0.5 };
  private frameT = performance.now();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 2, 90000);
    this.camera.position.set(0, 3000, 6000);
    this.scene.background = new THREE.Color("#9cc4dc");
    this.scene.fog = new THREE.FogExp2("#cfdbe3", FOG_DENSITY);
    this.sky = makeSkyDome();
    this.scene.add(this.sky.mesh);
    this.post = new PostFx(this.renderer, this.scene, this.camera);
    this.post.setSize(innerWidth, innerHeight, postPixelRatio());

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 400, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 70;
    this.controls.maxDistance = 30000;
    this.controls.minDistance = 40;
    this.controls.mouseButtons.LEFT = -1 as unknown as THREE.MOUSE;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    this.controls.enablePan = true;
    this.controls.enabled = false;

    this.addLights();
    this.addGround();
    this.loadMountain(0);
    this.treesHi = this.makeEmptyTrees(true);
    this.treesLo = this.makeEmptyTrees(false);
    this.scene.add(this.treesHi, this.treesLo, this.boulders, this.brushRing);
    this.scene.add(this.roadGroup, this.pathGroup, this.cars.group);
    this.scene.add(this.trailGroup, this.buildingGroup, this.liftGroup, this.featureGroup, this.peakGroup);
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    this.draft = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
    );
    this.draft.visible = false;
    this.draft.frustumCulled = false;
    this.scene.add(this.draft);
    this.snow = this.makeSnow();
    this.scene.add(this.snow);
    this.makeClouds();
    this.scene.add(this.cloudGroup, this.sunDisc);
    this.scene.add(this.liftPreview);
    this.helicopter.visible = false;
    this.scene.add(this.helicopter);
    this.scene.add(this.crowd.group);

    window.addEventListener("keydown", (e) => {
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    this.aimSun(0);
  }

  /** Toggle the slope-steepness overlay that tints terrain by difficulty band. */
  setSlopeView(on: boolean): void {
    this.slopeView = on;
  }

  private applySlopeColors(on: boolean): void {
    if (on === this.slopeApplied) return;
    this.slopeApplied = on;
    this.terrainUniforms.uDetail.value = on ? 0 : 1;
    if (!this.terrain) return;
    for (const tile of this.terrain.children) {
      if (!(tile instanceof THREE.Mesh) || !tile.geometry.userData.natural) continue;
      const geo = tile.geometry;
      geo.setAttribute("color", (on ? geo.userData.overlay : geo.userData.natural) as THREE.Float32BufferAttribute);
    }
  }

  /**
   * Unload the current mountain and load another: terrain, picking mesh and
   * the distant range around it. Everything on the mountain (trees, runs,
   * lifts, buildings) is rebuilt from the game state on the next update.
   */
  loadMountain(id: MountainId): void {
    if (this.loadedId === id) return;
    for (const old of [this.terrain, this.pickProxy, this.backdrop]) {
      if (!old) continue;
      this.scene.remove(old);
      old.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => m.dispose());
        }
      });
    }
    this.terrain = this.makeTerrain(id);
    this.scene.add(this.terrain);
    this.backdrop = makeBackdrop(id);
    this.scene.add(this.backdrop);
    this.loadedId = id;
    this.mid = id;
    this.stamp = "";
    this.roadStamp = -1;
    this.pathStamp = -1;
    this.draftKey = "";
    this.liftPreviewKey = "";
    const slope = this.slopeApplied;
    this.slopeApplied = false;
    this.applySlopeColors(slope);
    this.aimSun(id);
    if (!this.flying) this.focusMountain(id);
  }

  get slopeViewOn(): boolean {
    return this.slopeView;
  }

  /** The sun (and its shadow box) follows what you're looking at. */
  private aimSun(_id: MountainId): void {
    const t = this.controls.target;
    this.sun.target.position.copy(t);
    this.sun.position.copy(t).addScaledVector(this.sunDir, 2400);
    this.sun.target.updateMatrixWorld();
  }

  /** Fly the camera to look at a map position. */
  focusPoint(x: number, y: number, dist = 1600): void {
    const p = to3(x, y, 0, this.mid);
    this.controls.target.copy(p);
    this.camera.position.set(p.x + dist * 0.35, p.y + dist * 0.55, p.z + dist * 0.85);
    this.controls.update();
    this.aimSun(this.mid);
  }

  resize(): void {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.post.setSize(innerWidth, innerHeight, postPixelRatio());
  }

  startPlay(): void {
    this.flying = false;
    this.controls.enabled = true;
    this.focusMountain(this.mid);
  }

  setPointer(clientX: number, clientY: number): void {
    this.lastPointer.x = clientX;
    this.lastPointer.y = clientY;
  }

  hitAt(clientX: number, clientY: number): Hit | null {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const objs: THREE.Object3D[] = [
      ...(this.pickProxy ? [this.pickProxy] : []),
      this.buildingGroup,
      this.trailGroup,
      this.liftGroup,
    ];
    const hits = this.raycaster.intersectObjects(objs, true);
    if (!hits.length) return null;
    const obj = hits[0].object;
    if (obj.userData.kind === "terrain") {
      // Refine the coarse proxy hit against the real heightfield.
      const mid = obj.userData.mountain as MountainId;
      const ray = this.raycaster.ray;
      let t0 = hits[0].distance - 60;
      let t1 = hits[0].distance + 60;
      const above = (t: number) => {
        const q = ray.at(t, new THREE.Vector3());
        const g = from3(q, mid);
        return q.y - elevation(g.x, g.y, mid) * TERRAIN_H[mid];
      };
      if (above(t0) > 0 && above(t1) < 0) {
        for (let i = 0; i < 18; i++) {
          const m = (t0 + t1) / 2;
          if (above(m) > 0) t0 = m;
          else t1 = m;
        }
        hits[0].point.copy(ray.at((t0 + t1) / 2, new THREE.Vector3()));
      }
    }
    let node: THREE.Object3D | null = obj;
    let mountain: MountainId = this.mid;
    let kind = "hill";
    let id = 0;
    while (node) {
      const data = node.userData as { kind?: string; id?: number; mountain?: MountainId };
      if (data.mountain != null) mountain = data.mountain;
      if (data.kind && data.kind !== "terrain") {
        kind = data.kind;
        id = data.id ?? 0;
        break;
      }
      node = node.parent;
    }
    const g = from3(hits[0].point, mountain);
    return { x: g.x, y: g.y, kind, id, mountain };
  }

  focusMountain(_id: MountainId): void {
    // Start at the base village, looking south up toward the big peaks.
    this.focusPoint(BASE.x, BASE.y - 600, 2600);
  }

  showGhost(type: BuildingType | `feature:${FeatureType}`, x: number, y: number, ok: boolean, angle = 0): void {
    if (this.ghost.userData.type !== type) {
      this.ghost.clear();
      if (type.startsWith("feature:")) this.ghost.add(makeFeatureMesh(type.slice(8) as FeatureType, true));
      else this.ghost.add(makeBuildingMesh(type as BuildingType, true));
      this.ghost.userData.type = type;
    }
    this.ghost.rotation.set(0, 0, 0);
    if (type.startsWith("feature:")) {
      placeFeature(this.ghost, { x, y, angle, type: type.slice(8) as FeatureType } as Feature, this.mid);
    } else {
      this.ghost.position.copy(to3(x, y, 0, this.mid));
      // Parking turns to line up with the road; the angle is in map x/y.
      this.ghost.rotation.y = -angle;
    }
    this.ghost.visible = true;
    this.ghost.traverse((c) => {
      if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
        c.material = c.material.clone();
        c.material.color.set(ok ? "#7dcea0" : "#d9785f");
        c.material.transparent = true;
        c.material.opacity = 0.55;
      }
    });
  }

  hideGhost(): void {
    this.ghost.visible = false;
  }

  project(x: number, y: number): { x: number; y: number; vis: boolean } {
    const v = to3(x, y, 14, this.mid);
    v.project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * innerWidth,
      y: (-v.y * 0.5 + 0.5) * innerHeight - 36,
      vis: Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15 && v.z < 1,
    };
  }

  update(game: Game, dt: number): void {
    if (game.currentMountain !== this.loadedId) this.loadMountain(game.currentMountain);
    if (this.flying) {
      this.introT += dt * 0.1;
      const a = -0.55 + this.introT;
      // Slow orbit over the whole valley on the title screen.
      const c = to3(BASE.x, BASE.y - 2000, 0, this.mid);
      const r = 9000;
      this.camera.position.set(c.x + Math.sin(a) * r, 4200 + Math.sin(this.introT * 0.6) * 200, c.z + Math.cos(a) * r);
      this.camera.lookAt(c.x, c.y + 400, c.z);
    } else {
      this.flyKeys(dt);
      this.controls.update();
      this.aimSun(this.mid);
    }
    // Steepness tint is always on while drawing a run or placing a surface lift.
    const surfaceLift = game.tool === "lift:carpet" || game.tool === "lift:tbar";
    this.applySlopeColors(this.slopeView || game.tool === "cut" || surfaceLift);
    this.syncTerrain(game);
    this.syncStatic(game);
    this.syncRoads(game);
    this.syncPaths(game);
    this.syncBrush(game);
    this.syncCars(game);
    this.syncTrees(game);
    this.syncLift(game);
    this.syncHeli(game, dt);
    this.syncSkiers(game);
    this.syncDraft(game);
    this.syncLiftPreview(game);
    this.syncSky(game, dt);
    this.tickClouds(game, dt);
    this.tickSnow(dt, game.paused ? 0 : game.speed);
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.frameT) / 1000);
    this.frameT = now;
    this.treeTime.value = (this.treeTime.value + dt) % 10000;
    this.treeWind.value = this.weather.wind;
    this.sky.mesh.position.copy(this.camera.position);
    this.post.render(dt);
  }

  private flyKeys(dt: number): void {
    // Faster the higher you are, so crossing the valley doesn't take forever.
    const height = Math.max(200, this.camera.position.distanceTo(this.controls.target));
    const speed = (this.keys.has("shift") ? 2.5 : 1) * height * 0.6 * dt;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 0.0001) forward.set(0, 0, 1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3();
    if (this.keys.has("w") || this.keys.has("arrowup")) move.add(forward);
    if (this.keys.has("s") || this.keys.has("arrowdown")) move.sub(forward);
    if (this.keys.has("d") || this.keys.has("arrowright")) move.add(right);
    if (this.keys.has("a") || this.keys.has("arrowleft")) move.sub(right);
    if (this.keys.has("q")) {
      this.camera.position.y += speed * 0.7;
      this.controls.target.y += speed * 0.7;
    }
    if (this.keys.has("e")) {
      this.camera.position.y -= speed * 0.7;
      this.controls.target.y -= speed * 0.7;
    }
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      this.camera.position.add(move);
      this.controls.target.add(move);
    }
  }

  private addLights(): void {
    // Blue skylight fills the shadows; warm bounce off the snow from below.
    const hemi = new THREE.HemisphereLight(HEMI_CLEAR, "#b8aea2", 0.7);
    this.hemi = hemi;
    this.scene.add(hemi);
    // Low, raking sun so headwalls throw shadow and gentle slopes stay bright.
    const sun = new THREE.DirectionalLight("#ffe6c0", 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    sun.shadow.camera.near = 40;
    sun.shadow.camera.far = 6000;
    sun.shadow.camera.left = -1500;
    sun.shadow.camera.right = 1500;
    sun.shadow.camera.top = 1500;
    sun.shadow.camera.bottom = -1500;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 1.2;
    sun.shadow.radius = 3;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    this.scene.add(new THREE.AmbientLight("#b9d4e6", 0.04));
  }

  private addGround(): void {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(200000, 200000),
      new THREE.MeshLambertMaterial({ color: "#dfe8ef" }),
    );
    g.position.x = 0;
    g.rotation.x = -Math.PI / 2;
    g.position.y = -2;
    g.receiveShadow = true;
    this.scene.add(g);
  }

  /**
   * The whole map as tiles of TERRAIN_TILE × TERRAIN_TILE mesh cells, so the
   * renderer skips tiles that are off screen (and outside the shadow box).
   * Normals come from the heightfield itself so tile edges don't show seams.
   */
  private makeTerrain(id: MountainId): THREE.Group {
    const wx = Math.round(WORLD_W / TERRAIN_GRID);
    const wy = Math.round(WORLD_H / TERRAIN_GRID);
    const group = new THREE.Group();
    group.userData = { kind: "terrain", mountain: id };
    const mat = makeTerrainMaterial(this.terrainUniforms);
    const tile = TERRAIN_TILE;
    for (let tj = 0; tj < wy; tj += tile) {
      for (let ti = 0; ti < wx; ti += tile) {
        const cw = Math.min(tile, wx - ti);
        const ch = Math.min(tile, wy - tj);
        const m = (cw + 1) * (ch + 1);
        const tp = new Float32Array(m * 3);
        const tn = new Float32Array(m * 3);
        const tnat = new Float32Array(m * 3);
        const tov = new Float32Array(m * 3);
        let q = 0;
        for (let j = 0; j <= ch; j++) {
          for (let i = 0; i <= cw; i++, q++) shadeTerrainVertex(ti + i, tj + j, wx, wy, id, tp, tn, tnat, tov, q);
        }
        const idx: number[] = [];
        for (let j = 0; j < ch; j++) {
          for (let i = 0; i < cw; i++) {
            const a = j * (cw + 1) + i;
            idx.push(a, a + cw + 1, a + 1, a + 1, a + cw + 1, a + cw + 2);
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(tp, 3));
        geo.setAttribute("normal", new THREE.BufferAttribute(tn, 3));
        const naturalAttr = new THREE.Float32BufferAttribute(tnat, 3);
        const overlayAttr = new THREE.Float32BufferAttribute(tov, 3);
        geo.userData = { natural: naturalAttr, overlay: overlayAttr };
        geo.setAttribute("color", naturalAttr);
        geo.setIndex(idx);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        mesh.userData = { kind: "terrain", mountain: id, tile: { ti, tj, cw, ch, wx, wy } };
        group.add(mesh);
      }
    }
    group.add(makeSkirt(id));
    // Low-poly stand-in used only for mouse picking (refined against the heightfield).
    const proxy = new THREE.Mesh(makeProxyGeometry(id), new THREE.MeshBasicMaterial({ visible: false }));
    proxy.userData = { kind: "terrain", mountain: id };
    this.pickProxy = proxy;
    this.scene.add(proxy);
    return group;
  }

  /**
   * Redraw ground that was regraded: only the vertices in (and just around)
   * the changed heightmap cells, since normals and colours depend on their neighbours.
   * `box` is in heightmap cell indices; the mesh may be denser than the heightmap.
   */
  private refreshTerrain(box: { i0: number; i1: number; j0: number; j1: number }): void {
    if (!this.terrain) return;
    const scale = HEIGHT_CELL_M / TERRAIN_GRID;
    const i0 = Math.floor(box.i0 * scale) - 2;
    const i1 = Math.ceil(box.i1 * scale) + 2;
    const j0 = Math.floor(box.j0 * scale) - 2;
    const j1 = Math.ceil(box.j1 * scale) + 2;
    for (const mesh of this.terrain.children) {
      const t = mesh.userData.tile as { ti: number; tj: number; cw: number; ch: number; wx: number; wy: number } | undefined;
      if (!t || !(mesh instanceof THREE.Mesh)) continue;
      if (t.ti > i1 || t.ti + t.cw < i0 || t.tj > j1 || t.tj + t.ch < j0) continue;
      const geo = mesh.geometry;
      const pos = geo.getAttribute("position") as THREE.BufferAttribute;
      const nor = geo.getAttribute("normal") as THREE.BufferAttribute;
      const nat = geo.userData.natural as THREE.BufferAttribute;
      const ov = geo.userData.overlay as THREE.BufferAttribute;
      for (let j = Math.max(t.tj, j0); j <= Math.min(t.tj + t.ch, j1); j++) {
        for (let i = Math.max(t.ti, i0); i <= Math.min(t.ti + t.cw, i1); i++) {
          const q = (j - t.tj) * (t.cw + 1) + (i - t.ti);
          shadeTerrainVertex(i, j, t.wx, t.wy, this.mid, pos.array as Float32Array, nor.array as Float32Array, nat.array as Float32Array, ov.array as Float32Array, q);
        }
      }
      pos.needsUpdate = true;
      nor.needsUpdate = true;
      nat.needsUpdate = true;
      ov.needsUpdate = true;
      geo.computeBoundingSphere();
    }
  }

  /** Pick up ground edits: redraw the terrain now, and re-drape runs, roads and buildings a few times a second. */
  private syncTerrain(game: Game): void {
    const v = terrainVersion();
    if (v === this.terrainSeen) {
      if (this.redrapeAt && performance.now() > this.redrapeAt && this.redrapeBox) {
        const b = this.redrapeBox;
        this.redrapeAt = 0;
        this.redrapeBox = null;
        this.stamp = "";
        this.pathStamp = -1;
        // Roads are long (the highway is 25 km): only re-drape them when the edit reached one.
        // Dirty boxes are heightmap cells (HEIGHT_CELL_M), not mesh vertices.
        const pad = 60;
        const x0 = b.i0 * HEIGHT_CELL_M - pad;
        const x1 = b.i1 * HEIGHT_CELL_M + pad;
        const y0 = b.j0 * HEIGHT_CELL_M - pad;
        const y1 = b.j1 * HEIGHT_CELL_M + pad;
        if (game.roads.some((r) => r.points.some((p) => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1)) || game.nearRoad((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 2)) {
          this.roadStamp = -1;
        }
      }
      return;
    }
    this.terrainSeen = v;
    const box = takeTerrainDirty();
    if (box) {
      this.refreshTerrain(box);
      const r = this.redrapeBox;
      this.redrapeBox = r ? { i0: Math.min(r.i0, box.i0), i1: Math.max(r.i1, box.i1), j0: Math.min(r.j0, box.j0), j1: Math.max(r.j1, box.j1) } : box;
    }
    if (!this.redrapeAt) this.redrapeAt = performance.now() + 250;
  }

  private makeEmptyTrees(detailed: boolean): THREE.InstancedMesh {
    const geo = makeSpruceGeometry(detailed);
    const mat = makeTreeMaterial(this.treeTime, this.treeWind);
    const mesh = new THREE.InstancedMesh(geo, mat, TREES_DRAWN);
    mesh.customDepthMaterial = makeTreeDepthMaterial(this.treeTime, this.treeWind);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    return mesh;
  }

  /**
   * Sun, sky and fog follow the game clock and the weather: a low warm sun in
   * the morning, highest around 12:15, sinking west toward closing; clouds
   * dim and cool it, and a snowstorm closes the fog in.
   */
  private syncSky(game: Game, dt: number): void {
    const w = game.weather();
    // Ease toward the target so a weather change drifts in rather than pops.
    const k = 1 - Math.exp(-dt * 1.5);
    this.weather.cover += (w.cover - this.weather.cover) * k;
    this.weather.snow += (w.snow - this.weather.snow) * k;
    this.weather.wind = w.wind;
    const { cover, snow } = this.weather;

    // Title screen: a late-morning sun over the valley.
    const f = game.managing ? game.dayFraction() : 0.35;
    // 8:30 AM .. 4:00 PM as an hour angle from solar noon (about 12:15).
    const hour = 8.5 + f * 7.5;
    const ha = ((hour - 12.25) / 12) * Math.PI;
    // Winter sun in the south (+z), rising in the east (+x).
    const elev = THREE.MathUtils.degToRad(5 + 27 * Math.cos(ha * 1.05));
    const az = ha * 1.1;
    this.sunDir.set(-Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev)).normalize();
    this.aimSun(this.mid);

    const low = 1 - THREE.MathUtils.smoothstep(this.sunDir.y, 0.12, 0.45);
    const sunCol = SUN_HIGH.clone().lerp(SUN_LOW, low);
    this.sun.color.copy(sunCol).lerp(OVERCAST_LIGHT, cover * 0.6);
    this.sun.intensity = (2.7 - low * 0.6) * (1 - cover * 0.78);
    this.hemi.intensity = 1.05 + cover * 0.3;
    this.hemi.color.copy(HEMI_CLEAR).lerp(HEMI_OVERCAST, cover);

    const sky = SKY_CLEAR.clone().lerp(SKY_LOW, low * 0.45).lerp(SKY_OVERCAST, cover * 0.85).lerp(SKY_SNOW, snow * 0.6);
    (this.scene.background as THREE.Color).copy(sky);
    // Hazy horizon the fog fades into, so distant ridges dissolve into the sky.
    const horizon = HORIZON_CLEAR.clone().lerp(HORIZON_LOW, low * 0.6).lerp(SKY_OVERCAST, cover * 0.8).lerp(SKY_SNOW, snow * 0.7);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(horizon).lerp(FOG_TINT, snow * 0.4);
    fog.density = FOG_DENSITY * (1 + cover * 0.4) + snow * 0.00011;
    const su = this.sky.uniforms;
    su.uSunDir.value.copy(this.sunDir);
    su.uZenith.value.copy(ZENITH_CLEAR).lerp(SKY_OVERCAST, cover * 0.85).lerp(SKY_SNOW, snow * 0.7);
    su.uHorizon.value.copy(horizon);
    su.uGround.value.copy(fog.color);
    su.uSunGlow.value.copy(sunCol);
    su.uGlow.value = Math.max(0, 1 - cover * 1.1) * (0.8 + low * 0.7);
    this.renderer.toneMappingExposure = EXPOSURE + cover * 0.1;

    // The sun disc sits far out along the sun direction; clouds hide it.
    this.sunDisc.position.copy(this.camera.position).addScaledVector(this.sunDir, 50000);
    const discMat = this.sunDisc.material as THREE.SpriteMaterial;
    discMat.opacity = Math.max(0, 1 - cover * 1.15);
    discMat.color.copy(sunCol);
    this.sunDisc.visible = discMat.opacity > 0.01;
  }

  /** Clusters of soft billboard puffs scattered over the valley at cloud height. */
  private makeClouds(): void {
    const tex = makeCloudTexture();
    const rand = mulberry(7);
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, color: "#ffffff" });
      const group = new THREE.Group();
      const n = 5 + Math.floor(rand() * 6);
      const size = 1400 + rand() * 1600;
      for (let j = 0; j < n; j++) {
        const sp = new THREE.Sprite(mat);
        const s = size * (0.55 + rand() * 0.6);
        sp.scale.set(s * 1.5, s, 1);
        sp.position.set((rand() - 0.5) * size * 2.2, (rand() - 0.3) * size * 0.25, (rand() - 0.5) * size * 1.2);
        group.add(sp);
      }
      this.cloudGroup.add(group);
      this.clouds.push({
        group,
        mat,
        home: new THREE.Vector2((rand() - 0.5) * CLOUD_SPAN, (rand() - 0.5) * CLOUD_SPAN),
        alt: 3500 + rand() * 1300,
        // Thin clouds show up first; the last ones only in a full overcast.
        threshold: rand() * 0.85,
        radius: size * 1.2,
      });
    }
  }

  private tickClouds(game: Game, dt: number): void {
    const { cover, snow, wind } = this.weather;
    const move = dt * (game.paused ? 0.2 : Math.min(game.speed, 3)) * (40 + wind * 120);
    this.cloudDrift.x += move * 0.8;
    this.cloudDrift.y += move * 0.45;
    const centre = to3(BASE.x, BASE.y - 2000, 0, this.mid);
    const cam = this.camera.position;
    const tgt = this.controls.target;
    const seg = new THREE.Vector3().subVectors(tgt, cam);
    const segLen2 = Math.max(1, seg.lengthSq());
    const p = new THREE.Vector3();
    const lit = CLOUD_LIT.clone().lerp(CLOUD_LOW, 1 - THREE.MathUtils.smoothstep(this.sunDir.y, 0.12, 0.45));
    const col = lit.lerp(CLOUD_STORM, cover * 0.55 + snow * 0.3);
    const half = CLOUD_SPAN / 2;
    for (const c of this.clouds) {
      // Wrap the drift so the sky never empties out.
      const x = ((((c.home.x + this.cloudDrift.x + half) % CLOUD_SPAN) + CLOUD_SPAN) % CLOUD_SPAN) - half;
      const z = ((((c.home.y + this.cloudDrift.y + half) % CLOUD_SPAN) + CLOUD_SPAN) % CLOUD_SPAN) - half;
      c.group.position.set(centre.x + x, c.alt, centre.z + z);
      let a = THREE.MathUtils.smoothstep(cover, c.threshold, c.threshold + 0.15);
      // Fade out near the edges of the wrap so clouds don't pop across.
      a *= 1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(x), Math.abs(z)), half * 0.8, half);
      // Never let a cloud block the view of what you're looking at.
      const tt = THREE.MathUtils.clamp(p.subVectors(c.group.position, cam).dot(seg) / segLen2, 0, 1);
      const d = p.copy(cam).addScaledVector(seg, tt).distanceTo(c.group.position);
      a *= THREE.MathUtils.smoothstep(d, c.radius * 0.8, c.radius * 1.8);
      c.mat.opacity = a * 0.92;
      c.mat.color.copy(col);
      c.group.visible = c.mat.opacity > 0.01;
    }
  }

  /**
   * Snowflakes fill a box between the camera and what it's looking at,
   * scaled with zoom so it reads the same from close in or high up.
   */
  private makeSnow(): THREE.Points {
    const pos = new Float32Array(SNOW_MAX * 3);
    for (let i = 0; i < SNOW_MAX; i++) {
      pos[i * 3] = Math.random() - 0.5;
      pos[i * 3 + 1] = Math.random() - 0.5;
      pos[i * 3 + 2] = Math.random() - 0.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setDrawRange(0, 0);
    const pts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color: "#ffffff", size: 1.4, map: makeFlakeTexture(), transparent: true, opacity: 0.9, depthWrite: false }),
    );
    pts.frustumCulled = false;
    return pts;
  }

  private tickSnow(dt: number, speed: number): void {
    const { snow, wind } = this.weather;
    const n = Math.round(SNOW_MAX * snow);
    this.snow.geometry.setDrawRange(0, n);
    this.snow.visible = n > 0;
    if (!n) return;
    const pos = this.snow.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const fall = (0.07 + 0.03 * Math.min(speed, 3)) * dt;
    const drift = fall * (0.3 + wind * 0.9);
    this.snowT += dt;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      let y = arr[j + 1] - fall * (0.75 + (i % 7) * 0.08);
      let x = arr[j] + drift * 0.8 + Math.sin(this.snowT * 1.3 + i) * fall * 0.3;
      let z = arr[j + 2] + drift * 0.45;
      if (y < -0.5) y += 1;
      if (x > 0.5) x -= 1;
      if (z > 0.5) z -= 1;
      arr[j] = x;
      arr[j + 1] = y;
      arr[j + 2] = z;
    }
    pos.needsUpdate = true;
    const cam = this.camera.position;
    const dist = cam.distanceTo(this.controls.target);
    // Kept clear of the lens (even at the box corners) so no flake balloons up.
    const side = THREE.MathUtils.clamp(dist * 0.6, 150, 6000);
    this.snow.position.copy(cam).addScaledVector(this.camera.getWorldDirection(this.tmpV), side * 1.08);
    this.snow.scale.setScalar(side);
    const mat = this.snow.material as THREE.PointsMaterial;
    mat.size = side * 0.0055;
    mat.opacity = 0.55 + snow * 0.4;
  }

  private syncStatic(game: Game): void {
    const key = `${game.currentMountain}:${game.trails.map((t) => t.id).join(",")}:${game.buildings.map((b) => `${b.id}@${Math.round(b.x)},${Math.round(b.y)}`).join(",")}:${game.forestVersion}:${game.features.map((f) => f.id).join(",")}:${game.selected?.kind}:${game.selected?.id}:${game.conquered.size}:${game.lifts.map((l) => l.id).join(",")}`;
    if (key === this.stamp) return;
    this.stamp = key;
    this.treeVersion = -1;
    this.layoutTrails(game);
    this.layoutBuildings(game);
    this.layoutLift(game);
    this.layoutFeatures(game);
    this.layoutPeaks(game);
  }

  /** A flag on every summit: grey until a lift reaches it, gold once conquered. */
  private layoutPeaks(game: Game): void {
    this.peakGroup.clear();
    for (const p of SUMMITS) {
      const done = game.conquered.has(p.id);
      const base = to3(p.x, p.y, 0, this.mid);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 40, 6), std("#3a3f45"));
      pole.position.copy(base).add(new THREE.Vector3(0, 20, 0));
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(22, 13), std(done ? "#e2b857" : "#c8ced6", { side: THREE.DoubleSide }));
      flag.position.copy(base).add(new THREE.Vector3(11, 33, 0));
      this.peakGroup.add(pole, flag);
      const label = makePeakLabel(`${done ? "🚩 " : ""}${p.name} · ${p.elevation.toLocaleString()} m`, done);
      label.position.copy(base).add(new THREE.Vector3(0, 70, 0));
      this.peakGroup.add(label);
    }
  }

  private layoutFeatures(game: Game): void {
    this.featureGroup.clear();
    for (const f of game.features) {
      const m = makeFeatureMesh(f.type, false);
      placeFeature(m, f, this.mid);
      this.featureGroup.add(m);
    }
  }

  /** Trees are only drawn near where you're looking; farther out the ground is tinted. */
  private treeCentre = { x: -1e9, y: -1e9 };
  private treeVersion = -1;
  private treeRadius = TREE_RADIUS;

  /**
   * The drawn forest follows what you're looking at: centred a little past the
   * look point (where most of the screen is), wider when zoomed out, where it
   * samples a sparser grid of bigger trees so the count stays bounded.
   */
  private syncTrees(game: Game): void {
    const cam = this.camera.position;
    const tgt = this.controls.target;
    const dist = cam.distanceTo(tgt);
    // Snap the radius to a few levels so it doesn't relayout every frame.
    const want = TREE_RADIUS * Math.pow(1.6, Math.round(Math.log(Math.max(1, dist / 1400)) / Math.log(1.6)));
    const radius = Math.min(TREE_RADIUS_MAX, Math.max(TREE_RADIUS, want));
    const ahead = this.tmpV.subVectors(tgt, cam).setY(0);
    const len = ahead.length();
    if (len > 1) ahead.multiplyScalar(Math.min(radius * 0.35, len * 0.4) / len);
    const g = from3(new THREE.Vector3(tgt.x + ahead.x, tgt.y, tgt.z + ahead.z), this.mid);
    const moved = Math.hypot(g.x - this.treeCentre.x, g.y - this.treeCentre.y) > radius * 0.3;
    if (!moved && radius === this.treeRadius && this.treeVersion === game.forestVersion) return;
    // While you drag the tree brush, redraw the forest a few times a second, not every stamp.
    const now = performance.now();
    if (!moved && radius === this.treeRadius && now - this.lastTreeLayout < 140) return;
    this.lastTreeLayout = now;
    this.treeCentre = g;
    this.treeRadius = radius;
    this.treeVersion = game.forestVersion;
    this.layoutTrees(game);
  }

  private layoutTrees(game: Game): void {
    const dummy = this.tmp;
    const col = new THREE.Color();
    let n = 0;
    const c = this.treeCentre;
    const r = this.treeRadius;
    const stride = Math.max(1, Math.round(r / TREE_RADIUS));
    const list = game.treesIn(c.x - r, c.y - r, c.x + r, c.y + r, true, stride);
    // Sparser samples stand in for more trees, so draw them a bit bigger.
    const grow = 1 + (stride - 1) * 0.45;
    const trees = stride > 1 ? this.treesLo : this.treesHi;
    const other = stride > 1 ? this.treesHi : this.treesLo;
    other.count = 0;
    for (const t of list) {
      if (n >= TREES_DRAWN) break;
      const d = Math.hypot(t.x - c.x, t.y - c.y);
      if (d > r) continue;
      // Thin the trees out toward the edge so the drawn forest blends into the tinted ground.
      if (noise2(t.x * 0.37, t.y * 0.37) < smooth(r * 0.7, r, d)) continue;
      const sc = (0.7 + noise2(t.x, t.y) * 0.9) * grow;
      // Some tall and narrow, some squat and broad.
      const tall = 0.85 + noise2(t.y * 0.53, t.x * 0.41) * 0.4;
      dummy.position.copy(to3(t.x, t.y, 8 * sc * tall, this.mid));
      dummy.scale.set(sc / Math.sqrt(tall), sc * tall, sc / Math.sqrt(tall));
      dummy.rotation.set(0, t.x * 0.1, 0);
      dummy.updateMatrix();
      trees.setMatrixAt(n, dummy.matrix);
      const v = noise2(t.x * 0.7, t.y * 0.7);
      // Mostly spruce green; some bluer firs, some yellower pines.
      col.setRGB(0.82 + v * 0.22, 0.86 + v * 0.18 - (v > 0.7 ? 0.06 : 0), 0.8 + (1 - v) * 0.2);
      trees.setColorAt(n, col);
      n++;
    }
    trees.count = n;
    this.layoutBoulders(c, r, stride);
    trees.instanceMatrix.needsUpdate = true;
    if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
    // Bounds are cached from the first layout; refresh them or trees on the
    // other mountains get frustum-culled.
    trees.computeBoundingSphere();
    trees.computeBoundingBox();
  }

  /** The tree brush outline, draped on the ground under the pointer. */
  private syncBrush(game: Game): void {
    const h = game.tool === "clearTrees" || game.tool === "plantTrees" || game.tool === "shape" ? game.brushHover : null;
    this.brushRing.visible = !!h;
    if (!h) return;
    const pos = this.brushRing.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const a = (i / pos.count) * Math.PI * 2;
      const r = game.brushRadius();
      const p = onGround(h.x + Math.cos(a) * r, h.y + Math.sin(a) * r, 1.5, this.mid);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    this.brushRing.geometry.computeBoundingSphere();
  }

  private syncPaths(game: Game): void {
    if (this.pathStamp === game.pathVersion) return;
    this.pathStamp = game.pathVersion;
    for (const c of this.pathGroup.children) if (c instanceof THREE.Mesh) c.geometry.dispose();
    this.pathGroup.clear();
    for (const p of game.paths) this.pathGroup.add(makePathRibbon(p, this.mid));
  }

  private syncRoads(game: Game): void {
    if (this.roadStamp === game.roadVersion) return;
    this.roadStamp = game.roadVersion;
    for (const c of this.roadGroup.children) if (c instanceof THREE.Mesh) c.geometry.dispose();
    this.roadGroup.clear();
    for (const r of game.roads) this.roadGroup.add(makeRoadRibbon(r, this.mid));
  }

  /**
   * Cars drive the route from the highway to the parking lot: some coming in,
   * some heading home. Busier when the hill is busy; none until it's connected.
   */
  private syncCars(game: Game): void {
    const route = game.carRoute();
    this.cars.begin();
    if (!route || route.length < 2) {
      this.cars.end();
      return;
    }
    const total = polylineLength(route);
    // Only the last few km matter; beyond that they're specks in the fog.
    const span = Math.min(total, 3500);
    const n = Math.min(MAX_CARS, 8 + Math.round(game.skiers.length / 4));
    const dummy = this.tmp;
    for (let i = 0; i < n; i++) {
      const out = i % 2 === 1;
      const speed = 17 + (i % 5) * 1.5;
      const along = (game.clock * speed + (i * span) / n * 1.37) % span;
      // Inbound cars drive toward the lot (the route's last point), outbound away.
      const d = total - span + (out ? span - along : along);
      const p = pointOnPolyline(route, d);
      const dir = out ? -1 : 1;
      const lane = 2.3;
      const x = p.x - p.dy * lane * dir;
      const y = p.y + p.dx * lane * dir;
      // Every so often a Semi hauls supplies up; otherwise the family cars.
      const v: { model: VehicleModel; color: string } = i % 9 === 4 ? { model: "semi", color: "#f4f5f6" } : pickVehicle(i);
      dummy.position.copy(onGround(x, y, 0.05, this.mid));
      dummy.rotation.set(0, Math.atan2(p.dx * dir, p.dy * dir), 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      this.cars.add(v.model, dummy.matrix, this.carColor.set(v.color));
    }
    this.cars.end();
  }

  /** Boulders and outcrops wherever the ground is bare rock, near the view. */
  private layoutBoulders(c: { x: number; y: number }, r: number, stride: number): void {
    const dummy = this.tmp;
    const col = new THREE.Color();
    const step = 17 * stride;
    const grow = 1 + (stride - 1) * 0.5;
    let n = 0;
    for (let y = Math.floor((c.y - r) / step) * step; y <= c.y + r && n < BOULDERS_DRAWN; y += step) {
      for (let x = Math.floor((c.x - r) / step) * step; x <= c.x + r && n < BOULDERS_DRAWN; x += step) {
        const jx = x + (noise2(x * 0.13, y * 0.29) - 0.5) * step;
        const jy = y + (noise2(x * 0.31, y * 0.17) - 0.5) * step;
        if (Math.hypot(jx - c.x, jy - c.y) > r) continue;
        const h = noise2(jx * 0.71, jy * 0.53);
        if (h < 0.42) continue;
        const rock = rockAt(jx, jy);
        if (rock < 0.5) continue;
        // Bigger lumps toward the heart of an outcrop, rubble at its edge.
        // A few big crags among the rubble.
        const crag = noise2(jx * 0.05 + 9, jy * 0.05) > 0.62 ? 1.9 : 1;
        const size = (2 + Math.pow(h, 2) * 9 + (rock - 0.5) * 12) * crag * grow;
        dummy.position.copy(onGround(jx, jy, size * 0.2, this.mid));
        dummy.scale.set(size * (0.8 + h * 0.6), size * (0.45 + noise2(jx, jy) * 0.5), size * (0.8 + (1 - h) * 0.5));
        dummy.rotation.set((h - 0.5) * 0.5, jx * 0.37 + jy * 0.11, (noise2(jy, jx) - 0.5) * 0.4);
        dummy.updateMatrix();
        this.boulders.setMatrixAt(n, dummy.matrix);
        const v = noise2(jx * 0.9, jy * 0.9);
        col.setHSL(0.07 + v * 0.04, 0.05 + v * 0.05, 0.27 + v * 0.14);
        this.boulders.setColorAt(n, col);
        n++;
      }
    }
    this.boulders.count = n;
    this.boulders.instanceMatrix.needsUpdate = true;
    if (this.boulders.instanceColor) this.boulders.instanceColor.needsUpdate = true;
    this.boulders.computeBoundingSphere();
  }

  private layoutTrails(game: Game): void {
    this.trailGroup.clear();
    for (const t of game.trails) {
      const glow = game.selected?.kind === "trail" && game.selected.id === t.id;
      this.trailGroup.add(makeTrailRibbon(t, glow, this.mid));
    }
  }

  private layoutBuildings(game: Game): void {
    this.buildingGroup.clear();
    this.buildingGroup.add(makeVillageProps(this.mid, game.booth(), game.exit(), game.villageRadius()));
    for (const b of game.buildings) {
      const mesh = makeBuildingMesh(b.type, false);
      mesh.position.copy(to3(b.x, b.y, 0, this.mid));
      mesh.rotation.y = -(b.angle ?? 0);
      mesh.userData = { kind: "building", id: b.id };
      const lot = PARKING[b.type];
      const tag = makeRateSprite(
        b.type === "heli" ? `$${HELI.fare}/seat` : lot ? `P · ${lot.cars.toLocaleString()} cars` : `$${INCOME_PER_MIN[b.type]}/min`,
      );
      tag.position.y = tagHeight(b.type);
      mesh.add(tag);
      if (game.selected?.kind === "building" && game.selected.id === b.id) {
        mesh.traverse((c) => {
          if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
            c.material.emissive = new THREE.Color("#e2b857");
            c.material.emissiveIntensity = 0.18;
          }
        });
      }
      this.buildingGroup.add(mesh);
    }
  }

  private layoutLift(game: Game): void {
    this.liftGroup.clear();
    this.liftVis.clear();
    for (const lift of game.lifts) {
      const selected = game.selected?.kind === "lift" && game.selected.id === lift.id;
      const vis = buildLift(lift, this.mid, selected);
      this.liftGroup.add(vis.group);
      this.liftVis.set(lift.id, vis);
    }
  }

  private syncLift(game: Game): void {
    for (const lift of game.lifts) {
      const vis = this.liftVis.get(lift.id);
      if (!vis) continue;
      for (let i = 0; i < vis.up.length; i++) {
        const t = lift.carriers[i]?.t ?? 0;
        placeCarrier(vis, vis.up[i], t, 1);
        if (vis.down[i]) placeCarrier(vis, vis.down[i], 1 - t, -1);
      }
    }
  }

  /** Helicopter sits on the pad; on a drop it climbs away over the ridge and comes back. */
  private syncHeli(game: Game, dt: number): void {
    const pad = game.helipad();
    const h = this.helicopter;
    if (!pad) {
      h.visible = false;
      return;
    }
    const base = to3(pad.x, pad.y, 1.2, this.mid);
    const away = base.clone().add(new THREE.Vector3(0, 2600, -9000));
    let pos = base;
    let spin = game.heli.wait > 0 ? 8 : 0;
    h.visible = true;
    if (game.heli.flying) {
      const u = game.heli.t / HELI.tripTime;
      spin = 30;
      const ease = (x: number) => x * x * (3 - 2 * x);
      if (u < 0.25) pos = base.clone().lerp(away, ease(u / 0.25));
      else if (u > 0.75) pos = away.clone().lerp(base, ease((u - 0.75) / 0.25));
      else {
        pos = away;
        h.visible = false; // off the map, in the backcountry
      }
      const dir = u < 0.5 ? away.clone().sub(base) : base.clone().sub(away);
      h.rotation.y = Math.atan2(dir.x, dir.z);
    }
    h.position.copy(pos);
    this.rotorSpin += spin * dt * (game.paused ? 0 : 1);
    const rotor = h.getObjectByName("rotor");
    if (rotor) rotor.rotation.y = this.rotorSpin;
  }

  private syncLiftPreview(game: Game): void {
    const type = game.liftTool();
    if (!type || !game.liftStart) {
      this.liftPreview.visible = false;
      this.liftPreviewKey = "";
      return;
    }
    const pv = game.liftPreview();
    const a = game.liftStart;
    const b = pv?.b;
    const key = `${type}:${a.x}:${a.y}:${b ? `${Math.round(b.x)}:${Math.round(b.y)}:${pv?.error ?? ""}` : ""}`;
    if (key === this.liftPreviewKey) return;
    this.liftPreviewKey = key;
    this.liftPreview.clear();
    const ok = !pv || !pv.error;
    const color = new THREE.Color(ok ? "#7dcea0" : "#e0664f");
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false });
    const marker = (p: Vec2) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 18, 12, 1, true), mat);
      m.position.copy(to3(p.x, p.y, 9, this.mid));
      m.renderOrder = 5;
      this.liftPreview.add(m);
    };
    marker(a);
    if (b) {
      marker(b);
      const spec = LIFT_SPECS[type];
      const h = Math.max(2, spec.towerH);
      const n = 24;
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        // Surface lifts hug the snow; aerial lifts run a straight cable.
        if (spec.surface) pts.push(to3(x, y, h, this.mid));
        else {
          const p = to3(x, y, 0, this.mid);
          p.y = lerp(to3(a.x, a.y, h, this.mid).y, to3(b.x, b.y, h, this.mid).y, t);
          pts.push(p);
        }
      }
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 1.1, 6), mat);
      tube.renderOrder = 5;
      this.liftPreview.add(tube);
    }
    this.liftPreview.visible = true;
  }

  private syncSkiers(game: Game): void {
    const { body, head, skis } = this.crowd;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    let n = 0;
    for (const s of game.skiers) {
      if (n >= MAX_SKIERS_DRAWN) break;
      if (s.state === "heli") continue; // off the map
      const g = to3(s.x, s.y, 0, this.mid);
      p.copy(g);
      if (s.state === "riding" && s.liftId != null) {
        const vis = this.liftVis.get(s.liftId);
        if (vis && !vis.spec.surface) {
          if (vis.type === "gondola") continue; // inside the cabin
          const c = vis.at(s.rideT, 1);
          p.x += vis.side.x * vis.gauge * 0.5;
          p.z += vis.side.z * vis.gauge * 0.5;
          p.y = c.y - vis.hang - 1.2;
        }
      }
      if (s.air > 0 && s.state === "skiing") p.y += Math.sin(Math.min(1, s.air / 0.75) * Math.PI) * 5;
      // Face roughly downhill while skiing, up the hill otherwise.
      q.setFromAxisAngle(up, ((s.id * 2.399) % (Math.PI * 2)) * (s.state === "skiing" ? 0.15 : 1));
      m.compose(p, q, one);
      skis.setMatrixAt(n, m);
      p.y += 2.2;
      m.compose(p, q, one);
      body.setMatrixAt(n, m);
      p.y += 1.4;
      m.compose(p, q, one);
      head.setMatrixAt(n, m);
      let c = this.jacketColors.get(s.color);
      if (!c) this.jacketColors.set(s.color, (c = new THREE.Color(s.color)));
      body.setColorAt(n, c);
      n++;
    }
    for (const mesh of [body, head, skis]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
  }

  private syncDraft(game: Game): void {
    if (game.draft.length < 1) {
      this.draft.visible = false;
      this.draftKey = "";
      return;
    }
    const last = game.draft[game.draft.length - 1];
    const key = `${this.mid}:${game.draft.length}:${last.x}:${last.y}`;
    if (key !== this.draftKey) {
      this.draftKey = key;
      // Colour each leg by its own pitch so you can see where the run gets steep.
      const pts = game.draft.length === 1 ? [last, { x: last.x, y: last.y - 0.5 }] : game.draft;
      const road = game.tool === "road";
      const path = game.tool === "path";
      const geo = buildRibbon(pts, this.mid, road ? ROAD_WIDTH : path ? PATH_WIDTH : 5, 1.1, (seg) => {
        if (path) {
          const g = legGrade(pts[seg], pts[seg + 1]);
          const c = g > PATH_MAX_GRADE * 0.8 ? ROAD_DRAFT_STEEP : PATH_DRAFT_OK;
          return [c, c];
        }
        if (road) {
          // Grey while it's buildable, amber near the limit.
          const g = legGrade(pts[seg], pts[seg + 1]);
          const c = g > ROAD_MAX_GRADE * 0.8 ? ROAD_DRAFT_STEEP : ROAD_DRAFT_OK;
          return [c, c];
        }
        const a = pts[seg];
        const b = pts[seg + 1];
        const drop = (elevation(a.x, a.y, this.mid) - elevation(b.x, b.y, this.mid)) * VERTICAL_M;
        const len = Math.hypot(b.x - a.x, b.y - a.y) * UNIT_M;
        const c = BAND_COLORS[classifyGrade(drop, len)];
        return [c, c];
      });
      this.draft.geometry.dispose();
      this.draft.geometry = geo;
    }
    this.draft.visible = true;
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * A strip that hugs the terrain: the path is resampled every few units and
 * both edges are sampled from the heightfield, so it never cuts through bumps.
 * `colorFor(segment)` returns [edge, centre] colours for that leg.
 */
function buildRibbon(
  points: Vec2[],
  mid: MountainId,
  width: number,
  lift: number,
  colorFor: (segment: number) => [THREE.Color, THREE.Color],
  edgeFrac = 0.22,
): THREE.BufferGeometry {
  const samples: { x: number; y: number; seg: number; along: number }[] = [];
  let along = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / 1.5));
    for (let k = i === 1 ? 0 : 1; k <= steps; k++) {
      const t = k / steps;
      samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, seg: i - 1, along: along + len * t });
    }
    along += len;
  }
  const cols = [-0.5, -0.5 + edgeFrac, 0.5 - edgeFrac, 0.5];
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(samples.length - 1, i + 1)];
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const [edge, centre] = colorFor(p.seg);
    for (let c = 0; c < cols.length; c++) {
      const off = cols[c] * width;
      const v = onGround(p.x - dy * off, p.y + dx * off, lift, mid);
      pos.push(v.x, v.y, v.z);
      const cc = c === 0 || c === 3 ? edge : centre;
      col.push(cc.r, cc.g, cc.b);
    }
    if (i < samples.length - 1) {
      const a = i * 4;
      for (let c = 0; c < 3; c++) {
        idx.push(a + c, a + c + 1, a + c + 4, a + c + 1, a + c + 5, a + c + 4);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.userData.samples = samples;
  return geo;
}

function makeTrailRibbon(t: Trail, glow: boolean, mid: MountainId): THREE.Mesh {
  const diffColor = new THREE.Color(DIFF[t.difficulty].color);
  // Park runs get the orange edges parks are signed with.
  const edge = t.kind === "park" ? new THREE.Color("#f0892a") : t.difficulty >= 2 ? new THREE.Color("#23262b") : diffColor;
  const centre = new THREE.Color(t.kind === "moguls" ? "#e9eef3" : t.kind === "glades" ? "#dfe8ee" : "#fbfdff");
  const width = TRAIL_KIND_SPEC[t.kind].width;
  const geo = buildRibbon(t.points, mid, width, 0.7, () => [edge, centre], t.kind === "park" ? 0.1 : 0.2);
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    emissive: diffColor,
    emissiveIntensity: glow ? 0.45 : 0,
    roughness: 0.75,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    // Glades aren't groomed: just a faint corridor through the trees.
    transparent: t.kind === "glades",
    opacity: t.kind === "glades" ? (glow ? 0.6 : 0.3) : 1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.userData = { kind: "trail", id: t.id };
  if (t.kind === "glades") mesh.add(makeBoundaryPoles(mid, width, geo.userData.samples));

  if (t.kind === "moguls") mesh.add(makeMoguls(t, mid, width, geo.userData.samples));
  if (t.kind === "slalom") mesh.add(makeGates(mid, width, geo.userData.samples));

  // Trailhead sign with the difficulty symbol.
  const head = t.points[0];
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.35, 10, 5),
    new THREE.MeshStandardMaterial({ color: "#5a3c26" }),
  );
  post.scale.y = 1.6;
  post.position.copy(to3(head.x, head.y, 8, mid));
  post.castShadow = true;
  mesh.add(post);
  const sign = makeTrailSign(t.name, t.difficulty);
  sign.position.copy(to3(head.x, head.y, 21, mid));
  mesh.add(sign);
  return mesh;
}

function makeMoguls(t: Trail, mid: MountainId, width: number, samples: { x: number; y: number; along: number }[]): THREE.InstancedMesh {
  const double = t.difficulty >= 2;
  const spacing = double ? 4.2 : 5.5;
  const geo = new THREE.SphereGeometry(1, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: "#f3f6fa", roughness: 0.85 });
  const max = Math.ceil(t.length / spacing) * 3 + 3;
  const inst = new THREE.InstancedMesh(geo, mat, max);
  inst.castShadow = true;
  inst.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let n = 0;
  let next = 6;
  let row = 0;
  for (let i = 1; i < samples.length && n < max - 3; i++) {
    const p = samples[i];
    if (p.along < next) continue;
    next += spacing;
    row++;
    const prev = samples[i - 1];
    let dx = p.x - prev.x;
    let dy = p.y - prev.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const lanes = double ? [-0.3, 0, 0.3] : [-0.22, 0.22];
    for (const lane of lanes) {
      const off = (lane + (row % 2 ? 0.08 : -0.08)) * width;
      const jitter = (noise2(p.x * 0.9 + lane * 5, p.y * 0.9) - 0.5) * 1.2;
      const x = p.x - dy * off + dx * jitter;
      const y = p.y + dx * off + dy * jitter;
      dummy.position.copy(to3(x, y, 0.4, mid));
      const r = (double ? 2.2 : 1.8) * (0.85 + noise2(x, y) * 0.35);
      dummy.scale.set(r * 1.25, r * 0.55, r);
      dummy.rotation.set(0, Math.atan2(dx, dy), 0);
      dummy.updateMatrix();
      inst.setMatrixAt(n++, dummy.matrix);
    }
  }
  inst.count = n;
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

function makeTrailSign(name: string, diff: Difficulty): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 384;
  c.height = 96;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(250, 252, 255, 0.96)";
  ctx.beginPath();
  ctx.roundRect(4, 4, 376, 88, 18);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#1d2a36";
  ctx.stroke();
  const cy = 48;
  ctx.fillStyle = DIFF[diff].color;
  if (diff === 0) {
    ctx.beginPath();
    ctx.arc(52, cy, 24, 0, Math.PI * 2);
    ctx.fill();
  } else if (diff === 1) {
    ctx.fillRect(30, cy - 22, 44, 44);
  } else {
    const diamond = (cx: number) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy - 27);
      ctx.lineTo(cx + 20, cy);
      ctx.lineTo(cx, cy + 27);
      ctx.lineTo(cx - 20, cy);
      ctx.closePath();
      ctx.fill();
    };
    if (diff === 2) diamond(52);
    else {
      diamond(36);
      diamond(70);
    }
  }
  ctx.fillStyle = "#1d2a36";
  ctx.font = "800 34px Nunito, Segoe UI, sans-serif";
  ctx.textBaseline = "middle";
  const x0 = diff === 3 ? 104 : 92;
  let label = name;
  while (ctx.measureText(label).width > 370 - x0 && label.length > 3) label = label.slice(0, -2) + "…";
  ctx.fillText(label, x0, cy + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(44, 11, 1);
  sprite.renderOrder = 2;
  return sprite;
}

/** Rock curtain hanging off the terrain edges so the hill doesn't look like a floating sheet. */
function makeSkirt(id: MountainId): THREE.Mesh {
  const steps = 220;
  const ring: Vec2[] = [];
  for (let i = 0; i <= steps; i++) ring.push({ x: (i / steps) * WORLD_W, y: 0 });
  for (let i = 1; i <= steps; i++) ring.push({ x: WORLD_W, y: (i / steps) * WORLD_H });
  for (let i = 1; i <= steps; i++) ring.push({ x: WORLD_W - (i / steps) * WORLD_W, y: WORLD_H });
  for (let i = 1; i <= steps; i++) ring.push({ x: 0, y: WORLD_H - (i / steps) * WORLD_H });
  const pos: number[] = [];
  const idx: number[] = [];
  ring.forEach((p, i) => {
    const top = to3(p.x, p.y, 0, id);
    pos.push(top.x, top.y, top.z, top.x, -2, top.z);
    if (i < ring.length - 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: "#8c939b", roughness: 1, side: THREE.DoubleSide }));
  mesh.receiveShadow = true;
  return mesh;
}

/** Distant snowy range so the horizon isn't empty. */
/** Distant range around one mountain area; each mountain gets its own skyline. */
function makeBackdrop(id: MountainId): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
  const snow = new THREE.Color("#eef3f8");
  const rockC = new THREE.Color("#7d8794");
  for (let i = 0; i < 34; i++) {
    const a = (i / 34) * Math.PI * 2 + noise2(i * 1.7 + id * 31, 4) * 0.2;
    const r = 30000 + noise2(i * 0.9 + id * 17, 7) * 9000;
    const x = Math.cos(a) * r * 1.1;
    const z = Math.sin(a) * r;
    const height = 2200 + noise2(i * 2.3 + id * 13, 11) * 2600;
    const geo = new THREE.ConeGeometry(height * 1.25, height, 18, 7);
    const p = geo.getAttribute("position") as THREE.BufferAttribute;
    const colors: number[] = [];
    for (let v = 0; v < p.count; v++) {
      const yy = p.getY(v);
      if (yy < height / 2 - 1) {
        p.setX(v, p.getX(v) * (0.85 + noise2(v * 0.7, i) * 0.35));
        p.setZ(v, p.getZ(v) * (0.85 + noise2(i, v * 0.7) * 0.35));
      }
      const t = (yy + height / 2) / height;
      const c = rockC.clone().lerp(snow, smooth(0.25, 0.55, t));
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, height / 2 - 6, z);
    m.rotation.y = a;
    g.add(m);
  }
  return g;
}

/**
 * A crisp pill-shaped label drawn at 2x resolution, sized to its text, with a
 * soft shadow and a hairline border. `height` is its height in world units.
 */
function makePillSprite(text: string, height: number, opts: { font?: string; fg?: string; bg?: string; renderOrder?: number } = {}): THREE.Sprite {
  const S = 2;
  const font = opts.font ?? "800 28px Nunito, Segoe UI, sans-serif";
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const padX = 22;
  const h = 56;
  const w = Math.ceil(measure.measureText(text).width + padX * 2 + 8);
  const c = document.createElement("canvas");
  c.width = w * S;
  c.height = (h + 8) * S;
  const ctx = c.getContext("2d")!;
  ctx.scale(S, S);
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = opts.bg ?? "rgba(22, 33, 44, 0.86)";
  ctx.beginPath();
  ctx.roundRect(4, 3, w - 8, h - 4, (h - 4) / 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
  ctx.stroke();
  ctx.fillStyle = opts.fg ?? "#f0c96a";
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set((height * c.width) / c.height, height, 1);
  sprite.renderOrder = opts.renderOrder ?? 2;
  return sprite;
}

function makeSignSprite(text: string): THREE.Sprite {
  return makePillSprite(text, 7.5, { renderOrder: 3 });
}

function makeRateSprite(text: string): THREE.Sprite {
  return makePillSprite(text, 4, { font: "800 26px Nunito, Segoe UI, sans-serif" });
}

type BuildingLook = { body: string; roof: string; w: number; d: number; h: number; awning?: string };

const BUILDING_LOOK: Partial<Record<BuildingType, BuildingLook>> = {
  lodge: { body: "#d8cbb6", roof: "#8b3a32", w: 28, d: 20, h: 12 },
  restroom: { body: "#d9d2c5", roof: "#4a5560", w: 10, d: 8, h: 7 },
  coffee: { body: "#efe6d2", roof: "#6f4e37", w: 14, d: 11, h: 7, awning: "#6f4e37" },
  sandwich: { body: "#e7edd8", roof: "#355e3b", w: 14, d: 11, h: 7, awning: "#4f8a55" },
  shack: { body: "#c4a574", roof: "#6b3a2a", w: 8, d: 7, h: 5 },
  cafeteria: { body: "#ebe3d4", roof: "#5a6b4a", w: 22, d: 16, h: 8 },
  bar: { body: "#dcc8b0", roof: "#3d2a24", w: 18, d: 14, h: 9 },
  hotel: { body: "#e8e0d4", roof: "#4a3a32", w: 34, d: 22, h: 22 },
  restaurant: { body: "#ead7c3", roof: "#7a2e2a", w: 20, d: 16, h: 9, awning: "#7a2e2a" },
  shop: { body: "#f0e6c8", roof: "#355e3b", w: 16, d: 12, h: 8, awning: "#355e3b" },
  condo: { body: "#d7dde4", roof: "#2c3d4f", w: 24, d: 18, h: 16 },
  hostel: { body: "#cfd8c8", roof: "#4a5c3a", w: 20, d: 14, h: 12 },
  spa: { body: "#e4eef0", roof: "#5a7d86", w: 22, d: 16, h: 8 },
  patrol: { body: "#dfe7ee", roof: "#c45c4a", w: 12, d: 10, h: 7 },
  clinic: { body: "#f2f4f6", roof: "#c45c4a", w: 16, d: 12, h: 8 },
  rental: { body: "#e6dcc8", roof: "#2f5f7a", w: 18, d: 13, h: 8 },
  school: { body: "#f1e7d6", roof: "#2f6fb0", w: 22, d: 14, h: 9 },
  cabinOffice: { body: "#efe4cc", roof: "#5a3a26", w: 16, d: 11, h: 8 },
  // Quick bites
  pizza: { body: "#f1dcc0", roof: "#9c3b2a", w: 14, d: 11, h: 7, awning: "#c8102e" },
  burger: { body: "#f3e2b5", roof: "#3a3a3a", w: 15, d: 11, h: 7, awning: "#e8a33a" },
  bakery: { body: "#f6ead8", roof: "#8a5a3a", w: 13, d: 10, h: 7, awning: "#d98aa0" },
  noodle: { body: "#e9dccb", roof: "#2b2b2b", w: 14, d: 11, h: 7, awning: "#b3262e" },
  waffle: { body: "#d8b98a", roof: "#7a4a2a", w: 8, d: 7, h: 5, awning: "#f2c14e" },
  // Restaurants
  fondue: { body: "#efe2c6", roof: "#6b2e24", w: 18, d: 13, h: 9, awning: "#c8102e" },
  steakhouse: { body: "#cbb294", roof: "#3a2418", w: 22, d: 15, h: 9, awning: "#3a2418" },
  sushi: { body: "#ece7df", roof: "#1f2a33", w: 16, d: 12, h: 8, awning: "#2c3e50" },
  brewpub: { body: "#c9a77c", roof: "#4a3220", w: 22, d: 15, h: 10, awning: "#2f5f3a" },
  summit: { body: "#e2ebf0", roof: "#36495a", w: 30, d: 20, h: 11 },
  // Shops
  skiShop: { body: "#e8eef3", roof: "#1f5f9a", w: 16, d: 12, h: 8, awning: "#1f5f9a" },
  gifts: { body: "#f3e6d0", roof: "#8c3b5a", w: 13, d: 10, h: 7, awning: "#e07a5f" },
  grocery: { body: "#e5ead9", roof: "#3f6b3a", w: 22, d: 14, h: 7, awning: "#5a9a4a" },
  outfitter: { body: "#d9cdb5", roof: "#4d5a2e", w: 20, d: 14, h: 9, awning: "#c46a2a" },
  chocolate: { body: "#e9d6c4", roof: "#4b2a1d", w: 13, d: 10, h: 7, awning: "#6b3a26" },
  boutique: { body: "#f4f0ea", roof: "#222222", w: 15, d: 11, h: 8, awning: "#111111" },
  // Hotels
  motel: { body: "#e6d3b3", roof: "#6a4a3a", w: 34, d: 12, h: 7 },
  bnb: { body: "#efe3cf", roof: "#5b6f3e", w: 16, d: 13, h: 11 },
  inn: { body: "#dcc6a8", roof: "#5a2e22", w: 28, d: 18, h: 15 },
  boutiqueHotel: { body: "#ecebe6", roof: "#2e3540", w: 24, d: 18, h: 19, awning: "#2e3540" },
  grandHotel: { body: "#efe7d6", roof: "#2d4a3e", w: 48, d: 28, h: 32 },
};

/** Where a building's price tag floats. */
function tagHeight(type: BuildingType): number {
  if (type === "garage") return 26;
  if (PARKING[type]) return 10;
  if (type === "foodTruck") return 9;
  const h = BUILDING_LOOK[type]?.h ?? 8;
  return Math.max(14, h + 8);
}

function makeBuildingMesh(type: BuildingType, ghost: boolean): THREE.Group {
  if (type === "heli") return makeHelipad(ghost);
  if (PARKING[type]) return makeParkingMesh(type, ghost);
  if (type === "cabin") return makeLogCabin(ghost);
  if (type === "foodTruck") return makeFoodTruck(ghost);
  const p = BUILDING_LOOK[type]!;
  const g = makeChalet(p, { ghost, tall: p.h > 14, door: true });
  if (p.awning) g.add(makeAwning(p, ghost));
  return g;
}

/** A striped canvas awning over the front door, so shopfronts read from the air. */
function makeAwning(p: BuildingLook, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const w = Math.min(p.w * 0.7, 12);
  const depth = p.w < 10 ? 1.6 : 2.6;
  const stripes = Math.max(4, Math.round(w / 1.2));
  const sw = w / stripes;
  const colour = std(p.awning!, { metalness: 0 });
  const cream = std("#f4efe2", { metalness: 0 });
  for (let i = 0; i < stripes; i++) {
    const m = new THREE.Mesh(rbox(sw, 0.18, depth), i % 2 ? cream : colour);
    m.position.set(-w / 2 + sw * (i + 0.5), 0, depth / 2);
    m.castShadow = !ghost;
    g.add(m);
  }
  // Valance hanging off the front edge.
  const valance = new THREE.Mesh(rbox(w, 0.6, 0.12), colour);
  valance.position.set(0, -0.3, depth);
  g.add(valance);
  g.rotation.x = 0.32;
  const plinth = Math.min(2, p.h * 0.18);
  g.position.set(0, plinth + (p.h < 6 ? 3 : 4.1), p.d / 2 + 0.1);
  return g;
}

/** A street-food van: boxy body, cab, wheels, a lit serving hatch and a little awning. */
function makeFoodTruck(ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const add = (m: THREE.Mesh, x: number, y: number, z: number) => {
    m.position.set(x, y, z);
    m.castShadow = !ghost;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const paint = std("#e8b33c", { metalness: 0.2 });
  add(new THREE.Mesh(rbox(6.4, 3.2, 2.8), paint), -0.8, 2.4, 0);
  add(new THREE.Mesh(rbox(2.2, 2.2, 2.7), paint), 3.5, 1.9, 0);
  add(new THREE.Mesh(rbox(0.1, 1.1, 2.3), std("#2a3a48", { metalness: 0.5 })), 4.62, 2.4, 0);
  add(new THREE.Mesh(rbox(6.6, 0.25, 3), std("#f4efe2")), -0.8, 4.1, 0);
  // Serving hatch, lit from inside, with a propped-up flap.
  add(new THREE.Mesh(rbox(3.6, 1.3, 0.1), std("#2a2420", { emissive: "#ffcf8a", emissiveIntensity: 0.9 })), -1, 2.7, 1.42);
  const flap = add(new THREE.Mesh(rbox(3.9, 0.12, 1.4), std("#c8102e", { metalness: 0 })), -1, 3.55, 2.05);
  flap.rotation.x = -0.35;
  add(new THREE.Mesh(rbox(3.6, 0.15, 0.6), std("#9aa1a8", { metalness: 0.5 })), -1, 2.05, 1.7);
  const wheel = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 14);
  wheel.rotateX(Math.PI / 2);
  const tyre = std("#1d1f22", { metalness: 0 });
  for (const x of [-2.8, 3.4]) for (const z of [-1.35, 1.35]) add(new THREE.Mesh(wheel, tyre), x, 0.55, z);
  // A couple of picnic tables out front.
  const wood = std("#8a6a48", { metalness: 0 });
  for (const x of [-3, 1.5]) {
    add(new THREE.Mesh(rbox(2.4, 0.15, 1), wood), x, 1, 5);
    add(new THREE.Mesh(rbox(2.4, 0.12, 0.4), wood), x, 0.55, 4.1);
    add(new THREE.Mesh(rbox(2.4, 0.12, 0.4), wood), x, 0.55, 5.9);
    add(new THREE.Mesh(rbox(0.2, 1, 0.8), wood), x, 0.5, 5);
  }
  g.userData = { kind: "building" };
  return g;
}

/** Ticket booth, parking and the village boundary around the base. */
function makeVillageProps(mid: MountainId, booth: Vec2, exit: Vec2, radius: number): THREE.Group {
  const g = new THREE.Group();
  const hut = makeBuildingMesh("restroom", false);
  hut.scale.set(0.7, 0.85, 0.7);
  hut.position.copy(to3(booth.x, booth.y, 0, mid));
  hut.userData = { kind: "hill" };
  g.add(hut);
  const lot = new THREE.Mesh(rbox(150, 0.4, 70), new THREE.MeshLambertMaterial({ color: "#5c6570" }));
  lot.position.copy(to3(exit.x, exit.y, 0.2, mid));
  g.add(lot);
  const fleet = new Fleet(CAR_MODELS, 60);
  const m = new THREE.Object3D();
  const c = new THREE.Color();
  fleet.begin();
  for (let i = 0; i < 60; i++) {
    if (noise2(i * 1.3, 2) < 0.35) continue;
    m.position.copy(to3(exit.x - 66 + (i % 15) * 9.4, exit.y - 24 + Math.floor(i / 15) * 14, 0.4, mid));
    m.rotation.set(0, Math.floor(i / 15) % 2 ? Math.PI : 0, 0);
    m.updateMatrix();
    const v = pickVehicle(i);
    fleet.add(v.model, m.matrix, c.set(v.color));
  }
  fleet.end();
  g.add(fleet.group);
  // Village boundary: a dashed line draped on the snow.
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    pts.push(to3(BASE.x + Math.cos(a) * radius, BASE.y + Math.sin(a) * radius, 1.5, mid));
  }
  const ring = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: "#e2b857", dashSize: 18, gapSize: 12 }),
  );
  ring.computeLineDistances();
  g.add(ring);
  const sign = makeSignSprite("BASE VILLAGE — build here");
  sign.scale.multiplyScalar(1.6);
  sign.position.copy(to3(BASE.x, BASE.y, 30, mid));
  g.add(sign);
  return g;
}

/** Enough for the world-class resort tier (162,000 skiers). */
const MAX_SKIERS_DRAWN = 20000;

function makeCrowd(max: number): { group: THREE.Group; body: THREE.InstancedMesh; head: THREE.InstancedMesh; skis: THREE.InstancedMesh } {
  const group = new THREE.Group();
  const body = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.62, 1.0, 4, 10), new THREE.MeshLambertMaterial({ color: "#ffffff" }), max);
  const head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.55, 10, 8), new THREE.MeshLambertMaterial({ color: "#f1d5b8" }), max);
  const skiGeo = mergeGeometries([
    new THREE.BoxGeometry(0.3, 0.15, 3.4).translate(-0.4, 0.2, 0.2),
    new THREE.BoxGeometry(0.3, 0.15, 3.4).translate(0.4, 0.2, 0.2),
  ])!;
  const skis = new THREE.InstancedMesh(skiGeo, new THREE.MeshLambertMaterial({ color: "#2a3038" }), max);
  for (const m of [body, head, skis]) {
    m.count = 0;
    m.frustumCulled = false; // instances span the whole mountain
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
  }
  body.setColorAt(0, new THREE.Color("#ffffff"));
  return { group, body, head, skis };
}

interface LiftVis {
  type: LiftType;
  spec: (typeof LIFT_SPECS)[LiftType];
  group: THREE.Group;
  up: THREE.Object3D[];
  down: THREE.Object3D[];
  /** Unit vector across the line (toward the up-bound side). */
  side: THREE.Vector3;
  gauge: number;
  /** Distance a carrier hangs below the cable. */
  hang: number;
  /** Cable position for side (+1 up / -1 return) at fraction t. */
  at: (t: number, dir: number) => THREE.Vector3;
  heading: number;
}

const LIFT_LOOK: Record<LiftType, { gauge: number; hang: number; color: string; steel: string }> = {
  carpet: { gauge: 0, hang: 0, color: "#2b3036", steel: "#6b7480" },
  tbar: { gauge: 0, hang: 6.5, color: "#b33b2b", steel: "#5a3c26" },
  double: { gauge: 4.5, hang: 4.2, color: "#3f6b3a", steel: "#55606b" },
  quad: { gauge: 5.5, hang: 4.4, color: "#2f5d8a", steel: "#4c5864" },
  six: { gauge: 7, hang: 4.8, color: "#a8322d", steel: "#3f4a55" },
  gondola: { gauge: 7.5, hang: 6.5, color: "#d8a031", steel: "#3a434d" },
};

function std(color: string, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15, ...extra });
}

function buildLift(lift: Lift, mid: MountainId, selected: boolean): LiftVis {
  const spec = LIFT_SPECS[lift.type];
  const look = LIFT_LOOK[lift.type];
  const group = new THREE.Group();
  group.userData = { kind: "lift", id: lift.id };
  const a = lift.bottom;
  const b = lift.top;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const fwd = new THREE.Vector3(dx / len, 0, dy / len);
  const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const heading = Math.atan2(fwd.x, fwd.z);
  const ground = (t: number) => to3(a.x + dx * t, a.y + dy * t, 0, mid);

  if (lift.type === "carpet") {
    // Rubber belt on the snow with a covered gallery.
    const geo = buildRibbon([a, b], mid, 4.2, 0.5, () => [new THREE.Color("#3a3f45"), new THREE.Color("#262a2f")], 0.12);
    const belt = new THREE.Mesh(geo, std("#ffffff", { vertexColors: true, roughness: 0.9, metalness: 0 }));
    belt.receiveShadow = true;
    group.add(belt);
    const frameMat = std("#5a8fc4");
    const n = Math.max(2, Math.round(len / 9));
    for (let i = 0; i <= n; i++) {
      const p = ground(i / n);
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(3, 0.18, 4, 12, Math.PI), frameMat);
      hoop.position.copy(p);
      hoop.rotation.y = heading + Math.PI / 2;
      group.add(hoop);
    }
    const g0 = ground(0);
    const g1 = ground(1);
    for (const p of [g0, g1]) {
      const pad = new THREE.Mesh(rbox(6, 0.6, 6), std("#8a949e"));
      pad.position.copy(p).setY(p.y + 0.3);
      pad.rotation.y = heading;
      group.add(pad);
    }
    if (selected) highlight(group);
    return { type: lift.type, spec, group, up: [], down: [], side, gauge: 0, hang: 0, at: (t) => ground(t), heading };
  }

  // Towers: evenly spaced, tall enough that the cable clears every bump.
  const towerGap = lift.type === "gondola" ? 90 : lift.type === "tbar" ? 55 : 70;
  const nT = Math.max(1, Math.round(len / towerGap));
  const ts: number[] = [];
  for (let i = 0; i <= nT; i++) ts.push(i / nT);
  const tops = ts.map((t) => ground(t).y + spec.towerH);
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < ts.length; i++) {
      let need = 0;
      for (let k = 1; k < 8; k++) {
        const u = k / 8;
        const t = lerp(ts[i - 1], ts[i], u);
        const line = lerp(tops[i - 1], tops[i], u);
        need = Math.max(need, ground(t).y + look.hang + 3 - line);
      }
      if (need > 0) {
        tops[i - 1] += need;
        tops[i] += need;
      }
    }
  }
  // Stations hold the haul rope low (chairs load at knee height, cabins at
  // the platform); the line climbs to the first tower.
  const stationH = STATION_CABLE_H[lift.type];
  /** Points along the line that carry rope but no tower (the level run through a station). */
  const noTower = new Set<number>();
  if (stationH) {
    tops[0] = ground(0).y + stationH;
    tops[tops.length - 1] = ground(1).y + stationH;
    // Keep the rope level through each station so carriers ride in and out
    // of the building at platform height before climbing to the first tower.
    const flat = (lift.type === "gondola" ? 26 : 24) / len;
    if (ts[1] - flat > flat * 0.6) {
      ts.splice(1, 0, flat);
      tops.splice(1, 0, ground(0).y + stationH);
      noTower.add(flat);
    }
    const n = ts.length;
    if (1 - flat - ts[n - 2] > flat * 0.6) {
      ts.splice(n - 1, 0, 1 - flat);
      tops.splice(n - 1, 0, ground(1).y + stationH);
      noTower.add(1 - flat);
    }
  }
  const cableY = (t: number) => {
    let i = 0;
    while (i < ts.length - 2 && t > ts[i + 1]) i++;
    const u = (t - ts[i]) / (ts[i + 1] - ts[i] || 1);
    return lerp(tops[i], tops[i + 1], Math.max(0, Math.min(1, u)));
  };
  const gauge = look.gauge;
  const at = (t: number, dir: number) => {
    const p = ground(t);
    p.y = cableY(t);
    return p.addScaledVector(side, (gauge / 2) * dir);
  };

  const steel = std(look.steel);
  for (let i = 0; i < ts.length; i++) {
    const g = ground(ts[i]);
    const h = tops[i] - g.y;
    const station = i === 0 || i === ts.length - 1;
    if ((station && lift.type !== "tbar") || noTower.has(ts[i])) continue;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.75, h + 1, 12), steel);
    pole.position.copy(g).setY(g.y + h / 2);
    pole.castShadow = true;
    group.add(pole);
    const arm = new THREE.Mesh(rbox(Math.max(2.5, gauge + 1.6), 0.5, 0.6), std(lift.type === "tbar" ? "#c45c4a" : look.steel));
    arm.position.copy(g).setY(tops[i] + 0.3);
    arm.rotation.y = heading + Math.PI / 2;
    group.add(arm);
  }

  // Cable loop (up line and return line).
  const cableMat = new THREE.LineBasicMaterial({ color: "#1d2127" });
  for (const dir of gauge ? [1, -1] : [0]) {
    const pts = ts.map((t) => at(t, dir));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat));
  }

  // Terminals.
  for (const end of [0, 1]) {
    const g = ground(end);
    const y = tops[end === 0 ? 0 : tops.length - 1];
    group.add(makeTerminal(lift.type, g, y, heading, end === 0, look, lift.name));
  }

  // Carriers.
  const up: THREE.Object3D[] = [];
  const down: THREE.Object3D[] = [];
  const makeCarrier = () => {
    if (lift.type === "tbar") return makeTBar();
    if (lift.type === "gondola") return makeCabin(look.color);
    return makeChair(spec.seats, look.color, lift.type === "six");
  };
  for (let i = 0; i < lift.carriers.length; i++) {
    const c = makeCarrier();
    group.add(c);
    up.push(c);
    if (gauge) {
      const r = makeCarrier();
      group.add(r);
      down.push(r);
    }
  }
  if (selected) highlight(group);
  return { type: lift.type, spec, group, up, down, side, gauge, hang: look.hang, at, heading };
}

function placeCarrier(vis: LiftVis, obj: THREE.Object3D, t: number, dir: number): void {
  const p = vis.at(Math.max(0, Math.min(1, t)), vis.gauge ? dir : 0);
  obj.position.copy(p);
  obj.rotation.y = vis.heading + (dir < 0 ? Math.PI : 0);
}

function highlight(g: THREE.Object3D): void {
  g.traverse((c) => {
    if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
      c.material = c.material.clone();
      c.material.emissive = new THREE.Color("#e2b857");
      c.material.emissiveIntensity = 0.3;
    }
  });
}

/** Haul-rope height at the stations (0 = as tall as a tower). */
const STATION_CABLE_H: Record<LiftType, number> = { carpet: 0, tbar: 0, double: 5.2, quad: 5.4, six: 5.8, gondola: 9.5 };

/** The lift's name in white capitals for the side of a terminal, the way resorts letter them. */
function makeNameplate(name: string, width: number, height: number): THREE.Mesh {
  const S = 2;
  const text = name.toUpperCase();
  const c = document.createElement("canvas");
  const font = "800 64px Nunito, Segoe UI, sans-serif";
  const m = document.createElement("canvas").getContext("2d")!;
  m.font = font;
  const tw = Math.max(200, m.measureText(text).width + 60);
  c.width = Math.ceil(tw * S);
  c.height = Math.ceil(96 * S);
  const ctx = c.getContext("2d")!;
  ctx.scale(S, S);
  ctx.font = font;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, tw / 2, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  // Keep the letters in proportion: fit the width, or the height if the name is short.
  const aspect = c.width / c.height;
  const w = Math.min(width, height * aspect);
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(w, w / aspect),
    new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.5, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  return plate;
}

/** A rounded-rectangle outline in the x/y plane, for extruding soft-cornered shells. */
function roundedRect(w: number, d: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  r = Math.min(r, w / 2 - 0.01, d / 2 - 0.01);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/**
 * A soft-edged slab: a rounded rectangle (w across, d along the line) given
 * height h and rounded top and bottom edges. Sits on y = 0.
 */
function shell(w: number, d: number, h: number, corner: number, bevel: number): THREE.BufferGeometry {
  const b = Math.min(bevel, h / 2 - 0.01, w / 2 - 0.2);
  const geo = new THREE.ExtrudeGeometry(roundedRect(w - b * 2, d - b * 2, Math.max(0.05, corner - b)), {
    depth: Math.max(0.01, h - b * 2),
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 4,
    curveSegments: 10,
  });
  // Extruded along +z: stand it up so the depth becomes height.
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, b, 0);
  geo.computeVertexNormals();
  return geo;
}

function makeTerminal(
  type: LiftType,
  g: THREE.Vector3,
  cableY: number,
  heading: number,
  bottom: boolean,
  look: (typeof LIFT_LOOK)[LiftType],
  name: string,
): THREE.Group {
  const t = new THREE.Group();
  t.position.copy(g);
  t.rotation.y = heading;
  const h = cableY - g.y;
  // Which way the line runs out of this station (+z from the bottom, -z from the top).
  const out = bottom ? 1 : -1;
  const snow = std("#f2f5f8", { metalness: 0, roughness: 0.7 });
  const add = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T => {
    o.position.set(x, y, z);
    o.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        c.castShadow = true;
        c.receiveShadow = true;
      }
    });
    t.add(o);
    return o;
  };
  /** A little operator's hut: plaster walls, a lit window and a snowy pitched roof. */
  const hut = (w: number, d: number, wallH: number, x: number, z: number, body: string, roofCol: string) => {
    const hg = new THREE.Group();
    const walls = new THREE.Mesh(rbox(w, wallH, d), std(body, { metalness: 0, roughness: 0.85 }));
    walls.position.y = wallH / 2;
    const win = new THREE.Mesh(rbox(w * 0.6, wallH * 0.36, 0.2), std("#2a2420", { emissive: "#ffcf8a", emissiveIntensity: 0.8 }));
    win.position.set(0, wallH * 0.6, d / 2 + 0.05);
    const roof = gableRoof(d, w + 1.2, THREE.MathUtils.degToRad(34), 0.6, std(roofCol, { metalness: 0, roughness: 0.8 }), snow, true);
    roof.group.position.y = wallH;
    const tri = new THREE.Shape();
    tri.moveTo(-d / 2, 0);
    tri.lineTo(d / 2, 0);
    tri.lineTo(0, roof.rise);
    tri.closePath();
    const gableGeo = new THREE.ExtrudeGeometry(tri, { depth: w - 0.1, bevelEnabled: false });
    gableGeo.translate(0, 0, -(w - 0.1) / 2);
    const gable = new THREE.Mesh(gableGeo, walls.material);
    gable.rotation.y = Math.PI / 2;
    gable.position.y = wallH;
    hg.add(walls, win, roof.group, gable);
    return add(hg, x, 0, z);
  };
  if (type === "tbar") {
    if (bottom) hut(6, 5, 4.4, 5, -2, "#c9b08a", "#6b3a2a");
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.22, 8, 32), std("#3a3f45", { metalness: 0.5, roughness: 0.4 }));
    wheel.rotation.x = Math.PI / 2;
    add(wheel, 0, h + 0.8, 0);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.5, 14), std("#3a3f45"));
    add(hub, 0, h + 0.8, 0);
    return t;
  }
  if (type === "gondola") {
    // A station hall the cabins ride into: the rope comes in through a big
    // portal in the end wall and turns around the bullwheel inside.
    const R = look.gauge / 2 + 0.3;
    const w = look.gauge + 11;
    const D = 30;
    const back = R + 5;
    const zc = out * (D / 2 - back);
    const wallH = h + 4.5;
    const stone = std("#8a8379", { metalness: 0, roughness: 0.95 });
    const plaster = std("#e8dfcf", { metalness: 0, roughness: 0.85 });
    const timber = std("#4a3424", { metalness: 0, roughness: 0.9 });
    const glass = std("#2a3540", { roughness: 0.15, metalness: 0.4, emissive: "#ffcf8a", emissiveIntensity: 0.35 });
    add(new THREE.Mesh(rbox(w + 1, 2.4, D + 1), stone), 0, 0.9, zc);
    add(new THREE.Mesh(rbox(w, wallH - 2.1, D), plaster), 0, 2.1 + (wallH - 2.1) / 2, zc);
    // Long glazed galleries on both sides at platform level.
    add(new THREE.Mesh(rbox(w + 0.3, 3.4, D - 6), glass), 0, h - 4.6, zc);
    add(new THREE.Mesh(rbox(w + 0.5, 0.5, D - 5), timber), 0, h - 2.65, zc);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, -0.33, 0.33, 1]) add(new THREE.Mesh(rbox(0.8, wallH - 2.1, 0.8), timber), (sx * w) / 2, 2.1 + (wallH - 2.1) / 2, zc + (sz * D) / 2);
      add(new THREE.Mesh(rbox(0.5, 0.5, D + 0.6), timber), (sx * w) / 2 + sx * 0.05, wallH, zc);
    }
    // The portal the cabins sail through: a dark opening wide enough for both
    // lines, framed in timber, with the lift's name above it.
    const face = zc + out * (D / 2 + 0.06);
    const portalW = look.gauge + 5.5;
    const portalH = 7.5;
    const portalY = h - 4.6;
    const portal = new THREE.Mesh(new THREE.PlaneGeometry(portalW, portalH), new THREE.MeshBasicMaterial({ color: "#14181c" }));
    portal.rotation.y = bottom ? 0 : Math.PI;
    add(portal, 0, portalY, face);
    add(new THREE.Mesh(rbox(portalW + 1.6, 0.9, 0.9), timber), 0, portalY + portalH / 2 + 0.4, face);
    for (const sx of [-1, 1]) add(new THREE.Mesh(rbox(0.9, portalH, 0.9), timber), sx * (portalW / 2 + 0.4), portalY, face);
    // Name on a painted signboard in the lift's colour above the portal.
    const plate = makeNameplate(name, w - 5, 1.5);
    const boardW = (plate.geometry as THREE.PlaneGeometry).parameters.width + 1.6;
    add(new THREE.Mesh(rbox(boardW, 2.3, 0.4, 0.15), std(look.color === "#d8a031" ? "#2c3a48" : look.color, { metalness: 0.2, roughness: 0.45 })), 0, portalY + portalH / 2 + 2.1, face + out * 0.2);
    plate.rotation.y = bottom ? 0 : Math.PI;
    t.add(plate);
    plate.position.set(0, portalY + portalH / 2 + 2.1, face + out * 0.42);
    const roof = gableRoof(w, D + 4, THREE.MathUtils.degToRad(28), 1.8, std(look.color, { metalness: 0.1, roughness: 0.6 }), snow, true);
    roof.group.rotation.y = Math.PI / 2;
    add(roof.group, 0, wallH, zc);
    const tri = new THREE.Shape();
    tri.moveTo(-w / 2, 0);
    tri.lineTo(w / 2, 0);
    tri.lineTo(0, roof.rise);
    tri.closePath();
    const gableGeo = new THREE.ExtrudeGeometry(tri, { depth: D - 0.2, bevelEnabled: false });
    gableGeo.translate(0, 0, -(D - 0.2) / 2);
    add(new THREE.Mesh(gableGeo, timber), 0, wallH, zc);
    return t;
  }
  // Detachable chairlift terminal: a long, rounded two-tone shell over the
  // bullwheel, a band of tinted windows along the top, the lift's name on a
  // painted band, all held up on one central pedestal. Chairs slow down and
  // swing out underneath it.
  const R = look.gauge / 2 + 0.3;
  const W = look.gauge + 2.8;
  const L = look.gauge * 2 + 9;
  const zc = out * (L / 2 - R - 1.6);
  const band = std(look.color, { metalness: 0.3, roughness: 0.35 });
  const silver = std("#dde1e5", { metalness: 0.35, roughness: 0.3 });
  const tint = std("#1f2a35", { metalness: 0.6, roughness: 0.12 });
  const concrete = std("#a7abb0", { metalness: 0.1, roughness: 0.8 });
  const bandH = 1.9;
  const topH = 2.5;
  const y0 = h - 0.7;
  add(new THREE.Mesh(shell(W, L, bandH, W * 0.5, 0.35), band), 0, y0, zc);
  add(new THREE.Mesh(shell(W - 0.25, L - 0.4, topH, W * 0.48, 0.9), silver), 0, y0 + bandH - 0.15, zc);
  // White trim between the two tones.
  add(new THREE.Mesh(shell(W + 0.1, L + 0.1, 0.18, W * 0.5, 0.06), std("#eef1f4", { metalness: 0.2, roughness: 0.5 })), 0, y0 + bandH - 0.12, zc);
  // Tinted windows down both long sides, in panes.
  const panes = Math.max(3, Math.round((L - W) / 2.6));
  const run = L - W * 0.7;
  for (const sx of [-1, 1]) {
    for (let k = 0; k < panes; k++) {
      const z = zc - run / 2 + (run * (k + 0.5)) / panes;
      add(new THREE.Mesh(rbox(0.14, 1.25, run / panes - 0.35, 0.06), tint), sx * ((W - 0.25) / 2 + 0.03), y0 + bandH + 0.95, z);
    }
    const plate = makeNameplate(name, L * 0.7, bandH * 0.62);
    plate.rotation.y = sx * (Math.PI / 2);
    t.add(plate);
    plate.position.set(sx * (W / 2 + 0.04), y0 + bandH * 0.48, zc);
  }
  // The pedestal and a cross-head under the shell.
  add(new THREE.Mesh(rbox(2.2, y0, 3.6, 0.5), concrete), 0, y0 / 2, zc);
  add(new THREE.Mesh(rbox(W - 1.2, 0.6, 4.4, 0.25), std("#3a3f45", { metalness: 0.5, roughness: 0.4 })), 0, y0 - 0.25, zc);
  // Bullwheel just under the back of the shell.
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.24, 10, 48), std("#2e3338", { metalness: 0.6, roughness: 0.35 }));
  rim.rotation.x = Math.PI / 2;
  add(rim, 0, h, 0);
  // Loading carpet / unload ramp where the chairs come out from under the shell.
  add(new THREE.Mesh(rbox(look.gauge + 4, 0.8, 9, 0.38), std("#e9eef3", { metalness: 0 })), 0, 0.4, zc + out * (L / 2 + 1));
  if (bottom) {
    add(new THREE.Mesh(rbox(look.gauge + 3, 0.12, 0.5, 0.05), std("#d2343a", { metalness: 0 })), 0, 0.86, zc + out * (L / 2 - 2));
    hut(4.6, 4.2, 3.4, W / 2 + 4.2, zc + out * (L / 2 - 2), "#d6dbe0", "#3f4a55");
  }
  return t;
}

function makeTBar(): THREE.Group {
  const g = new THREE.Group();
  const dark = new THREE.MeshBasicMaterial({ color: "#2a3038" });
  const hang = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 4), dark);
  hang.position.y = -3;
  const bar = new THREE.Mesh(rbox(4.2, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: "#b33b2b" }));
  bar.position.y = -6;
  g.add(hang, bar);
  return g;
}

function makeChair(seats: number, color: string, bubble: boolean): THREE.Group {
  const g = new THREE.Group();
  const w = seats * 1.25 + 0.4;
  const frame = std("#3a3f45", { metalness: 0.5, roughness: 0.4 });
  const pad = std(color, { metalness: 0.05, roughness: 0.55 });
  const hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4, 8), frame);
  hanger.position.set(0, -2, 0);
  const seat = new THREE.Mesh(rbox(w, 0.45, 1.4, 0.2), pad);
  seat.position.set(0, -4.1, 0.1);
  const back = new THREE.Mesh(rbox(w, 1.5, 0.32, 0.15), pad);
  back.position.set(0, -3.3, -0.6);
  back.rotation.x = -0.12;
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, w, 8), frame);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, -3, 1.1);
  g.add(hanger, seat, back, bar);
  for (const sx of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.6, 6), frame);
    arm.rotation.x = Math.PI / 2;
    arm.position.set((sx * w) / 2, -3.2, 0.25);
    g.add(arm);
  }
  if (bubble) {
    // Tinted bubble hinged above the chair, closed down over the riders' front.
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 10, 0, Math.PI, 0, Math.PI * 0.62),
      std("#ff8f3d", { transparent: true, opacity: 0.5, roughness: 0.08, metalness: 0.2, side: THREE.DoubleSide }),
    );
    dome.scale.set(w / 2 + 0.35, 2.6, 2.1);
    dome.position.set(0, -4.1, 0.1);
    g.add(dome);
  }
  g.traverse((c) => {
    if (c instanceof THREE.Mesh) c.castShadow = true;
  });
  return g;
}

function makeCabin(color: string): THREE.Group {
  const g = new THREE.Group();
  const frame = std("#3a3f45", { metalness: 0.5, roughness: 0.4 });
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 8), frame);
  grip.position.y = -1.2;
  const body = new THREE.Mesh(rbox(3.6, 3.4, 3.6, 1.0), std(color, { metalness: 0.2, roughness: 0.4 }));
  body.position.y = -4.4;
  const windows = new THREE.Mesh(rbox(3.72, 1.4, 3.72, 0.9), std("#284a66", { roughness: 0.08, metalness: 0.6 }));
  windows.position.y = -3.9;
  const roof = new THREE.Mesh(rbox(2.6, 0.5, 2.6, 0.24), std("#e6e9ec", { metalness: 0.3, roughness: 0.4 }));
  roof.position.y = -2.6;
  g.add(grip, body, windows, roof);
  g.traverse((c) => {
    if (c instanceof THREE.Mesh) c.castShadow = true;
  });
  return g;
}

/** Coarse version of a mountain's terrain, used only for mouse picking. */
function makeProxyGeometry(id: MountainId): THREE.BufferGeometry {
  const wx = 500;
  const wy = 297;
  const o = MOUNT_OFF[id];
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= wy; j++) {
    for (let i = 0; i <= wx; i++) {
      const x = (i / wx) * WORLD_W;
      const y = (j / wy) * WORLD_H;
      pos.push(x - WORLD_W / 2 + o.x, elevation(x, y, id) * TERRAIN_H[id], y - WORLD_H / 2 + o.z);
    }
  }
  for (let j = 0; j < wy; j++) {
    for (let i = 0; i < wx; i++) {
      const a = j * (wx + 1) + i;
      idx.push(a, a + wx + 1, a + 1, a + 1, a + wx + 1, a + wx + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/** Slalom gates: alternating red and blue pole pairs down the run. */
function makeGates(mid: MountainId, width: number, samples: { x: number; y: number; along: number }[]): THREE.Group {
  const g = new THREE.Group();
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.12, 4, 5);
  const flagGeo = new THREE.PlaneGeometry(1.6, 1.1);
  const mats = [std("#d63a2f"), std("#2d63c8")].map((m) => {
    m.side = THREE.DoubleSide;
    return m;
  });
  let next = 18;
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i];
    if (p.along < next) continue;
    next += 28;
    const prev = samples[i - 1];
    let dx = p.x - prev.x;
    let dy = p.y - prev.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const side = n % 2 ? 1 : -1;
    const mat = mats[n % 2];
    n++;
    for (const off of [0.08, 0.3]) {
      const o = side * off * width;
      const base = to3(p.x - dy * o, p.y + dx * o, 2, mid);
      const pole = new THREE.Mesh(poleGeo, mat);
      pole.position.copy(base);
      pole.castShadow = true;
      g.add(pole);
      const flag = new THREE.Mesh(flagGeo, mat);
      flag.position.copy(base).add(new THREE.Vector3(0, 1.2, 0));
      flag.rotation.y = Math.atan2(dx, dy) + Math.PI / 2;
      g.add(flag);
    }
  }
  return g;
}

/** Jumps, rails, boxes and a halfpipe, modelled along +z (direction of travel). */
function makeFeatureMesh(type: FeatureType, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const snow = std("#f4f7fa", { metalness: 0, roughness: 0.9 });
  const steel = std("#9aa4ae", { metalness: 0.7, roughness: 0.3 });
  const accent = std("#f0892a", { metalness: 0.1 });
  if (type === "jump") {
    // Wedge kicker: low at the approach, lip at the far end.
    const shape = new THREE.Shape();
    shape.moveTo(-7, 0);
    shape.lineTo(5, 3.6);
    shape.lineTo(6, 3.6);
    shape.lineTo(6.5, 0);
    shape.lineTo(-7, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 7, bevelEnabled: false });
    geo.translate(0, 0, -3.5);
    geo.rotateY(-Math.PI / 2);
    const m = new THREE.Mesh(geo, snow);
    m.castShadow = !ghost;
    m.receiveShadow = true;
    g.add(m);
    const lip = new THREE.Mesh(rbox(7.2, 0.25, 0.4), accent);
    lip.position.set(0, 3.7, 5.5);
    g.add(lip);
  } else if (type === "rail") {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 16, 8), steel);
    bar.rotation.x = Math.PI / 2;
    bar.position.y = 1.8;
    g.add(bar);
    for (const z of [-6.5, 6.5]) {
      const post = new THREE.Mesh(rbox(0.4, 1.8, 0.4), accent);
      post.position.set(0, 0.9, z);
      g.add(post);
    }
    const ramp = new THREE.Mesh(rbox(3, 1.2, 5), snow);
    ramp.position.set(0, 0.6, -10);
    g.add(ramp);
  } else if (type === "box") {
    const top = new THREE.Mesh(rbox(2.6, 0.8, 13), std("#3e78c4"));
    top.position.y = 1.2;
    top.castShadow = !ghost;
    g.add(top);
    const legs = new THREE.Mesh(rbox(2, 0.8, 11), steel);
    legs.position.y = 0.4;
    g.add(legs);
  } else {
    // Halfpipe: a long U-shaped trough with snow walls.
    const len = 60;
    const r = 7;
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 20, 1, true, -Math.PI / 2, Math.PI), std("#eaf0f5", { side: THREE.DoubleSide, metalness: 0 }));
    pipe.rotation.x = Math.PI / 2;
    pipe.position.y = r;
    pipe.receiveShadow = true;
    g.add(pipe);
    for (const sx of [-1, 1]) {
      const wall = new THREE.Mesh(rbox(3, r, len), snow);
      wall.position.set(sx * (r + 1.5), r / 2, 0);
      wall.castShadow = !ghost;
      g.add(wall);
      const deck = new THREE.Mesh(rbox(0.3, 0.3, len), accent);
      deck.position.set(sx * r, r + 0.15, 0);
      g.add(deck);
    }
  }
  g.userData = { kind: "feature" };
  return g;
}

/** Sit a feature on the slope, facing its direction of travel and tilted to the fall line. */
function placeFeature(obj: THREE.Object3D, f: Pick<Feature, "x" | "y" | "angle" | "type">, mid: MountainId): void {
  const dx = Math.cos(f.angle);
  const dy = Math.sin(f.angle);
  const half = f.type === "halfpipe" ? 30 : 7;
  const back = to3(f.x - dx * half, f.y - dy * half, 0, mid);
  const front = to3(f.x + dx * half, f.y + dy * half, 0, mid);
  obj.position.copy(to3(f.x, f.y, 0, mid));
  obj.position.y = (back.y + front.y) / 2 + (f.type === "halfpipe" ? -2 : 0);
  obj.rotation.order = "YXZ";
  obj.rotation.y = Math.atan2(dx, dy);
  obj.rotation.x = -Math.atan2(front.y - back.y, half * 2);
}

/** Bamboo boundary poles with orange tips along both edges of a glade. */
function makeBoundaryPoles(mid: MountainId, width: number, samples: { x: number; y: number; along: number }[]): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.CylinderGeometry(0.15, 0.15, 5, 5);
  const tip = new THREE.CylinderGeometry(0.17, 0.17, 1, 5);
  const poleMat = std("#d9c27a", { metalness: 0 });
  const tipMat = std("#f0892a", { metalness: 0 });
  let next = 0;
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i];
    if (p.along < next) continue;
    next += 22;
    const prev = samples[i - 1];
    let dx = p.x - prev.x;
    let dy = p.y - prev.y;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    for (const side of [-0.5, 0.5]) {
      const o = side * width;
      const base = to3(p.x - dy * o, p.y + dx * o, 2.5, mid);
      const m = new THREE.Mesh(pole, poleMat);
      m.position.copy(base);
      g.add(m);
      const t = new THREE.Mesh(tip, tipMat);
      t.position.copy(base).add(new THREE.Vector3(0, 3, 0));
      g.add(t);
    }
  }
  return g;
}

/** Concrete pad with a painted H, a windsock and a small hangar. */
function makeHelipad(ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 0.6, 48), std("#8e959c", { metalness: 0 }));
  pad.position.y = 0.3;
  pad.receiveShadow = true;
  g.add(pad);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(12, 0.5, 4, 32), std("#f2c94c"));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.65;
  g.add(ring);
  const paint = std("#ffffff", { metalness: 0 });
  for (const x of [-3, 3]) {
    const bar = new THREE.Mesh(rbox(1.2, 0.2, 9), paint);
    bar.position.set(x, 0.7, 0);
    g.add(bar);
  }
  const cross = new THREE.Mesh(rbox(6, 0.2, 1.2), paint);
  cross.position.set(0, 0.7, 0);
  g.add(cross);
  const hangar = new THREE.Mesh(rbox(14, 8, 12), std("#c9cdd2", { metalness: 0.3 }));
  hangar.position.set(26, 4, 0);
  hangar.castShadow = !ghost;
  g.add(hangar);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 14, 28, 1, false, 0, Math.PI), std("#3a434d", { side: THREE.DoubleSide }));
  roof.rotation.z = Math.PI / 2;
  roof.position.set(26, 8, 0);
  g.add(roof);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 7, 5), std("#55606b"));
  mast.position.set(-18, 3.5, -10);
  const sock = new THREE.Mesh(new THREE.ConeGeometry(0.7, 3, 8, 1, true), std("#f0892a", { side: THREE.DoubleSide }));
  sock.rotation.z = Math.PI / 2;
  sock.position.set(-16.5, 6.6, -10);
  g.add(mast, sock);
  g.userData = { kind: "building" };
  return g;
}

function makeHelicopter(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(2.6, 24, 16), std("#c8332b"));
  body.scale.set(1, 0.85, 1.5);
  body.position.y = 2.6;
  body.castShadow = true;
  const glass = new THREE.Mesh(new THREE.SphereGeometry(1.9, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), std("#2b4d6b", { roughness: 0.1, metalness: 0.5 }));
  glass.rotation.x = Math.PI / 2.4;
  glass.position.set(0, 3, 2.4);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 7, 14), std("#c8332b"));
  boom.rotation.x = Math.PI / 2;
  boom.position.set(0, 3.2, -6.5);
  const fin = new THREE.Mesh(rbox(0.25, 2.2, 1.2), std("#e6e9ec"));
  fin.position.set(0, 4, -9.8);
  const skid = std("#3a3f45");
  for (const x of [-1.6, 1.6]) {
    const s = new THREE.Mesh(rbox(0.25, 0.25, 6), skid);
    s.position.set(x, 0.2, 0);
    g.add(s);
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.2, 6), skid);
  mast.position.y = 5.2;
  const rotor = new THREE.Group();
  rotor.name = "rotor";
  for (const a of [0, Math.PI / 2]) {
    const blade = new THREE.Mesh(rbox(14, 0.12, 0.5), skid);
    blade.rotation.y = a;
    rotor.add(blade);
  }
  rotor.position.y = 5.8;
  g.add(body, glass, boom, fin, mast, rotor);
  return g;
}

/** How far around the view trees are drawn, and the most drawn at once. */
const TREE_RADIUS = 1300;
const TREE_RADIUS_MAX = 5300;
const TREES_DRAWN = 60000;

/** Peak names stay readable from anywhere on the map (fixed on-screen size). */
function makePeakLabel(text: string, done: boolean): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 72;
  const ctx = c.getContext("2d")!;
  ctx.font = "800 30px Nunito, Segoe UI, sans-serif";
  const w = Math.min(500, ctx.measureText(text).width + 36);
  ctx.fillStyle = done ? "rgba(226, 184, 87, 0.95)" : "rgba(19, 32, 44, 0.82)";
  ctx.beginPath();
  ctx.roundRect((512 - w) / 2, 8, w, 56, 16);
  ctx.fill();
  ctx.fillStyle = done ? "#13202c" : "#f3efe4";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 37);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, sizeAttenuation: false, depthTest: false }));
  sprite.scale.set(0.2, 0.028, 1);
  sprite.renderOrder = 4;
  return sprite;
}

type CloudPuff = {
  group: THREE.Group;
  mat: THREE.SpriteMaterial;
  home: THREE.Vector2;
  alt: number;
  threshold: number;
  radius: number;
};

const CLOUD_COUNT = 34;
const CLOUD_SPAN = 36000;
const SNOW_MAX = 9000;
const SUN_HIGH = new THREE.Color("#ffe9c8");
const SUN_LOW = new THREE.Color("#ffbd80");
const OVERCAST_LIGHT = new THREE.Color("#dfe6ee");
const HEMI_CLEAR = new THREE.Color("#b4d0f0");
const HEMI_OVERCAST = new THREE.Color("#e4e9ef");
const SKY_CLEAR = new THREE.Color("#9cc4dc");
const SKY_LOW = new THREE.Color("#e9c6a6");
const SKY_OVERCAST = new THREE.Color("#b4bfc8");
const SKY_SNOW = new THREE.Color("#c9d0d6");
const FOG_TINT = new THREE.Color("#d5dde4");
const ZENITH_CLEAR = new THREE.Color("#3f78b8");
const HORIZON_CLEAR = new THREE.Color("#d6e2ea");
const HORIZON_LOW = new THREE.Color("#f0d6b8");
const FOG_DENSITY = 0.000042;
const EXPOSURE = 0.95;

/** Post-processing runs at up to 1.5x so high-DPI screens stay smooth. */
function postPixelRatio(): number {
  return Math.min(devicePixelRatio || 1, 1.5);
}
const CLOUD_LIT = new THREE.Color("#ffffff");
const CLOUD_LOW = new THREE.Color("#ffe2c6");
const CLOUD_STORM = new THREE.Color("#8c96a2");

/** Small seeded random so the cloud layout is the same every game. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, size: number) => void): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d")!, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A lumpy cloud puff: overlapping soft blobs, a little shaded at the bottom. */
function makeCloudTexture(): THREE.Texture {
  return canvasTexture(256, (g, n) => {
    const rand = mulberry(3);
    for (let i = 0; i < 16; i++) {
      const x = n * (0.25 + rand() * 0.5);
      const y = n * (0.35 + rand() * 0.3);
      const r = n * (0.12 + rand() * 0.16);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      const shade = Math.round(255 - (y / n) * 40);
      grad.addColorStop(0, `rgba(${shade},${shade},${Math.min(255, shade + 6)},0.55)`);
      grad.addColorStop(0.6, `rgba(${shade},${shade},${Math.min(255, shade + 6)},0.25)`);
      grad.addColorStop(1, `rgba(${shade},${shade},${shade},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, n, n);
    }
  });
}

function makeFlakeTexture(): THREE.Texture {
  return canvasTexture(32, (g, n) => {
    const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.45, "rgba(255,255,255,0.8)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
  });
}

/** The sun in the sky: a bright core in a soft glow, drawn on top of the fog. */
function makeSunDisc(): THREE.Sprite {
  const tex = canvasTexture(256, (g, n) => {
    const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.09, "rgba(255,255,250,1)");
    grad.addColorStop(0.13, "rgba(255,245,220,0.55)");
    grad.addColorStop(0.35, "rgba(255,230,190,0.16)");
    grad.addColorStop(1, "rgba(255,220,180,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
  });
  const sp = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }),
  );
  sp.scale.set(9000, 9000, 1);
  sp.renderOrder = -1;
  return sp;
}

const MAX_CARS = 70;
const ROAD_DRAFT_OK = new THREE.Color("#596069");
const ROAD_DRAFT_STEEP = new THREE.Color("#d99a2b");
const PATH_DRAFT_OK = new THREE.Color("#b49a72");

/** Asphalt with snowy shoulders, draped on the terrain. The highway is wider. */
/** A packed, swept footpath: warm gravel with a darker trodden kerb. */
function makePathRibbon(p: Path, mid: MountainId): THREE.Mesh {
  const kerb = new THREE.Color("#8d8170");
  const gravel = new THREE.Color("#b9ab92");
  const geo = buildRibbon(p.points, mid, PATH_WIDTH, 0.55, () => [kerb, gravel], 0.18);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  mesh.receiveShadow = true;
  mesh.userData = { kind: "path", id: p.id };
  // Round paved landings where the path starts and ends.
  const pad = new THREE.CircleGeometry(PATH_WIDTH * 0.75, 20).rotateX(-Math.PI / 2);
  for (const e of [p.points[0], p.points[p.points.length - 1]]) {
    const m = new THREE.Mesh(pad, mesh.material);
    m.position.copy(onGround(e.x, e.y, 0.5, mid));
    m.receiveShadow = true;
    mesh.add(m);
  }
  return mesh;
}

function makeRoadRibbon(r: Road, mid: MountainId): THREE.Mesh {
  const shoulder = new THREE.Color("#c8cfd6");
  const asphalt = new THREE.Color(r.highway ? "#3a3e44" : "#454a51");
  const width = r.highway ? ROAD_WIDTH * 1.4 : ROAD_WIDTH;
  const geo = buildRibbon(r.points, mid, width, 0.8, () => [shoulder, asphalt], 0.12);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }),
  );
  mesh.receiveShadow = true;
  mesh.userData = { kind: "road", id: r.id };
  // Centre line: short dashes along the middle.
  const samples = geo.userData.samples as { x: number; y: number; along: number }[] | undefined;
  if (samples && samples.length > 1) {
    const dashes = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.35, 0.05, 3.2),
      new THREE.MeshBasicMaterial({ color: r.highway ? "#e2b857" : "#e8ecef" }),
      Math.ceil(samples[samples.length - 1].along / 9) + 2,
    );
    const m = new THREE.Object3D();
    let n = 0;
    let next = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      if (b.along < next) continue;
      next = b.along + 9;
      m.position.copy(onGround(b.x, b.y, 0.95, mid));
      m.rotation.set(0, Math.atan2(b.x - a.x, b.y - a.y), 0);
      m.updateMatrix();
      dashes.setMatrixAt(n++, m.matrix);
    }
    dashes.count = n;
    dashes.computeBoundingSphere();
    mesh.add(dashes);
  }
  return mesh;
}

const BOULDERS_DRAWN = 16000;

/** Faceted rocks: a subdivided icosahedron, flat shaded, coloured per instance. */
function makeBoulders(max: number): THREE.InstancedMesh {
  const geo = new THREE.IcosahedronGeometry(1, 2);
  // Break the regular facets so each boulder reads as a chunk of mountain.
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n = 0.82 + noise2(x * 3.1 + i * 0.17, z * 2.7) * 0.38;
    pos.setXYZ(i, x * n, y * (0.7 + noise2(y * 4.2, x * 2.1) * 0.55), z * n);
  }
  geo.computeVertexNormals();
  const mesh = new THREE.InstancedMesh(
    geo,
    new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.95, flatShading: true }),
    max,
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;
  return mesh;
}

function makeBrushRing(): THREE.LineLoop {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(64 * 3), 3));
  const ring = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: "#ffd166", depthTest: false, transparent: true }));
  ring.renderOrder = 10;
  ring.frustumCulled = false;
  ring.visible = false;
  return ring;
}

/**
 * Painted stalls in back-to-back rows with aisles between, and parked cars in
 * most of them. `y` is the deck height. Returns the stripes and the cars.
 */
function parkingDeck(w: number, d: number, y: number, seed: number, fill: number, ghost: boolean): THREE.Object3D[] {
  const stall = 2.8;
  const per = Math.floor((w - 8) / stall);
  const bands = Math.max(1, Math.floor((d - 8) / 12) + 1);
  const z0 = -((bands - 1) * 12) / 2;
  const stripes = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.16, 0.06, 5),
    new THREE.MeshStandardMaterial({ color: "#e9edf0", roughness: 0.6 }),
    bands * (per + 1),
  );
  const m = new THREE.Object3D();
  let n = 0;
  const spots: { x: number; z: number }[] = [];
  for (let b = 0; b < bands; b++) {
    const z = z0 + b * 12;
    for (let i = 0; i <= per; i++) {
      const x = -((per * stall) / 2) + i * stall;
      m.position.set(x, y + 0.05, z);
      m.updateMatrix();
      stripes.setMatrixAt(n++, m.matrix);
      if (i < per) spots.push({ x: x + stall / 2, z });
    }
  }
  stripes.count = n;
  const out: THREE.Object3D[] = [stripes];
  if (ghost) return out;
  const fleet = new Fleet(CAR_MODELS, spots.length);
  const c = new THREE.Color();
  fleet.begin();
  spots.forEach((s, i) => {
    if (noise2(i * 0.77 + seed, seed * 1.3) > fill) return;
    m.position.set(s.x, y, s.z + (noise2(i, seed) - 0.5) * 0.6);
    m.rotation.set(0, i % 2 ? Math.PI : 0, 0);
    m.updateMatrix();
    const v = pickVehicle(i * 3 + seed);
    fleet.add(v.model, m.matrix, c.set(v.color));
  });
  fleet.end();
  out.push(fleet.group);
  return out;
}

/** Surface lots (graded asphalt pads) and the multi-deck garage. */
function makeParkingMesh(type: BuildingType, ghost: boolean): THREE.Group {
  const spec = PARKING[type]!;
  const g = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: "#b7bcc2", roughness: 0.85 });
  if (type !== "garage") {
    // A pad graded into the slope: thick enough that its downhill edge never floats.
    const depth = spec.maxGrade * spec.w + 1.5;
    const pad = new THREE.Mesh(rbox(spec.w, depth, spec.d), new THREE.MeshStandardMaterial({ color: "#4b525b", roughness: 0.92 }));
    pad.position.y = 0.35 - depth / 2;
    pad.receiveShadow = true;
    g.add(pad);
    // Snow pushed into berms along the back and sides.
    const berm = new THREE.MeshStandardMaterial({ color: "#eef3f7", roughness: 0.95 });
    for (const [bw, bd, x, z] of [
      [spec.w, 2.5, 0, -spec.d / 2 - 0.6],
      [2.5, spec.d, -spec.w / 2 - 0.6, 0],
      [2.5, spec.d, spec.w / 2 + 0.6, 0],
    ]) {
      const b = new THREE.Mesh(rbox(bw, 1.4, bd), berm);
      b.position.set(x, 0.5, z);
      g.add(b);
    }
    g.add(...parkingDeck(spec.w, spec.d, 0.36, type === "parkingLarge" ? 11 : 5, 0.62, ghost));
    // Light poles.
    const poles = type === "parkingLarge" ? [[-28, -6], [0, -6], [28, -6], [-28, 18], [0, 18], [28, 18]] : [[-14, 0], [14, 0]];
    for (const [x, z] of poles) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 9, 6), concrete);
      pole.position.set(x, 4.8, z);
      const lamp = new THREE.Mesh(rbox(1.8, 0.35, 0.7), new THREE.MeshStandardMaterial({ color: "#3a3f45", emissive: "#fff2c4", emissiveIntensity: 0.25 }));
      lamp.position.set(x, 9.3, z);
      pole.castShadow = !ghost;
      g.add(pole, lamp);
    }
  } else {
    const levels = 5;
    const lh = 3.4;
    // Plinth down into the slope, then open decks on columns with low walls.
    const plinth = new THREE.Mesh(rbox(spec.w, 9, spec.d), concrete);
    plinth.position.y = -4.4;
    g.add(plinth);
    const wall = new THREE.MeshStandardMaterial({ color: "#d4d8dc", roughness: 0.8 });
    for (let i = 0; i <= levels; i++) {
      const y = i * lh;
      const slab = new THREE.Mesh(rbox(spec.w, 0.5, spec.d), concrete);
      slab.position.y = y;
      slab.castShadow = !ghost;
      slab.receiveShadow = true;
      g.add(slab);
      if (i === 0) continue;
      for (const [bw, bd, x, z] of [
        [spec.w, 0.4, 0, spec.d / 2],
        [spec.w, 0.4, 0, -spec.d / 2],
        [0.4, spec.d, spec.w / 2, 0],
        [0.4, spec.d, -spec.w / 2, 0],
      ]) {
        const p = new THREE.Mesh(rbox(bw, 1.1, bd), wall);
        p.position.set(x, y + 0.8, z);
        g.add(p);
      }
    }
    for (let x = -spec.w / 2 + 1; x <= spec.w / 2 - 1; x += (spec.w - 2) / 5) {
      for (const z of [-spec.d / 2 + 1, 0, spec.d / 2 - 1]) {
        const col = new THREE.Mesh(rbox(0.8, levels * lh, 0.8), concrete);
        col.position.set(x, (levels * lh) / 2, z);
        g.add(col);
      }
    }
    // Cars on every deck (the roof is the emptiest).
    for (let i = 0; i < levels; i++) g.add(...parkingDeck(spec.w - 6, spec.d - 6, i * lh + 0.25, 3 + i * 5, i === levels - 1 ? 0.3 : 0.7, ghost));
    // Stair and lift tower, with a big P.
    const tower = new THREE.Mesh(rbox(7, levels * lh + 4, 7), new THREE.MeshStandardMaterial({ color: "#2f5f99", roughness: 0.6 }));
    tower.position.set(spec.w / 2 - 2, (levels * lh + 4) / 2, spec.d / 2 + 2);
    tower.castShadow = !ghost;
    g.add(tower);
    // Entry ramp up the long side.
    const ramp = new THREE.Mesh(rbox(22, 0.5, 7), concrete);
    ramp.position.set(-spec.w / 2 + 14, lh / 2, spec.d / 2 + 4);
    ramp.rotation.z = Math.atan2(lh, 22);
    g.add(ramp);
  }
  g.userData = { kind: "building" };
  return g;
}

/**
 * Terrain mesh spacing in metres. Finer than the 28 m heightmap so ridges
 * and the fine relief read as real geometry (~4× the triangles).
 */
const TERRAIN_GRID = 14;
/** Mesh cells per tile; sized so draw-call count stays close to the old 28 m grid. */
const TERRAIN_TILE = 128;
const T_GROOMED = new THREE.Color("#edf2f7");
const T_PACKED = new THREE.Color("#dbe4ee");
const T_WIND = new THREE.Color("#c3cfdc");
const T_ROCK = new THREE.Color("#5f5b58");
const T_ROCK_DARK = new THREE.Color("#433f3d");
const T_FOREST = new THREE.Color("#2c4636");
const T_TMP = new THREE.Color();

/**
 * One terrain vertex: position, normal (from the heightfield, so tiles don't
 * seam), the natural colour (snow, wind crust, rock, woods tint) and the
 * steepness overlay colour, written at index q of the given arrays.
 */
function shadeTerrainVertex(
  i: number,
  j: number,
  wx: number,
  wy: number,
  id: MountainId,
  pos: Float32Array,
  nor: Float32Array,
  natural: Float32Array,
  overlay: Float32Array,
  q: number,
): void {
  const cell = TERRAIN_GRID;
  const o = MOUNT_OFF[id];
  const hScale = TERRAIN_H[id];
  const c = T_TMP;
  const x = (i / wx) * WORLD_W;
  const y = (j / wy) * WORLD_H;
  const e = meshSample(x, y, id);
  const g = gradeAt(x, y, id);
  pos[q * 3] = x - WORLD_W / 2 + o.x;
  pos[q * 3 + 1] = e * hScale;
  pos[q * 3 + 2] = y - WORLD_H / 2 + o.z;
  const hx = (meshSample(x + cell, y, id) - meshSample(x - cell, y, id)) * hScale;
  const hz = (meshSample(x, y + cell, id) - meshSample(x, y - cell, id)) * hScale;
  const nl = Math.hypot(hx, 2 * cell, hz);
  nor[q * 3] = -hx / nl;
  nor[q * 3 + 1] = (2 * cell) / nl;
  nor[q * 3 + 2] = -hz / nl;

  // Natural look: the steeper it gets, the more wind-blown, then rocky.
  const grain = noise2(x * 0.06, y * 0.06);
  const streak = noise2(x * 0.02, y * 0.004);
  if (g < 0.25) c.copy(T_GROOMED);
  else if (g < 0.45) c.copy(T_GROOMED).lerp(T_PACKED, (g - 0.25) / 0.2);
  else c.copy(T_PACKED).lerp(T_WIND, Math.min(1, (g - 0.45) / 0.25));
  const rockAmt = Math.max(smooth(0.62, 0.98, g + (streak - 0.5) * 0.35), smooth(0.3, 0.7, rockAt(x, y)) * 0.95);
  if (rockAmt > 0) c.lerp(streak > 0.55 ? T_ROCK_DARK : T_ROCK, rockAmt * 0.92);
  // Woods read as a dark tint from far away; real trees are drawn near the camera.
  const woods = smooth(0.3, 0.6, forestDensity(x, y)) * (1 - rockAmt);
  if (woods > 0) c.lerp(T_FOREST, woods * 0.55);
  const shade = (grain - 0.5) * 0.05;
  natural[q * 3] = c.r + shade;
  natural[q * 3 + 1] = c.g + shade;
  natural[q * 3 + 2] = c.b + shade;

  // Overlay: same bands the trail classifier uses.
  const band: Difficulty = classifyGrade(g * 100, 100);
  c.copy(BAND_COLORS[band]).lerp(T_GROOMED, 0.18);
  overlay[q * 3] = c.r;
  overlay[q * 3 + 1] = c.g;
  overlay[q * 3 + 2] = c.b;
}
