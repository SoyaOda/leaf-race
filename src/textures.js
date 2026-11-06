// Procedural textures and asset loading.
import * as THREE from 'three';
import { FullscreenPass } from './sim.js?v=a087d61d0b56';

// Tileable ripple detail: RG = ripple slope (encoded), B = foam cells, A = sparkle noise.
const DETAIL_FRAG = /* glsl */`
precision highp float;
uniform vec2 uRes;
out vec4 outColor;
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
}
// periodic gradient noise
float pnoise(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash2(mod(i, per)), f);
  float b = dot(hash2(mod(i + vec2(1, 0), per)), f - vec2(1, 0));
  float c = dot(hash2(mod(i + vec2(0, 1), per)), f - vec2(0, 1));
  float d = dot(hash2(mod(i + vec2(1, 1), per)), f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float ripples(vec2 uv) {
  float h = 0.0, a = 0.5, per = 6.0;
  for (int o = 0; o < 5; o++) {
    // ridged octaves look like capillary ripples on running water
    float n = pnoise(uv * per, per);
    h += a * (0.6 * n + 0.4 * (0.5 - abs(n)));
    per *= 2.0; a *= 0.52;
  }
  return h;
}
float cells(vec2 uv, float per) {
  vec2 p = uv * per; vec2 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(x, y);
    vec2 o = 0.5 + 0.45 * hash2(mod(i + g, per));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return d2 - d1;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float e = 1.0 / uRes.x;
  float hx = ripples(uv + vec2(e, 0)) - ripples(uv - vec2(e, 0));
  float hy = ripples(uv + vec2(0, e)) - ripples(uv - vec2(0, e));
  vec2 slope = vec2(hx, hy) / (2.0 * e) * 0.0045;
  float foam = smoothstep(0.02, 0.26, cells(uv, 14.0)) * 0.65 + 0.35 * smoothstep(0.05, 0.3, cells(uv + 0.31, 31.0));
  foam = 1.0 - foam;  // bubbles bright at the cell rims
  foam = clamp(foam + 0.25 * pnoise(uv * 8.0, 8.0), 0.0, 1.0);
  float sparkle = pnoise(uv * 64.0, 64.0) * 0.5 + 0.5;
  outColor = vec4(clamp(slope * 0.5 + 0.5, 0.0, 1.0), foam, sparkle);
}
`;

export function makeDetailTexture(renderer, size = 512, into = null) {
  const rt = into ? into.userData.rt : new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    generateMipmaps: true, depthBuffer: false,
  });
  rt.texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  rt.texture.userData.rt = rt;
  const pass = new FullscreenPass(new THREE.RawShaderMaterial({
    vertexShader: 'in vec3 position; void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: DETAIL_FRAG, glslVersion: THREE.GLSL3,
    uniforms: { uRes: { value: new THREE.Vector2(size, size) } }, depthTest: false, depthWrite: false,
  }));
  pass.render(renderer, rt);
  renderer.setRenderTarget(null);
  pass.material.dispose();
  return rt.texture;
}

export async function loadAssets(renderer, base, onProgress) {
  const tl = new THREE.TextureLoader();
  const names = ['bed', 'rock', 'grass', 'mud', 'wall'];
  const jobs = [];
  const tex = {};
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  let done = 0;
  const total = names.length * 2 + 1;
  const tick = () => { done++; onProgress?.(done / total); };
  for (const n of names) {
    tex[n] = {};
    for (const kind of ['albedo', 'data']) {
      jobs.push(tl.loadAsync(`${base}assets/tex/${n}_${kind}.webp`).then((t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = kind === 'albedo' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = maxAniso;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        tex[n][kind] = t;
        tick();
      }));
    }
  }
  jobs.push(loadRGBE(`${base}assets/sky_rgb.png`, `${base}assets/sky_exp.png`).then((t) => { tex.sky = t; tick(); }));
  await Promise.all(jobs);
  return tex;
}

// The sky HDRI ships as two PNGs (RGBE mantissa + exponent) because static hosts rarely serve .hdr.
async function pixels(url) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, cv.width, cv.height);
}
async function loadRGBE(rgbUrl, expUrl) {
  const [rgb, ex] = await Promise.all([pixels(rgbUrl), pixels(expUrl)]);
  const w = rgb.width, h = rgb.height;
  const out = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    // Radiance files are stored top-down; flip so v = 1 is the zenith like three's RGBELoader
    const src = y * w, dst = (h - 1 - y) * w;
    for (let x = 0; x < w; x++) {
      const k = (src + x) * 4, e = ex.data[k];
      const f = e ? Math.pow(2, e - 136) : 0;
      const o = (dst + x) * 4;
      out[o] = THREE.DataUtils.toHalfFloat(rgb.data[k] * f);
      out[o + 1] = THREE.DataUtils.toHalfFloat(rgb.data[k + 1] * f);
      out[o + 2] = THREE.DataUtils.toHalfFloat(rgb.data[k + 2] * f);
      out[o + 3] = 15360; // 1.0
    }
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// ---- leaf textures (canvas) ------------------------------------------------------------
function rng(seed) { let s = seed >>> 0; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296); }

// Leaf albedo drawn on a canvas in the leaf's planar UV space (u = x, v = z, both mapped from [-1,1]).
export function makeLeafCanvas(type, outline, seed = 7, size = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const r = rng(seed);
  const toPx = (x, z) => [(x * 0.5 + 0.5) * size, (1 - (z * 0.5 + 0.5)) * size];
  const [c0, c1, c2] = type.colors;
  g.fillStyle = c2; g.fillRect(0, 0, size, size);
  // base gradient from the stem outward
  const [sx, sy] = toPx(0, type.key === 'ichou' ? -0.55 : 0);
  const grad = g.createRadialGradient(sx, sy, size * 0.02, sx, sy, size * 0.62);
  grad.addColorStop(0, c2); grad.addColorStop(0.35, c0); grad.addColorStop(1, c1);
  g.beginPath();
  outline.forEach(([x, z], i) => { const [px, py] = toPx(x, z); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
  g.closePath();
  g.fillStyle = grad; g.fill();
  g.save(); g.clip();
  // blotches: autumn leaves are never one colour
  for (let i = 0; i < 26; i++) {
    const [px, py] = toPx(r() * 2 - 1, r() * 2 - 1);
    const rad = size * (0.03 + r() * 0.12);
    const bg = g.createRadialGradient(px, py, 0, px, py, rad);
    const col = r() < 0.2 ? 'rgba(70,40,20,0.35)' : (r() < 0.5 ? hexA(c1, 0.35) : hexA(c2, 0.3));
    bg.addColorStop(0, col); bg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bg; g.fillRect(px - rad, py - rad, rad * 2, rad * 2);
  }
  // veins
  g.lineCap = 'round';
  const vein = (pts, w, a) => {
    g.strokeStyle = `rgba(255,236,190,${a})`; g.lineWidth = w;
    g.beginPath(); pts.forEach(([x, z], i) => { const [px, py] = toPx(x, z); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.stroke();
    g.strokeStyle = `rgba(60,25,10,${a * 0.35})`; g.lineWidth = w * 0.45;
    g.beginPath(); pts.forEach(([x, z], i) => { const [px, py] = toPx(x, z); if (i) g.lineTo(px + w * 0.4, py + w * 0.4); else g.moveTo(px + w * 0.4, py + w * 0.4); }); g.stroke();
  };
  for (const v of type.veins) {
    vein(v, size * 0.012, 0.55);
    // side veins
    for (let t = 0.2; t < 0.9; t += 0.16) {
      const i = Math.floor(t * (v.length - 1));
      const [x0, z0] = v[i], [x1, z1] = v[Math.min(v.length - 1, i + 1)];
      const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1;
      for (const side of [-1, 1]) {
        const ex = x0 + (dx / l) * 0.18 + side * (-dz / l) * 0.2, ez = z0 + (dz / l) * 0.18 + side * (dx / l) * 0.2;
        vein([[x0, z0], [ex, ez]], size * 0.005, 0.32);
      }
    }
  }
  // dry, darker margin
  g.globalCompositeOperation = 'source-atop';
  g.lineWidth = size * 0.035; g.strokeStyle = 'rgba(60,30,15,0.28)';
  g.beginPath(); outline.forEach(([x, z], i) => { const [px, py] = toPx(x, z); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.closePath(); g.stroke();
  g.restore();
  return cv;
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// Soft plume texture for susuki (Japanese pampas grass).
export function makePlumeTexture() {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 256;
  const g = cv.getContext('2d');
  const r = rng(11);
  g.clearRect(0, 0, 64, 256);
  for (let i = 0; i < 900; i++) {
    const t = r();
    const y = 256 - t * 250;
    const spread = 4 + 22 * Math.sin(Math.min(1, t * 1.15) * Math.PI) * (0.6 + 0.4 * r());
    const x = 32 + (r() * 2 - 1) * spread;
    const a = 0.05 + 0.12 * r();
    g.strokeStyle = `rgba(255,248,232,${a})`;
    g.lineWidth = 0.8 + r();
    g.beginPath(); g.moveTo(32, y + 6); g.quadraticCurveTo(32 + (x - 32) * 0.5, y + 2, x, y - 4 - r() * 6); g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Hand-lettered paper flag for the finish line.
export function makeFlagTexture() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 160;
  const g = cv.getContext('2d');
  g.fillStyle = '#f7f1e3'; g.fillRect(0, 0, 256, 160);
  g.strokeStyle = 'rgba(80,90,140,0.25)'; g.lineWidth = 2;
  for (let y = 30; y < 160; y += 28) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
  g.fillStyle = '#d23a2a';
  g.font = '700 74px "Klee One", "Hiragino Mincho ProN", serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('ゴール', 128, 86);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
