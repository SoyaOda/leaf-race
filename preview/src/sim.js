// GPU shallow-water solver in channel coordinates (staggered grid, semi-Lagrangian momentum advection,
// upwind depth flux). The grid follows the stream, so banks are aligned with it and a tight bend costs
// nothing extra. Curvature enters through the metric J = 1 - n * kappa and the centrifugal terms, which
// is what piles water against the outer bank and sends a floating leaf there.
//
// Vertical drops are handled by reconstructing faces at the higher of the two beds: water going over a
// lip feels only its own head above the crest, reaches critical speed, and falls. The drop does not
// appear as an enormous pressure gradient. The momentum of the falling water is added back in the first
// row below the lip.
import * as THREE from 'three';
import { WORLD, PHYS } from './config.js?v=f337fed88ee5';
import { restEta, INFLOW, kappa } from './course.js?v=f337fed88ee5';

const FS_GEOM = new THREE.BufferGeometry();
FS_GEOM.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const FS_CAM = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

export class FullscreenPass {
  constructor(material) {
    this.material = material;
    this.mesh = new THREE.Mesh(FS_GEOM, material);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
  }
  render(renderer, target) {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, FS_CAM);
  }
}

const VERT = /* glsl */`
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMMON = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uState;   // R depth h, G u at the right face (across), B v at the top face (along), A foam
uniform sampler2D uBed;     // R bed elevation, G Manning n, B foam seed, A impact speed of falling water
uniform sampler2D uKappa;   // R curvature, one texel per row
uniform ivec2 uSize;
uniform float uDx;
uniform float uW;
ivec2 cl(ivec2 c) { return clamp(c, ivec2(0), uSize - 1); }
vec4 S(ivec2 c) { return texelFetch(uState, cl(c), 0); }
vec4 Bd(ivec2 c) { return texelFetch(uBed, cl(c), 0); }
float K(int j) { return texelFetch(uKappa, ivec2(0, clamp(j, 0, uSize.y - 1)), 0).r; }
// manual bilinear (float32 textures are not filterable everywhere); p in texel-index space
float bil(sampler2D t, vec2 p, int k) {
  p = clamp(p, vec2(0.0), vec2(uSize) - 1.0);
  vec2 f = floor(p); vec2 w = p - f; ivec2 c = ivec2(f);
  ivec2 c1 = min(c + 1, uSize - 1);
  float a = texelFetch(t, c, 0)[k], b = texelFetch(t, ivec2(c1.x, c.y), 0)[k];
  float d = texelFetch(t, ivec2(c.x, c1.y), 0)[k], e = texelFetch(t, c1, 0)[k];
  return mix(mix(a, b, w.x), mix(d, e, w.x), w.y);
}
// grid positions of the staggered components; p is (n + W/2, s) in metres
vec2 uGrid(vec2 p) { return p / uDx - vec2(1.0, 0.5); }
vec2 vGrid(vec2 p) { return p / uDx - vec2(0.5, 1.0); }
vec2 cGrid(vec2 p) { return p / uDx - vec2(0.5); }
`;

// Pass 1: momentum (advection, curvature, gravity, friction, impulses) + foam transport.
const VELOCITY_FRAG = COMMON + /* glsl */`
uniform float uDt, uG, uHDry, uVmax;
uniform vec4 uImpulse[4];   // grid x, s, radius, strength (m/s)
uniform int uImpulseCount;
out vec4 outColor;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = S(c);
  vec4 sR = S(c + ivec2(1, 0)), sT = S(c + ivec2(0, 1));
  vec4 sL = S(c - ivec2(1, 0)), sB = S(c - ivec2(0, 1));
  vec4 bd = Bd(c);
  float b0 = bd.r, bR = Bd(c + ivec2(1, 0)).r, bT = Bd(c + ivec2(0, 1)).r, bB = Bd(c - ivec2(0, 1)).r;
  float e0 = b0 + s.r, eR = bR + sR.r, eT = bT + sT.r, eB = bB + sB.r;
  float dx = uDx, dt = uDt;
  float kC = K(c.y), kT = 0.5 * (kC + K(c.y + 1));
  float gxU = (float(c.x) + 1.0) * dx, gxV = (float(c.x) + 0.5) * dx;
  float JU = 1.0 - (gxU - 0.5 * uW) * kC;
  float JV = 1.0 - (gxV - 0.5 * uW) * kT;

  // ---- u on the right face
  vec2 pu = vec2(gxU, (float(c.y) + 0.5) * dx);
  float vAtU = 0.25 * (s.b + sB.b + sR.b + S(c + ivec2(1, -1)).b);
  vec2 backU = pu - dt * vec2(s.g, vAtU / JU);
  float u = bil(uState, uGrid(backU), 1);
  float bfU = max(b0, bR);
  u -= dt * uG * (max(eR, bfU) - max(e0, bfU)) / dx;
  u -= dt * kC * vAtU * vAtU / JU;

  // ---- v on the top face
  vec2 pv = vec2(gxV, (float(c.y) + 1.0) * dx);
  float uAtV = 0.25 * (s.g + sL.g + sT.g + S(c + ivec2(-1, 1)).g);
  vec2 backV = pv - dt * vec2(uAtV, s.b / JV);
  float v = bil(uState, vGrid(backV), 2);
  float bfV = max(b0, bT);
  v -= dt * uG * (max(eT, bfV) - max(e0, bfV)) / (dx * JV);
  v += dt * kT * uAtV * s.b / JV;

  // ---- the curtain lands here: its momentum goes into the first row below the lip
  if (bd.a > 0.0) {
    float bfB = max(b0, bB);
    float fIn = max(sB.b, 0.0) * max(max(e0, eB) - bfB, 0.0);
    v += dt * fIn * bd.a * 0.55 / (max(s.r, 0.03) * dx);
  }

  // ---- pebble impulses: radial push, launches ring waves
  for (int k = 0; k < 4; k++) {
    if (k >= uImpulseCount) break;
    vec4 im = uImpulse[k];
    vec2 du = pu - im.xy; float ru = length(du);
    vec2 dv = pv - im.xy; float rv = length(dv);
    u += im.w * (du.x / im.z) * exp(-ru * ru / (im.z * im.z));
    v += im.w * (dv.y / im.z) * exp(-rv * rv / (im.z * im.z));
  }

  // ---- friction (semi-implicit Manning) and wet/dry faces
  float n = bd.g;
  float hU = max(e0, eR) - bfU;
  float hV = max(e0, eT) - bfV;
  float spU = length(vec2(u, vAtU)), spV = length(vec2(uAtV, v));
  float hu = max(hU, uHDry), hv = max(hV, uHDry);
  u /= 1.0 + dt * uG * n * n * spU / (hu * pow(hu, 1.0 / 3.0));
  v /= 1.0 + dt * uG * n * n * spV / (hv * pow(hv, 1.0 / 3.0));
  if (hU < uHDry) u = 0.0;
  if (hV < uHDry) v = 0.0;

  u = clamp(u, -uVmax, uVmax);
  v = clamp(v, -uVmax, uVmax);

  // ---- boundaries
  if (c.x >= uSize.x - 1) u = 0.0;
  if (c.y >= uSize.y - 1) v = max(sB.b, 0.0);       // outflow: extrapolate

  // ---- foam: advect with the cell-centred velocity, decay, seed
  vec2 pc = (vec2(c) + 0.5) * dx;
  float JC = 1.0 - (pc.x - 0.5 * uW) * kC;
  vec2 vc = vec2(0.5 * (s.g + sL.g), 0.5 * (s.b + sB.b));
  float foam = bil(uState, cGrid(pc - dt * vec2(vc.x, vc.y / JC)), 3);
  float speed = length(vc);
  float curl = abs((sR.b - sL.b) - (sT.g - sB.g)) / (2.0 * dx);
  float src = bd.b * (0.3 + smoothstep(0.08, 0.4, speed)) * 1.15
            + max(curl - 7.0, 0.0) * 0.05
            + smoothstep(0.8, 1.3, speed) * 0.5;
  for (int k = 0; k < 4; k++) {
    if (k >= uImpulseCount) break;
    vec4 im = uImpulse[k];
    float r = length(pc - im.xy) / im.z;
    src += 40.0 * exp(-(r - 1.2) * (r - 1.2) * 1.5) * step(0.0, im.w);
  }
  foam = foam * exp(-dt / 1.1) + src * dt;
  foam = s.r < uHDry ? 0.0 : clamp(foam, 0.0, 1.0);

  outColor = vec4(s.r, u, v, foam);
}
`;

// Pass 2: continuity with the metric, inflow and outflow boundaries.
const DEPTH_FRAG = COMMON + /* glsl */`
uniform float uDt, uTime, uInflowPeak, uInflowGust, uInflowNc, uInflowHw, uEtaOut;
out vec4 outColor;
float sill(float e0, float e1, float b0, float b1) { return max(max(e0, e1) - max(b0, b1), 0.0); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = S(c);
  float h = s.r;
  vec4 sL = S(c - ivec2(1, 0)), sR = S(c + ivec2(1, 0)), sB = S(c - ivec2(0, 1)), sT = S(c + ivec2(0, 1));
  float uR = s.g, vT = s.b;
  float uL = c.x > 0 ? sL.g : 0.0;
  // Flux depth is limited by the water above the higher bed of the two cells, so a deep cell cannot
  // push its whole column over a sill. Both neighbours compute the same face value.
  float b0 = Bd(c).r, bL = Bd(c - ivec2(1, 0)).r, bR = Bd(c + ivec2(1, 0)).r;
  float bB = Bd(c - ivec2(0, 1)).r, bT = Bd(c + ivec2(0, 1)).r;
  float e0 = b0 + h;
  float FR = uR * min(uR > 0.0 ? h : sR.r, sill(e0, bR + sR.r, b0, bR));
  float FL = uL * min(uL > 0.0 ? sL.r : h, sill(bL + sL.r, e0, bL, b0));
  float FT = vT * min(vT > 0.0 ? h : sT.r, sill(e0, bT + sT.r, b0, bT));
  float k = K(c.y);
  float gx = (float(c.x) + 0.5) * uDx - 0.5 * uW;
  float JC = 1.0 - gx * k, JR = 1.0 - (gx + 0.5 * uDx) * k, JL = 1.0 - (gx - 0.5 * uDx) * k;
  float FB;
  if (c.y == 0) {
    float d = (gx - uInflowNc) / uInflowHw;
    float gust = 1.0 + uInflowGust * (0.6 * sin(uTime * 0.7 + d * 3.0) + 0.4 * sin(uTime * 1.9 - d * 5.0));
    FB = uInflowPeak * max(0.0, 1.0 - d * d) * gust;
  } else {
    float vB = sB.b;
    FB = vB * min(vB > 0.0 ? sB.r : h, sill(bB + sB.r, e0, bB, b0));
  }
  float hn = max(0.0, h + uDt / (uDx * JC) * (JL * FL - JR * FR + FB - FT));
  if (c.y >= uSize.y - 1) hn = max(0.0, uEtaOut - b0);   // the culvert holds the level
  outColor = vec4(hn, s.gba);
}
`;

// Render-friendly products, filterable half floats:
//   A = (eta, d eta/dn, d eta/ds, foam), B = (u_c, v_c, h, b)
// Dry cells next to water borrow the neighbours' surface so the water mesh meets the bank cleanly.
const SURFACE_FRAG = COMMON + /* glsl */`
uniform float uHDry;
layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = S(c);
  float b = Bd(c).r;
  bool wet = s.r > uHDry;
  ivec2 o[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  float etaN[4]; bool wetN[4];
  float acc = 0.0, cnt = 0.0;
  for (int k = 0; k < 4; k++) {
    vec4 sn = S(c + o[k]);
    float bn = Bd(c + o[k]).r;
    wetN[k] = sn.r > uHDry;
    etaN[k] = bn + sn.r;
    if (wetN[k] && abs(etaN[k] - b) < 0.05) { acc += etaN[k]; cnt += 1.0; }
  }
  float eta;
  if (wet) eta = b + s.r;
  else if (cnt > 0.0) eta = min(acc / cnt, b) - 0.003;
  else eta = b - 0.05;
  float gx = 0.0, gz = 0.0;
  if (wet) {
    float eR = wetN[0] ? etaN[0] : eta, eL = wetN[1] ? etaN[1] : eta;
    float eT = wetN[2] ? etaN[2] : eta, eB = wetN[3] ? etaN[3] : eta;
    float J = 1.0 - ((float(c.x) + 0.5) * uDx - 0.5 * uW) * K(c.y);
    gx = clamp((eR - eL) / (2.0 * uDx), -1.0, 1.0);
    gz = clamp((eT - eB) / (2.0 * uDx * J), -1.0, 1.0);
  }
  vec4 sL = S(c - ivec2(1, 0)), sB = S(c - ivec2(0, 1));
  vec2 vc = vec2(0.5 * (s.g + sL.g), 0.5 * (s.b + sB.b));
  outA = vec4(eta, gx, gz, s.a);
  outB = vec4(vc, s.r, b);
}
`;

const PROBE_COUNT = 32;
const PROBE_FRAG = COMMON + /* glsl */`
uniform vec2 uProbe[${PROBE_COUNT}];
out vec4 outColor;
void main() {
  int k = int(gl_FragCoord.x);
  vec2 p = uProbe[k];
  float u = bil(uState, uGrid(p), 1);
  float v = bil(uState, vGrid(p), 2);
  float h = bil(uState, cGrid(p), 0);
  float b = bil(uBed, cGrid(p), 0);
  outColor = vec4(u, v, b + h, h);
}
`;

const COPY_FRAG = /* glsl */`
precision highp float; precision highp sampler2D;
uniform sampler2D uSrc;
out vec4 outColor;
void main() { outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }
`;

// Resample a coarser run onto this grid: interpolate the surface and the velocities, take depth from
// the finer bed. Everything is stored per cell centre or face in metres, so only the indices change.
const POUR_FRAG = /* glsl */`
precision highp float; precision highp sampler2D;
uniform sampler2D uFrom; uniform sampler2D uFromBed; uniform sampler2D uBed;
uniform ivec2 uFromSize;
uniform float uFromDx, uDx;
out vec4 outColor;
float bil(sampler2D t, vec2 p, int k) {
  p = clamp(p, vec2(0.0), vec2(uFromSize) - 1.0);
  vec2 f = floor(p); vec2 w = p - f; ivec2 c = ivec2(f);
  ivec2 c1 = min(c + 1, uFromSize - 1);
  float a = texelFetch(t, c, 0)[k], b = texelFetch(t, ivec2(c1.x, c.y), 0)[k];
  float d = texelFetch(t, ivec2(c.x, c1.y), 0)[k], e = texelFetch(t, c1, 0)[k];
  return mix(mix(a, b, w.x), mix(d, e, w.x), w.y);
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 pc = (vec2(c) + 0.5) * uDx;
  vec2 gc = pc / uFromDx - 0.5;
  float eta = bil(uFrom, gc, 0) + bil(uFromBed, gc, 0);
  float h = max(0.0, eta - texelFetch(uBed, c, 0).r);
  float u = bil(uFrom, (pc + vec2(0.5 * uDx, 0.0)) / uFromDx - vec2(1.0, 0.5), 1);
  float v = bil(uFrom, (pc + vec2(0.0, 0.5 * uDx)) / uFromDx - vec2(0.5, 1.0), 2);
  outColor = vec4(h, u, v, 0.0);
}
`;

function rawMaterial(frag, uniforms) {
  return new THREE.RawShaderMaterial({
    vertexShader: VERT, fragmentShader: frag, uniforms,
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  });
}

function floatTarget(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, generateMipmaps: false,
  });
}

function dataTex(data, w, h) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

export class ShallowWater {
  // grid: { nx, nz, maxSub }
  constructor(renderer, grid, bedData, kappaData, withSurface = true) {
    if (!renderer.extensions.has('EXT_color_buffer_float')) {
      throw new Error('この端末のWebGL2は浮動小数点の描画ターゲット (EXT_color_buffer_float) に対応していません。');
    }
    const gl = renderer.getContext();
    if (grid.nz > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
      throw new Error(`この端末のテクスチャ上限では ${grid.nz} 行の川を置けません。`);
    }
    this.renderer = renderer;
    this.nx = grid.nx; this.nz = grid.nz;
    this.dx = WORLD.W / this.nx;
    this.maxSub = grid.maxSub;
    this.dtMax = 0.92 * PHYS.cflMax * this.dx / PHYS.designSpeed;
    this.time = 0;
    this.impulses = [];
    this.bedData = bedData;
    this.bedTex = dataTex(bedData, this.nx, this.nz);
    this.kappaTex = dataTex(kappaData, 1, this.nz);
    this.targets = [floatTarget(this.nx, this.nz), floatTarget(this.nx, this.nz)];
    this.cur = 0;

    const ivSize = { value: [this.nx, this.nz] };
    const base = () => ({
      uState: { value: null }, uBed: { value: this.bedTex }, uKappa: { value: this.kappaTex },
      uSize: ivSize, uDx: { value: this.dx }, uW: { value: WORLD.W },
    });
    const impulses = [];
    for (let i = 0; i < 4; i++) impulses.push(new THREE.Vector4());
    this.velPass = new FullscreenPass(rawMaterial(VELOCITY_FRAG, {
      ...base(), uDt: { value: 0 }, uG: { value: PHYS.g }, uHDry: { value: PHYS.hDry }, uVmax: { value: PHYS.cflMax * this.dx / this.dtMax },
      uImpulse: { value: impulses }, uImpulseCount: { value: 0 },
    }));
    this.depthPass = new FullscreenPass(rawMaterial(DEPTH_FRAG, {
      ...base(), uDt: { value: 0 }, uTime: { value: 0 }, uInflowPeak: { value: PHYS.inflowPeak }, uInflowGust: { value: PHYS.inflowGust },
      uInflowNc: { value: INFLOW.nc }, uInflowHw: { value: INFLOW.hw }, uEtaOut: { value: restEta(WORLD.L) - 0.03 },
    }));
    this.copyPass = new FullscreenPass(rawMaterial(COPY_FRAG, { uSrc: { value: null } }));

    if (withSurface) {
      this.surface = new THREE.WebGLRenderTarget(this.nx, this.nz, {
        count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, generateMipmaps: false,
      });
      this.surfacePass = new FullscreenPass(rawMaterial(SURFACE_FRAG, { ...base(), uHDry: { value: PHYS.hDry } }));
      this.probePositions = [];
      for (let i = 0; i < PROBE_COUNT; i++) this.probePositions.push(new THREE.Vector2(-1, -1));
      this.probePass = new FullscreenPass(rawMaterial(PROBE_FRAG, { ...base(), uProbe: { value: this.probePositions } }));
      this.probeTarget = floatTarget(PROBE_COUNT, 1);
      this.probeBuffer = new Float32Array(PROBE_COUNT * 4);
      this.probeResult = new Float32Array(PROBE_COUNT * 4);
      this.probePending = false;
      this.probeSerial = 0;
      this.probeLatency = 0;
      this.probeReady = 0;
      this.syncProbes = false;      // headless physics runs read back in step with the simulation
    }
    this.reset();
  }

  get stateTexture() { return this.targets[this.cur].texture; }
  get surfA() { return this.surface.textures[0]; }
  get surfB() { return this.surface.textures[1]; }

  // Start near the resting profile; the solver settles the rest.
  reset() {
    const { nx, nz, dx } = this;
    const init = new Float32Array(nx * nz * 4);
    for (let j = 0; j < nz; j++) {
      const eta = restEta((j + 0.5) * dx);
      for (let i = 0; i < nx; i++) {
        const k = (j * nx + i) * 4;
        const h = Math.max(0, eta - this.bedData[k]);
        init[k] = h;
        init[k + 2] = h > PHYS.hDry ? 0.2 : 0;
      }
    }
    const tex = dataTex(init, nx, nz);
    this.copyPass.material.uniforms.uSrc.value = tex;
    this.copyPass.render(this.renderer, this.targets[0]);
    this.copyPass.render(this.renderer, this.targets[1]);
    tex.dispose();
    this.cur = 0;
    this.time = 0;
    this.impulses.length = 0;
  }

  // Take the surface and velocities of a coarser, already settled run.
  pourFrom(coarse) {
    const pass = new FullscreenPass(new THREE.RawShaderMaterial({
      vertexShader: VERT, fragmentShader: POUR_FRAG, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
      uniforms: {
        uFrom: { value: coarse.stateTexture }, uFromBed: { value: coarse.bedTex }, uBed: { value: this.bedTex },
        uFromSize: { value: [coarse.nx, coarse.nz] }, uFromDx: { value: coarse.dx }, uDx: { value: this.dx },
      },
    }));
    pass.render(this.renderer, this.targets[this.cur]);
    pass.material.dispose();
    this.copyPass.material.uniforms.uSrc.value = this.targets[this.cur].texture;
    this.copyPass.render(this.renderer, this.targets[1 - this.cur]);
  }

  addImpulse(n, s, radius, strength) {
    this.impulses.push(new THREE.Vector4(n + WORLD.W / 2, s, radius, strength));
  }

  // Advance by dt seconds of simulated time using as many substeps as the CFL limit needs.
  // Returns the simulated time actually advanced (less than dt if the frame was very long).
  step(dt) {
    const want = Math.min(dt, this.dtMax * this.maxSub);
    const n = Math.max(1, Math.ceil(want / this.dtMax - 1e-6));
    const h = want / n;
    const vu = this.velPass.material.uniforms, du = this.depthPass.material.uniforms;
    for (let s = 0; s < n; s++) {
      const imps = s === 0 ? this.impulses.splice(0, 4) : [];
      for (let i = 0; i < imps.length; i++) vu.uImpulse.value[i].copy(imps[i]);
      vu.uImpulseCount.value = imps.length;
      vu.uDt.value = h;
      vu.uState.value = this.targets[this.cur].texture;
      this.velPass.render(this.renderer, this.targets[1 - this.cur]);
      this.cur = 1 - this.cur;
      du.uDt.value = h; du.uTime.value = this.time;
      du.uState.value = this.targets[this.cur].texture;
      this.depthPass.render(this.renderer, this.targets[1 - this.cur]);
      this.cur = 1 - this.cur;
      this.time += h;
    }
    this.lastSubsteps = n;
    return want;
  }

  // Run forward without drawing anything, in small slices so a loading screen can breathe.
  async advance(seconds, onProgress) {
    const slice = this.dtMax * 4;
    const total = Math.ceil(seconds / slice);
    for (let i = 0; i < total; i++) {
      this.step(slice);
      if (i % 40 === 39) {
        onProgress?.(i / total);
        this.renderer.getContext().flush();
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  updateSurface() {
    this.surfacePass.material.uniforms.uState.value = this.stateTexture;
    this.surfacePass.render(this.renderer, this.surface);
  }

  // Readback of up to 32 points. Async during play: results arrive 1-2 frames later and never stall the GPU.
  // points are [n, s] or null.
  requestProbes(points) {
    if (this.probePending && !this.syncProbes) return;
    for (let i = 0; i < PROBE_COUNT; i++) {
      const p = points[i];
      if (p) this.probePositions[i].set(p[0] + WORLD.W / 2, p[1]); else this.probePositions[i].set(-1, -1);
    }
    this.probePass.material.uniforms.uState.value = this.stateTexture;
    this.probePass.render(this.renderer, this.probeTarget);
    const serial = ++this.probeSerial;
    if (this.syncProbes) {
      // While an earlier async read is in flight, three.js leaves its buffer bound as the pack target, and
      // a direct read then fails without a word: every probe keeps its old value. Unbind it first; the
      // async read binds its buffer again when it resumes.
      const gl = this.renderer.getContext();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.renderer.readRenderTargetPixels(this.probeTarget, 0, 0, PROBE_COUNT, 1, this.probeResult);
      this.probeReady = serial;
      return;
    }
    this.probePending = true;
    const sent = performance.now();
    this.renderer.readRenderTargetPixelsAsync(this.probeTarget, 0, 0, PROBE_COUNT, 1, this.probeBuffer).then(() => {
      this.probePending = false;
      if (serial < this.probeReady) return;      // a direct read has been made since: this one is old news
      this.probeResult.set(this.probeBuffer);
      this.probeLatency = performance.now() - sent;
      this.probeReady = serial;
    }, (err) => {
      this.probePending = false;
      // a lost context cancels in-flight reads; that is expected and recovered on restore
      if (this.renderer.getContext().isContextLost()) return;
      throw err;
    });
  }

  // Probe result k: [u, v, eta, h]
  probe(k) {
    const o = k * 4;
    return this.probeResult.subarray(o, o + 4);
  }

  kappaAt(s) { return kappa(s); }

  // Bed lookups for leaf contact, from the same data the solver runs on. s, n in metres.
  bedAt(s, n) {
    const { nx, nz, dx, bedData } = this;
    const fx = Math.min(nx - 1.001, Math.max(0, (n + WORLD.W / 2) / dx - 0.5));
    const fz = Math.min(nz - 1.001, Math.max(0, s / dx - 0.5));
    const i = Math.floor(fx), j = Math.floor(fz), wx = fx - i, wz = fz - j;
    const k = (j * nx + i) * 4;
    const a = bedData[k], b = bedData[k + 4], c = bedData[k + nx * 4], d = bedData[k + nx * 4 + 4];
    return (a + (b - a) * wx) * (1 - wz) + (c + (d - c) * wx) * wz;
  }

  dispose() {
    this.targets.forEach((t) => t.dispose());
    this.surface?.dispose(); this.probeTarget?.dispose();
    this.bedTex.dispose(); this.kappaTex.dispose();
  }
}

export { PROBE_COUNT };
