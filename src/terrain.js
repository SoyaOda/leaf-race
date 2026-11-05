// Bed, banks, lane, hillside and rocks. Standard PBR materials patched with height-blended Poly Haven
// materials, wetness, underwater light, caustics and refraction-correct shadows.
// The ground near the stream is a strip that follows the channel. A coarse grid in world space carries
// the land beyond it and tucks itself under the strip.
import * as THREE from 'three';
import { WORLD } from './config.js?v=e79679972dca';
import { groundHeight, fbm, ROCKS, toWorld, nearest, stripLimit, LANE, halfWidth, centerOffset, STEPS } from './course.js?v=e79679972dca';
import { WATER_PARS, SHADOW_SHIFT_VERTEX, UNDERWATER_LIGHT } from './water.js?v=e79679972dca';

const WORLD_VARYINGS_VERT = /* glsl */`
#include <worldpos_vertex>
vWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWorldN = normalize(mat3(modelMatrix) * objectNormal);
vSN = aSN;
`;

function patchCommon(shader, waterUniforms, extraUniforms, fragPars) {
  Object.assign(shader.uniforms, waterUniforms, extraUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute vec2 aSN;\nvarying vec3 vWorldP;\nvarying vec3 vWorldN;\nvarying vec2 vSN;\n${WATER_PARS}`)
    .replace('#include <worldpos_vertex>', WORLD_VARYINGS_VERT)
    .replace('#include <shadowmap_vertex>', `${SHADOW_SHIFT_VERTEX}\n#include <shadowmap_vertex>`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vWorldP;\nvarying vec3 vWorldN;\nvarying vec2 vSN;\n${WATER_PARS}\n${fragPars}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${UNDERWATER_LIGHT}`);
}

const PLANAR_NORMAL = /* glsl */`
vec3 perturbPlanar(vec3 n, vec2 nts, float strength) {
  vec3 T = normalize(vec3(1.0, 0.0, 0.0) - n * n.x);
  vec3 Bv = cross(n, T);
  vec3 t = vec3(nts * strength, 1.0);
  return normalize(T * t.x + Bv * t.y + n * t.z);
}
vec3 hash3(vec2 p) { return fract(sin(vec3(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash3(i).x, hash3(i + vec2(1, 0)).x, u.x), mix(hash3(i + vec2(0, 1)).x, hash3(i + vec2(1, 1)).x, u.x), u.y);
}
`;

const TERRAIN_PARS = /* glsl */`
uniform sampler2D uBedA; uniform sampler2D uBedD;
uniform sampler2D uMudA; uniform sampler2D uMudD;
uniform sampler2D uGrassA; uniform sampler2D uGrassD;
uniform sampler2D uRockA; uniform sampler2D uRockD;
${PLANAR_NORMAL}
`;

const TERRAIN_MAP = /* glsl */`
vec3 wp = vWorldP;
float etaM;
float wDepth = waterDepthAt(vSN, wp.y, etaM);
float n1 = vnoise(wp.xz * 1.9), n2 = vnoise(wp.xz * 6.3);
float nn = vSN.x - ${(WORLD.W / 2).toFixed(2)};      // across the stream
vec2 uvBed = vec2(wp.x, -wp.z) / 0.55;
vec2 uvBed2 = mat2(0.8, -0.6, 0.6, 0.8) * vec2(wp.x, -wp.z) / 0.83 + 0.37;
float bmix = smoothstep(0.35, 0.65, n1);
vec4 bedA = mix(texture(uBedA, uvBed), texture(uBedA, uvBed2), bmix);
vec4 bedD = mix(texture(uBedD, uvBed), texture(uBedD, uvBed2), bmix);
vec2 uvM = vec2(wp.x, -wp.z) / 1.1;
vec4 mudA = texture(uMudA, uvM), mudD = texture(uMudD, uvM);
vec2 uvG = vec2(wp.x, -wp.z) / 0.7;
vec4 grA = texture(uGrassA, uvG), grD = texture(uGrassD, uvG);
// steep faces show stone: lips of the drops, cut banks
vec2 uvR = (abs(vWorldN.x) > abs(vWorldN.z) ? wp.zy : wp.xy) / 0.36;
vec4 roA = texture(uRockA, uvR), roD = texture(uRockD, uvR);

float slope = 1.0 - clamp(vWorldN.y, 0.0, 1.0);
float hw = uHalf(vSN.y);
float inChannel = 1.0 - smoothstep(0.92, 1.12, abs(nn - uCentre(vSN.y)) / hw);
float aboveW = wp.y - etaM;

// the lane: packed earth in a band of n, wandering a little, thin grass down its middle
float laneC = ${((LANE.n0 + LANE.n1) / 2).toFixed(3)} + 0.07 * sin(vSN.y * 0.8) + 0.05 * (n1 - 0.5);
float laneHalf = ${((LANE.n1 - LANE.n0) / 2).toFixed(3)} + 0.06 * (n2 - 0.5);
float laneD = abs(nn - laneC) / laneHalf;
float lane = (1.0 - smoothstep(0.82, 1.15, laneD)) * step(0.0, nn);
float laneMid = (1.0 - smoothstep(0.0, 0.22, laneD)) * smoothstep(0.45, 0.7, n1);

float wBed = inChannel * (1.0 - smoothstep(0.0, 0.05, aboveW));
float wRock = smoothstep(0.28, 0.5, slope + (n1 - 0.5) * 0.15);
float wGrass = (1.0 - inChannel) * (1.0 - lane + laneMid * lane) * (1.0 - smoothstep(0.3, 0.6, slope));
float wMud = max(0.0, 1.0 - wBed - wGrass);
vec4 hb = vec4(bedA.a + wBed, mudA.a + wMud, grA.a + wGrass, roA.a + wRock * 1.2) * vec4(sign(wBed), sign(wMud), sign(wGrass), sign(wRock));
float hm = max(max(hb.x, hb.y), max(hb.z, hb.w)) - 0.22;
vec4 bw = max(hb - hm, 0.0);
bw /= max(bw.x + bw.y + bw.z + bw.w, 1e-4);
vec3 alb = bedA.rgb * bw.x + mudA.rgb * bw.y + grA.rgb * bw.z + roA.rgb * bw.w;
vec4 dat = bedD * bw.x + mudD * bw.y + grD * bw.z + roD * bw.w;
// the lane is lighter than bank earth, trodden and dry
{
  float lum = dot(alb, vec3(0.3, 0.6, 0.1));
  alb = mix(alb, vec3(lum) * vec3(1.32, 1.14, 0.92) + 0.02, lane * bw.y * 0.8);
}
// autumn: grass drifts toward straw in patches
alb = mix(alb, alb * vec3(1.14, 0.98, 0.6), smoothstep(0.4, 0.8, n1) * bw.z * 0.6) * mix(1.0, 0.72, bw.z);
// beyond the lane and the hill foot the ground turns to stubble and dark field
alb *= mix(vec3(1.0), vec3(0.6, 0.56, 0.36), smoothstep(2.6, 4.5, abs(nn)));
// moss where a shaded bank meets the water
float moss = smoothstep(0.35, 0.7, vnoise(wp.xz * 5.0 + wp.y * 3.0)) * (1.0 - smoothstep(0.02, 0.22, aboveW)) * step(0.0, aboveW);
alb = mix(alb, vec3(0.09, 0.14, 0.035), moss * (1.0 - bw.x) * 0.75);
// wetness: under water, plus a darker capillary band above the waterline
float nearW = inDomain(vSN) * (1.0 - smoothstep(0.0, 0.06, aboveW));
float wet = max(smoothstep(0.0, 0.008, wDepth), nearW);
alb *= mix(1.0, 0.56, wet);
alb = mix(alb, alb * vec3(0.84, 1.0, 0.8), smoothstep(0.015, 0.12, wDepth) * 0.6);
diffuseColor.rgb = alb * mix(0.74, 1.0, wet);
float tRough = mix(dat.b, 0.24, wet * (1.0 - smoothstep(0.0, 0.008, wDepth)));
tRough = mix(tRough, 0.6, smoothstep(0.0, 0.008, wDepth));
float tAO = dat.a;
vec2 tNts = dat.rg * 2.0 - 1.0;
`;

// Half width and centre as GLSL, from a small table along the course, so the material can tell the
// channel from the bank without another texture.
function profileGlsl() {
  const N = 28;
  const hws = [], ncs = [];
  for (let i = 0; i < N; i++) { hws.push(halfWidth(i).toFixed(3)); ncs.push(centerOffset(i).toFixed(3)); }
  return /* glsl */`
const float HW_T[${N}] = float[${N}](${hws.join(',')});
const float NC_T[${N}] = float[${N}](${ncs.join(',')});
float uHalf(float s) { float f = clamp(s, 0.0, ${(N - 1.01).toFixed(2)}); int i = int(f); return mix(HW_T[i], HW_T[i + 1], fract(f)) + 0.03; }
float uCentre(float s) { float f = clamp(s, 0.0, ${(N - 1.01).toFixed(2)}); int i = int(f); return mix(NC_T[i], NC_T[i + 1], fract(f)); }
`;
}

export function createTerrainMaterial(tex, waterUniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    patchCommon(shader, waterUniforms, {
      uBedA: { value: tex.bed.albedo }, uBedD: { value: tex.bed.data },
      uMudA: { value: tex.mud.albedo }, uMudD: { value: tex.mud.data },
      uGrassA: { value: tex.grass.albedo }, uGrassD: { value: tex.grass.data },
      uRockA: { value: tex.rock.albedo }, uRockD: { value: tex.rock.data },
    }, `${TERRAIN_PARS}\n${profileGlsl()}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', TERRAIN_MAP)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
      .replace('#include <normal_fragment_maps>', `
        vec3 nW = perturbPlanar(normalize(vWorldN), tNts, 1.1);
        normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);`)
      .replace('#include <aomap_fragment>', `
        reflectedLight.indirectDiffuse *= tAO;
        reflectedLight.indirectSpecular *= tAO;`);
  };
  mat.customProgramCacheKey = () => 'terrain-v2';
  return mat;
}

// ---- rocks ----------------------------------------------------------------------------
const ROCK_PARS = /* glsl */`
uniform sampler2D uRockA; uniform sampler2D uRockD;
${PLANAR_NORMAL}
`;
const ROCK_MAP = /* glsl */`
vec3 wp = vWorldP;
vec3 nw = normalize(vWorldN);
vec3 bw3 = pow(abs(nw), vec3(4.0)); bw3 /= bw3.x + bw3.y + bw3.z;
const float RS = 0.34;
vec4 aX = texture(uRockA, wp.zy / RS), aY = texture(uRockA, wp.xz / RS), aZ = texture(uRockA, wp.xy / RS);
vec4 dX = texture(uRockD, wp.zy / RS), dY = texture(uRockD, wp.xz / RS), dZ = texture(uRockD, wp.xy / RS);
vec4 alb4 = aX * bw3.x + aY * bw3.y + aZ * bw3.z;
vec4 dat = dX * bw3.x + dY * bw3.y + dZ * bw3.z;
float etaM;
float wDepth = waterDepthAt(vSN, wp.y, etaM);
float above = inDomain(vSN) > 0.5 ? wp.y - etaM : 1.0;
vec3 alb = mix(alb4.rgb, vec3(dot(alb4.rgb, vec3(0.3, 0.6, 0.1))), 0.35) * 0.78;
// sun-bleached dry tops, dark wet band, slick algae below, moss on the shaded crown
alb = mix(alb, alb * vec3(1.15, 1.12, 1.05), smoothstep(0.03, 0.12, above));
float wet = 1.0 - smoothstep(0.0, 0.035, above);
alb *= mix(1.0, 0.5, wet);
alb = mix(alb, vec3(0.06, 0.08, 0.035), smoothstep(0.005, 0.08, wDepth) * 0.5);
float mossN = vnoise(wp.xz * 14.0 + wp.y * 9.0) * 0.6 + vnoise(wp.xz * 41.0) * 0.4;
float moss = smoothstep(0.5, 0.68, mossN) * smoothstep(0.35, 0.85, nw.y) * smoothstep(0.015, 0.06, above);
alb = mix(alb, vec3(0.085, 0.125, 0.04), moss * 0.7);
diffuseColor.rgb = alb;
float tRough = mix(mix(dat.b, 0.95, moss), 0.22, wet);
float tAO = dat.a;
vec3 tN;
{
  vec2 nx = dX.rg * 2.0 - 1.0, ny = dY.rg * 2.0 - 1.0, nz = dZ.rg * 2.0 - 1.0;
  vec3 tx = vec3(0.0, nx.y, nx.x) * sign(nw.x);
  vec3 ty = vec3(ny.x, 0.0, ny.y) * sign(nw.y);
  vec3 tz = vec3(nz.x, nz.y, 0.0) * sign(nw.z);
  tN = normalize(nw + tx * bw3.x + ty * bw3.y + tz * bw3.z);
}
`;

export function createRockMaterial(tex, waterUniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    patchCommon(shader, waterUniforms, { uRockA: { value: tex.rock.albedo }, uRockD: { value: tex.rock.data } }, ROCK_PARS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', ROCK_MAP)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(tN, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', 'reflectedLight.indirectDiffuse *= tAO; reflectedLight.indirectSpecular *= tAO;');
  };
  mat.customProgramCacheKey = () => 'rock-v2';
  return mat;
}

// A river-worn stone written into shared arrays, bent along the stream by the channel mapping so its
// footprint matches the one the solver was given.
function appendRock(r, detail, out) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  // IcosahedronGeometry is non-indexed; weld so normals smooth across faces
  const p = geo.attributes.position;
  const key = (i) => `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
  const map = new Map(), verts = [], idx = [];
  for (let i = 0; i < p.count; i++) {
    const k = key(i);
    let v = map.get(k);
    if (v === undefined) { v = verts.length; map.set(k, v); verts.push(new THREE.Vector3().fromBufferAttribute(p, i)); }
    idx.push(v);
  }
  let crown = 0;
  for (const v of verts) {
    const n = fbm(v.x * 1.6 + r.seed * 7.1, v.z * 1.6 + v.y * 1.3 + r.seed, 4);
    const n2 = fbm(v.x * 5.3 + r.seed, v.y * 5.3 - v.z * 2.0, 3);
    let s = 1 + 0.26 * n + 0.05 * n2;
    if (v.y > 0.55) s *= 1 - (v.y - 0.55) * 0.35;      // flatter top, rounder sides
    v.multiplyScalar(s);
    crown = Math.max(crown, v.y);
  }
  const base = out.pos.length / 3;
  const c = Math.cos(r.yaw), sn = Math.sin(r.yaw);
  const w = [0, 0];
  for (const v of verts) {
    const ln = v.x * r.rn * 1.05, ls = v.z * r.rs * 1.05;
    const dn = ln * c + ls * sn, ds = -ln * sn + ls * c;
    const s = r.s + ds, n = r.n + dn;
    toWorld(s, n, w);
    out.pos.push(w[0], r.cy + r.ry * (v.y / crown), w[1]);
    out.sn.push(n + WORLD.W / 2, s);
  }
  for (const i of idx) out.idx.push(base + i);
  geo.dispose();
}

function rockChunk(list, detailOf, material) {
  const out = { pos: [], sn: [], idx: [] };
  for (const r of list) appendRock(r, detailOf(r), out);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  g.setAttribute('aSN', new THREE.Float32BufferAttribute(out.sn, 2));
  g.setIndex(out.idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Field stones along the banks: they break up the edge of the stream and give it its old, dry-stone look.
function bankStones() {
  const stones = [];
  const seedRnd = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); };
  let i = 0;
  for (let s = 0.4; s < WORLD.CULVERT_S - 0.3; s += 0.11) {
    i++;
    const side = seedRnd(i) < 0.62 ? -1 : 1;              // more on the hill side
    if (seedRnd(i + 500) > (side < 0 ? 0.62 : 0.28)) continue;
    const hw = halfWidth(s), nc = centerOffset(s);
    const out = (0.01 + seedRnd(i + 1000) * 0.08);
    const n = nc + side * (hw + out);
    const r = 0.04 + Math.pow(seedRnd(i + 2000), 1.9) * 0.12;
    const g = groundHeight(s, n);
    const ry = r * (0.36 + seedRnd(i + 3000) * 0.3);
    stones.push({ s: s + (seedRnd(i + 4000) - 0.5) * 0.08, n, rs: r * (1 + seedRnd(i + 5000) * 0.5), rn: r, cy: g + ry * 0.25, ry, yaw: seedRnd(i + 6000) * 6.28, seed: 40 + i });
  }
  // Dry-stone facing at the drops, stacked beside each lip.
  for (const st of STEPS) {
    const nc = centerOffset(st.s), hw = halfWidth(st.s);
    for (const side of [-1, 1]) for (let k = 0; k < 4; k++) {
      i++;
      const n = nc + side * (hw + 0.03 + k * 0.05);
      const s = st.s + 0.02 + k * 0.1 + (seedRnd(i) - 0.5) * 0.05;
      const g = groundHeight(s, n);
      const r = 0.07 + seedRnd(i + 77) * 0.05;
      stones.push({ s, n, rs: r * 1.3, rn: r, cy: g + r * 0.2 + st.drop * 0.3, ry: r * 0.8 + st.drop * 0.35, yaw: seedRnd(i + 13) * 6.28, seed: 200 + i });
    }
  }
  return stones;
}

export function buildRocks(material, tier) {
  const group = new THREE.Group();
  const all = [...ROCKS.map((r) => ({ ...r, inStream: true })), ...bankStones()];
  const CH = 5;
  for (let c = 0; c * CH < WORLD.L; c++) {
    const list = all.filter((r) => r.s >= c * CH && r.s < (c + 1) * CH);
    if (list.length) group.add(rockChunk(list, (r) => (r.inStream ? tier.rockDetail : Math.max(2, tier.rockDetail - 1)), material));
  }
  return group;
}

// ---- ground meshes --------------------------------------------------------------------
function acrossColumns(step) {
  const cols = [];
  const STRIP = WORLD.STRIP_N;
  const inner = 0.62;
  for (let n = -STRIP; n < -inner - 1e-6; n += 0.13) cols.push(n);
  for (let n = -inner; n < inner - 1e-6; n += step) cols.push(n);
  for (let n = inner; n < STRIP - 1e-6; n += 0.09) cols.push(n);
  cols.push(STRIP);
  return cols;
}

function alongRows(step) {
  const rows = new Set();
  const add = (a, b, st) => { for (let s = a; s < b - 1e-6; s += st) rows.add(+s.toFixed(4)); };
  add(-6, -0.3, 0.25);
  add(-0.3, WORLD.CULVERT_S + 0.5, step);
  add(WORLD.CULVERT_S + 0.5, WORLD.L + 5, 0.25);
  rows.add(WORLD.L + 5);
  for (const st of STEPS) { rows.add(+(st.s - 0.002).toFixed(4)); rows.add(+(st.s + 0.002).toFixed(4)); }
  return [...rows].sort((a, b) => a - b);
}

function stripChunk(rows, cols, material) {
  const nr = rows.length, nc = cols.length;
  const pos = new Float32Array(nr * nc * 3), sn = new Float32Array(nr * nc * 2);
  const w = [0, 0];
  const inner = 0.62;
  for (let j = 0; j < nr; j++) {
    const s = rows[j];
    const limPos = stripLimit(s, 1), limNeg = stripLimit(s, -1);
    const fPos = (limPos - inner) / (WORLD.STRIP_N - inner), fNeg = (limNeg - inner) / (WORLD.STRIP_N - inner);
    for (let i = 0; i < nc; i++) {
      let n = cols[i];
      if (n > inner) n = inner + (n - inner) * fPos;
      else if (n < -inner) n = -inner + (n + inner) * fNeg;
      toWorld(s, n, w);
      const k = j * nc + i;
      pos[k * 3] = w[0]; pos[k * 3 + 1] = groundHeight(s, n); pos[k * 3 + 2] = w[1];
      sn[k * 2] = n + WORLD.W / 2; sn[k * 2 + 1] = s;
    }
  }
  const idx = [];
  for (let j = 0; j < nr - 1; j++) for (let i = 0; i < nc - 1; i++) {
    const a = j * nc + i, b = a + 1, c = a + nc, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSN', new THREE.BufferAttribute(sn, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, material);
  m.receiveShadow = true;
  return m;
}

// The land beyond the strip: a coarse world-space grid. Height comes from the same function evaluated
// at each vertex's nearest channel coordinates, and vertices over the strip are pushed under it.
function farGround(material) {
  const pts = [];
  const w = [0, 0];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let s = -6; s <= WORLD.L + 5; s += 0.5) { toWorld(s, 0, w); pts.push([w[0], w[1]]); x0 = Math.min(x0, w[0]); x1 = Math.max(x1, w[0]); z0 = Math.min(z0, w[1]); z1 = Math.max(z1, w[1]); }
  const M = 46, step = 1.3;
  x0 -= M; x1 += M; z0 -= M; z1 += M;
  const nx = Math.ceil((x1 - x0) / step) + 1, nz = Math.ceil((z1 - z0) / step) + 1;
  const pos = new Float32Array(nx * nz * 3), sn = new Float32Array(nx * nz * 2);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + i * step, z = z0 + j * step;
    const { s, n } = nearest(x, z, 12);
    const lim = n > 0 ? stripLimit(s, 1) : stripLimit(s, -1);
    let y = groundHeight(s, n);
    if (Math.abs(n) < lim - 0.25) y -= 0.5;           // tucked under the strip
    const k = j * nx + i;
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    sn[k * 2] = n + WORLD.W / 2; sn[k * 2 + 1] = s;
  }
  const idx = [];
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSN', new THREE.BufferAttribute(sn, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.receiveShadow = true;
  m.frustumCulled = false;
  return m;
}

export function buildTerrain(tex, waterUniforms, tier) {
  const material = createTerrainMaterial(tex, waterUniforms);
  const group = new THREE.Group();
  const cols = acrossColumns(tier.terrainStep);
  const rows = alongRows(tier.terrainStep);
  const CH = 2.5;
  let start = 0;
  for (let s = rows[0] + CH; start < rows.length - 1; s += CH) {
    let end = start;
    while (end < rows.length - 1 && rows[end] < s) end++;
    group.add(stripChunk(rows.slice(start, end + 1), cols, material));
    start = end;
  }
  group.add(farGround(material));
  return group;
}
