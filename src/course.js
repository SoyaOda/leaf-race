// The stream: a centreline authored by its curvature, a bed with real drops, and the rocks.
// Everything is defined in channel coordinates (s along, n across). One analytic height function
// feeds the rendered terrain and the simulated bed, so what you see and what the water flows over agree.
import { WORLD, PHYS } from './config.js?v=e79679972dca';

const gauss = (x) => Math.exp(-x * x);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const DEG = Math.PI / 180;

function hash2(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uz;
}
export function fbm(x, z, oct = 4) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * (vnoise(x * f, z * f) * 2 - 1); f *= 2.03; a *= 0.5; }
  return s;
}

// ---- the course, in order --------------------------------------------------------------
// Bends: [centre s, total turn in degrees, length scale]. Positive turns toward +n (the lane side).
const BENDS = [
  [3.5, 62, 1.25], [6.0, -58, 1.15],
  [9.6, 16, 1.2],
  [12.5, -96, 1.2], [15.3, 66, 1.25], [17.3, -30, 0.9],
  [20.6, 58, 1.2], [22.9, -62, 1.05], [24.8, 24, 0.8],
];

// Reach slope between knots: [from s, bed slope]. The steep ones are the fast water.
const SLOPES = [[-8, 0.012], [2.6, 0.016], [6.2, 0.02], [8.3, 0.07], [10.9, 0.012], [14.4, 0.027], [18.6, 0.017], [22.3, 0.055], [25.0, 0.012]];

// Drops in the bed. notch: where the water goes over, in n relative to the local channel centre.
// pool: how far the bed is dug below (negative = a rock shelf just under the surface).
// roller: length of the recirculating cell below the curtain.
export const STEPS = [
  { name: '小さなたき', s: 10.9, drop: 0.13, notch: [-0.16, 0.16], pool: 0.09, roller: 0.3 },
  { name: 'ふただんめ', s: 14.5, drop: 0.07, notch: [-0.2, 0.09], pool: 0.03, roller: 0.15 },
  { name: 'ふただんめ', s: 15.15, drop: 0.07, notch: [-0.08, 0.2], pool: 0.03, roller: 0.15 },
  { name: 'おおだき', s: 18.6, drop: 0.29, notch: [-0.14, 0.11], pool: 0.13, roller: 0.5 },
  { name: 'いわだな', s: 22.3, drop: 0.17, notch: [-0.13, 0.13], pool: -0.04, roller: 0.2 },
];

// Named stretches, for the map and for what the HUD says when a leaf gets there.
export const SPOTS = [
  { name: 'はじまりのカーブ', s: 3.0, kind: 'bend' },
  { name: '石のせき', s: 7.2, kind: 'trap' },
  { name: 'はやせ', s: 9.0, kind: 'fast' },
  { name: '小さなたき', s: 10.9, kind: 'fall' },
  { name: 'よどみ', s: 12.6, kind: 'eddy' },
  { name: 'ふただんの段', s: 14.5, kind: 'fall' },
  { name: 'おおだき', s: 18.6, kind: 'fall' },
  { name: 'いわだな', s: 22.3, kind: 'fall' },
  { name: 'さいごのはやせ', s: 23.2, kind: 'fast' },
];

export function halfWidth(s) {
  return 0.24
    + 0.025 * Math.sin(s * 0.9 + 1.0)
    + 0.08 * gauss((s - 1.9) / 1.0)      // the start pool under the plank bridge
    + 0.03 * gauss((s - 7.2) / 0.8)      // the stone weir sits in a slightly wider reach
    - 0.11 * gauss((s - 9.3) / 1.1)      // fast chute
    + 0.08 * gauss((s - 11.2) / 0.4)
    + 0.12 * gauss((s - 12.7) / 0.7)     // the back-eddy pocket on the outer bend
    - 0.06 * gauss((s - 17.5) / 0.7)
    - 0.03 * gauss((s - 18.5) / 0.25)
    + 0.15 * gauss((s - 19.0) / 0.42)    // the big plunge pool
    + 0.05 * gauss((s - 22.5) / 0.3)
    - 0.1 * gauss((s - 23.4) / 0.8);     // last fast run
}

// Channel centre offset from the centreline; the pocket pushes out toward the outer bank.
export function centerOffset(s) {
  return -0.07 * gauss((s - 12.7) / 0.7) + 0.03 * Math.sin(s * 0.7);
}

function channelDepth(s) {
  return 0.085
    + 0.025 * gauss((s - 1.9) / 1.0)
    - 0.02 * gauss((s - 9.3) / 1.1)
    + 0.05 * gauss((s - 12.7) / 0.7)
    - 0.02 * gauss((s - 23.4) / 0.8);
}

// ---- lookup tables along the course -----------------------------------------------------
const DS = 0.02;
const S_MIN = -8, S_MAX = WORLD.L + 8;
const TN = Math.round((S_MAX - S_MIN) / DS) + 1;
const TH = new Float64Array(TN), TX = new Float64Array(TN), TZ = new Float64Array(TN), TK = new Float64Array(TN), TB = new Float64Array(TN);
const idxS = (s) => (s - S_MIN) / DS;

function kappaRaw(s) {
  let k = 0;
  for (const [c, deg, len] of BENDS) k += deg * DEG / (len * Math.sqrt(Math.PI)) * gauss((s - c) / len);
  return k;
}
function slopeAt(s) {
  let v = SLOPES[0][1];
  for (const [from, sl] of SLOPES) if (s >= from) v = sl;
  return v;
}

// Integrate curvature to heading and position, slope to the continuous part of the bed line.
{
  const i0 = Math.round(idxS(0));
  const fill = (from, to, dir) => {
    for (let i = from; i !== to; i += dir) {
      const s = S_MIN + i * DS, k = kappaRaw(s);
      TK[i] = k;
      const j = i + dir;
      const sNext = S_MIN + j * DS;
      const th = TH[i] + dir * DS * 0.5 * (k + kappaRaw(sNext));
      TH[j] = th;
      const am = 0.5 * (TH[i] + th);
      TX[j] = TX[i] + dir * DS * Math.sin(am);
      TZ[j] = TZ[i] + dir * DS * Math.cos(am);
      TB[j] = TB[i] - dir * DS * slopeAt(0.5 * (s + sNext));
    }
  };
  fill(i0, TN - 1, 1);
  fill(i0, 0, -1);
  TK[TN - 1] = kappaRaw(S_MAX);
  TK[0] = kappaRaw(S_MIN);
}

function lerpTable(t, s) {
  const f = clamp(idxS(s), 0, TN - 1.0001), i = Math.floor(f), w = f - i;
  return t[i] + (t[i + 1] - t[i]) * w;
}

export function kappa(s) { return lerpTable(TK, s); }
export function heading(s) { return lerpTable(TH, s); }

// Elevation is set so the end of the course sits just above y = 0: half-float textures keep the most
// precision near zero, and the whole stream stays within about a metre of it.
const DROP_TOTAL_AT = (s) => {
  let d = 0;
  for (const st of STEPS) if (s >= st.s) d += st.drop;
  return d;
};
const Y_OFFSET = 0.05 - (lerpTable(TB, WORLD.L) - DROP_TOTAL_AT(WORLD.L));
export function bedLine(s) { return lerpTable(TB, s) - DROP_TOTAL_AT(s) + Y_OFFSET; }
function footAt(s) { return bedLine(s) + channelDepth(s); }

// World position of a channel point. out = [x, z]
export function toWorld(s, n, out = [0, 0]) {
  const th = heading(s), x = lerpTable(TX, s), z = lerpTable(TZ, s);
  out[0] = x + n * Math.cos(th);
  out[1] = z - n * Math.sin(th);
  return out;
}

// Nearest channel coordinates of a world point.
export function nearest(x, z, stride = 8) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < TN; i += stride) {
    const dx = x - TX[i], dz = z - TZ[i], d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  const a = Math.max(0, best - stride), b = Math.min(TN - 1, best + stride);
  for (let i = a; i <= b; i++) {
    const dx = x - TX[i], dz = z - TZ[i], d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = i; }
  }
  const th = TH[best];
  return { s: S_MIN + best * DS, n: (x - TX[best]) * Math.cos(th) - (z - TZ[best]) * Math.sin(th) };
}

// The lane runs beside the stream on a smooth grade of its own, so the banks grow below each drop.
const TP = new Float64Array(TN);
{
  const sigma = 1.4, r = Math.round(sigma * 2.5 / DS);
  const foot = new Float64Array(TN);
  for (let i = 0; i < TN; i++) foot[i] = footAt(S_MIN + i * DS);
  const raw = new Float64Array(TN);
  for (let i = 0; i < TN; i++) {
    let acc = 0, w = 0;
    for (let k = -r; k <= r; k += 4) {
      const j = clamp(i + k, 0, TN - 1), g = gauss(k * DS / sigma);
      acc += foot[j] * g; w += g;
    }
    raw[i] = Math.max(acc / w + 0.17, foot[i] + 0.13);
  }
  // soften the corners the max() leaves
  const r2 = Math.round(0.5 / DS);
  for (let i = 0; i < TN; i++) {
    let acc = 0, w = 0;
    for (let k = -r2; k <= r2; k += 2) { acc += raw[clamp(i + k, 0, TN - 1)]; w++; }
    TP[i] = acc / w;
  }
}
export function laneHeight(s) { return lerpTable(TP, s); }
export const LANE = { n0: 0.72, n1: 1.48 };   // the lane runs in this band of n

// Where the folded inner side of a bend would start. Terrain columns stop short of it.
const TLIM_POS = new Float64Array(TN), TLIM_NEG = new Float64Array(TN);
{
  const max = WORLD.STRIP_N;
  for (let i = 0; i < TN; i++) {
    TLIM_POS[i] = TK[i] > 0 ? Math.min(max, 0.86 / TK[i]) : max;
    TLIM_NEG[i] = TK[i] < 0 ? Math.min(max, 0.86 / -TK[i]) : max;
  }
  for (const t of [TLIM_POS, TLIM_NEG]) {
    const c = Float64Array.from(t), r = Math.round(0.6 / DS);
    for (let i = 0; i < TN; i++) {
      let m = Infinity;
      for (let k = -r; k <= r; k += 3) m = Math.min(m, c[clamp(i + k, 0, TN - 1)]);
      t[i] = m;
    }
  }
}
export function stripLimit(s, side) { return lerpTable(side > 0 ? TLIM_POS : TLIM_NEG, s); }

// Rough resting water surface: only used to place rocks and to start the solver near its steady state.
export function restEta(s) { return footAt(s) - 0.03; }

// ---- ground height ----------------------------------------------------------------------
function stepShape(s, n, y) {
  const nc = centerOffset(s);
  for (const st of STEPS) {
    const a = s - st.s;
    if (a < -0.5 || a > 0.9) continue;
    const footUp = bedLine(st.s - 0.001) + channelDepth(st.s);
    const hw = halfWidth(s);
    const inChannel = 1 - Math.min(1, Math.abs((n - nc) / hw) ** 2);
    if (a < 0) {
      // The bed rises to the crest, leaving a thin sheet of water over the lip.
      const crest = footUp - 0.08;
      y = Math.max(y, y + (crest - y) * smooth(-0.42, -0.04, a) * inChannel);
      // Outside the notch the ledge stands proud of the water.
      if (a > -0.13) {
        const m = n - nc;
        const out = Math.max(st.notch[0] - m, m - st.notch[1]);
        const t = smooth(0, 0.035, out) * smooth(-0.13, -0.07, a);
        y = Math.max(y, y + (footUp + 0.075 - y) * t);
      }
    } else {
      y -= st.pool * gauss((a - 0.24 - st.roller * 0.2) / (0.2 + st.roller * 0.3)) * inChannel;
    }
  }
  return y;
}

// Bed or ground elevation without the rocks.
export function groundHeight(s, n) {
  const hw = halfWidth(s), nc = centerOffset(s), dep = channelDepth(s), foot = bedLine(s) + dep;
  const k = kappa(s);
  const d = (n - nc) / hw, ad = Math.abs(d);
  if (ad < 1) {
    // deeper toward the outside of a bend, a gravel bar on the inside
    const bend = clamp(-k * 1.1, -1, 1);
    let depth = dep * (1 - Math.pow(ad, 2.6)) * (1 + 0.32 * bend * d);
    depth -= Math.abs(bend) * 0.03 * smooth(0.25, 0.8, -d * Math.sign(bend || 1)) * smooth(0.0, 0.3, ad);
    const y = foot - Math.max(depth, -0.012) + 0.008 * fbm(s * 3.1, n * 7.1, 3) * (0.5 + 0.5 * ad);
    return stepShape(s, n, y);
  }
  const lane = laneHeight(s);
  const edge = ad - 1;
  const t = edge * hw;
  const lump = 0.018 * fbm(s * 2.3, n * 5.1, 3);
  if (d > 0) {
    // lane side: a short earth bank, then the lane, then the ground falls away to the fields
    const top = lane + 0.02 * smooth(LANE.n1, LANE.n1 + 0.3, n);
    const y = foot + (top - foot) * smooth(0, 0.16, t) + lump * smooth(0, 0.12, t);
    const away = Math.max(0, n - LANE.n1 - 0.3);
    return stepShape(s, n, y) - away * 0.11 + 0.06 * fbm(s * 0.5, n * 0.5, 3) * smooth(0, 1.5, away);
  }
  // hill side: steeper bank up to a slope that keeps rising
  const top = lane + 0.05;
  const y = foot + (top - foot) * smooth(0, 0.13, t) + lump * smooth(0, 0.1, t);
  const up = Math.max(0, t - 0.13);
  return stepShape(s, n, y) + up * 0.3 + up * up * 0.012 + 0.09 * fbm(s * 0.6, n * 0.6, 4) * smooth(0, 1.2, up);
}

// ---- rocks ------------------------------------------------------------------------------
// [s, across (-1..1 of the half width), radius along, radius across, top above the resting water, seed]
const ROCK_DEFS = [
  // first bends: stones that make the outer line tempting
  [4.1, 0.34, 0.09, 0.08, 0.07, 1], [5.2, -0.42, 0.1, 0.085, 0.08, 2],
  // the stone weir: three stones across, gaps of about 9 and 15 cm between them. All the water goes
  // through the gaps, so a broad leaf arriving flat gets pressed across one.
  [7.2, -0.72, 0.1, 0.095, 0.14, 3], [7.25, -0.1, 0.1, 0.095, 0.145, 4], [7.18, 0.58, 0.1, 0.1, 0.14, 5],
  // a second row, staggered, to catch what slips through
  [7.82, -0.36, 0.085, 0.08, 0.1, 6], [7.9, 0.26, 0.09, 0.075, 0.09, 7],
  // chute: a single stone that splits the fast water
  [9.75, 0.15, 0.065, 0.055, 0.06, 8],
  // flanking the first fall
  [10.72, -0.92, 0.14, 0.09, 0.11, 9], [10.72, 0.92, 0.14, 0.09, 0.12, 10],
  // in the pool and on the pocket's lip
  [12.05, -0.66, 0.1, 0.085, 0.09, 11], [13.3, 0.32, 0.09, 0.08, 0.08, 12],
  // between the two small steps
  [14.85, 0.36, 0.075, 0.065, 0.06, 13], [15.55, -0.3, 0.08, 0.07, 0.08, 14],
  // the neck above the big fall: a stone in the middle, gap on either side
  [16.75, 0.0, 0.1, 0.085, 0.1, 15], [17.45, -0.55, 0.08, 0.07, 0.09, 16], [17.75, 0.5, 0.085, 0.07, 0.09, 17],
  // shoulders of the big fall
  [18.4, -0.86, 0.17, 0.09, 0.16, 18], [18.4, 0.86, 0.17, 0.09, 0.17, 19],
  // below it, stones that hold the pool in
  [19.55, -0.72, 0.1, 0.1, 0.1, 20], [19.65, 0.62, 0.09, 0.085, 0.09, 21],
  // last bends
  [20.9, -0.2, 0.085, 0.075, 0.08, 22], [21.5, 0.38, 0.08, 0.07, 0.07, 23],
  [22.1, -0.88, 0.13, 0.08, 0.12, 24], [22.1, 0.88, 0.13, 0.08, 0.12, 25],
  [23.45, 0.12, 0.06, 0.05, 0.05, 26], [24.4, -0.4, 0.08, 0.07, 0.06, 27],
];

export const ROCKS = ROCK_DEFS.map(([s, across, rs, rn, top, seed]) => {
  const n = centerOffset(s) + across * halfWidth(s);
  const g = groundHeight(s, n);
  const t = restEta(s) + top;
  const ry = Math.max(0.05, t - g + 0.07);       // the stone sinks 7 cm into the bed
  return { s, n, rs, rn, top: t, ry, cy: t - ry, yaw: seed * 2.1, seed, base: g };
});

function rockHeightAt(s, n) {
  let best = -Infinity;
  for (const r of ROCKS) {
    const ds = s - r.s;
    if (Math.abs(ds) > 0.3) continue;
    const dn = n - r.n;
    const c = Math.cos(r.yaw), sn = Math.sin(r.yaw);
    const ln = dn * c - ds * sn, ls = dn * sn + ds * c;
    const q = (ls / r.rs) ** 2 + (ln / r.rn) ** 2;
    if (q < 1) best = Math.max(best, r.cy + r.ry * Math.sqrt(1 - q));
  }
  return best;
}

// ---- what the solver reads ---------------------------------------------------------------
// Bed texture: R = bed elevation, G = Manning n, B = foam seed, A = impact speed of falling water.
export function buildBed(nx, nz) {
  const dx = WORLD.W / nx;
  const bed = new Float32Array(nx * nz * 4);
  for (let j = 0; j < nz; j++) {
    const s = (j + 0.5) * dx;
    const hw = halfWidth(s), nc = centerOffset(s);
    for (let i = 0; i < nx; i++) {
      const n = (i + 0.5) * dx - WORLD.W / 2;
      const g = groundHeight(s, n);
      const r = rockHeightAt(s, n);
      const k = (j * nx + i) * 4;
      bed[k] = Math.max(g, r);
      bed[k + 1] = Math.abs(n - nc) < hw ? PHYS.manningBed : PHYS.manningBank;
    }
  }
  // Foam seeds in the water just around stones that break the surface (not along the banks).
  const reach = Math.max(1, Math.round(0.03 / dx));
  for (const r of ROCKS) {
    const j0 = Math.max(0, Math.floor((r.s - r.rs - 0.04) / dx)), j1 = Math.min(nz - 1, Math.ceil((r.s + r.rs + 0.04) / dx));
    const i0 = Math.max(0, Math.floor((r.n + WORLD.W / 2 - r.rn - 0.04) / dx)), i1 = Math.min(nx - 1, Math.ceil((r.n + WORLD.W / 2 + r.rn + 0.04) / dx));
    const rest = restEta(r.s);
    if (r.top < rest - 0.006) continue;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = (j * nx + i) * 4;
      if (bed[k] > rest) continue;
      let seed = 0;
      for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) {
        const jj = Math.min(nz - 1, Math.max(0, j + dj)), ii = Math.min(nx - 1, Math.max(0, i + di));
        const sn = (jj + 0.5) * dx, nn = (ii + 0.5) * dx - WORLD.W / 2;
        if (rockHeightAt(sn, nn) > rest - 0.006) seed = Math.max(seed, 1 - Math.hypot(di, dj) / (reach + 1));
      }
      bed[k + 2] = Math.max(bed[k + 2], seed);
    }
  }
  // Falling water: the first row below each lip takes the momentum of the curtain.
  for (const st of STEPS) {
    const jLip = Math.floor(st.s / dx + 0.5);          // first row whose centre is past the lip
    const nc = centerOffset(st.s);
    const n0 = nc + st.notch[0], n1 = nc + st.notch[1];
    const impact = Math.sqrt(2 * PHYS.g * st.drop);
    for (let i = 0; i < nx; i++) {
      const n = (i + 0.5) * dx - WORLD.W / 2;
      if (n < n0 - dx || n > n1 + dx) continue;
      bed[(jLip * nx + i) * 4 + 3] = impact;
      // White water where the curtain lands, thinning out over the roller.
      const rowsFoam = Math.ceil((0.14 + st.roller * 0.8) / dx);
      const edgeFade = Math.min(1, Math.min(n - n0, n1 - n) / 0.05 + 1);
      for (let dj = 0; dj < rowsFoam; dj++) {
        const a = dj * dx, land = 0.05 + st.drop * 0.3, spread = 0.05 + st.roller * 0.3;
        const k = ((jLip + dj) * nx + i) * 4 + 2;
        bed[k] = Math.max(bed[k], Math.exp(-(((a - land) / spread) ** 2)) * edgeFade);
      }
    }
    st.nCenter = nc + 0.5 * (st.notch[0] + st.notch[1]);
    st.n0 = n0; st.n1 = n1;
    st.fallTime = Math.sqrt(2 * st.drop / PHYS.g);
    st.impact = impact;
  }
  return bed;
}

export function buildKappa(nz, dx) {
  const a = new Float32Array(nz * 4);
  for (let j = 0; j < nz; j++) a[j * 4] = kappa((j + 0.5) * dx);
  return a;
}

export const INFLOW = { nc: centerOffset(0), hw: halfWidth(0) };

export function progressOf(s) {
  return clamp((s - WORLD.DROP_S) / (WORLD.FINISH_S - WORLD.DROP_S), 0, 1);
}
