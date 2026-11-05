// Leaves: procedural shapes, materials, and a small rigid body riding the simulated flow.
//
// Three things the depth-averaged solver cannot say are modelled here, from what it does say:
//  - Contact. The leaf is an outline of points against the solver's own bed: wherever the bed stands
//    above the leaf's level there is a wall, with Coulomb friction. A leaf pressed across a gap by the
//    current stays there until the water or a pebble turns it. No trap is scripted.
//  - The curtain. Under a drop, falling water pushes the leaf down in proportion to the discharge read
//    at the lip above it. On a shallow shelf that presses it to the bed, held by friction.
//  - The roller. Below the curtain the surface runs back toward the fall while the bottom runs away
//    from it. A leaf that comes up too soon is carried back in and dunked again. It gets out by staying
//    down long enough to surface past the boil line, or by drifting sideways out of the curtain.
import * as THREE from 'three';
import { WORLD, PHYS, SUN, LEAF_TYPES, FALL, RACE } from './config.js?v=e79679972dca';
import { STEPS, toWorld, heading, centerOffset } from './course.js?v=e79679972dca';
import { makeLeafCanvas } from './textures.js?v=e79679972dca';
import { LAYER_OPAQUE, LAYER_FLOAT } from './post.js?v=e79679972dca';

// ---- outlines (normalised: tip toward +z, fits roughly in [-1, 1]) --------------------
function tri(x) { const f = x - Math.floor(x); return 1 - Math.abs(f * 2 - 1); }

function momijiOutline(n = 140) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = -Math.PI + (i / n) * Math.PI * 2;
    const env = Math.max(0.12, 0.42 + 0.58 * Math.cos(0.72 * t));
    const lobe = Math.pow(tri(3.5 * t / Math.PI + 0.5), 0.8);
    let r = 0.38 + 0.62 * env * lobe;
    r += 0.03 * Math.pow(tri(t * 40 / Math.PI), 2) * lobe * env;   // fine teeth on the lobes
    pts.push([r * Math.sin(t), r * Math.cos(t) - 0.04]);
  }
  return { pts, center: [0, -0.05] };
}

function ichouOutline(n = 120) {
  const pts = [];
  const base = [0, -0.62];
  const half = 68 * Math.PI / 180;
  const R = (a) => 1.42 * (1 - 0.16 * Math.exp(-((a / 0.07) ** 2))) + 0.025 * Math.sin(a * 16) + 0.02 * Math.sin(a * 37);
  // arc from left to right
  for (let i = 0; i <= n; i++) {
    const a = -half + (i / n) * 2 * half;
    const r = R(a);
    pts.push([base[0] + r * Math.sin(a), base[1] + r * Math.cos(a)]);
  }
  // right edge back to the base (slightly concave), petiole, left edge
  const re = pts[pts.length - 1], le = pts[0];
  for (let i = 1; i < 10; i++) { const t = i / 10; pts.push([re[0] * (1 - t) * (1 - 0.12 * Math.sin(t * Math.PI)), re[1] + (base[1] - re[1]) * t]); }
  pts.push([0.035, base[1] - 0.02], [0.02, -1.25], [-0.02, -1.25], [-0.035, base[1] - 0.02]);
  for (let i = 1; i < 10; i++) { const t = 1 - i / 10; pts.push([le[0] * (1 - t) * (1 - 0.12 * Math.sin(t * Math.PI)), le[1] + (base[1] - le[1]) * t]); }
  const s = 0.7;
  return { pts: pts.map(([x, z]) => [x * s, z * s + 0.12]), center: [0, 0.12 + 0.05] };
}

function sakuraOutline(n = 140) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    const tipPinch = 1 - 0.42 * Math.pow(Math.max(c, 0), 3);
    let x = 0.5 * s * tipPinch * (1 + 0.12 * c);
    let z = c * (c > 0 ? 1.0 : 0.82);
    const tooth = 0.022 * tri(t * 52 / Math.PI);
    const l = Math.hypot(x, z) || 1;
    x += (x / l) * tooth; z += (z / l) * tooth;
    pts.push([x, z]);
  }
  return { pts, center: [0, 0] };
}

// Star-shaped fan mesh from an outline, with interior rings so the leaf can curl.
function leafGeometry(outline, size, bend) {
  const rings = [0.18, 0.42, 0.66, 0.86, 1.0];
  const { pts, center } = outline;
  const N = pts.length;
  const pos = [center[0], 0, center[1]];
  const uv = [center[0] * 0.5 + 0.5, center[1] * 0.5 + 0.5];
  for (const t of rings) {
    for (const [x, z] of pts) {
      const px = center[0] + (x - center[0]) * t, pz = center[1] + (z - center[1]) * t;
      pos.push(px, 0, pz);
      uv.push(px * 0.5 + 0.5, pz * 0.5 + 0.5);
    }
  }
  const idx = [];
  for (let i = 0; i < N; i++) idx.push(0, 1 + i, 1 + (i + 1) % N);
  for (let r = 0; r < rings.length - 1; r++) {
    const a0 = 1 + r * N, b0 = 1 + (r + 1) * N;
    for (let i = 0; i < N; i++) {
      const i1 = (i + 1) % N;
      idx.push(a0 + i, b0 + i, b0 + i1, a0 + i, b0 + i1, a0 + i1);
    }
  }
  for (let k = 0; k < pos.length; k += 3) {
    const x = pos[k], z = pos[k + 2];
    pos[k + 1] = bend(x, z);
    pos[k] *= size; pos[k + 1] *= size; pos[k + 2] *= size;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Sasabune: a bamboo-leaf boat. Canoe hull with the folded ends tucked up.
function sasabuneGeometry(size) {
  const nu = 26, nv = 40;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nv; j++) {
    const z = -1 + 2 * j / nv;
    const w = 0.3 * Math.pow(Math.max(0, 1 - z * z), 0.65);
    for (let i = 0; i <= nu; i++) {
      const s = -1 + 2 * i / nu;
      const x = s * w;
      const y = 0.16 * (s * s - 0.55) * Math.pow(Math.max(0, 1 - z * z), 0.6) + 0.1 * Math.pow(Math.abs(z), 3);
      pos.push(x * size, y * size, z * size);
      uv.push(s * 0.5 + 0.5, z * 0.5 + 0.5);
    }
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // the two folded wings at each end (small triangles standing up)
  const base = pos.length / 3;
  const wing = (zc, dir) => {
    const z0 = zc * size, h = 0.14 * size;
    pos.push(-0.17 * size, 0.03 * size, z0, 0.17 * size, 0.03 * size, z0, 0, h, z0 + dir * 0.28 * size);
    uv.push(0.1, 0.5, 0.9, 0.5, 0.5, 0.95);
  };
  wing(-0.55, -1); wing(0.55, 1);
  idx.push(base, base + 1, base + 2, base + 3, base + 4, base + 5);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function sasabuneCanvas(type) {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 256;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 128, 0);
  grad.addColorStop(0, type.colors[2]); grad.addColorStop(0.5, type.colors[1]); grad.addColorStop(1, type.colors[2]);
  g.fillStyle = grad; g.fillRect(0, 0, 128, 256);
  for (let x = 6; x < 128; x += 7) {
    g.strokeStyle = 'rgba(230,240,190,0.18)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (x - 64) * 0.05, 256); g.stroke();
  }
  g.strokeStyle = 'rgba(235,240,200,0.55)'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(64, 0); g.lineTo(64, 256); g.stroke();
  for (let i = 0; i < 18; i++) {
    g.fillStyle = `rgba(120,90,40,${0.08 + Math.random() * 0.12})`;
    g.beginPath(); g.ellipse(Math.random() * 128, Math.random() * 256, 3 + Math.random() * 8, 2 + Math.random() * 5, 0, 0, Math.PI * 2); g.fill();
  }
  return cv;
}

function veinsFor(key, outline) {
  if (key === 'momiji') {
    const v = [];
    for (let k = -3; k <= 3; k++) {
      const t = k * 2 * Math.PI / 7;
      const env = Math.max(0.12, 0.42 + 0.58 * Math.cos(0.72 * t));
      const r = (0.3 + 0.7 * env) * 0.92;
      const p = [];
      for (let i = 0; i <= 6; i++) p.push([Math.sin(t) * r * i / 6, Math.cos(t) * r * i / 6 - 0.05]);
      v.push(p);
    }
    return v;
  }
  if (key === 'ichou') {
    const v = [];
    for (let k = -6; k <= 6; k++) {
      const a = k / 6 * 66 * Math.PI / 180;
      const p = [];
      for (let i = 0; i <= 5; i++) { const r = 1.3 * i / 5; p.push([r * Math.sin(a) * 0.7, (-0.62 + r * Math.cos(a)) * 0.7 + 0.12]); }
      v.push(p);
    }
    return v;
  }
  const p = [];
  for (let i = 0; i <= 10; i++) p.push([0, -0.82 + 1.8 * i / 10]);
  return [p];
}

const BENDS = {
  momiji: (x, z) => 0.1 * (x * x + z * z) - 0.04 * Math.abs(x) + 0.02 * Math.sin(z * 4),
  ichou: (x, z) => 0.07 * (x * x) + 0.05 * Math.sin(x * 5) * Math.max(0, z),
  sakura: (x, z) => 0.38 * x * x - 0.06 * z * z + 0.06 * z,
};

const LEAF_TRANSLUCENCY = /* glsl */`
{
  vec3 sunV = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
  vec3 toFrag = -normalize(vViewPosition);
  float back = pow(max(dot(toFrag, sunV), 0.0), 5.0);
  float thru = max(dot(-normal, sunV), 0.0);
  reflectedLight.directDiffuse += diffuseColor.rgb * uSunRad * (back * 0.16 + thru * 0.18);
}
`;

const leafAssets = new Map();
function getLeafAssets(key) {
  if (leafAssets.has(key)) return leafAssets.get(key);
  const type = { ...LEAF_TYPES[key], key };
  let geo, canvas, previewPts;
  if (key === 'sasabune') {
    geo = sasabuneGeometry(type.size);
    canvas = sasabuneCanvas(type);
    previewPts = [];
    for (let i = 0; i < 64; i++) {
      const t = i / 64 * Math.PI * 2;
      previewPts.push([0.36 * Math.sin(t) * Math.pow(Math.abs(Math.cos(t)) < 1 ? 1 - Math.cos(t) ** 2 : 0, 0.15), 0.98 * Math.cos(t)]);
    }
  } else {
    const outline = key === 'momiji' ? momijiOutline() : key === 'ichou' ? ichouOutline() : sakuraOutline();
    geo = leafGeometry(outline, type.size, BENDS[key]);
    canvas = makeLeafCanvas({ ...type, veins: veinsFor(key, outline) }, outline.pts, key.length * 13 + 5);
    previewPts = outline.pts;
  }
  // card artwork: the same texture, cut out along the leaf outline
  const preview = document.createElement('canvas');
  preview.width = preview.height = 160;
  {
    const g = preview.getContext('2d');
    const S = 160;
    g.translate(S / 2, S / 2); g.rotate(-0.5); g.translate(-S / 2, -S / 2);
    g.beginPath();
    previewPts.forEach(([x, z], i) => { const px = (x * 0.5 + 0.5) * S, py = (1 - (z * 0.5 + 0.5)) * S; if (i) g.lineTo(px, py); else g.moveTo(px, py); });
    g.closePath();
    g.save(); g.clip(); g.drawImage(canvas, 0, 0, S, S); g.restore();
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const mat = new THREE.MeshStandardMaterial({ map, roughness: key === 'sasabune' ? 0.42 : 0.55, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunDirW = { value: new THREE.Vector3(...SUN.dir) };
    shader.uniforms.uSunRad = { value: new THREE.Vector3(...SUN.color).multiplyScalar(SUN.intensity) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunDirW;\nuniform vec3 uSunRad;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${LEAF_TRANSLUCENCY}`);
  };
  mat.customProgramCacheKey = () => `leaf-${key}`;
  const a = { type, geo, mat, canvas, preview };
  leafAssets.set(key, a);
  return a;
}

export function leafPreviewCanvas(key) { return getLeafAssets(key).preview; }

// ---------------------------------------------------------------------------------------
const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion(), tmpQ3 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0), tmpN = new THREE.Vector3(), tmpAxis = new THREE.Vector3();
const PROBE_OFFSETS = [[0, 0], [0, 0.7], [0, -0.7], [0.6, 0], [-0.6, 0]];
export const PROBES_PER_LEAF = PROBE_OFFSETS.length + 1;    // the last one reads the lip above a fall
const OUTLINE_POINTS = 10;
const FREE_TIME = 0.8;            // seconds
const HOLD_CLEAR = 0.3;           // metres past where it stopped before a hold is over
const HOLD_SURGE_AFTER = 9;       // seconds
const HOLD_HOP_AFTER = 14;        // seconds; the surge lifts it clear of whatever walls it in
const HOP_TIME = 0.45;            // seconds
const PERCH_SLIDE = 3;            // m/s2
const CONTACT_MU = 0.55;
const MAX_PUSH = 0.03;
const w2 = [0, 0];

function gaussian() {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

export class Leaf {
  constructor(key, owner) {
    const a = getLeafAssets(key);
    this.key = key;
    this.type = a.type;
    this.owner = owner;               // { name, color, isPlayer }
    this.mesh = new THREE.Mesh(a.geo, a.mat);
    this.mesh.castShadow = true;
    this.mesh.visible = false;
    // contact outline: an ellipse sized to the leaf
    this.outline = [];
    for (let i = 0; i < OUTLINE_POINTS; i++) {
      const t = i / OUTLINE_POINTS * Math.PI * 2;
      this.outline.push([Math.sin(t) * a.type.radW, Math.cos(t) * a.type.radL]);
    }
    this.inertia = 0.3 * (a.type.radL * a.type.radL + a.type.radW * a.type.radW);
    this.reset();
  }

  reset() {
    this.state = 'hand';              // hand -> air -> water <-> falling -> gone
    this.s = 0; this.n = 0;           // channel position
    this.x = 0; this.z = 0; this.y = 0.8;
    this.vs = 0; this.vn = 0; this.vy = 0;
    this.yaw = Math.random() * Math.PI * 2; this.w = 0;
    this.tilt = new THREE.Vector3(0, 1, 0);
    this.pitch = 0;                   // nose-down rotation while going over a lip
    this.zeta = 0; this.zetaV = 0;    // how far under the surface
    this.lipQ = 0; this.lipV = 0.5;
    this.contacts = 0;
    this.aground = false;
    this.pinned = false;
    this.step = null;                 // the drop whose roller this leaf is in
    this.fall = null;
    this.turbN = 0; this.turbS = 0;
    this.finished = false; this.finishTime = 0;
    this.flutter = Math.random() * 10;
    this.speed = 0;
    this.mesh.visible = false;
    this.lastPokeAt = -10;
    this.hop = 0;
    this.freeT = 0;                   // after a shove the roller has no hold on it for a moment
    this.sLast = 0;
    // held: how long progress has stalled, and why
    this.progressRef = 0; this.progressT = 0; this.holdAnchor = 0;
    this.heldTime = 0; this.heldKind = null;
    this.diary = [];                  // { kind, where, seconds }
    this.dunks = 0;
  }

  hold(s, n, y) {
    this.state = 'hand';
    this.s = s; this.n = n; this.y = y;
    this.mesh.visible = true;
    this.syncMesh();
  }

  drop(vs, vn) {
    this.state = 'air';
    this.vs = vs; this.vn = vn; this.vy = 0;
    this.sLast = this.s;
    this.progressRef = this.s; this.progressT = 0;
  }

  probePoints(out) {
    const size = this.type.size;
    const fn = Math.sin(this.yaw), fs = Math.cos(this.yaw);   // forward in (n, s)
    const rn = Math.cos(this.yaw), rs = -Math.sin(this.yaw);  // right in (n, s)
    for (const [a, b] of PROBE_OFFSETS) out.push([this.n + (a * rn + b * fn) * size, this.s + (a * rs + b * fs) * size]);
    const st = this.upcomingStep();
    out.push(st ? [this.n, st.s - 0.03] : null);
  }

  // The nearest drop whose curtain could matter to this leaf.
  upcomingStep() {
    // Latest match wins: of two close drops, the second is the one over this leaf once it is near it.
    for (let i = STEPS.length - 1; i >= 0; i--) {
      const st = STEPS[i];
      if (this.s > st.s - 0.25 && this.s < st.s + st.roller + 0.55) return st;
    }
    return null;
  }

  // Height of the curtain's landing point and the roller around it, for a discharge q at the lip.
  rollerAt(st, q) {
    const v0 = this.lipV;
    const tf = st.fallTime;
    const land = st.s + v0 * tf + 0.01;
    const impact = Math.hypot(v0, st.impact);
    const a = this.s - land;
    const L = st.roller * (0.8 + Math.min(1, q / 0.05) * 0.3);
    const inCell = a > -0.04 && a < L;
    const cell = inCell ? Math.sin(Math.PI * Math.min(1, Math.max(0, (a + 0.04) / (L + 0.04)))) : 0;
    const sig = 0.05 + 0.07 * st.drop / 0.3;
    return { land, impact, a, L, cell, under: Math.exp(-(a * a) / (sig * sig)), speed: FALL.rollerSpeed * Math.sqrt(q * impact) };
  }

  stepFalling(dt, c, sim) {
    const f = this.fall;
    f.t += dt;
    this.s += f.vs * dt;
    this.n += this.vn * dt;
    f.vy -= PHYS.g * dt;
    this.y += f.vy * dt;
    this.pitch = Math.min(1.15, this.pitch + dt * 7);
    this.yaw += this.w * dt;
    const eta = c && c[3] > PHYS.hDry ? c[2] : sim.bedAt(this.s, this.n) + 0.02;
    if (f.t > f.st.fallTime * 0.75 && this.y <= eta) {
      // Into the pool, as deep as the landing speed carries it.
      const vi = Math.abs(f.vy);
      this.zeta = 0.012;
      this.zetaV = vi * 0.55;
      this.vs = f.vs * 0.5;
      this.fall = null;
      this.state = 'water';
      this.sLast = this.s;
      this.pitch = 0.5;
      this.dunks++;
      return true;
    }
    return false;
  }

  // probes: 6 x [u, v, eta, h]; wind in (n, s)
  stepWater(dt, probes, wind, t, sim) {
    const T = this.type, size = T.size;
    const fn = Math.sin(this.yaw), fs = Math.cos(this.yaw);
    const rn = Math.cos(this.yaw), rs = -Math.sin(this.yaw);
    const c = probes[0];
    const hC = c[3];

    // mean flow (centre weighted)
    let Wn = c[0] * 2, Ws = c[1] * 2, wsum = 2;
    for (let k = 1; k < 5; k++) if (probes[k][3] > PHYS.hDry) { Wn += probes[k][0]; Ws += probes[k][1]; wsum++; }
    Wn /= wsum; Ws /= wsum;
    // surface slope from the probe stencil
    const eta = (k) => (probes[k][3] > PHYS.hDry ? probes[k][2] : c[2]);
    const gF = (eta(1) - eta(2)) / (1.4 * size), gR = (eta(3) - eta(4)) / (1.2 * size);
    let gn = gR * rn + gF * fn, gs = gR * rs + gF * fs;
    const gl = Math.hypot(gn, gs);
    if (gl > 0.2) { gn *= 0.2 / gl; gs *= 0.2 / gl; }

    // ---- the fall above, if any
    let press = 0;
    let rollerCell = 0;
    const st = this.upcomingStep();
    this.step = null;
    if (st && this.s > st.s) {
      const lip = probes[5];
      const q = Math.max(0, lip[1] * lip[3]);
      this.lipQ += (q - this.lipQ) * Math.min(1, dt * 8);
      this.lipV += (Math.max(0, lip[1]) - this.lipV) * Math.min(1, dt * 8);
      const rl = this.rollerAt(st, this.lipQ);
      this.freeT = Math.max(0, this.freeT - dt);
      if (this.freeT > 0) { rl.cell = 0; rl.under = 0; }
      if (rl.cell > 0 || rl.under > 0.05) this.step = st;
      // The curtain's push flickers as the sheet breaks up, and its landing line sways.
      const flick = 1 + FALL.flicker * (0.6 * Math.sin(t * 5.3 + this.n * 31) + 0.4 * Math.sin(t * 2.1 + this.n * 13 + this.flutter));
      press = FALL.pressure * this.lipQ * rl.impact * rl.under * flick;
      rollerCell = rl.cell;
      // Surface runs back, bottom runs away. depth fraction 0 at the surface, 1 at the bed.
      const frac = hC > 0.01 ? Math.min(1, this.zeta / hC) : 0;
      Ws += rl.speed * rl.cell * (-1 + 2.3 * frac);
      // Water thrown off the curtain's edges spreads the leaf sideways, weakly.
      Wn += rl.speed * rl.cell * 0.2 * Math.tanh((this.n - st.nCenter) * 12) * (1 - frac);
    }

    // ---- under the surface
    const sinkMax = Math.max(0, hC - T.draft);
    this.zetaV += dt * (press - (this.zeta > 0 ? T.buoy : 0) - FALL.sinkDrag * this.zetaV);
    this.zeta += this.zetaV * dt;
    this.pinned = false;
    if (this.zeta >= sinkMax) {
      this.zeta = sinkMax;
      if (this.zetaV > 0) this.zetaV = 0;
      if (press > T.buoy && sinkMax > 0.003) this.pinned = true;
    }
    if (this.zeta <= 0) {
      this.zeta = 0;
      if (this.zetaV < 0) this.zetaV = 0;
    }

    // ---- turbulence: the part of the flow the grid does not resolve
    const spW = Math.hypot(Wn, Ws);
    // A leaf held for a long time meets a bigger fluctuation sooner or later; the longer the wait, the
    // larger the swing it has been exposed to.
    const patience = 1 + Math.min(this.heldTime, 9) / 8;
    const sigma = (0.015 + 0.09 * spW + 0.22 * rollerCell) * patience;
    const tau = 0.35;
    const drive = sigma * Math.sqrt(2 * dt / tau);
    this.turbN += -this.turbN * dt / tau + drive * gaussian();
    this.turbS += -this.turbS * dt / tau + drive * gaussian();
    Wn += this.turbN; Ws += this.turbS;

    // ---- drag and pressure
    const reln = Wn - this.vn, rels = Ws - this.vs;
    const rl2 = Math.hypot(reln, rels);
    let an = reln / T.tau + T.quad * rl2 * reln;
    let as = rels / T.tau + T.quad * rl2 * rels;
    const afloat = this.zeta < 0.004 ? 1 : 0;
    an += -PHYS.g * gn * 0.9 * afloat; as += -PHYS.g * gs * 0.9 * afloat;
    an += T.air * (wind[0] - this.vn) * afloat; as += T.air * (wind[1] - this.vs) * afloat;

    // torque from the flow difference across the leaf
    let tq = 0;
    for (let k = 1; k < 5; k++) {
      const [a, b] = PROBE_OFFSETS[k];
      const pn = (a * rn + b * fn) * size, ps = (a * rs + b * fs) * size;
      const pvn = this.vn + this.w * ps, pvs = this.vs - this.w * pn;
      const p = probes[k][3] > PHYS.hDry ? probes[k] : c;
      tq += ps * (p[0] - pvn) - pn * (p[1] - pvs);
    }
    let alpha = T.spin * 14 * tq / (size * size) - T.angDamp * this.w;
    if (T.align > 0 && Math.hypot(Wn, Ws) > 0.05) {
      const flowYaw = Math.atan2(Wn, Ws);
      let d = this.yaw - flowYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      alpha += -T.align * (this.key === 'sasabune' ? Math.sin(2 * d) : Math.sin(d)) * 6;
    }
    if (rollerCell > 0.2) alpha += gaussian() * 18 * rollerCell;

    this.vn += an * dt; this.vs += as * dt; this.w += alpha * dt;

    // ---- pressed to the bed: friction in proportion to the push
    if (this.pinned) {
      const k = Math.exp(-dt * FALL.bedGrip * press * (T.grip + 0.5));
      this.vn *= k; this.vs *= k; this.w *= k;
    }

    // ---- contact against the solver's bed
    this.solveContact(dt, c[2], sim);

    const sp = Math.hypot(this.vn, this.vs);
    if (sp > 2.2) { this.vn *= 2.2 / sp; this.vs *= 2.2 / sp; }
    this.w = Math.max(-16, Math.min(16, this.w));

    // ---- move. s advances by arc length at this n.
    const J = Math.max(0.5, 1 - this.n * sim.kappaAt(this.s));
    this.s += this.vs / J * dt;
    this.n += this.vn * dt;
    this.yaw += this.w * dt;
    this.n = Math.min(WORLD.W / 2 - 0.02, Math.max(-WORLD.W / 2 + 0.02, this.n));

    // ---- ride the surface
    const targetY = c[2] - this.zeta + T.draft * 0.5;
    this.y += (targetY - this.y) * Math.min(1, dt * 20);
    tmpN.set(-gn, 1, -gs).normalize();
    if (this.zeta > 0.004) {
      // tumbling in the aerated water
      tmpN.x += 0.5 * Math.sin(t * 11 + this.flutter); tmpN.z += 0.5 * Math.sin(t * 7 + this.flutter * 2);
      tmpN.normalize();
    }
    this.tilt.lerp(tmpN, Math.min(1, dt * 10)).normalize();
    this.pitch *= Math.exp(-dt * 6);
    this.speed = Math.abs(this.vs) + Math.abs(this.vn);

    // ---- over a lip?
    for (const fs2 of STEPS) {
      if (this.sLast < fs2.s && this.s >= fs2.s && fs2.drop > 0.04) {
        this.sLast = this.s;
        this.state = 'falling';
        this.fall = { st: fs2, t: 0, vs: Math.max(0.22, this.vs * 0.9), vy: 0 };
        this.zeta = 0; this.zetaV = 0;
        return 'fall';
      }
    }

    this.sLast = this.s;
    this.trackHold(dt, st);
    return null;
  }

  // Sequential impulses at every outline point the bed stands above.
  solveContact(dt, eta, sim) {
    const T = this.type;
    const fn = Math.sin(this.yaw), fs = Math.cos(this.yaw);
    const rn = Math.cos(this.yaw), rs = -Math.sin(this.yaw);
    const level = eta - this.zeta - T.draft;
    const dx = sim.dx;
    let pushN = 0, pushS = 0, count = 0;
    let flatTouch = 0;
    this.hop = Math.max(0, this.hop - dt);
    if (this.hop > 0) { this.contacts = 0; this.aground = false; return; }
    // Its middle has ridden up onto a stone: contacts all around would only squeeze it in place.
    // It slides off whichever way the stone falls away, and the current does the rest.
    if (sim.bedAt(this.s, this.n) > level) {
      const gx0 = (sim.bedAt(this.s, this.n + dx) - sim.bedAt(this.s, this.n - dx)) / (2 * dx);
      const gz0 = (sim.bedAt(this.s + dx, this.n) - sim.bedAt(this.s - dx, this.n)) / (2 * dx);
      const g0 = Math.hypot(gx0, gz0);
      if (g0 > 0.35) {
        this.vn -= gx0 / g0 * dt * PERCH_SLIDE; this.vs -= gz0 / g0 * dt * PERCH_SLIDE;
        this.contacts = 1;
        this.aground = false;
        return;
      }
    }
    for (let i = 0; i < this.outline.length; i++) {
      const [a, b] = this.outline[i];
      const on = a * rn + b * fn, os = a * rs + b * fs;
      const pn = this.n + on, ps = this.s + os;
      const bed = sim.bedAt(ps, pn);
      const over = bed - level;
      if (over <= 0) continue;
      const gx = (sim.bedAt(ps, pn + dx) - sim.bedAt(ps, pn - dx)) / (2 * dx);
      const gz = (sim.bedAt(ps + dx, pn) - sim.bedAt(ps - dx, pn)) / (2 * dx);
      const g = Math.hypot(gx, gz);
      if (g < 0.35) { flatTouch++; continue; }      // sitting on gravel, not against a wall
      // the wall's outward normal points downhill
      const nx = -gx / g, nz = -gz / g;
      const depth = Math.min(over / g, MAX_PUSH);
      pushN += nx * depth; pushS += nz * depth; count++;
      // normal impulse
      const vpn = this.vn + this.w * os, vps = this.vs - this.w * on;
      const vrel = vpn * nx + vps * nz;
      if (vrel < 0) {
        const rxn = os * nx - on * nz;
        const jn = -vrel * 1.08 / (1 + rxn * rxn / this.inertia);
        this.vn += jn * nx; this.vs += jn * nz; this.w += jn * rxn / this.inertia;
        // friction, limited by the normal impulse
        const tx = -nz, tz = nx;
        const vpn2 = this.vn + this.w * os, vps2 = this.vs - this.w * on;
        const vt = vpn2 * tx + vps2 * tz;
        const rxt = os * tx - on * tz;
        let jt = -vt / (1 + rxt * rxt / this.inertia);
        const lim = CONTACT_MU * jn;
        jt = Math.max(-lim, Math.min(lim, jt));
        this.vn += jt * tx; this.vs += jt * tz; this.w += jt * rxt / this.inertia;
      }
    }
    this.contacts = count;
    if (count) { this.n += pushN / count; this.s += pushS / count; }
    // Stranded in water too thin to float it: gravel friction wins until a wave lifts it.
    this.aground = this.zeta < 0.004 && flatTouch >= this.outline.length * 0.5;
    if (this.aground) {
      const k = Math.exp(-dt * 7);
      this.vn *= k; this.vs *= k; this.w *= k;
      // It settles down the slope of the gravel, back toward the water.
      const gx = (sim.bedAt(this.s, this.n + dx) - sim.bedAt(this.s, this.n - dx)) / (2 * dx);
      const gz = (sim.bedAt(this.s + dx, this.n) - sim.bedAt(this.s - dx, this.n)) / (2 * dx);
      this.vn -= gx * dt * 1.2; this.vs -= gz * dt * 1.2;
    }
  }

  // A leaf counts as held until it has got clear of where it stopped, so a jiggle against a stone or a
  // lap around an eddy does not reset the count.
  trackHold(dt, st) {
    this.progressT += dt;
    if (this.progressT < 1.0) return;
    const rate = (this.s - this.progressRef) / this.progressT;
    this.progressRef = this.s; this.progressT = 0;
    if (this.heldTime === 0 && rate >= RACE.stuckSpeed) return;
    if (this.heldTime === 0) this.holdAnchor = this.s;
    if (this.s > this.holdAnchor + HOLD_CLEAR) { this.endHold(); return; }
    this.heldTime += 1.0;
    if (this.step || (st && this.s > st.s && this.s < st.s + 0.5)) this.heldKind = 'fall';
    else if (this.contacts > 0) this.heldKind = 'rock';
    else if (this.aground) this.heldKind = 'shallow';
    else this.heldKind = 'eddy';
    // No trap keeps a leaf for good. After a long wait a surge comes down, stronger each time.
    if (this.heldTime >= HOLD_SURGE_AFTER && this.heldTime % 2 === 0) {
      const k = 0.18 + 0.05 * (this.heldTime - HOLD_SURGE_AFTER);
      const toMiddle = Math.sign(centerOffset(this.s) - this.n) || 1;
      this.kick(Math.min(k, 0.8), toMiddle * Math.min(k, 0.8) * 0.6, (Math.random() - 0.5) * 8, true);
      if (this.heldTime >= HOLD_HOP_AFTER) this.hop = HOP_TIME;
    }
  }

  endHold() {
    if (this.heldTime >= RACE.holdReport) this.diary.push({ kind: this.heldKind, s: this.s, seconds: this.heldTime });
    this.heldTime = 0; this.heldKind = null;
  }

  stepAir(dt) {
    // a falling leaf: drag-limited fall with a side-to-side flutter
    this.vy += (-PHYS.g - this.vy * 9) * dt;
    this.vy = Math.max(this.vy, this.key === 'sasabune' ? -2.2 : -1.0);
    this.flutter += dt * 7;
    const sway = this.key === 'sasabune' ? 0 : 0.22;
    this.n += (this.vn + Math.sin(this.flutter) * sway) * dt;
    this.s += this.vs * dt;
    this.vn *= Math.exp(-dt * 1.5); this.vs *= Math.exp(-dt * 1.5);
    this.y += this.vy * dt;
    this.w = Math.sin(this.flutter * 0.7) * 2;
    this.yaw += this.w * dt;
    this.n = Math.min(WORLD.W / 2 - 0.05, Math.max(-WORLD.W / 2 + 0.05, this.n));
  }

  // A shove from a pebble's wave or a twig. Knocks a dunked leaf loose too.
  kick(ds, dn, spin, lift) {
    this.vs += ds; this.vn += dn; this.w += spin;
    if (lift) { this.zeta *= 0.25; this.zetaV = -0.2; this.freeT = FREE_TIME; }
  }

  syncMesh() {
    toWorld(this.s, this.n, w2);
    this.x = w2[0]; this.z = w2[1];
    const m = this.mesh;
    m.position.set(this.x, this.y, this.z);
    const th = heading(this.s);
    tmpQ.setFromAxisAngle(UP, th + this.yaw);
    // tilt was expressed across / along the stream; rotate it into world axes
    const tn = this.tilt.x, ts = this.tilt.z;
    tmpN.set(tn * Math.cos(th) + ts * Math.sin(th), this.tilt.y, -tn * Math.sin(th) + ts * Math.cos(th));
    tmpQ2.setFromUnitVectors(UP, tmpN);
    m.quaternion.copy(tmpQ2).multiply(tmpQ);
    if (this.pitch > 0.01) {
      tmpAxis.set(Math.cos(th), 0, -Math.sin(th));
      tmpQ3.setFromAxisAngle(tmpAxis, this.pitch);
      m.quaternion.premultiply(tmpQ3);
    }
    // Under water it is drawn with the bed, so the water refracts and tints it.
    const under = this.zeta > 0.006;
    if (under !== this.underLayer) {
      this.underLayer = under;
      m.layers.set(under ? LAYER_OPAQUE : LAYER_FLOAT);
    }
  }
}

// Leaf-leaf contact (soft, symmetric).
export function collideLeaves(leaves) {
  for (let i = 0; i < leaves.length; i++) {
    const a = leaves[i];
    if (a.state !== 'water') continue;
    for (let j = i + 1; j < leaves.length; j++) {
      const b = leaves[j];
      if (b.state !== 'water' || Math.abs(a.zeta - b.zeta) > 0.02) continue;
      const dn = b.n - a.n, ds = b.s - a.s;
      const d = Math.hypot(dn, ds), m = 0.5 * (a.type.radL + a.type.radW + b.type.radL + b.type.radW);
      if (d >= m || d < 1e-6) continue;
      const nn = dn / d, ns = ds / d, push = (m - d) * 0.5;
      a.n -= nn * push; a.s -= ns * push; b.n += nn * push; b.s += ns * push;
      const rv = (b.vn - a.vn) * nn + (b.vs - a.vs) * ns;
      if (rv < 0) {
        const jv = -rv * 0.6;
        a.vn -= jv * nn; a.vs -= jv * ns; b.vn += jv * nn; b.vs += jv * ns;
        a.w += (Math.random() - 0.5) * 4; b.w += (Math.random() - 0.5) * 4;
      }
    }
  }
}
