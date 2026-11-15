import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { elevation, gradeAt, lerp, noise2 } from "./height";
import { Game } from "./sim";
import { classifyGrade } from "./sim";
import { BuildingType, DIFF, Difficulty, INCOME_PER_MIN, MountainId, Trail, UNIT_M, Vec2, VERTICAL_M, WORLD_H, WORLD_W } from "./types";

/**
 * World units of height per unit of elevation. The trail classifier treats
 * elevation 1 as VERTICAL_M metres over UNIT_M metres per world unit, so
 * VERTICAL_M / UNIT_M is the "true" scale; a little extra exaggeration makes
 * steep pitches read clearly from the orbit camera.
 */
const TRUE_SCALE = VERTICAL_M / UNIT_M;
const H = TRUE_SCALE * 1.3;
export const TERRAIN_H = [H, H, H];

/** Slope-overlay colours by difficulty band (green, blue, black, double black). */
const BAND_COLORS = ["#3fb878", "#3d84d8", "#3a3f47", "#b8324b"].map((c) => new THREE.Color(c));

export const MOUNT_OFF = [
  { x: 0, z: 0 },
  { x: 980, z: 70 },
  { x: 2080, z: 30 },
];

export function to3(x: number, y: number, lift = 0, mid: MountainId = 0): THREE.Vector3 {
  const o = MOUNT_OFF[mid];
  return new THREE.Vector3(
    x - WORLD_W / 2 + o.x,
    elevation(x, y, mid) * TERRAIN_H[mid] + lift,
    y - WORLD_H / 2 + o.z,
  );
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
  private terrains: THREE.Mesh[] = [];
  private trees: THREE.InstancedMesh;
  private mid: MountainId = 0;
  private trailGroup = new THREE.Group();
  private buildingGroup = new THREE.Group();
  private liftGroup = new THREE.Group();
  private carriers: THREE.Group[] = [];
  private skiers: THREE.Group[] = [];
  private ghost = new THREE.Group();
  private draft: THREE.Mesh;
  private draftKey = "";
  private slopeView = false;
  private slopeApplied = false;
  private sun!: THREE.DirectionalLight;
  private snow: THREE.Points;
  private stamp = "";
  private introT = 0;
  private flying = true;
  private tmp = new THREE.Object3D();
  private lastPointer = { x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 1, 12000);
    this.camera.position.set(320, 340, -560);
    this.scene.background = new THREE.Color("#9cc4dc");
    this.scene.fog = new THREE.Fog("#a9cbe0", 1300, 6200);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 70, -20);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 70;
    this.controls.maxDistance = 3000;
    this.controls.mouseButtons.LEFT = -1 as unknown as THREE.MOUSE;
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    this.controls.enablePan = true;
    this.controls.enabled = false;

    this.addLights();
    this.addGround();
    for (const id of [0, 1, 2] as MountainId[]) {
      const mesh = this.makeTerrain(id);
      this.terrains.push(mesh);
      this.scene.add(mesh);
    }
    this.trees = this.makeEmptyTrees();
    this.scene.add(this.trees);
    this.scene.add(this.trailGroup, this.buildingGroup, this.liftGroup);
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
    this.carriers = [];
    for (let i = 0; i < 40; i++) {
      const s = makeSkierMesh("#c45c4a");
      s.visible = false;
      this.scene.add(s);
      this.skiers.push(s);
    }

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
    for (const mesh of this.terrains) {
      const geo = mesh.geometry;
      const src = (on ? geo.userData.overlay : geo.userData.natural) as THREE.Float32BufferAttribute;
      geo.setAttribute("color", src);
    }
  }

  get slopeViewOn(): boolean {
    return this.slopeView;
  }

  private aimSun(id: MountainId): void {
    const o = MOUNT_OFF[id];
    this.sun.target.position.set(o.x, 60, o.z);
    this.sun.position.set(o.x + 640, 360, o.z - 160);
    this.sun.target.updateMatrixWorld();
  }

  resize(): void {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(innerWidth, innerHeight, false);
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
      ...this.terrains,
      this.buildingGroup,
      this.trailGroup,
      this.liftGroup,
      ...this.skiers,
    ];
    const hits = this.raycaster.intersectObjects(objs, true);
    if (!hits.length) return null;
    const obj = hits[0].object;
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

  focusMountain(id: MountainId): void {
    const o = MOUNT_OFF[id];
    this.controls.target.set(o.x + 20, 90, o.z + 10);
    this.camera.position.set(o.x + 300, 330, o.z - 640);
    this.controls.update();
    this.aimSun(id);
  }

  showGhost(type: BuildingType, x: number, y: number, ok: boolean): void {
    if (this.ghost.userData.type !== type) {
      this.ghost.clear();
      this.ghost.add(makeBuildingMesh(type, true));
      this.ghost.userData.type = type;
    }
    const p = to3(x, y, 0, this.mid);
    this.ghost.position.copy(p);
    this.ghost.visible = true;
    this.ghost.traverse((c) => {
      if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshStandardMaterial) {
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
    if (game.currentMountain !== this.mid) {
      this.mid = game.currentMountain;
      this.stamp = "";
      if (!this.flying) this.focusMountain(this.mid);
      else this.aimSun(this.mid);
    }
    if (this.flying) {
      this.introT += dt * 0.1;
      const a = -0.55 + this.introT;
      const r = 640;
      this.camera.position.set(Math.sin(a) * r, 330 + Math.sin(this.introT * 0.6) * 24, Math.cos(a) * r * 0.85 - 40);
      this.camera.lookAt(0, 90, 40);
    } else {
      this.flyKeys(dt);
      this.controls.update();
    }
    // Steepness tint is always on while drawing a run.
    this.applySlopeColors(this.slopeView || game.tool === "cut");
    this.syncStatic(game);
    this.syncLift(game);
    this.syncSkiers(game);
    this.syncDraft(game);
    this.tickSnow(dt, game.paused ? 0.15 : game.speed);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private flyKeys(dt: number): void {
    const speed = (this.keys.has("shift") ? 280 : 150) * dt;
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
    const hemi = new THREE.HemisphereLight("#cfe3ff", "#6f7f94", 0.55);
    this.scene.add(hemi);
    // Low, raking sun so headwalls throw shadow and gentle slopes stay bright.
    const sun = new THREE.DirectionalLight("#fff0d2", 2.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 40;
    sun.shadow.camera.far = 2400;
    sun.shadow.camera.left = -620;
    sun.shadow.camera.right = 620;
    sun.shadow.camera.top = 620;
    sun.shadow.camera.bottom = -620;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 1.2;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    this.scene.add(new THREE.AmbientLight("#b9d4e6", 0.05));
  }

  private addGround(): void {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(9000, 6000),
      new THREE.MeshLambertMaterial({ color: "#dfe8ef" }),
    );
    g.position.x = 1000;
    g.rotation.x = -Math.PI / 2;
    g.position.y = -2;
    g.receiveShadow = true;
    this.scene.add(g);
    this.scene.add(this.makeFarTrees());
    this.scene.add(makeBackdrop());
  }

  private makeTerrain(id: MountainId): THREE.Mesh {
    const wx = 200;
    const wy = 256;
    const o = MOUNT_OFF[id];
    const hScale = TERRAIN_H[id];
    const n = (wx + 1) * (wy + 1);
    const pos = new Float32Array(n * 3);
    const natural = new Float32Array(n * 3);
    const overlay = new Float32Array(n * 3);
    const idx: number[] = [];
    const c = new THREE.Color();
    const groomed = new THREE.Color("#edf2f7");
    const packed = new THREE.Color("#dbe4ee");
    const wind = new THREE.Color("#c3cfdc");
    const rock = new THREE.Color("#5f5b58");
    const rockDark = new THREE.Color("#433f3d");
    const meadow = new THREE.Color("#d8d6cc");
    let k = 0;
    for (let j = 0; j <= wy; j++) {
      for (let i = 0; i <= wx; i++, k++) {
        const x = (i / wx) * WORLD_W;
        const y = (j / wy) * WORLD_H;
        const e = elevation(x, y, id);
        const g = gradeAt(x, y, id);
        pos[k * 3] = x - WORLD_W / 2 + o.x;
        pos[k * 3 + 1] = e * hScale;
        pos[k * 3 + 2] = y - WORLD_H / 2 + o.z;

        // Natural look: the steeper it gets, the more wind-blown, then rocky.
        const grain = noise2(x * 0.06, y * 0.06);
        const streak = noise2(x * 0.22, y * 0.035);
        if (g < 0.16) c.copy(groomed);
        else if (g < 0.3) c.copy(groomed).lerp(packed, (g - 0.16) / 0.14);
        else c.copy(packed).lerp(wind, Math.min(1, (g - 0.3) / 0.18));
        const rockAmt = smooth(0.52, 0.8, g + (streak - 0.5) * 0.28);
        if (rockAmt > 0) c.lerp(streak > 0.55 ? rockDark : rock, rockAmt * 0.92);
        if (y < 150) c.lerp(meadow, (1 - y / 150) * 0.55);
        const shade = (grain - 0.5) * 0.05;
        natural[k * 3] = c.r + shade;
        natural[k * 3 + 1] = c.g + shade;
        natural[k * 3 + 2] = c.b + shade;

        // Overlay: same bands the trail classifier uses.
        const band: Difficulty = classifyGrade(g * 100, 100);
        c.copy(BAND_COLORS[band]).lerp(groomed, 0.18);
        overlay[k * 3] = c.r;
        overlay[k * 3 + 1] = c.g;
        overlay[k * 3 + 2] = c.b;
      }
    }
    for (let j = 0; j < wy; j++) {
      for (let i = 0; i < wx; i++) {
        const a = j * (wx + 1) + i;
        idx.push(a, a + wx + 1, a + 1, a + 1, a + wx + 1, a + wx + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const naturalAttr = new THREE.Float32BufferAttribute(natural, 3);
    const overlayAttr = new THREE.Float32BufferAttribute(overlay, 3);
    geo.userData = { natural: naturalAttr, overlay: overlayAttr };
    geo.setAttribute("color", naturalAttr);
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.userData = { kind: "terrain", mountain: id };
    mesh.add(makeSkirt(id));
    return mesh;
  }

  private makeEmptyTrees(): THREE.InstancedMesh {
    const lower = new THREE.ConeGeometry(3.8, 9, 7);
    lower.translate(0, -2, 0);
    const upper = new THREE.ConeGeometry(2.6, 8, 7);
    upper.translate(0, 3.5, 0);
    const trunk = new THREE.CylinderGeometry(0.45, 0.6, 3, 5);
    trunk.translate(0, -7.5, 0);
    const geo = mergeGeometries([lower, upper, trunk])!;
    const mat = new THREE.MeshLambertMaterial({ color: "#ffffff" });
    const mesh = new THREE.InstancedMesh(geo, mat, 500);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.count = 0;
    return mesh;
  }

  private makeFarTrees(): THREE.InstancedMesh {
    const geo = new THREE.ConeGeometry(4.2, 18, 5);
    const mat = new THREE.MeshLambertMaterial({ color: "#163828" });
    const mesh = new THREE.InstancedMesh(geo, mat, 280);
    const dummy = this.tmp;
    let n = 0;
    for (let i = 0; i < 280; i++) {
      const a = noise2(i * 0.41, 3) * Math.PI * 2;
      const r = 420 + noise2(i * 0.2, 9) * 520;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.abs(x) < WORLD_W * 0.55 && Math.abs(z) < WORLD_H * 0.55) continue;
      dummy.position.set(x, 8, z);
      dummy.scale.setScalar(0.8 + noise2(i, 1) * 1.4);
      dummy.rotation.y = a;
      dummy.updateMatrix();
      mesh.setMatrixAt(n++, dummy.matrix);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private makeSnow(): THREE.Points {
    const count = 500;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 900;
      pos[i * 3 + 1] = Math.random() * 460;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 1000;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ color: "#ffffff", size: 1.4, transparent: true, opacity: 0.75 }));
  }

  private tickSnow(dt: number, speed: number): void {
    const pos = this.snow.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      let y = pos.getY(i) - (8 + speed * 10) * dt;
      if (y < 0) y = 440;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
  }

  private syncStatic(game: Game): void {
    const key = `${game.currentMountain}:${game.trails.length}:${game.buildings.length}:${game.trees.length}:${game.selected?.kind}:${game.selected?.id}:${game.owned.join(",")}`;
    if (key === this.stamp) return;
    this.stamp = key;
    this.layoutTrees(game);
    this.layoutTrails(game);
    this.layoutBuildings(game);
    this.layoutLift(game);
    this.terrains.forEach((mesh, i) => {
      const owned = game.owned.includes(i as MountainId);
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissive = new THREE.Color(owned ? "#000000" : "#1a2430");
      mat.emissiveIntensity = owned ? 0 : 0.12;
      mat.opacity = owned ? 1 : 0.72;
      mat.transparent = !owned;
    });
  }

  private layoutTrees(game: Game): void {
    const dummy = this.tmp;
    const col = new THREE.Color();
    let n = 0;
    for (const t of game.trees) {
      if (n >= 500) break;
      // Nothing grows on the cliff bands.
      if (gradeAt(t.x, t.y, this.mid) > 0.6) continue;
      const sc = 0.7 + noise2(t.x, t.y) * 0.9;
      dummy.position.copy(to3(t.x, t.y, 8 * sc, this.mid));
      dummy.scale.setScalar(sc);
      dummy.rotation.set(0, t.x * 0.1, 0);
      dummy.updateMatrix();
      this.trees.setMatrixAt(n, dummy.matrix);
      const v = noise2(t.x * 0.7, t.y * 0.7);
      col.setHSL(0.38 + v * 0.06, 0.38 + v * 0.15, 0.17 + v * 0.07);
      this.trees.setColorAt(n, col);
      n++;
    }
    this.trees.count = n;
    this.trees.instanceMatrix.needsUpdate = true;
    if (this.trees.instanceColor) this.trees.instanceColor.needsUpdate = true;
    // Bounds are cached from the first layout; refresh them or trees on the
    // other mountains get frustum-culled.
    this.trees.computeBoundingSphere();
    this.trees.computeBoundingBox();
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
    this.buildingGroup.add(makeVillageProps(this.mid));
    for (const b of game.buildings) {
      const mesh = makeBuildingMesh(b.type, false);
      mesh.position.copy(to3(b.x, b.y, 0, this.mid));
      mesh.userData = { kind: "building", id: b.id };
      const tag = makeRateSprite(`$${INCOME_PER_MIN[b.type]}/min`);
      tag.position.y = b.type === "hotel" ? 28 : b.type === "condo" || b.type === "lodge" ? 20 : 14;
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
    this.carriers = [];
    const bot = to3(game.lift.bottom.x, game.lift.bottom.y, 0, this.mid);
    const top = to3(game.lift.top.x, game.lift.top.y, 0, this.mid);
    const cableH = 16;
    for (const p of [bot, top]) {
      const tower = makeTower();
      tower.position.copy(p);
      tower.userData = { kind: "lift", id: 0 };
      this.liftGroup.add(tower);
    }
    const midCount = 3;
    for (let i = 1; i <= midCount; i++) {
      const t = i / (midCount + 1);
      const p = bot.clone().lerp(top, t);
      const g = from3(p, this.mid);
      const ground = to3(g.x, g.y, 0, this.mid).y;
      const cableY = lerp(bot.y, top.y, t) + cableH;
      p.y = ground;
      const tower = makeTower();
      tower.scale.set(0.8, Math.max(0.5, (cableY - ground) / cableH), 0.8);
      tower.position.copy(p);
      tower.userData = { kind: "lift", id: 0 };
      this.liftGroup.add(tower);
    }
    const c0 = bot.clone();
    c0.y += cableH;
    const c1 = top.clone();
    c1.y += cableH;
    const cableGeo = new THREE.BufferGeometry().setFromPoints([c0, c1]);
    const cable = new THREE.Line(cableGeo, new THREE.LineBasicMaterial({ color: "#22262c" }));
    cable.userData = { kind: "lift", id: 0 };
    this.liftGroup.add(cable);
    for (let i = 0; i < game.lift.carriers.length; i++) {
      const bar = makeTBar();
      this.liftGroup.add(bar);
      this.carriers.push(bar);
    }
  }

  private syncLift(game: Game): void {
    const bot = to3(game.lift.bottom.x, game.lift.bottom.y, 16, this.mid);
    const top = to3(game.lift.top.x, game.lift.top.y, 16, this.mid);
    for (let i = 0; i < this.carriers.length; i++) {
      const t = game.lift.carriers[i]?.t ?? 0;
      this.carriers[i].position.lerpVectors(bot, top, t);
    }
  }

  private syncSkiers(game: Game): void {
    for (let i = 0; i < this.skiers.length; i++) {
      const mesh = this.skiers[i];
      const s = game.skiers[i];
      if (!s) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      const p = to3(s.x, s.y, 1.4, this.mid);
      mesh.position.copy(p);
      mesh.userData = { kind: "skier", id: s.id };
      const body = mesh.children[0] as THREE.Mesh;
      if (body && body.material instanceof THREE.MeshLambertMaterial) {
        body.material.color.set(s.color);
      }
    }
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
      const geo = buildRibbon(pts, this.mid, 5, 1.1, (seg) => {
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
    const steps = Math.max(1, Math.ceil(len / 3));
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
      const v = to3(p.x - dy * off, p.y + dx * off, lift, mid);
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
  const edge = t.difficulty >= 2 ? new THREE.Color("#23262b") : diffColor;
  const centre = new THREE.Color(t.difficulty >= 2 ? "#eef2f6" : "#fbfdff");
  const width = 10;
  const geo = buildRibbon(t.points, mid, width, 0.7, () => [edge, centre], 0.2);
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    emissive: diffColor,
    emissiveIntensity: glow ? 0.45 : 0,
    roughness: 0.75,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.userData = { kind: "trail", id: t.id };

  // Black runs are left ungroomed: a field of moguls.
  if (t.difficulty >= 2) mesh.add(makeMoguls(t, mid, width, geo.userData.samples));

  // Trailhead sign with the difficulty symbol.
  const head = t.points[0];
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.35, 10, 5),
    new THREE.MeshStandardMaterial({ color: "#5a3c26" }),
  );
  post.position.copy(to3(head.x, head.y, 5, mid));
  post.castShadow = true;
  mesh.add(post);
  const sign = makeTrailSign(t.name, t.difficulty);
  sign.position.copy(to3(head.x, head.y, 14, mid));
  mesh.add(sign);
  return mesh;
}

function makeMoguls(t: Trail, mid: MountainId, width: number, samples: { x: number; y: number; along: number }[]): THREE.InstancedMesh {
  const double = t.difficulty === 3;
  const spacing = double ? 4.2 : 5.5;
  const geo = new THREE.SphereGeometry(1, 9, 6, 0, Math.PI * 2, 0, Math.PI / 2);
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
  sprite.scale.set(28, 7, 1);
  sprite.renderOrder = 2;
  return sprite;
}

/** Rock curtain hanging off the terrain edges so the hill doesn't look like a floating sheet. */
function makeSkirt(id: MountainId): THREE.Mesh {
  const steps = 96;
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
function makeBackdrop(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
  const snow = new THREE.Color("#eef3f8");
  const rockC = new THREE.Color("#7d8794");
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + noise2(i * 1.7, 4) * 0.2;
    const r = 2300 + noise2(i * 0.9, 7) * 900;
    const x = 1040 + Math.cos(a) * r * 1.35;
    const z = Math.sin(a) * r;
    const height = 380 + noise2(i * 2.3, 11) * 520;
    const geo = new THREE.ConeGeometry(height * 1.25, height, 7, 3);
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

function makeSignSprite(text: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 80;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(19, 32, 44, 0.9)";
  ctx.beginPath();
  ctx.roundRect(8, 8, 496, 64, 16);
  ctx.fill();
  ctx.fillStyle = "#e2b857";
  ctx.font = "700 28px Nunito, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 40);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(48, 7.5, 1);
  sprite.renderOrder = 3;
  return sprite;
}

function makeRateSprite(text: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(19, 32, 44, 0.88)";
  ctx.beginPath();
  ctx.roundRect(8, 8, 240, 48, 14);
  ctx.fill();
  ctx.fillStyle = "#e2b857";
  ctx.font = "700 28px Nunito, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(16, 4, 1);
  sprite.renderOrder = 2;
  return sprite;
}

function makeBuildingMesh(type: BuildingType, ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const palette: Record<BuildingType, { body: string; roof: string; w: number; d: number; h: number }> = {
    lodge: { body: "#d8cbb6", roof: "#8b3a32", w: 28, d: 20, h: 12 },
    restroom: { body: "#d9d2c5", roof: "#4a5560", w: 10, d: 8, h: 7 },
    coffee: { body: "#efe6d2", roof: "#6f4e37", w: 14, d: 11, h: 7 },
    sandwich: { body: "#e7edd8", roof: "#355e3b", w: 14, d: 11, h: 7 },
    shack: { body: "#c4a574", roof: "#6b3a2a", w: 8, d: 7, h: 5 },
    hotel: { body: "#e8e0d4", roof: "#4a3a32", w: 34, d: 22, h: 22 },
    restaurant: { body: "#ead7c3", roof: "#7a2e2a", w: 20, d: 16, h: 9 },
    shop: { body: "#f0e6c8", roof: "#355e3b", w: 16, d: 12, h: 8 },
    condo: { body: "#d7dde4", roof: "#2c3d4f", w: 24, d: 18, h: 16 },
    patrol: { body: "#dfe7ee", roof: "#c45c4a", w: 12, d: 10, h: 7 },
  };
  const p = palette[type];
  const bodyMat = new THREE.MeshStandardMaterial({ color: p.body, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: p.roof, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), bodyMat);
  body.position.y = p.h / 2;
  body.castShadow = !ghost;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(p.w, p.d) * 0.62, type === "hotel" ? 8 : 5, 4), roofMat);
  roof.position.y = p.h + (type === "hotel" ? 4 : 2.5);
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = !ghost;
  g.add(body, roof);
  if (type === "lodge" || type === "hotel") {
    const door = new THREE.Mesh(new THREE.BoxGeometry(4, 6, 0.6), new THREE.MeshStandardMaterial({ color: "#5c3317" }));
    door.position.set(0, 3, p.d / 2 + 0.2);
    g.add(door);
  }
  g.userData = { kind: "building" };
  return g;
}

function makeVillageProps(mid: MountainId): THREE.Group {
  const g = new THREE.Group();
  const booth = makeBuildingMesh("restroom", false);
  booth.scale.set(0.7, 0.85, 0.7);
  booth.position.copy(to3(352, 92, 0, mid));
  booth.userData = { kind: "hill" };
  g.add(booth);
  const road = new THREE.Mesh(
    new THREE.BoxGeometry(18, 0.4, 90),
    new THREE.MeshLambertMaterial({ color: "#5c6570" }),
  );
  road.position.copy(to3(300, 50, 0.2, mid));
  g.add(road);
  const colors = ["#8b3a32", "#2e4a72", "#d5d0c4", "#355e3b"];
  const spots = [
    [240, 28],
    [268, 32],
    [296, 26],
    [390, 34],
  ];
  spots.forEach(([x, y], i) => {
    const car = new THREE.Mesh(new THREE.BoxGeometry(6, 2.2, 3.2), new THREE.MeshLambertMaterial({ color: colors[i] }));
    car.position.copy(to3(x, y, 1.2, mid));
    g.add(car);
  });
  const pad = new THREE.Mesh(
    new THREE.BoxGeometry(220, 0.35, 90),
    new THREE.MeshLambertMaterial({ color: "#c9c2b0" }),
  );
  pad.position.copy(to3(325, 108, 0.1, mid));
  g.add(pad);
  const sign = makeSignSprite("BASE VILLAGE — build here");
  sign.position.copy(to3(325, 150, 10, mid));
  g.add(sign);
  return g;
}

function makeTower(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.7, 16, 6),
    new THREE.MeshStandardMaterial({ color: "#3c2a1e" }),
  );
  pole.position.y = 8;
  pole.castShadow = true;
  const arm = new THREE.Mesh(new THREE.BoxGeometry(8, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: "#c45c4a" }));
  arm.position.y = 15.5;
  g.add(pole, arm);
  g.userData = { kind: "lift", id: 0 };
  return g;
}

function makeTBar(): THREE.Group {
  const g = new THREE.Group();
  const hang = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 4), new THREE.MeshBasicMaterial({ color: "#2a3038" }));
  hang.position.y = -3;
  const bar = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.25, 0.25), new THREE.MeshBasicMaterial({ color: "#b33b2b" }));
  bar.position.y = -6;
  g.add(hang, bar);
  return g;
}

function makeSkierMesh(color: string): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.2, 1.1), new THREE.MeshLambertMaterial({ color }));
  body.position.y = 2.2;
  body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 8), new THREE.MeshLambertMaterial({ color: "#f1d5b8" }));
  head.position.y = 3.6;
  const ski = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.15, 3.4), new THREE.MeshLambertMaterial({ color: "#2a3038" }));
  ski.position.set(-0.4, 0.2, 0.2);
  const ski2 = ski.clone();
  ski2.position.x = 0.4;
  g.add(body, head, ski, ski2);
  g.userData = { kind: "skier" };
  return g;
}
