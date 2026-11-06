// Camera choreography. It follows the stream, not the world: along the bends behind the leaf, standing
// on the lane side. Near a fall it steps down the bank and looks back up at the curtain, because from
// upstream a fall is only an edge.
import * as THREE from 'three';
import { WORLD } from './config.js?v=a087d61d0b56';
import { toWorld, heading, groundHeight, restEta, STEPS, centerOffset } from './course.js?v=a087d61d0b56';

const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const w2 = [0, 0];
const leafAt = new THREE.Vector3();
const CLEARANCE = 0.2;

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
    this.closeUp = 0;
    this.snap = true;
    this.followS = WORLD.DROP_S;
  }

  setMode(mode) { this.mode = mode; this.t = 0; this.closeUp = 0; if (mode === 'race') this.followS = WORLD.DROP_S; }

  place(out, s, n, heightAbove) {
    toWorld(s, n, w2);
    const g = Math.max(groundHeight(s, n), restEta(s));
    out.set(w2[0], g + heightAbove, w2[1]);
    return out;
  }

  update(dt, target, aspect) {
    this.t += dt;
    const P = new THREE.Vector3(), Lk = new THREE.Vector3();
    let k = 2.2;
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
      const s = WORLD.DROP_S;
      this.place(P, s - 0.95, 0.12, 0.72 + 0.14 * (tall - 1));
      this.place(Lk, s + 0.55, centerOffset(s), 0);
      k = 2.0;
      this.focusS = s + 0.8;
      this.place(this.focus, this.focusS, 0, 0);
    } else if (this.mode === 'race' && target) {
      // Follow along the stream with a smoothed s, so a leaf bouncing in a roller does not shake the view.
      const lead = Math.max(0.12, Math.min(0.9, target.vs * 0.7));
      const want = target.s + lead;
      this.followS = damp(this.followS, want, 3.0, dt);
      const fs = this.followS;
      const back = 0.62 + 0.14 * (tall - 1);
      const hgt = 0.68 + 0.2 * (tall - 1);
      const sideN = 0.14;
      this.place(P, fs - back, sideN, hgt);
      this.place(Lk, fs + 0.32, target.n * 0.35 + centerOffset(fs) * 0.5, 0.0);
      k = 2.6;

      // near a fall, go to the lane side below it and look back at the curtain
      let shot = 0, st = null;
      for (const c of STEPS) {
        if (c.drop < 0.1) continue;
        const a = target.s - c.s;
        const w = sstep(-1.0, -0.45, a) * (1 - sstep(c.roller + 0.3, c.roller + 0.72, a));
        if (w > shot) { shot = w; st = c; }
      }
      if (shot > 0.001) {
        // Hover over the pool below it, looking straight back at the falling water.
        const dist = 0.78 + c2d(st.drop) * 0.42;
        const sc = new THREE.Vector3(), lc = new THREE.Vector3();
        toWorld(st.s + dist, st.nCenter + 0.16, w2);
        const below = restEta(st.s + 0.3);
        sc.set(w2[0], below + 0.36 + st.drop * 0.75, w2[1]);
        toWorld(st.s + 0.1, st.nCenter, w2);
        lc.set(w2[0], below + st.drop * 0.42, w2[1]);
        // keep the leaf in the narrow portrait frame when it drifts off to the side of the fall
        this.place(leafAt, target.s, target.n, 0);
        leafAt.y = below + st.drop * 0.2;
        if (target.state === 'water' && target.s > st.s) lc.lerp(leafAt, 0.62);
        P.lerp(sc, shot);
        Lk.lerp(lc, shot);
        // the moment a leaf is pressed under, ease in closer
        const closer = Math.min(1, this.closeUp);
        P.lerp(lc, 0.2 * closer * shot);
        k = 1.9;
      }
      this.focusS = fs;
      this.place(this.focus, fs + 0.3, 0, 0);
    } else if (this.mode === 'finish') {
      const s = WORLD.FINISH_S;
      const a = this.t * 0.04;
      this.place(P, s - 1.1 + Math.sin(a) * 0.15, 0.55 + Math.cos(a) * 0.1, 0.42);
      this.place(Lk, s + 0.3, 0, 0.12);
      k = 1.0;
      this.focusS = s;
      this.place(this.focus, s, 0, 0);
    }
    // never inside the ground
    const near = nearGround(P);
    if (P.y < near + CLEARANCE) P.y = near + CLEARANCE;

    if (this.snap) { this.pos.copy(P); this.look.copy(Lk); this.snap = false; }
    this.pos.x = damp(this.pos.x, P.x, k, dt);
    this.pos.y = damp(this.pos.y, P.y, k, dt);
    this.pos.z = damp(this.pos.z, P.z, k, dt);
    this.look.x = damp(this.look.x, Lk.x, k * 1.3, dt);
    this.look.y = damp(this.look.y, Lk.y, k * 1.3, dt);
    this.look.z = damp(this.look.z, Lk.z, k * 1.3, dt);
    this.camera.position.copy(this.pos);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 3);
      this.camera.position.x += (Math.random() - 0.5) * 0.008 * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * 0.008 * this.shake;
    }
    this.camera.lookAt(this.look);
    void heading;
  }
}

const c2d = (d) => Math.min(1, d / 0.3);

// Ground height under a world point is only needed roughly: the camera stays well above the stream.
let groundLookup = null;
export function setGroundLookup(fn) { groundLookup = fn; }
function nearGround(p) { return groundLookup ? groundLookup(p.x, p.z) : -Infinity; }
