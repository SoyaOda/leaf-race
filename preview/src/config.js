// Global constants. Units: meters, seconds.
// The stream is solved in channel coordinates: s runs down the centreline, n runs across it.
// World axes: x and z are horizontal, y is up.

export const WORLD = {
  W: 1.0,            // solved width across the channel (n in [-W/2, W/2])
  L: 27.0,           // solved length along the channel (s in [0, L])
  DROP_S: 1.9,       // where leaves are released
  FINISH_S: 25.7,    // the string between the two bamboo poles
  CULVERT_S: 26.6,   // stone headwall where the stream goes under the lane
  STRIP_N: 2.5,      // half width of the detailed terrain strip that follows the stream
};

export const PHYS = {
  g: 9.81,
  manningBed: 0.032,
  manningBank: 0.08,
  hDry: 0.0015,      // below this depth a cell counts as dry
  cflMax: 0.35,      // per-face velocity cap in cells per substep
  designSpeed: 1.5,  // fastest water the substep length is sized for (m/s)
  inflowPeak: 0.041, // discharge per metre of width at the centre of the inflow (m2/s)
  inflowGust: 0.12,
  waterSigma: [2.6, 1.0, 0.85],     // absorption per metre (r, g, b): clear, slightly olive
  waterScatter: [0.020, 0.040, 0.034],
};

// How falling water treats a leaf. See Leaf.stepWater for how each number is used.
export const FALL = {
  rollerSpeed: 2.2,    // surface back-flow speed = rollerSpeed * sqrt(q * impact speed)
  pressure: 150,       // downward push under the curtain = pressure * q * impact speed
  sinkDrag: 14,        // vertical drag on a submerged leaf (1/s)
  flicker: 0.55,       // how much the curtain's push varies from moment to moment
  bedGrip: 0.9,        // friction of a leaf pressed to the bed, per unit of push
};

const cells = (nx) => ({ nx, nz: Math.ceil(WORLD.L / (WORLD.W / nx)) });

// Grid resolution sets the substep length through the CFL limit, so maxSub must cover a 30 fps frame.
export const TIERS = {
  high: { ...cells(80), maxSub: 12, scale: 0.85, minScale: 0.55, shadow: 2048, msaa: 4, caustics: true, bloom: true, grass: 16000, terrainStep: 0.025, rockDetail: 4 },
  mid:  { ...cells(64), maxSub: 10, scale: 0.72, minScale: 0.5,  shadow: 1024, msaa: 0, caustics: true, bloom: true, grass: 9000,  terrainStep: 0.032, rockDetail: 3 },
  low:  { ...cells(48), maxSub: 8,  scale: 0.62, minScale: 0.45, shadow: 1024, msaa: 0, caustics: false, bloom: false, grass: 4500, terrainStep: 0.05, rockDetail: 3 },
};

// Low afternoon sun ahead of the camera, high enough to reach the water between the banks.
const SUN_ELEV = 29 * Math.PI / 180;
const SUN_AZIM = 62 * Math.PI / 180; // atan2(z, x)
export const SUN = {
  dir: [Math.cos(SUN_ELEV) * Math.cos(SUN_AZIM), Math.sin(SUN_ELEV), Math.cos(SUN_ELEV) * Math.sin(SUN_AZIM)],
  color: [1.0, 0.74, 0.5],
  intensity: 3.3,
  envRotationY: (40.6 - 62) * Math.PI / 180, // the HDRI sun sits at azimuth 40.6 degrees
};

export const RACE = {
  timeLimit: 170,
  pebbles: 5,
  pebbleRecharge: 8,
  stuckSpeed: 0.05,     // m/s of progress below which a leaf counts as held
  holdReport: 2.5,      // seconds held before it is told to the player and kept for the diary
};

// A pebble is the player's only hand on the race: it never touches a floating leaf to move it, it moves
// the water. Leaves near the splash are pushed straight away from it.
export const PEBBLE = {
  reach: 0.24,          // m: leaves further than this from the splash feel nothing
  sweet: 0.11,          // m: the push falls off as exp(-(r / sweet)^2)
  push: 0.75,           // m/s at the splash itself
  hit: 0.035,           // m: closer than this the stone lands on the leaf
  loosen: 0.25,         // a push at least this strong shakes a leaf out from under falling water
  knockAlong: 0.42,     // m/s downstream when a stone knocks a held leaf off whatever holds it
  knockIn: 0.2,         // m/s toward the middle of the channel
  dunkSpeed: 0.5,       // m/s downward when a stone lands on a floating leaf
  dunkKeep: 0.35,       // share of its speed a dunked leaf keeps
};

// radL / radW: half length and half width of the outline used for contact.
// buoy: how fast the leaf comes back up (m/s2). A leaf that surfaces quickly is carried back into the
// falling water by the surface current; one that stays down rides the jet out along the bottom.
export const LEAF_TYPES = {
  momiji: {
    name: 'もみじ', kana: 'MOMIJI', size: 0.066, tau: 0.2, quad: 3.0, air: 0.05,
    spin: 1.25, angDamp: 1.6, align: 0.0, radL: 0.058, radW: 0.058, draft: 0.003, buoy: 1.5, grip: 0.5,
    stats: { speed: 3, slip: 2, fall: 5 }, blurb: 'ひらたくて、沈みやすい。滝の下をくぐってぬける。石にはひっかかる。',
    colors: ['#c8321f', '#e4572e', '#f29c38'],
  },
  ichou: {
    name: 'いちょう', kana: 'ICHOU', size: 0.06, tau: 0.26, quad: 2.6, air: 0.04,
    spin: 0.9, angDamp: 2.2, align: 0.9, radL: 0.05, radW: 0.046, draft: 0.003, buoy: 2.0, grip: 0.4,
    stats: { speed: 3, slip: 3, fall: 3 }, blurb: 'じくがしっぽになって、むきがそろう。どこでもそこそこ。',
    colors: ['#e9b520', '#f6d34a', '#c99a17'],
  },
  sakura: {
    name: 'さくらのは', kana: 'SAKURA', size: 0.064, tau: 0.22, quad: 2.8, air: 0.14,
    spin: 1.0, angDamp: 1.9, align: 0.5, radL: 0.06, radW: 0.032, draft: 0.003, buoy: 1.8, grip: 0.35,
    stats: { speed: 4, slip: 4, fall: 3 }, blurb: 'ほそくて、はやせに強い。すきまをすりぬけるが、岸で止まりやすい。',
    colors: ['#b8462a', '#d9743a', '#8e3a22'],
  },
  sasabune: {
    name: 'ささぶね', kana: 'SASABUNE', size: 0.074, tau: 0.42, quad: 1.6, air: 0.03,
    spin: 0.45, angDamp: 3.4, align: 1.4, radL: 0.072, radW: 0.022, draft: 0.008, buoy: 4.2, grip: 0.3,
    stats: { speed: 3, slip: 5, fall: 1 }, blurb: 'よくうく。石はよけられるが、滝の泡には何度ももどされる。',
    colors: ['#5f8f3a', '#86ad4c', '#3f6b2a'],
  },
};

export const RIVALS = [
  { name: 'ゆうた', color: '#4aa3df' },
  { name: 'はるか', color: '#e86f9a' },
  { name: 'そうちゃん', color: '#9a7be0' },
];
export const PLAYER = { name: 'きみ', color: '#ffb547' };
