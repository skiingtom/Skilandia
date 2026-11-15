/**
 * The painterly look: a hazy gradient sky, post-processing (bloom, colour
 * grade, vignette), a terrain shader with fine relief and snow/rock detail,
 * snow-laden spruces and half-timbered chalets.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

// ---------------------------------------------------------------- noise (GLSL)

const GLSL_NOISE = /* glsl */ `
float lkHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float lkNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = lkHash(i);
  float b = lkHash(i + vec2(1.0, 0.0));
  float c = lkHash(i + vec2(0.0, 1.0));
  float d = lkHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float lkFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * lkNoise(p);
    p = p * 2.03 + vec2(17.1, 9.7);
    a *= 0.5;
  }
  return s;
}
`;

// ---------------------------------------------------------------- sky

export type SkyUniforms = {
  uSunDir: { value: THREE.Vector3 };
  uZenith: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uGround: { value: THREE.Color };
  uSunGlow: { value: THREE.Color };
  uGlow: { value: number };
};

/** A big dome that follows the camera: deep blue overhead, milky haze at the horizon, a warm glow around the sun. */
export function makeSkyDome(): { mesh: THREE.Mesh; uniforms: SkyUniforms } {
  const uniforms: SkyUniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uZenith: { value: new THREE.Color("#4f86c2") },
    uHorizon: { value: new THREE.Color("#d9e4ea") },
    uGround: { value: new THREE.Color("#c9d3da") },
    uSunGlow: { value: new THREE.Color("#ffd8a8") },
    uGlow: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGround;
      uniform vec3 uSunGlow;
      uniform float uGlow;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uZenith, pow(smoothstep(0.0, 0.75, h), 0.65));
        col = mix(col, uGround, smoothstep(0.0, -0.08, h));
        float s = max(dot(d, normalize(uSunDir)), 0.0);
        // Broad warm scatter, then a tighter halo.
        col += uSunGlow * (pow(s, 6.0) * 0.35 + pow(s, 64.0) * 0.6) * uGlow;
        // A little extra haze glow along the horizon on the sun's side.
        col += uSunGlow * pow(s, 2.0) * (1.0 - smoothstep(0.0, 0.35, abs(h))) * 0.18 * uGlow;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 72, 36), mat);
  mesh.scale.setScalar(80000);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return { mesh, uniforms };
}

// ---------------------------------------------------------------- post-processing

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.32 },
    uSaturation: { value: 1.08 },
    uContrast: { value: 1.06 },
    uWarm: { value: 1.0 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uWarm;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // Split tone: cool, slightly teal shadows; warm, golden highlights.
      vec3 shadowTint = vec3(0.94, 0.99, 1.05);
      vec3 highTint = vec3(1.03, 1.0, 0.95);
      c *= mix(shadowTint, highTint, smoothstep(0.15, 0.85, l) * uWarm);
      // Saturation and a gentle S-curve.
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      // Painterly vignette, a little warm at the edges.
      vec2 q = vUv - 0.5;
      float v = 1.0 - dot(q, q) * uVignette * 2.2;
      c *= mix(vec3(0.86, 0.82, 0.78), vec3(1.0), smoothstep(0.0, 1.0, v));
      // Fine grain so gradients in the sky and snow don't band.
      float n = fract(sin(dot(vUv * 1000.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453);
      c += (n - 0.5) * 0.012;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

export class PostFx {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly grade: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.22, 0.55, 1.6);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  render(dt: number): void {
    this.grade.uniforms.uTime.value = (this.grade.uniforms.uTime.value + dt) % 100;
    this.composer.render(dt);
  }
}

// ---------------------------------------------------------------- terrain

export type TerrainUniforms = {
  uDetail: { value: number };
  uRock: { value: THREE.Color };
};

/**
 * Terrain material: vertex colours carry snow / rock / woods; the shader adds
 * fine relief (drifts, wind ripples), per-pixel rock on steep faces, colour
 * breakup at several scales and a little sparkle on the snow near the camera.
 */
export function makeTerrainMaterial(uniforms: TerrainUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = uniforms.uDetail;
    shader.uniforms.uRock = uniforms.uRock;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vWorldNormal;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWorldNormal = normalize(mat3(modelMatrix) * objectNormal);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        uniform float uDetail;
        uniform vec3 uRock;
        ${GLSL_NOISE}
        float lkDist;
        float lkHeight(vec2 p) {
          // Big soft drifts, smaller lumps, and fine wind ripples across the slope.
          float h = lkFbm(p * 0.012) * 2.6;
          h += lkFbm(p * 0.07 + 3.1) * 1.15;
          h += lkFbm(p * 0.22 + 8.4) * 0.35;
          // Wind ripples only close up, where they can't alias into stripes.
          h += sin(p.x * 0.55 + p.y * 0.21 + lkNoise(p * 0.05) * 6.0) * 0.12 * (1.0 - smoothstep(80.0, 250.0, lkDist));
          return h;
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        lkDist = length(vViewPosition);
        vec2 wp = vWorldPos.xz;
        float n1 = lkFbm(wp * 0.004);
        float n2 = lkFbm(wp * 0.03);
        float n3 = lkNoise(wp * 0.35);
        float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        float snowy = smoothstep(0.5, 0.78, lum);
        float slope = 1.0 - clamp(vWorldNormal.y, 0.0, 1.0);
        vec3 tc = diffuseColor.rgb;
        // Broad colour breakup: snow goes faintly blue in hollows, cream on crests.
        tc *= mix(vec3(0.93, 0.96, 1.02), vec3(1.03, 1.01, 0.97), n1);
        tc *= 0.94 + 0.08 * n2 + 0.03 * n3;
        // Rock reads as layered strata rather than flat grey.
        float strata = lkNoise(vec2(vWorldPos.y * 0.18, (wp.x + wp.y) * 0.006) + n2 * 1.5);
        tc = mix(tc, tc * (0.7 + 0.6 * strata) * vec3(1.04, 0.99, 0.94), (1.0 - snowy) * uDetail);
        // Bare rock where it's too steep for snow to stick, with a ragged edge.
        float bare = smoothstep(0.3, 0.42, slope + (n2 - 0.5) * 0.22 + (n3 - 0.5) * 0.06) * uDetail;
        vec3 rockC = uRock * (0.65 + 0.6 * strata) * (0.9 + 0.2 * n3);
        tc = mix(tc, rockC, bare * snowy * 0.9);
        diffuseColor.rgb = tc;
        float lkSnow = snowy * (1.0 - bare);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        {
          // Bump from the procedural height, faded out with distance so it never shimmers.
          float amp = (1.0 - smoothstep(1200.0, 5500.0, lkDist)) * (0.85 + 0.45 * uDetail);
          if (amp > 0.001) {
            float hh = lkHeight(wp) * amp;
            vec3 dpx = dFdx(-vViewPosition);
            vec3 dpy = dFdy(-vViewPosition);
            float dhx = dFdx(hh);
            float dhy = dFdy(hh);
            vec3 r1 = cross(dpy, normal);
            vec3 r2 = cross(normal, dpx);
            float det = dot(dpx, r1);
            vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
            normal = normalize(abs(det) * normal - grad);
          }
        }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          // Glints on the snow close up.
          vec2 cell = floor(wp * 2.5);
          float g = lkHash(cell + floor(vViewPosition.xy * 0.02));
          float near = 1.0 - smoothstep(120.0, 450.0, lkDist);
          totalEmissiveRadiance += vec3(1.0, 0.97, 0.9) * step(0.996, g) * near * lkSnow * 2.0 * uDetail;
        }`,
      );
  };
  mat.customProgramCacheKey = () => "skilandia-terrain";
  return mat;
}

// ---------------------------------------------------------------- trees

const SNOW = new THREE.Color("#e3ebf2");
const NEEDLE_DARK = new THREE.Color("#22392a");
const NEEDLE = new THREE.Color("#355a3c");
const NEEDLE_TIP = new THREE.Color("#57784b");
const BARK = new THREE.Color("#4a3426");

function hash1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * A spruce: stacked, drooping tiers of boughs with patchy snow lying on the
 * upper faces, darker needles deep inside. Same frame as the old tree
 * (ground at y = -8 when the scale is 1).
 */
export function makeSpruceGeometry(detailed = true): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const tiers = detailed ? 9 : 5;
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1);
    const r = THREE.MathUtils.lerp(4.6, 1.3, t);
    const h = THREE.MathUtils.lerp(6, 3.6, t);
    const y = THREE.MathUtils.lerp(-4.2, 6.6, t);
    const cone = new THREE.ConeGeometry(r, h, detailed ? 16 : 8, detailed ? 3 : 2, true).toNonIndexed();
    cone.rotateY(k * 0.7);
    const pos = cone.getAttribute("position") as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let v = 0; v < pos.count; v++) {
      const vy = pos.getY(v);
      const vx = pos.getX(v);
      const vz = pos.getZ(v);
      // Bough tips droop and are ragged.
      if (vy < -h / 2 + 0.01) {
        const a = Math.atan2(vz, vx);
        const jag = 0.85 + hash1(a * 10 + k * 3.3) * 0.35;
        pos.setX(v, vx * jag);
        pos.setZ(v, vz * jag);
        pos.setY(v, vy - 0.5 - hash1(a * 7 + k) * 0.6);
      }
    }
    // Colour per face so the snow sits in patches on the boughs.
    for (let f = 0; f < pos.count / 3; f++) {
      let cy = 0;
      for (let q = 0; q < 3; q++) cy += pos.getY(f * 3 + q);
      cy /= 3;
      const up = (cy + h / 2) / h; // 0 at the bough tips, 1 at the top
      // Far-off trees carry less snow so whole forests still read green.
      const snowy = hash1(f * 3.17 + k * 11.3) < (detailed ? 0.42 : 0.22) - up * 0.1;
      for (let q = 0; q < 3; q++) {
        const vy = pos.getY(f * 3 + q);
        const vu = (vy + h / 2) / h;
        if (snowy && vu > 0.25) c.copy(SNOW).lerp(NEEDLE_TIP, (1 - vu) * 0.25);
        else c.copy(NEEDLE_DARK).lerp(vu < 0.1 ? NEEDLE_TIP : NEEDLE, Math.min(1, vu * 1.6 + 0.2));
        // Lower tiers sit in the tree's own shade.
        c.multiplyScalar(0.78 + t * 0.22);
        colors[(f * 3 + q) * 3] = c.r;
        colors[(f * 3 + q) * 3 + 1] = c.g;
        colors[(f * 3 + q) * 3 + 2] = c.b;
      }
    }
    cone.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    cone.translate(0, y, 0);
    cone.computeVertexNormals();
    // Push normals outward-upward so the canopy shades like a soft mass, not facets.
    const nor = cone.getAttribute("normal") as THREE.BufferAttribute;
    const p2 = cone.getAttribute("position") as THREE.BufferAttribute;
    const tmp = new THREE.Vector3();
    for (let v = 0; v < nor.count; v++) {
      const hx = p2.getX(v);
      const hz = p2.getZ(v);
      tmp.set(hx, Math.hypot(hx, hz) * 0.8 + 0.4, hz).normalize();
      tmp.lerp(new THREE.Vector3(nor.getX(v), nor.getY(v), nor.getZ(v)), 0.45).normalize();
      nor.setXYZ(v, tmp.x, tmp.y, tmp.z);
    }
    parts.push(cone);
  }
  // A small snowy tip.
  const tip = new THREE.ConeGeometry(0.5, 2.6, detailed ? 12 : 8).toNonIndexed();
  tip.translate(0, 9.6, 0);
  paint(tip, NEEDLE);
  parts.push(tip);
  const trunk = new THREE.CylinderGeometry(0.4, 0.75, 6, detailed ? 12 : 6, 1, !detailed).toNonIndexed();
  trunk.translate(0, -6.5, 0);
  paint(trunk, BARK);
  parts.push(trunk);
  return mergeGeometries(parts)!;
}

function paint(g: THREE.BufferGeometry, col: THREE.Color): void {
  const n = g.getAttribute("position").count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = col.r;
    a[i * 3 + 1] = col.g;
    a[i * 3 + 2] = col.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
}

/** Tree material with a slow sway in the wind (more toward the crown). */
export function makeTreeMaterial(time: { value: number }, wind: { value: number }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.uWind = wind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uWind;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
          #else
          vec3 ip = vec3(0.0);
          #endif
          float bend = max(0.0, transformed.y + 6.0) / 16.0;
          float ph = uTime * 1.3 + ip.x * 0.013 + ip.z * 0.017;
          float sway = (sin(ph) * 0.6 + sin(ph * 2.7 + 1.3) * 0.25) * bend * bend * (0.25 + uWind * 0.9);
          transformed.x += sway;
          transformed.z += sway * 0.6;
        }`,
      );
  };
  mat.customProgramCacheKey = () => "skilandia-tree";
  return mat;
}

/** Shadow pass for the trees, swaying the same way so shadows match. */
export function makeTreeDepthMaterial(time: { value: number }, wind: { value: number }): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.uniforms.uWind = wind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uWind;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
          #else
          vec3 ip = vec3(0.0);
          #endif
          float bend = max(0.0, transformed.y + 6.0) / 16.0;
          float ph = uTime * 1.3 + ip.x * 0.013 + ip.z * 0.017;
          float sway = (sin(ph) * 0.6 + sin(ph * 2.7 + 1.3) * 0.25) * bend * bend * (0.25 + uWind * 0.9);
          transformed.x += sway;
          transformed.z += sway * 0.6;
        }`,
      );
  };
  mat.customProgramCacheKey = () => "skilandia-tree-depth";
  return mat;
}

// ---------------------------------------------------------------- soft shapes

const RBOX_CACHE = new Map<string, THREE.BufferGeometry>();

/**
 * A box with softly rounded edges, so models catch a highlight along every
 * edge instead of reading as hard-cut blocks. Shared and cached by size:
 * never translate or rotate the geometry it returns.
 */
export function rbox(w: number, h: number, d: number, radius?: number): THREE.BufferGeometry {
  const m = Math.min(w, h, d);
  const r = Math.min(radius ?? Math.min(m * 0.3, 0.12 + Math.max(w, h, d) * 0.012, 0.7), m * 0.49);
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${r.toFixed(3)}`;
  let g = RBOX_CACHE.get(key);
  if (!g) {
    g = r < 0.02 ? new THREE.BoxGeometry(w, h, d) : new RoundedBoxGeometry(w, h, d, m > 1.5 ? 2 : 1, r);
    RBOX_CACHE.set(key, g);
  }
  return g;
}

/**
 * A pitched roof with soft edges and a pillow of snow lying on it. The ridge
 * runs along x; `span` is the width of the walls it sits on (along z), and the
 * underside meets the wall tops at y = 0.
 */
export function gableRoof(
  span: number,
  len: number,
  pitch: number,
  eave: number,
  roofMat: THREE.Material,
  snowMat: THREE.Material | null,
  shadow: boolean,
): { group: THREE.Group; rise: number } {
  const group = new THREE.Group();
  const tan = Math.tan(pitch);
  const rise = (span / 2) * tan;
  const hs = span / 2 + eave;
  const yb = -eave * tan;
  const chevron = (half: number, y0: number, thick: number) => {
    const s = new THREE.Shape();
    s.moveTo(-half, y0);
    s.lineTo(0, y0 + half * tan);
    s.lineTo(half, y0);
    s.lineTo(half, y0 + thick);
    s.lineTo(0, y0 + half * tan + thick);
    s.lineTo(-half, y0 + thick);
    s.closePath();
    return s;
  };
  const tv = Math.max(0.5, span * 0.03) / Math.cos(pitch);
  const bevel = Math.min(0.35, tv * 0.35);
  const roofGeo = new THREE.ExtrudeGeometry(chevron(hs, yb, tv), {
    depth: len - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 2,
    curveSegments: 1,
  });
  roofGeo.translate(0, 0, -(len - bevel * 2) / 2);
  roofGeo.rotateY(Math.PI / 2);
  roofGeo.computeVertexNormals();
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.castShadow = shadow;
  roof.receiveShadow = true;
  group.add(roof);
  if (snowMat) {
    // A thick, rounded blanket that stops just short of the eaves.
    const sh = hs - 0.25;
    const st = Math.max(0.45, span * 0.035) / Math.cos(pitch);
    const sb = Math.min(0.6, st * 0.55);
    // Sit the bevelled blanket's underside on the roof's bevelled top face.
    const cos = Math.cos(pitch);
    const y0 = yb + tv + (hs - (sh - sb)) * tan + (sb + bevel * 0.8) / cos - 0.05;
    const snowGeo = new THREE.ExtrudeGeometry(chevron(sh - sb, y0, st * 0.6), {
      depth: Math.max(0.1, len - 0.5 - sb * 2),
      bevelEnabled: true,
      bevelThickness: sb,
      bevelSize: sb,
      bevelSegments: 3,
      curveSegments: 1,
    });
    snowGeo.translate(0, 0, -Math.max(0.1, len - 0.5 - sb * 2) / 2);
    snowGeo.rotateY(Math.PI / 2);
    snowGeo.computeVertexNormals();
    const snow = new THREE.Mesh(snowGeo, snowMat);
    snow.castShadow = shadow;
    snow.receiveShadow = true;
    group.add(snow);
  }
  return { group, rise };
}

// ---------------------------------------------------------------- buildings

export type ChaletSpec = { body: string; roof: string; w: number; d: number; h: number };

const TIMBER = "#3b2a1e";
const STONE = "#8a8379";
const SNOW_ROOF = "#f2f5f8";
const GLASS = "#ffcf8a";

/**
 * A half-timbered alpine chalet: stone plinth, plaster walls framed in dark
 * oak, a steep gabled roof with deep eaves under a blanket of snow, a stone
 * chimney and warm-lit windows. Taller buildings get more storeys.
 */
export function makeChalet(p: ChaletSpec, opts: { ghost: boolean; tall?: boolean; door?: boolean }): THREE.Group {
  const g = new THREE.Group();
  const shadow = !opts.ghost;
  const mat = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra });
  const plaster = mat(p.body);
  const timber = mat(TIMBER, { roughness: 0.9 });
  const stone = mat(STONE, { roughness: 0.95 });
  const roofMat = mat(p.roof, { roughness: 0.8 });
  const snowMat = mat(SNOW_ROOF, { roughness: 0.7 });
  const glass = mat("#2a2420", { emissive: GLASS, emissiveIntensity: 0.9, roughness: 0.3 });
  const add = (m: THREE.Mesh) => {
    m.castShadow = shadow;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
    const b = add(new THREE.Mesh(rbox(w, h, d), m));
    b.position.set(x, y, z);
    return b;
  };
  // The long side runs along x; the gable faces ±z when the building is deeper than wide.
  const w = p.w;
  const d = p.d;
  const plinth = Math.min(2, p.h * 0.18);
  box(w + 0.8, plinth, d + 0.8, stone, 0, plinth / 2 - 0.3, 0);
  const wallH = p.h - plinth;
  box(w, wallH, d, plaster, 0, plinth + wallH / 2, 0);

  // Timber frame: corner posts, a sill and plate, a beam at each storey, and braces.
  const storeyH = 4.2;
  const storeys = Math.max(1, Math.round(wallH / storeyH));
  const beam = 0.45;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) box(beam * 1.4, wallH, beam * 1.4, timber, (sx * w) / 2, plinth + wallH / 2, (sz * d) / 2);
  }
  for (let s = 0; s <= storeys; s++) {
    const y = plinth + (wallH * s) / storeys;
    box(w + 0.3, beam, beam, timber, 0, y, d / 2 + 0.05);
    box(w + 0.3, beam, beam, timber, 0, y, -d / 2 - 0.05);
    box(beam, beam, d + 0.3, timber, w / 2 + 0.05, y, 0);
    box(beam, beam, d + 0.3, timber, -w / 2 - 0.05, y, 0);
  }
  // Posts along the long walls, windows between them.
  const bays = Math.max(2, Math.round(w / 5));
  const bayW = w / bays;
  for (let s = 0; s < storeys; s++) {
    const y0 = plinth + (wallH * s) / storeys;
    const sh = wallH / storeys;
    for (let b = 0; b < bays; b++) {
      const cx = -w / 2 + bayW * (b + 0.5);
      for (const sz of [-1, 1]) {
        const z = (sz * d) / 2;
        if (b > 0) box(beam, sh, beam, timber, -w / 2 + bayW * b, y0 + sh / 2, z + sz * 0.05);
        const isDoor = opts.door && s === 0 && sz === 1 && b === Math.floor(bays / 2);
        if (isDoor) {
          box(Math.min(3.2, bayW * 0.6), Math.min(sh * 0.8, 4.4), 0.4, mat("#5a3a22"), cx, y0 + Math.min(sh * 0.8, 4.4) / 2, z + sz * 0.15);
          continue;
        }
        // A window per bay, with shutters on the ground floor.
        const ww = Math.min(2, bayW * 0.42);
        const wh = Math.min(2.2, sh * 0.48);
        box(ww, wh, 0.3, glass, cx, y0 + sh * 0.55, z + sz * 0.12);
        box(ww + 0.5, 0.3, 0.6, timber, cx, y0 + sh * 0.55 - wh / 2 - 0.15, z + sz * 0.25);
        if (s === 0 && bayW > 4) {
          const shutter = mat(p.roof);
          box(ww * 0.5, wh, 0.2, shutter, cx - ww * 0.78, y0 + sh * 0.55, z + sz * 0.2);
          box(ww * 0.5, wh, 0.2, shutter, cx + ww * 0.78, y0 + sh * 0.55, z + sz * 0.2);
        }
      }
    }
  }
  // Diagonal braces on the gable-end walls.
  for (const sx of [-1, 1]) {
    for (let s = 0; s < storeys; s++) {
      const y0 = plinth + (wallH * s) / storeys;
      const sh = wallH / storeys;
      const len = Math.hypot(d * 0.5, sh);
      for (const side of [-1, 1]) {
        const brace = box(beam, len, beam, timber, (sx * w) / 2 + sx * 0.08, y0 + sh / 2, (side * d) / 4);
        brace.rotation.x = side * Math.atan2(d * 0.5, sh);
      }
    }
  }

  // Wooden balconies along the upper floors of taller buildings.
  if (storeys >= 2) {
    const balW = w * 0.82;
    for (let s = 1; s < storeys; s++) {
      const y = plinth + (wallH * s) / storeys;
      for (const sz of [-1, 1]) {
        const z = (sz * d) / 2;
        box(balW, 0.35, 1.7, timber, 0, y + 0.1, z + sz * 0.85);
        box(balW, 0.9, 0.14, timber, 0, y + 0.85, z + sz * 1.62);
        box(balW + 0.2, 0.18, 0.3, timber, 0, y + 1.36, z + sz * 1.62);
        for (const sx of [-1, 1]) box(0.16, 1.2, 1.5, timber, (sx * balW) / 2, y + 0.75, z + sz * 0.9);
      }
    }
  }

  // Steep gabled roof along x, with deep eaves and a pillow of snow.
  const eave = 1.6;
  const pitch = THREE.MathUtils.degToRad(opts.tall ? 38 : 42);
  const roofW = w + eave * 2;
  const top = p.h;
  const roof = gableRoof(d, roofW, pitch, eave, roofMat, snowMat, shadow);
  roof.group.position.y = top;
  g.add(roof.group);
  const rise = roof.rise;
  // Gable triangles closing each end.
  const gable = new THREE.Shape();
  gable.moveTo(-d / 2, 0);
  gable.lineTo(d / 2, 0);
  gable.lineTo(0, rise);
  gable.closePath();
  const gableGeo = new THREE.ExtrudeGeometry(gable, { depth: 0.4, bevelEnabled: false });
  for (const sx of [-1, 1]) {
    const m = add(new THREE.Mesh(gableGeo, plaster));
    m.rotation.y = Math.PI / 2;
    m.position.set(sx * (w / 2) - 0.2, top, 0);
    // King post and collar on the gable.
    box(beam, rise * 0.9, beam, timber, sx * (w / 2 + 0.1), top + rise * 0.45, 0);
    box(beam, beam, d * 0.55, timber, sx * (w / 2 + 0.1), top + rise * 0.45, 0);
  }
  // Chimney with a stone cap, smoke is left to the imagination.
  box(1.6, rise + 3, 1.6, stone, w * 0.28, top + (rise + 3) / 2, -d * 0.18);
  box(2.1, 0.4, 2.1, stone, w * 0.28, top + rise + 3.1, -d * 0.18);
  box(1.9, 0.35, 1.9, snowMat, w * 0.28, top + rise + 3.45, -d * 0.18);
  g.userData = { kind: "building" };
  return g;
}

/**
 * A hillside log cabin: stacked round logs, a steep A-frame roof that comes
 * nearly to the snow, a covered porch facing the run, a stone chimney and a
 * warm window.
 */
export function makeLogCabin(ghost: boolean): THREE.Group {
  const g = new THREE.Group();
  const shadow = !ghost;
  const mat = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, ...extra });
  const logMat = mat("#7a5232");
  const logEnd = mat("#b88a5c");
  const roofMat = mat("#4a2f22");
  const snowMat = mat(SNOW_ROOF, { roughness: 0.7 });
  const stone = mat(STONE, { roughness: 0.95 });
  const glass = mat("#2a2420", { emissive: GLASS, emissiveIntensity: 1.1, roughness: 0.3 });
  const add = (m: THREE.Mesh) => {
    m.castShadow = shadow;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const W = 9;
  const D = 7;
  const wallH = 3.2;
  const r = 0.28;
  // Stone footing.
  const foot = add(new THREE.Mesh(rbox(W + 0.6, 0.9, D + 0.6), stone));
  foot.position.y = 0.15;
  // Log courses, crossing at the corners with the ends sticking out.
  const logX = new THREE.CylinderGeometry(r, r, W + 1, 14);
  logX.rotateZ(Math.PI / 2);
  const logZ = new THREE.CylinderGeometry(r, r, D + 1, 14);
  logZ.rotateX(Math.PI / 2);
  const courses = Math.round(wallH / (r * 2));
  for (let c = 0; c < courses; c++) {
    const y = 0.6 + r + c * r * 2;
    for (const s of [-1, 1]) {
      const a = add(new THREE.Mesh(logX, logMat));
      a.position.set(0, y + (c % 2 ? r : 0), (s * D) / 2);
      const b = add(new THREE.Mesh(logZ, logMat));
      b.position.set((s * W) / 2, y + (c % 2 ? 0 : r), 0);
    }
  }
  // Fill behind the logs so there are no gaps.
  const core = add(new THREE.Mesh(rbox(W - 0.2, wallH, D - 0.2), logEnd));
  core.position.y = 0.6 + wallH / 2;
  const top = 0.6 + wallH;
  // Steep A-frame roof over the length (ridge along z), eaves wide.
  const eave = 1.2;
  const pitch = THREE.MathUtils.degToRad(52);
  const len = D + 3.2;
  const roof = gableRoof(W, len, pitch, eave, roofMat, snowMat, shadow);
  roof.group.rotation.y = Math.PI / 2;
  roof.group.position.set(0, top, 0.8);
  g.add(roof.group);
  const rise = roof.rise;
  // Gable ends in logs-coloured boards, with a big window in the front one.
  const gable = new THREE.Shape();
  gable.moveTo(-W / 2, 0);
  gable.lineTo(W / 2, 0);
  gable.lineTo(0, rise);
  gable.closePath();
  const gableGeo = new THREE.ExtrudeGeometry(gable, { depth: 0.3, bevelEnabled: false });
  for (const sz of [-1, 1]) {
    const m = add(new THREE.Mesh(gableGeo, logMat));
    m.position.set(0, top, sz > 0 ? D / 2 - 0.1 : -D / 2 - 0.2);
  }
  const win = add(new THREE.Mesh(rbox(2.4, 2.4, 0.2), glass));
  win.position.set(0, top + rise * 0.35, D / 2 + 0.25);
  const win2 = add(new THREE.Mesh(rbox(1.6, 1.3, 0.2), glass));
  win2.position.set(-W / 4, 0.6 + wallH * 0.55, D / 2 + 0.35);
  const door = add(new THREE.Mesh(rbox(1.3, 2.3, 0.2), mat("#4a2f1c")));
  door.position.set(W / 4, 0.6 + 1.15, D / 2 + 0.35);
  // Porch deck and posts under the roof overhang.
  const deck = add(new THREE.Mesh(rbox(W + 0.6, 0.3, 2.6), mat("#8a6440")));
  deck.position.set(0, 0.6, D / 2 + 1.4);
  for (const sx of [-1, 1]) {
    const post = add(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, wallH, 10), logMat));
    post.position.set(sx * (W / 2 - 0.2), 0.6 + wallH / 2, D / 2 + 2.5);
  }
  // Stone chimney poking through the roof.
  const ch = add(new THREE.Mesh(rbox(1.3, rise + 2.5, 1.3), stone));
  ch.position.set(W * 0.2, top + (rise + 2.5) / 2 - 0.5, -D * 0.25);
  const cap = add(new THREE.Mesh(rbox(1.5, 0.3, 1.5), snowMat));
  cap.position.set(W * 0.2, top + rise + 1.9, -D * 0.25);
  // Firewood stacked by the door.
  const wood = add(new THREE.Mesh(rbox(1.8, 1.1, 0.8), logEnd));
  wood.position.set(W / 2 + 0.9, 1.1, D / 2 - 0.6);
  g.userData = { kind: "building" };
  return g;
}
