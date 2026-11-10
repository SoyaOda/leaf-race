// The camera is the child. Their feet stay on the stream-side edge of the lane and their eyes sit at a
// child's height; the view never floats over the water once the leaf is away. What the child does is
// what the camera does:
//   - walks a step behind the leaf, runs when the water takes it ahead (speed-limited, so it has to catch up)
//   - runs on ahead to a fall and looks back up at it, because from upstream a fall is only an edge
//   - stops and crouches beside a leaf that is held
//   - waits at the finish string
// Gaze stays on the leaf while the head bobs with each step, the way eyes do.
import * as THREE from 'three';
import { WORLD } from './config.js?v=f337fed88ee5';
import { toWorld, groundHeight, restEta, STEPS, centerOffset, halfWidth } from './course.js?v=f337fed88ee5';

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;
const w2 = [0, 0];

const CLEARANCE = 0.2;
const CUT_DISTANCE = 3;        // m: further than this the view cuts instead of travelling
const EYE_STAND = 0.86;        // eyes of a seven-year-old running hunched over the water (m above the feet)
const EYE_CROUCH = 0.55;
const EYE_AT_FALL = 0.74;      // half crouched on the bank below a fall
const WALK_MARGIN = 0.26;      // feet this far outside the water's edge, on the lane side
const LEAN_IN = 0.1;           // a crouching child leans this much toward the water
const TRAIL = 0.9;             // walks this far behind the leaf
const TRAIL_HELD = 0.34;       // and stops about here when it is held
const RUN_MAX = 2.8;           // m/s, a child's run
const RUN_GAIN = 3.2;          // how hard they close a gap (1/s)
const STEP_LENGTH = 0.42;      // m per step, sets the bob rate
const BOB_HEIGHT = 0.013;      // m at a run
const BOB_SWAY = 0.007;
const HELD_FROM = 1, HELD_FULL = 3;       // seconds held over which the child settles into a crouch
const BODY_S_MIN = 0.7, BODY_S_MAX = WORLD.FINISH_S - 1.0;   // the plank at one end; short of the finish poles at the other
const FALL_MIN_DROP = 0.1;     // smaller steps are not worth running ahead for
const LOOK_AHEAD = 0.18;       // gaze rests this far downstream of the leaf, so what is coming is in view
const FOV = 50, FOV_CHASE_TALL = 54;   // degrees; a tall screen gets a wider view while running
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const fallReach = (drop) => Math.min(1, drop / 0.3);
// Where the child's feet go at a given s: along the top of the lane-side bank.
const walkN = (s) => centerOffset(s) + halfWidth(s) + WALK_MARGIN;

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'title';
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this.focusS = WORLD.DROP_S;
    this.t = 0;
    this.shake = 0;
    this.snap = true;
    this.followS = WORLD.DROP_S;
    // the child's body, in channel coordinates
    this.bodyS = WORLD.DROP_S - 0.95;
    this.bodyN = 0.12;
    this.bodyV = 0;
    this.eye = EYE_STAND;
    this.crouch = 0;
    this.gait = 0;
    this.P = new THREE.Vector3();
    this.Lk = new THREE.Vector3();
    this.tmpA = new THREE.Vector3();
    this.tmpB = new THREE.Vector3();
  }

  setMode(mode) {
    this.mode = mode;
    this.t = 0;
    this.shake = 0;
    if (mode === 'race') {
      // steps off the plank where the aim view stood
      this.followS = WORLD.DROP_S;
      this.bodyS = WORLD.DROP_S - 0.95;
      this.bodyN = 0.12;
      this.bodyV = 0;
      this.eye = EYE_CROUCH + 0.1;
    }
  }

  place(out, s, n, heightAbove) {
    toWorld(s, n, w2);
    const g = Math.max(groundHeight(s, n), restEta(s));
    out.set(w2[0], g + heightAbove, w2[1]);
    return out;
  }

  // The child chasing the leaf. Fills P (eyes) and Lk (what they look at).
  chase(dt, target, tall) {
    const P = this.P, Lk = this.Lk;
    // A smoothed s to look at, so a leaf bouncing in a roller does not shake the view.
    const lead = clamp(target.vs * 0.5, 0.05, 0.4);
    this.followS = damp(this.followS, target.s + lead, 3.0, dt);
    const fs = this.followS;

    const afloat = target.state === 'water';
    const held = afloat ? sstep(HELD_FROM, HELD_FULL, target.heldTime) : 0;
    let wantS = target.s - mix(TRAIL + 0.12 * (tall - 1), TRAIL_HELD, held);
    let crouch = held;
    this.crouch = crouch;

    // the nearest fall worth running ahead for
    let shot = 0, st = null;
    for (const c of STEPS) {
      if (c.drop < FALL_MIN_DROP) continue;
      const a = target.s - c.s;
      const w = sstep(-1.25, -0.55, a) * (1 - sstep(c.roller + 0.35, c.roller + 0.8, a));
      if (w > shot) { shot = w; st = c; }
    }
    // A leaf held short of the lip keeps the child beside it; the fall can wait.
    if (st && target.s < st.s) shot *= 1 - held;
    if (st) wantS = mix(wantS, st.s + 0.5 + 0.45 * fallReach(st.drop), shot);
    wantS = clamp(wantS, BODY_S_MIN, BODY_S_MAX);

    // feet: close the gap like a child does, never faster than they can run
    const wantV = clamp((wantS - this.bodyS) * RUN_GAIN, -RUN_MAX, RUN_MAX);
    this.bodyV = damp(this.bodyV, wantV, 7, dt);
    this.bodyS = clamp(this.bodyS + this.bodyV * dt, BODY_S_MIN, BODY_S_MAX);
    const lean = Math.max(crouch, shot * 0.6) * LEAN_IN;
    this.bodyN = damp(this.bodyN, walkN(this.bodyS) - lean, 3.5, dt);

    // eyes
    const wantEye = mix(mix(EYE_STAND, EYE_AT_FALL, shot), EYE_CROUCH, crouch);
    this.eye = damp(this.eye, wantEye, 3.2, dt);
    this.place(P, this.bodyS, this.bodyN, this.eye);
    if (!reducedMotion) {
      const run = sstep(0.08, 1.6, Math.abs(this.bodyV));
      this.gait += Math.abs(this.bodyV) / STEP_LENGTH * Math.PI * 2 * dt;
      P.y += BOB_HEIGHT * run * Math.sin(this.gait);
      const sway = BOB_SWAY * run * Math.sin(this.gait * 0.5);
      toWorld(this.bodyS, this.bodyN + sway, w2);
      P.x = w2[0]; P.z = w2[1];
    }

    // gaze: the water a little ahead of the leaf, and the leaf itself when it is in trouble
    const aheadN = target.n * 0.8 + centerOffset(fs) * 0.2;
    this.place(Lk, mix(fs + LOOK_AHEAD, target.s, held), mix(aheadN, target.n, held), 0);
    if (afloat) Lk.y = mix(Lk.y, target.y, held);
    if (st && shot > 0.001) {
      // from below the fall: the curtain, then the leaf once it is over
      const below = restEta(st.s + 0.3);
      const lc = this.tmpA, leafAt = this.tmpB;
      toWorld(st.s + 0.1, st.nCenter, w2);
      lc.set(w2[0], below + st.drop * 0.42, w2[1]);
      toWorld(target.s, target.n, w2);
      leafAt.set(w2[0], below + st.drop * 0.2, w2[1]);
      if (afloat && target.s > st.s) lc.lerp(leafAt, 0.62);
      Lk.lerp(lc, shot);
    }
    this.focusS = fs;
    this.place(this.focus, fs + 0.3, 0, 0);
  }

  update(dt, target, aspect) {
    this.t += dt;
    const P = this.P, Lk = this.Lk;
    let k = 2.2, fov = FOV;
    // portrait screens need more height to keep the stream ahead in frame
    const tall = THREE.MathUtils.clamp(1 / aspect, 1, 2.3);
    if (this.mode === 'title') {
      const s = 2.2 + 2.6 * (1 - Math.cos(this.t * 0.04));
      // a child's eye height on the lane, the stream running on ahead beside it
      this.place(P, s - 1.6, 0.98, 0.98 + 0.02 * Math.sin(this.t * 0.2));
      this.place(Lk, s + 5.5, 0.1, 0.1);
      k = 1.2;
      this.focusS = s + 1.2;
      this.place(this.focus, this.focusS, 0, 0);
    } else if (this.mode === 'aim') {
      // crouched on the plank, the leaf held out over the pool
      const s = WORLD.DROP_S;
      this.place(P, s - 0.95, 0.12, 0.72 + 0.14 * (tall - 1));
      this.place(Lk, s + 0.55, centerOffset(s), 0);
      k = 2.0;
      this.focusS = s + 0.8;
      this.place(this.focus, this.focusS, 0, 0);
    } else if (this.mode === 'race' && target) {
      this.chase(dt, target, tall);
      fov = mix(FOV, FOV_CHASE_TALL, clamp(tall - 1, 0, 1) * (1 - this.crouch));
      k = 7;      // the body is already smoothed; this only takes the edge off
    } else {
      // at the finish: crouched on the bank by the string, watching the others come in
      const s = WORLD.FINISH_S;
      const a = this.t * 0.04;
      // far enough back and out that the near pole stands to one side of the string, not across it
      this.place(P, s - 1.5 + Math.sin(a) * 0.12, 0.78 + Math.cos(a) * 0.06, 0.5);
      this.place(Lk, s + 0.2, 0, 0.1);
      k = 1.0;
      this.focusS = s;
      this.place(this.focus, s, 0, 0);
    }
    // never inside the ground
    const near = nearGround(P);
    if (P.y < near + CLEARANCE) P.y = near + CLEARANCE;

    // A retry from the far end of the course cuts to the new place; it does not fly there through the ground.
    if (this.snap || this.pos.distanceTo(P) > CUT_DISTANCE) { this.pos.copy(P); this.look.copy(Lk); this.snap = false; }
    const kl = this.mode === 'race' ? 5 : k * 1.3;
    this.pos.x = damp(this.pos.x, P.x, k, dt);
    this.pos.y = damp(this.pos.y, P.y, k, dt);
    this.pos.z = damp(this.pos.z, P.z, k, dt);
    this.look.x = damp(this.look.x, Lk.x, kl, dt);
    this.look.y = damp(this.look.y, Lk.y, kl, dt);
    this.look.z = damp(this.look.z, Lk.z, kl, dt);
    this.camera.position.copy(this.pos);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 3);
      if (!reducedMotion) {
        this.camera.position.x += (Math.random() - 0.5) * 0.008 * this.shake;
        this.camera.position.y += (Math.random() - 0.5) * 0.008 * this.shake;
      }
    }
    this.camera.lookAt(this.look);
    const f = damp(this.camera.fov, fov, 2.5, dt);
    if (Math.abs(f - this.camera.fov) > 0.01) { this.camera.fov = f; this.camera.updateProjectionMatrix(); }
  }
}

// Ground height under a world point is only needed roughly: the camera stays well above it.
let groundLookup = null;
export function setGroundLookup(fn) { groundLookup = fn; }
function nearGround(p) { return groundLookup ? groundLookup(p.x, p.z) : -Infinity; }
