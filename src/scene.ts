import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { elevation, lerp, noise2, slopeAt } from "./height";
import { Game } from "./sim";
import { BuildingType, DIFF, INCOME_PER_MIN, MountainId, Trail, WORLD_H, WORLD_W } from "./types";

export const TERRAIN_H = [124, 158, 186];

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
  private draft: THREE.Line;
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
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 1, 9000);
    this.camera.position.set(280, 240, -430);
    this.scene.background = new THREE.Color("#8ebbd4");
    this.scene.fog = new THREE.Fog("#8ebbd4", 900, 4200);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 36, -20);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 70;
    this.controls.maxDistance = 2400;
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
    this.draft = this.makeLine("#e2b857");
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
    this.controls.target.set(0, 32, -40);
    this.controls.update();
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
    this.controls.target.set(o.x, 40, o.z);
    this.camera.position.set(o.x + 280, 240, o.z - 430);
    this.controls.update();
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
    }
    if (this.flying) {
      this.introT += dt * 0.1;
      const a = -0.55 + this.introT;
      const r = 460;
      this.camera.position.set(Math.sin(a) * r, 210 + Math.sin(this.introT * 0.6) * 16, Math.cos(a) * r * 0.85 - 30);
      this.camera.lookAt(0, 40, 20);
    } else {
      this.flyKeys(dt);
      this.controls.update();
    }
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
    const hemi = new THREE.HemisphereLight("#e7f3ff", "#6d5b43", 0.85);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight("#fff4d8", 1.35);
    sun.position.set(220, 340, -160);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 40;
    sun.shadow.camera.far = 2800;
    sun.shadow.camera.left = -900;
    sun.shadow.camera.right = 900;
    sun.shadow.camera.top = 900;
    sun.shadow.camera.bottom = -900;
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight("#b9d4e6", 0.22));
  }

  private addGround(): void {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(6400, 4000),
      new THREE.MeshLambertMaterial({ color: "#8aa3a0" }),
    );
    g.position.x = 1000;
    g.rotation.x = -Math.PI / 2;
    g.position.y = -2;
    g.receiveShadow = true;
    this.scene.add(g);
    const far = this.makeFarTrees();
    this.scene.add(far);
  }

  private makeTerrain(id: MountainId): THREE.Mesh {
    const wx = 128;
    const wy = 160;
    const geo = new THREE.BufferGeometry();
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const o = MOUNT_OFF[id];
    const hScale = TERRAIN_H[id];
    for (let j = 0; j <= wy; j++) {
      for (let i = 0; i <= wx; i++) {
        const x = (i / wx) * WORLD_W;
        const y = (j / wy) * WORLD_H;
        const e = elevation(x, y, id);
        const sl = slopeAt(x, y, id);
        pos.push(x - WORLD_W / 2 + o.x, e * hScale, y - WORLD_H / 2 + o.z);
        let r = 0.93, g = 0.95, b = 0.97;
        if (y < 150) {
          r = lerp(0.82, r, y / 150);
          g = lerp(0.8, g, y / 150);
          b = lerp(0.74, b, y / 150);
        } else if (sl > 0.01 && e > 0.55) {
          r = 0.55; g = 0.55; b = 0.58;
        } else if (e < 0.22) {
          r = 0.78; g = 0.84; b = 0.8;
        }
        const n = noise2(x * 0.05, y * 0.05) * 0.06;
        col.push(r - n, g - n, b - n);
      }
    }
    for (let j = 0; j < wy; j++) {
      for (let i = 0; i < wx; i++) {
        const a = j * (wx + 1) + i;
        idx.push(a, a + 1, a + wx + 1, a + 1, a + wx + 2, a + wx + 1);
      }
    }
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.userData = { kind: "terrain", mountain: id };
    return mesh;
  }

  private makeEmptyTrees(): THREE.InstancedMesh {
    const geo = new THREE.ConeGeometry(3.4, 14, 6);
    const mat = new THREE.MeshLambertMaterial({ color: "#1f4a33" });
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

  private makeLine(color: string): THREE.Line {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
    line.visible = false;
    line.frustumCulled = false;
    return line;
  }

  private makeSnow(): THREE.Points {
    const count = 500;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 900;
      pos[i * 3 + 1] = Math.random() * 280;
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
      if (y < 0) y = 260;
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
    const n = Math.min(game.trees.length, this.trees.count === 0 ? 500 : 500);
    this.trees.count = n;
    for (let i = 0; i < n; i++) {
      const t = game.trees[i];
      const p = to3(t.x, t.y, 7, this.mid);
      dummy.position.copy(p);
      dummy.scale.setScalar(0.7 + noise2(t.x, t.y) * 0.9);
      dummy.rotation.set(0, t.x * 0.1, 0);
      dummy.updateMatrix();
      this.trees.setMatrixAt(i, dummy.matrix);
    }
    this.trees.instanceMatrix.needsUpdate = true;
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
      p.y = lerp(bot.y, top.y, t);
      const tower = makeTower();
      tower.scale.set(0.8, 0.8, 0.8);
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
      return;
    }
    const pts = game.draft.map((p) => to3(p.x, p.y, 1.5, this.mid));
    if (pts.length === 1) pts.push(pts[0].clone());
    this.draft.geometry.dispose();
    this.draft.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.draft.visible = true;
  }
}

function makeTrailRibbon(t: Trail, glow: boolean, mid: MountainId): THREE.Mesh {
  const pts = t.points.map((p) => to3(p.x, p.y, 0.9, mid));
  const width = 6.5;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dir = new THREE.Vector3().subVectors(next, prev);
    dir.y = 0;
    if (dir.lengthSq() < 0.0001) dir.set(1, 0, 0);
    dir.normalize();
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(width * 0.5);
    const l = pts[i].clone().add(perp);
    const r = pts[i].clone().sub(perp);
    pos.push(l.x, l.y, l.z, r.x, r.y, r.z);
    if (i < pts.length - 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const color = new THREE.Color(DIFF[t.difficulty].color);
  const mat = new THREE.MeshStandardMaterial({
    color: glow ? color : new THREE.Color("#f4f8fc"),
    emissive: color,
    emissiveIntensity: glow ? 0.35 : 0.12,
    roughness: 0.7,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = { kind: "trail", id: t.id };
  const edge = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color, linewidth: 2 }),
  );
  mesh.add(edge);
  return mesh;
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
