// Water surface (PBR: Fresnel, sky reflection, sun GGX, screen-space refraction with Beer-Lambert
// absorption, flow-mapped ripples and foam), the falling curtains, and the caustics map.
// All field lookups are in channel coordinates; the mesh is already bent along the stream.
import * as THREE from 'three';
import { WORLD, PHYS, SUN } from './config.js?v=a087d61d0b56';
import { SKY_GLSL } from './sky.js?v=a087d61d0b56';
import { STEPS, toWorld, heading, bedLine, centerOffset, halfWidth } from './course.js?v=a087d61d0b56';

// Shared by every material that sits in or under the water. vSN = (n + W/2, s).
export const WATER_PARS = /* glsl */`
uniform sampler2D uSurfA;   // eta, deta/dn, deta/ds, foam
uniform sampler2D uSurfB;   // u, v, h, b
uniform sampler2D uCaustics;
uniform vec4 uDomain;       // W, L, 1/W, 1/L
uniform vec3 uSunDirW;
uniform vec3 uSigma;
uniform float uCausticsOn;
uniform vec2 uCausticWin;
vec2 waterUV(vec2 sn) { return clamp(sn * uDomain.zw, vec2(0.0), vec2(1.0)); }
float inDomain(vec2 sn) {
  return step(0.0, sn.x) * step(sn.x, uDomain.x) * step(0.0, sn.y) * step(sn.y, ${WORLD.CULVERT_S.toFixed(2)});
}
// depth of water above a point (0 when dry or outside the stream)
float waterDepthAt(vec2 sn, float y, out float eta) {
  vec2 uv = waterUV(sn);
  vec4 A = texture(uSurfA, uv);
  vec4 B = texture(uSurfB, uv);
  eta = A.x;
  float wet = smoothstep(0.0015, 0.004, B.z) * inDomain(sn);
  return max(eta - y, 0.0) * wet;
}
vec3 refractedSun() { return refract(-uSunDirW, vec3(0.0, 1.0, 0.0), 1.0 / 1.333); }
`;

// Vertex snippet: move the shadow lookup to where the refracted sun ray leaves the water surface,
// so floating leaves cast their shadow where it really lands on the bed (Snell, not a straight line).
export const SHADOW_SHIFT_VERTEX = /* glsl */`
{
  float etaS;
  float dS = waterDepthAt(aSN, worldPosition.y, etaS);
  if (dS > 0.0) {
    vec3 tS = refractedSun();
    worldPosition.xyz += -tS * (dS / max(-tS.y, 0.2));
  }
}
`;

// Fragment snippet (after lights are accumulated): attenuate light that travelled through water and add caustics.
export const UNDERWATER_LIGHT = /* glsl */`
{
  float etaU;
  float dU = waterDepthAt(vSN, vWorldP.y, etaU);
  if (dU > 0.0) {
    vec3 tU = refractedSun();
    vec3 sunT = exp(-uSigma * dU / max(-tU.y, 0.2));
    vec3 ambT = exp(-uSigma * dU * 1.3);
    float caus = 1.0;
    if (uCausticsOn > 0.5) {
      float win = smoothstep(uCausticWin.x, uCausticWin.x + 0.6, vSN.y) * (1.0 - smoothstep(uCausticWin.y - 0.6, uCausticWin.y, vSN.y));
      caus = mix(1.0, texture(uCaustics, waterUV(vSN)).r * 4.0, win * smoothstep(0.01, 0.05, dU));
    }
    float sub = smoothstep(0.0, 0.008, dU);
    reflectedLight.directDiffuse *= sunT * mix(1.0, caus, sub);
    reflectedLight.directSpecular *= mix(vec3(1.0), sunT * 0.15, sub);
    reflectedLight.indirectDiffuse *= mix(vec3(1.0), ambT, sub);
    reflectedLight.indirectSpecular *= mix(vec3(1.0), ambT * 0.3, sub);
  }
}
`;

export function makeWaterUniforms(sim, causticsTexture, causticsOn) {
  return {
    uSurfA: { value: sim.surfA },
    uSurfB: { value: sim.surfB },
    uCaustics: { value: causticsTexture },
    uCausticsOn: { value: causticsOn ? 1 : 0 },
    uCausticWin: { value: new THREE.Vector2(0, WORLD.L) },
    uDomain: { value: new THREE.Vector4(WORLD.W, WORLD.L, 1 / WORLD.W, 1 / WORLD.L) },
    uSunDirW: { value: new THREE.Vector3(...SUN.dir) },
    uSigma: { value: new THREE.Vector3(...PHYS.waterSigma) },
  };
}

// Rows along the stream at every second cell, plus the exact cells either side of each lip so the drop
// stays one cell wide instead of smearing into a ramp.
export function streamRows(dx, stride = 2, s0 = 0, s1 = WORLD.L) {
  const set = new Set();
  const j0 = Math.floor(s0 / dx), j1 = Math.ceil(s1 / dx);
  for (let j = j0; j <= j1; j += stride) set.add(j);
  for (const st of STEPS) {
    const jl = Math.floor(st.s / dx + 0.5);
    set.add(jl - 2); set.add(jl - 1); set.add(jl); set.add(jl + 1);
  }
  return [...set].sort((a, b) => a - b).map((j) => (j + 0.5) * dx);
}

// ---------------------------------------------------------------------------------------
const WATER_VERT = /* glsl */`
uniform sampler2D uSurfA;
uniform vec4 uDomain;
in vec2 aSN;
in vec2 aTan;
out vec3 vWorld;
out vec2 vUV;
out vec2 vSNf;
out vec2 vTan;
void main() {
  vec3 p = position;
  vec2 uv = clamp(aSN * uDomain.zw, vec2(0.0), vec2(1.0));
  p.y = textureLod(uSurfA, uv, 0.0).x;
  vUV = uv; vSNf = aSN; vTan = aTan;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */`
uniform sampler2D uSurfA;
uniform sampler2D uSurfB;
uniform sampler2D uRefr;
uniform sampler2D uDetail;
uniform vec2 uResolution;
uniform float uTime;
uniform float uSkyIntensity;
uniform vec3 uSunRadiance;
uniform vec3 uSigma;
uniform vec3 uScatter;
uniform vec3 uAmbient;
uniform vec3 uBankColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
in vec3 vWorld;
in vec2 vUV;
in vec2 vSNf;
in vec2 vTan;
out vec4 fragColor;

#define PI 3.14159265

${SKY_GLSL}
vec3 skyLookup(vec3 d) { return skyColor(d) * uSkyIntensity; }
vec2 slopeAt(vec2 p) { return texture(uDetail, p).rg * 2.0 - 1.0; }
float D_GGX(float NoH, float a) {
  float a2 = a * a; float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

void main() {
  vec4 A = texture(uSurfA, vUV);
  vec4 B = texture(uSurfB, vUV);
  float h = B.z;
  if (h < 0.0012 || vSNf.y > ${WORLD.CULVERT_S.toFixed(2)}) discard;
  vec2 vel = B.xy;
  float speed = length(vel);
  float foam = A.w;

  // basis: T = along the stream, Nn = across it (both horizontal, in world xz)
  vec3 T = vec3(vTan.x, 0.0, vTan.y);
  vec3 Nn = vec3(vTan.y, 0.0, -vTan.x);

  // macro normal from the simulated surface
  vec3 Nm = normalize(vec3(0.0, 1.0, 0.0) - Nn * A.y - T * A.z);

  // flow-mapped ripples (two phases cross-faded so the texture never stretches), in channel metres
  const float PERIOD = 0.9;
  float ph0 = fract(uTime / PERIOD), ph1 = fract(uTime / PERIOD + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
  vec2 sn = vSNf;
  vec2 o0 = vel * (ph0 - 0.5) * PERIOD, o1 = vel * (ph1 - 0.5) * PERIOD + vec2(0.37, 0.61);
  vec2 sl = mix(slopeAt((sn - o1) / 0.26), slopeAt((sn - o0) / 0.26), w0);
  vec2 slF = mix(slopeAt((sn - o1) / 0.085 + 0.5), slopeAt((sn - o0) / 0.085 + 0.5), w0);
  float turb = smoothstep(0.1, 0.85, speed) + foam * 0.7;
  float amp = 0.16 + 0.75 * turb;
  vec2 dn = sl * amp + slF * (0.12 + 0.45 * turb);
  float dist = length(cameraPosition - vWorld);
  dn *= 1.0 / (1.0 + dist * 0.09);
  vec3 N = normalize(Nm + Nn * dn.x + T * dn.y);

  vec3 V = normalize(cameraPosition - vWorld);
  float NoV = clamp(dot(N, V), 0.02, 1.0);
  float F = min(0.02 + 0.98 * pow(1.0 - NoV, 5.0), 0.5);

  // reflection: a little sky through the canopy, mostly dark banks low down
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 sky = min(skyLookup(R), vec3(1.5));
  // What a stream this small mirrors is mostly banks and leaves overhead, with sky between them.
  float bank = 1.0 - smoothstep(0.08, 0.5, R.y);
  float canopy = smoothstep(0.3, 0.72, texture(uDetail, R.xz / (R.y + 0.35) * 0.42 + 0.2).a);
  vec3 refl = mix(sky * 0.55, uBankColor * vec3(2.6, 2.3, 1.5), max(bank, canopy * 0.7));

  // sun glitter
  vec3 L = uSunDirW;
  vec3 H = normalize(L + V);
  float NoL = max(dot(N, L), 0.0);
  float rough = 0.025 + 0.05 * turb;
  float Fs = 0.02 + 0.98 * pow(1.0 - clamp(dot(H, V), 0.0, 1.0), 5.0);
  float vis = 0.25 / max(NoL * NoV, 0.05);
  vec3 spec = min(uSunRadiance * D_GGX(max(dot(N, H), 0.0), rough) * Fs * vis * NoL * 0.3, vec3(mix(0.22, 1.6, min(turb, 1.0)))) * (1.0 - foam * 0.8)
    * smoothstep(0.36, 0.62, texture(uDetail, vWorld.xz / 4.0 + uTime * 0.004).a);   // light through leaves

  // refraction of the already-lit bed
  vec2 suv = gl_FragCoord.xy / uResolution;
  float thick = clamp(h, 0.0, 0.25);
  vec2 dist2 = (N.xz - Nm.xz * 0.35) * thick * 0.9;
  vec3 under = texture(uRefr, clamp(suv + dist2, vec2(0.001), vec2(0.999))).rgb;
  vec3 Tr = refract(-V, N, 1.0 / 1.333);
  float path = h / max(-Tr.y, 0.25);
  vec3 trans = exp(-uSigma * path);
  vec3 inscatter = uScatter * (uSunRadiance * 0.08 * max(L.y, 0.0) + uAmbient) * (1.0 - trans) * 4.0;
  vec3 body = under * trans + inscatter;

  vec3 col = mix(body, refl, F) + spec;

  // foam: advected density shaped by a flow-mapped bubble texture
  // Soft blobs at three sizes, carried with the flow: aerated water, not a net of cells.
  float fb0 = mix(texture(uDetail, (sn - o1) / 1.5).a, texture(uDetail, (sn - o0) / 1.5).a, w0);
  float fb1 = mix(texture(uDetail, (sn - o1) / 0.55 + 0.3).a, texture(uDetail, (sn - o0) / 0.55 + 0.3).a, w0);
  float fb2 = mix(texture(uDetail, (sn - o1) / 0.2 + 0.7).a, texture(uDetail, (sn - o0) / 0.2 + 0.7).a, w0);
  float fp = clamp((fb0 * 0.5 + fb1 * 0.32 + fb2 * 0.18 - 0.5) * 2.4 + 0.5, 0.0, 1.0);
  float fa = clamp(foam * 1.1, 0.0, 1.0);
  float fm = smoothstep(1.0 - fa, 1.0 - fa + 0.6, fp) * smoothstep(0.03, 0.5, fa) * 0.72;
  // a thin lace where water meets the bank
  fm = max(fm, smoothstep(0.007, 0.002, h) * 0.2 * smoothstep(0.4, 0.8, fp));
  vec3 foamCol = vec3(0.92, 0.94, 0.95) * (uSunRadiance * 0.03 * (0.35 + 0.65 * max(dot(N, L), 0.0)) + uAmbient * 0.82) * (0.62 + 0.75 * fb2);
  col = mix(col, foamCol, fm * 0.92);

  // fade into the wet bed at the shoreline
  float edge = smoothstep(0.0012, 0.005, h);
  col = mix(under, col, edge);

  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  col = mix(col, uFogColor, fog);
  fragColor = vec4(col, 1.0);
}
`;

const CHUNK_LEN = 2.5;

function waterChunk(rows, colsN, material) {
  const nr = rows.length, nc = colsN.length;
  const pos = new Float32Array(nr * nc * 3), sn = new Float32Array(nr * nc * 2), tan = new Float32Array(nr * nc * 2);
  const w = [0, 0];
  for (let j = 0; j < nr; j++) {
    const s = rows[j], th = heading(s);
    for (let i = 0; i < nc; i++) {
      const k = j * nc + i;
      toWorld(s, colsN[i], w);
      pos[k * 3] = w[0]; pos[k * 3 + 1] = bedLine(s); pos[k * 3 + 2] = w[1];
      sn[k * 2] = colsN[i] + WORLD.W / 2; sn[k * 2 + 1] = s;
      tan[k * 2] = Math.sin(th); tan[k * 2 + 1] = Math.cos(th);
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
  g.setAttribute('aTan', new THREE.BufferAttribute(tan, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.boundingSphere.radius += 0.4;
  return new THREE.Mesh(g, material);
}

export class WaterSurface {
  constructor(sim, detailTex, skyTex, tier) {
    this.uniforms = {
      uSurfA: { value: sim.surfA },
      uSurfB: { value: sim.surfB },
      uRefr: { value: null },
      uSky: { value: skyTex },
      uDetail: { value: detailTex },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uSkyRot: { value: SUN.envRotationY },
      uSkyIntensity: { value: 0.5 },
      uDomain: { value: new THREE.Vector4(WORLD.W, WORLD.L, 1 / WORLD.W, 1 / WORLD.L) },
      uSunDirW: { value: new THREE.Vector3(...SUN.dir) },
      uSunRadiance: { value: new THREE.Vector3(...SUN.color).multiplyScalar(SUN.intensity * 9) },
      uSigma: { value: new THREE.Vector3(...PHYS.waterSigma) },
      uScatter: { value: new THREE.Vector3(...PHYS.waterScatter) },
      uAmbient: { value: new THREE.Vector3(0.42, 0.48, 0.52) },
      uBankColor: { value: new THREE.Vector3(0.12, 0.13, 0.07) },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, uniforms: this.uniforms, glslVersion: THREE.GLSL3,
    });
    // Half the sim resolution is enough for the silhouette; shading reads the field per pixel.
    const dx = sim.dx;
    const cols = [];
    for (let i = 0; i <= Math.round(sim.nx / 2); i++) cols.push(-WORLD.W / 2 + i * 2 * dx + 0.5 * dx);
    const rows = streamRows(dx, 2);
    this.group = new THREE.Group();
    let start = 0;
    for (let s = CHUNK_LEN; start < rows.length - 1; s += CHUNK_LEN) {
      let end = start;
      while (end < rows.length - 1 && rows[end] < s) end++;
      const m = waterChunk(rows.slice(start, end + 1), cols, this.material);
      m.renderOrder = 1;
      this.group.add(m);
      start = end;
    }
    void tier;
  }
  setLayer(layer) { this.group.traverse((o) => o.layers.set(layer)); }
}

// ---- the falling curtains --------------------------------------------------------------
// One sheet per drop. It leaves the lip with the speed the solver reports there and follows a ballistic
// path to the pool; where no water crosses the lip, the sheet has no opacity.
const CURTAIN_VERT = /* glsl */`
uniform sampler2D uSurfA;
uniform sampler2D uSurfB;
uniform vec4 uDomain;
uniform vec2 uLipSN;     // (unused x, s) of the row just above the lip
uniform vec3 uOrigin;
uniform vec3 uT;
uniform vec3 uN;
uniform float uDrop;
uniform float uG;
in vec3 position;        // x = n relative to the centreline, y = 0..1 fall time fraction, z = 0..1 across
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
out vec2 vP;
out float vSheet;
out vec3 vWorld;
out float vRel;
out float vEdge;
void main() {
  float n = position.x, f = position.y;
  vEdge = smoothstep(0.0, 0.14, position.z) * (1.0 - smoothstep(0.86, 1.0, position.z));
  vec2 uv = clamp(vec2(n + uDomain.x * 0.5, uLipSN.y) * uDomain.zw, vec2(0.0), vec2(1.0));
  vec4 B = textureLod(uSurfB, uv, 0.0);
  float eta = textureLod(uSurfA, uv, 0.0).x;
  float v0 = max(B.y, 0.0);
  float h0 = B.z;
  float tf = sqrt(2.0 * (uDrop + h0) / uG);
  float t = f * tf;
  vec3 p = uOrigin + uN * n + uT * (v0 * t + 0.008);
  p.y = eta - 0.5 * uG * t * t;
  vP = vec2(n, t);
  vSheet = v0 * h0;      // discharge per metre of lip
  vWorld = p;
  vRel = f;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const CURTAIN_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uDetail;
uniform sampler2D uRefr;
uniform vec2 uResolution;
uniform float uTime;
uniform vec3 uSunRadiance;
uniform vec3 uAmbient;
in vec2 vP;
in float vSheet;
in vec3 vWorld;
in float vRel;
in float vEdge;
out vec4 fragColor;
void main() {
  float q = smoothstep(0.002, 0.018, vSheet) * vEdge;
  if (q < 0.01) discard;
  // Streaks run down the sheet and stretch as the water accelerates.
  float n1 = texture(uDetail, vec2(vP.x * 4.0, vP.y * 0.55 - uTime * 0.9)).a;
  float n2 = texture(uDetail, vec2(vP.x * 11.0 + 0.3, vP.y * 1.1 - uTime * 1.4)).a;
  float streak = smoothstep(0.3, 0.72, n1 * 0.55 + n2 * 0.55);
  // clear glassy at the lip, broken and aerated toward the pool
  float air = smoothstep(0.05, 0.75, vRel);
  float white = mix(0.04, 0.72, air * air) * mix(0.3, 1.0, streak);
  vec2 suv = gl_FragCoord.xy / uResolution;
  vec3 behind = texture(uRefr, suv + vec2((n1 - 0.5) * 0.03, 0.0)).rgb;
  vec3 lit = vec3(0.9, 0.93, 0.94) * (uSunRadiance * 0.03 + uAmbient * 0.95);
  vec3 col = mix(behind * vec3(0.8, 0.88, 0.86), lit, white);
  // The sheet leaves the lip whole and comes apart into strands on the way down.
  float strand = texture(uDetail, vec2(vP.x * 3.1, 0.37 + vP.y * 0.05 - uTime * 0.04)).a * 0.6 + n2 * 0.4;
  float thr = mix(0.1, 0.5, vRel);
  float cover = smoothstep(thr, thr + 0.14, strand);
  float alpha = q * mix(0.26, 0.74, air) * cover * (1.0 - smoothstep(0.82, 1.0, vRel));
  // the edges of the sheet fray
  fragColor = vec4(col, alpha);
}
`;

export class Curtains {
  constructor(sim, detailTex, waterUniforms) {
    this.group = new THREE.Group();
    this.materials = [];
    const dx = sim.dx;
    for (const st of STEPS) {
      const jLip = Math.floor(st.s / dx + 0.5) - 1;
      const sLip = (jLip + 0.5) * dx;
      const th = heading(st.s);
      const T = new THREE.Vector3(Math.sin(th), 0, Math.cos(th));
      const N = new THREE.Vector3(Math.cos(th), 0, -Math.sin(th));
      const [ox, oz] = toWorld(st.s, 0);
      const n0 = centerOffset(st.s) + st.notch[0] - 0.03, n1 = centerOffset(st.s) + st.notch[1] + 0.03;
      const cols = Math.max(4, Math.round((n1 - n0) / dx)), rows = 10;
      const geo = new THREE.BufferGeometry();
      const pos = [];
      for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) pos.push(n0 + (n1 - n0) * i / cols, Math.pow(j / rows, 0.8), i / cols);
      const idx = [];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      const mat = new THREE.RawShaderMaterial({
        vertexShader: CURTAIN_VERT, fragmentShader: CURTAIN_FRAG, glslVersion: THREE.GLSL3,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: {
          uSurfA: waterUniforms.uSurfA, uSurfB: waterUniforms.uSurfB, uDomain: waterUniforms.uDomain,
          uLipSN: { value: new THREE.Vector2(0, sLip) },
          uOrigin: { value: new THREE.Vector3(ox, 0, oz) }, uT: { value: T }, uN: { value: N },
          uDrop: { value: st.drop }, uG: { value: PHYS.g },
          uDetail: { value: detailTex }, uRefr: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) },
          uTime: { value: 0 }, uSunRadiance: { value: new THREE.Vector3(...SUN.color).multiplyScalar(SUN.intensity * 9) },
          uAmbient: { value: new THREE.Vector3(0.42, 0.48, 0.52) },
        },
      });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      m.renderOrder = 3;
      this.group.add(m);
      this.materials.push(mat);
    }
  }
  setLayer(layer) { this.group.traverse((o) => o.layers.set(layer)); }
  update(time, refrTexture, width, height) {
    for (const m of this.materials) {
      m.uniforms.uTime.value = time;
      m.uniforms.uRefr.value = refrTexture;
      m.uniforms.uResolution.value.set(width, height);
    }
  }
}

// ---- caustics --------------------------------------------------------------------------
// Refract the sun through a grid of surface points onto the bed and splat the area ratio (Jacobian)
// additively in channel space. Only the reach near the camera is rendered.
const CAUSTIC_VERT = /* glsl */`
precision highp float;
precision highp sampler2D;
in vec3 position;   // x = n + W/2, y = s, z = heading
uniform sampler2D uSurfA;
uniform sampler2D uSurfB;
uniform sampler2D uDetail;
uniform vec4 uDomain;
uniform vec3 uSunDirW;
uniform float uTime;
out vec2 vOld;
out vec2 vNew;
out float vWet;
vec2 slopeAt(vec2 p) { return textureLod(uDetail, p, 0.0).rg * 2.0 - 1.0; }
void main() {
  vec2 sn = position.xy;
  float th = position.z;
  vec2 uv = clamp(sn * uDomain.zw, vec2(0.0), vec2(1.0));
  vec4 A = textureLod(uSurfA, uv, 0.0);
  vec4 B = textureLod(uSurfB, uv, 0.0);
  float h = min(B.z, 0.3);
  vec2 vel = B.xy;
  const float PERIOD = 0.9;
  float ph0 = fract(uTime / PERIOD), ph1 = fract(uTime / PERIOD + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
  vec2 o0 = vel * (ph0 - 0.5) * PERIOD, o1 = vel * (ph1 - 0.5) * PERIOD + vec2(0.37, 0.61);
  vec2 sl = mix(slopeAt((sn - o1) / 0.26), slopeAt((sn - o0) / 0.26), w0);
  float turb = smoothstep(0.1, 0.85, length(vel)) + A.w * 0.7;
  vec2 dn = sl * (0.14 + 0.5 * turb) - A.yz;
  // sun in the local frame: x across, z along, y up
  float cs = cos(th), sn2 = sin(th);
  vec3 Ll = vec3(uSunDirW.x * cs - uSunDirW.z * sn2, uSunDirW.y, uSunDirW.x * sn2 + uSunDirW.z * cs);
  vec3 N = normalize(vec3(dn.x, 1.0, dn.y));
  vec3 Lr = refract(-Ll, N, 1.0 / 1.333);
  vec2 hit = sn + Lr.xz * (h / max(-Lr.y, 0.1));
  vOld = sn;
  vNew = hit;
  vWet = step(0.003, h);
  gl_Position = vec4((hit * uDomain.zw) * 2.0 - 1.0, 0.0, 1.0);
}
`;
const CAUSTIC_FRAG = /* glsl */`
precision highp float;
in vec2 vOld;
in vec2 vNew;
in float vWet;
out vec4 outColor;
void main() {
  float a0 = abs(dFdx(vOld).x * dFdy(vOld).y - dFdx(vOld).y * dFdy(vOld).x);
  float a1 = abs(dFdx(vNew).x * dFdy(vNew).y - dFdx(vNew).y * dFdy(vNew).x);
  float I = mix(1.0, a0 / max(a1, 1e-12), vWet);
  outColor = vec4(min(I, 3.9) * 0.25, 0.0, 0.0, 1.0);
}
`;

export class Caustics {
  constructor(renderer, sim, detailTex) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(sim.nx, sim.nz, {
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false,
    });
    const cols = Math.round(sim.nx / 2) + 1;
    this.rowStep = sim.dx * 2;
    this.rows = Math.ceil(WORLD.L / this.rowStep);
    const pos = new Float32Array(cols * (this.rows + 1) * 3);
    for (let j = 0; j <= this.rows; j++) {
      const s = j * this.rowStep, th = heading(s);
      for (let i = 0; i < cols; i++) {
        const k = (j * cols + i) * 3;
        pos[k] = i * WORLD.W / (cols - 1); pos[k + 1] = s; pos[k + 2] = th;
      }
    }
    const idx = new Uint32Array((cols - 1) * this.rows * 6);
    let q = 0;
    for (let j = 0; j < this.rows; j++) for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    this.quadsPerRow = (cols - 1) * 6;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo = geo;
    this.material = new THREE.RawShaderMaterial({
      vertexShader: CAUSTIC_VERT, fragmentShader: CAUSTIC_FRAG, glslVersion: THREE.GLSL3,
      uniforms: {
        uSurfA: { value: sim.surfA }, uSurfB: { value: sim.surfB }, uDetail: { value: detailTex },
        uDomain: { value: new THREE.Vector4(WORLD.W, WORLD.L, 1 / WORLD.W, 1 / WORLD.L) },
        uSunDirW: { value: new THREE.Vector3(...SUN.dir) }, uTime: { value: 0 },
      },
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  get texture() { return this.target.texture; }
  // Renders [sFrom, sTo]; returns that window so materials can fade the map out beyond it.
  render(time, sFrom, sTo, win) {
    const j0 = Math.max(0, Math.floor(sFrom / this.rowStep));
    const j1 = Math.min(this.rows, Math.ceil(sTo / this.rowStep));
    this.geo.setDrawRange(j0 * this.quadsPerRow, (j1 - j0) * this.quadsPerRow);
    this.material.uniforms.uTime.value = time;
    win.set(j0 * this.rowStep, j1 * this.rowStep);
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.scene, this.camera);
  }
}

export { halfWidth };
