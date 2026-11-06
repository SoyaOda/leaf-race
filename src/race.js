// Race flow: release, stepping the leaves against the simulated flow, pebbles and splashes,
// spray at the falls, rival friends' behaviour, finishing order.
import * as THREE from 'three';
import { WORLD, RACE, RIVALS, PLAYER, LEAF_TYPES } from './config.js?v=a087d61d0b56';
import { centerOffset, halfWidth, groundHeight, progressOf, toWorld, restEta, STEPS, SPOTS, heading } from './course.js?v=a087d61d0b56';
import { Leaf, collideLeaves, PROBES_PER_LEAF } from './leaves.js?v=a087d61d0b56';
import { LAYER_OPAQUE, LAYER_FLOAT } from './post.js?v=a087d61d0b56';

const SPLASH_MAX = 260;
const PEBBLE_MAX = 24;
const LEAF_SLOTS = 4;
const SPRAY_RANGE = 7;     // falls further than this from the camera throw no droplets
const SUBSTEPS = 3;
export const LISTENER_PROBE = LEAF_SLOTS * PROBES_PER_LEAF;
const w2 = [0, 0];
const HAND_OFFSET = new THREE.Vector3(0.12, -0.35, 0.1);

export class Race {
  constructor(scene, sim, sound) {
    this.scene = scene;
    this.sim = sim;
    this.sound = sound;
    this.leaves = [];
    this.state = 'idle';
    this.time = 0;
    this.wind = [0, 0];
    this.events = [];               // UI events: {type, ...}
    this.pebbles = [];
    this.flying = [];
    this.autopilot = false;
    this.pendingDrops = [];
    this.handOrigin = new THREE.Vector3();
    this.buildSplash();
    this.pebbleGeo = new THREE.IcosahedronGeometry(0.014, 1);
    this.pebbleMats = [0x8a8378, 0x6f6a63, 0x9b9488, 0x5d5a55].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 }));
    this.sprayAcc = STEPS.map(() => 0);
  }

  buildSplash() {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xe9f1f2, roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.8, depthWrite: false });
    this.splash = new THREE.InstancedMesh(geo, mat, SPLASH_MAX);
    this.splash.layers.set(LAYER_FLOAT);
    this.splash.frustumCulled = false;
    this.splash.count = 0;
    this.scene.add(this.splash);
    this.drops = [];
  }

  // Build a race with the player's chosen leaf; rivals take the other three kinds.
  setup(playerKey) {
    for (const l of this.leaves) this.scene.remove(l.mesh);
    const kinds = Object.keys(LEAF_TYPES).filter((k) => k !== playerKey);
    this.leaves = [new Leaf(playerKey, { ...PLAYER, isPlayer: true })];
    RIVALS.forEach((r, i) => this.leaves.push(new Leaf(kinds[i % kinds.length], { ...r, isPlayer: false })));
    for (const l of this.leaves) { l.mesh.layers.set(LAYER_FLOAT); l.underLayer = false; this.scene.add(l.mesh); }
    this.player = this.leaves[0];
    this.state = 'aim';
    this.time = 0;
    this.finishOrder = [];
    this.playerPebbles = RACE.pebbles;
    this.pebbleTimer = 0;
    this.ai = RIVALS.map(() => ({ pebbles: 4, cool: 2 + Math.random() * 2 }));
    this.doneTimer = 0;
    this.results = null;
    this.spotSeen = new Set();
    this.heldAnnounced = false;
    this.pendingDrops.length = 0;
    // friends hold their leaves out over the water
    const s0 = WORLD.DROP_S, nc = centerOffset(s0), hw = halfWidth(s0), y0 = restEta(s0);
    this.leaves.forEach((l, i) => {
      if (i === 0) l.hold(s0, nc, y0 + 0.28);
      else l.hold(s0 - 0.2, nc + (i - 2) * hw * 0.6, y0 + 0.34);
    });
  }

  holdPlayer(s, n) {
    const s0 = WORLD.DROP_S, nc = centerOffset(s0), hw = halfWidth(s0) * 0.82;
    n = Math.min(nc + hw, Math.max(nc - hw, n));
    s = Math.min(s0 + 0.28, Math.max(s0 - 0.28, s));
    this.player.hold(s, n, restEta(s0) + 0.24);
  }

  // Release everyone: "se-no!"
  release(vs, vn) {
    if (this.state !== 'aim') return;
    const sp = Math.hypot(vs, vn);
    if (sp > 1.1) { vs *= 1.1 / sp; vn *= 1.1 / sp; }
    this.player.drop(vs, vn);
    const s0 = WORLD.DROP_S, nc = centerOffset(s0), hw = halfWidth(s0);
    this.leaves.slice(1).forEach((l) => {
      this.pendingDrops.push({ leaf: l, at: 0.05 + Math.random() * 0.25, s: s0 - 0.12 + Math.random() * 0.25, n: nc + (Math.random() * 2 - 1) * hw * 0.7 });
    });
    this.state = 'race';
    this.time = 0;
    this.events.push({ type: 'go' });
  }

  // ---- player input during the race ----
  tap(s, n) {
    if (this.state !== 'race') return 'none';
    const p = this.player;
    if ((p.state === 'water') && Math.hypot(n - p.n, s - p.s) < 0.15 && (p.heldTime >= 1 || p.step) && this.time - p.lastPokeAt > RACE.pokeCooldown) {
      // a twig: push it along and out from under the water
      const dir = Math.sign(centerOffset(p.s) - p.n) || 1;
      p.kick(0.42, dir * 0.2, (Math.random() - 0.5) * 7, true);
      p.lastPokeAt = this.time;
      this.sim.addImpulse(p.n, p.s, 0.03, 0.15);
      this.sound.plop(0.45, 0);
      this.events.push({ type: 'poke' });
      return 'poke';
    }
    if (this.playerPebbles <= 0) { this.events.push({ type: 'empty' }); return 'empty'; }
    this.playerPebbles--;
    this.throwPebble(this.handOrigin.clone(), s, n, true);
    return 'pebble';
  }

  throwPebble(origin, s, n, byPlayer) {
    const mesh = new THREE.Mesh(this.pebbleGeo, this.pebbleMats[Math.floor(Math.random() * 4)]);
    mesh.layers.set(LAYER_OPAQUE);
    mesh.castShadow = true;
    mesh.scale.setScalar(0.8 + Math.random() * 0.5);
    mesh.position.copy(origin);
    this.scene.add(mesh);
    toWorld(s, n, w2);
    const to = new THREE.Vector3(w2[0], restEta(s), w2[1]);
    const dist = origin.distanceTo(to);
    this.flying.push({ mesh, from: origin, to, s, n, t: 0, T: 0.26 + dist * 0.05, arc: 0.12 + dist * 0.06, byPlayer });
  }

  splashAt(x, y, z, size) {
    const k = Math.round(16 * size);
    for (let i = 0; i < k; i++) {
      const a = Math.random() * Math.PI * 2, sp = (0.2 + Math.random() * 0.7) * size;
      const up = (0.9 + Math.random() * 1.3) * Math.sqrt(size);
      this.drops.push({ x: x + Math.cos(a) * 0.012, y, z: z + Math.sin(a) * 0.012, floor: y, vx: Math.cos(a) * sp, vy: up, vz: Math.sin(a) * sp, r: 0.002 + Math.random() * 0.0045 * size, life: 1 });
    }
    this.drops.push({ x, y, z, floor: y, vx: 0, vy: 1.6 * Math.sqrt(size), vz: 0, r: 0.006 * size, life: 1 });
    if (this.drops.length > SPLASH_MAX) this.drops.splice(0, this.drops.length - SPLASH_MAX);
  }

  // Fine droplets jump from where the curtains land, as long as water is coming over.
  updateSpray(dt, camera) {
    STEPS.forEach((st, i) => {
      toWorld(st.s + 0.1, st.nCenter, w2);
      const d = Math.hypot(w2[0] - camera.position.x, w2[1] - camera.position.z);
      if (d > SPRAY_RANGE) return;
      this.sprayAcc[i] += dt * 40 * st.drop / 0.15;
      const th = heading(st.s);
      while (this.sprayAcc[i] > 1) {
        this.sprayAcc[i] -= 1;
        const nn = st.n0 + Math.random() * (st.n1 - st.n0);
        const ss = st.s + 0.06 + Math.random() * 0.1;
        toWorld(ss, nn, w2);
        const a = Math.random() * Math.PI * 2, sp = 0.15 + Math.random() * 0.5;
        const y = restEta(ss) - 0.01;
        this.drops.push({
          x: w2[0], y, z: w2[1], floor: y - 0.02,
          vx: Math.cos(a) * sp + Math.sin(th) * 0.3, vy: 0.5 + Math.random() * (0.6 + 2.2 * st.drop), vz: Math.sin(a) * sp + Math.cos(th) * 0.3,
          r: 0.0012 + Math.random() * 0.0028, life: 0.9,
        });
      }
    });
    if (this.drops.length > SPLASH_MAX) this.drops.splice(0, this.drops.length - SPLASH_MAX);
  }

  // ---- per frame ----
  // Everything advances by simulated time, so pebbles and leaves stay in step on a slow frame.
  update(simT, camera) {
    this.events.length = 0;
    this.handOrigin.copy(camera.position).add(HAND_OFFSET);
    const tt = this.sim.time;
    this.wind[0] = 0.1 * Math.sin(tt * 0.13);
    this.wind[1] = 0.14 + 0.1 * Math.sin(tt * 0.071 + 1.0);
    if (this.state === 'race') this.time += simT;

    for (let i = this.pendingDrops.length - 1; i >= 0; i--) {
      const p = this.pendingDrops[i];
      p.at -= simT;
      if (p.at <= 0) {
        p.leaf.s = p.s; p.leaf.n = p.n;
        p.leaf.drop(0.1 + Math.random() * 0.25, (Math.random() - 0.5) * 0.3);
        this.pendingDrops.splice(i, 1);
      }
    }

    // Probes are one frame old at most; a leaf between frames extrapolates on its own velocity.
    const h = simT / SUBSTEPS;
    for (let k = 0; k < SUBSTEPS; k++) {
      for (let i = 0; i < this.leaves.length; i++) {
        const l = this.leaves[i];
        const base = i * PROBES_PER_LEAF;
        if (l.state === 'air') {
          l.stepAir(h);
          const c = this.sim.probe(base);
          const surface = this.sim.probeReady && c[3] > 0.002 ? c[2] : groundHeight(l.s, l.n);
          if (l.y <= surface + 0.004) {
            l.state = 'water'; l.y = surface + 0.004;
            this.sim.addImpulse(l.n, l.s, 0.03, 0.16);
            if (l.owner.isPlayer) { this.sound.leafLand(); this.events.push({ type: 'landed' }); }
          }
        } else if (l.state === 'water') {
          if (!this.sim.probeReady) continue;
          const probes = [];
          for (let q = 0; q < PROBES_PER_LEAF; q++) probes.push(this.sim.probe(base + q));
          const r = l.stepWater(h, probes, this.wind, tt, this.sim);
          if (r === 'fall' && l.owner.isPlayer) this.events.push({ type: 'over', step: l.fall.st });
        } else if (l.state === 'falling') {
          if (l.stepFalling(h, this.sim.probe(base), this.sim)) {
            toWorld(l.s, l.n, w2);
            this.splashAt(w2[0], l.y, w2[1], 0.3);
            if (l.owner.isPlayer) { this.sound.plop(0.5, 0); this.events.push({ type: 'plunge' }); }
          }
        }
      }
      collideLeaves(this.leaves);
    }

    // finishing, and what to say about where the player's leaf is
    for (const l of this.leaves) {
      if ((l.state === 'water') && !l.finished && l.s >= WORLD.FINISH_S && this.state === 'race') {
        l.endHold();
        l.finished = true; l.finishTime = this.time;
        this.finishOrder.push(l);
        this.events.push({ type: 'finish', leaf: l, rank: this.finishOrder.length });
      }
      if (l.state === 'water' && l.s > WORLD.CULVERT_S - 0.1) { l.state = 'gone'; l.mesh.visible = false; }
      if (l.state !== 'hand' && l.state !== 'gone') l.syncMesh();
    }

    if (this.state === 'race') {
      this.announce();
      this.updateAI(simT);
      this.pebbleTimer += simT;
      if (this.playerPebbles < RACE.pebbles && this.pebbleTimer > RACE.pebbleRecharge) { this.playerPebbles++; this.pebbleTimer = 0; this.events.push({ type: 'recharge' }); }
      if (this.playerPebbles >= RACE.pebbles) this.pebbleTimer = 0;
      if (this.autopilot) this.updateAutopilot(simT);
      const allIn = this.leaves.every((l) => l.finished || l.state === 'gone');
      if (this.player.finished) this.doneTimer += simT;
      if (allIn || this.doneTimer > 7 || this.time > RACE.timeLimit) this.finishRace();
    }

    this.updatePebbles(simT, camera);
    this.updateSpray(simT, camera);
    this.updateDrops(simT);
  }

  announce() {
    const p = this.player;
    for (const spot of SPOTS) {
      if (!this.spotSeen.has(spot.name) && p.s > spot.s - 0.9) {
        this.spotSeen.add(spot.name);
        this.events.push({ type: 'spot', spot });
      }
    }
    if (p.heldTime >= RACE.holdReport && !this.heldAnnounced) {
      this.heldAnnounced = true;
      this.events.push({ type: 'held', kind: p.heldKind });
    }
    if (p.heldTime === 0 && this.heldAnnounced) {
      this.heldAnnounced = false;
      this.events.push({ type: 'freed' });
    }
  }

  finishRace() {
    this.state = 'done';
    for (const l of this.leaves) if (!l.finished) l.endHold();
    const unfinished = this.leaves.filter((l) => !l.finished).sort((a, b) => b.s - a.s);
    const order = [...this.finishOrder, ...unfinished];
    this.results = order.map((l, i) => ({
      rank: i + 1, name: l.owner.name, color: l.owner.color, leaf: l.type.name, isPlayer: l.owner.isPlayer,
      time: l.finished ? l.finishTime : null, progress: progressOf(l.s), diary: l.diary, s: l.s,
    }));
    this.events.push({ type: 'done' });
  }

  ranking() {
    return [...this.leaves].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.s - a.s;
    });
  }

  updateAI(dt) {
    this.ai.forEach((a, i) => {
      const l = this.leaves[i + 1];
      a.cool -= dt;
      if (a.cool > 0 || a.pebbles <= 0 || l.state !== 'water' || l.finished) return;
      a.cool = 0.9 + Math.random() * 0.8;
      if (l.heldTime > 5) {
        // a friend helps their own leaf: drop a stone just upstream of it
        a.pebbles--;
        toWorld(l.s - 0.6, l.n + 0.9, w2);
        this.throwPebble(new THREE.Vector3(w2[0], l.y + 0.7, w2[1]), l.s - 0.05, l.n - Math.sign(l.n - centerOffset(l.s)) * 0.05, false);
        this.events.push({ type: 'rivalThrow', name: l.owner.name });
      }
    });
  }

  updateAutopilot(dt) {
    const p = this.player;
    this.autoCool = (this.autoCool ?? 2) - dt;
    if (this.autoCool > 0 || p.state !== 'water') return;
    this.autoCool = 1.5 + Math.random() * 2;
    if (p.heldTime >= 3) this.tap(p.s, p.n);
  }

  updatePebbles(dt, camera) {
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      f.t += dt;
      const u = Math.min(1, f.t / f.T);
      f.mesh.position.lerpVectors(f.from, f.to, u);
      f.mesh.position.y += 4 * f.arc * u * (1 - u);
      f.mesh.rotation.x += dt * 9; f.mesh.rotation.z += dt * 6;
      if (u >= 1) {
        this.flying.splice(i, 1);
        this.landPebble(f, camera);
      }
    }
    for (const p of this.pebbles) {
      if (p.mesh.position.y > p.rest) {
        p.vy = Math.max(p.vy - dt * 2.5, -0.45);
        p.mesh.position.y = Math.max(p.rest, p.mesh.position.y + p.vy * dt);
        p.mesh.rotation.x += dt * 2;
      }
    }
  }

  landPebble(f, camera) {
    const { s, n, to } = f;
    const inStrip = Math.abs(n) < WORLD.W / 2;
    const ground = inStrip ? this.sim.bedAt(s, n) : groundHeight(s, n);
    const wet = inStrip && ground < to.y - 0.005;
    if (wet) {
      this.sim.addImpulse(n, s, 0.035, 0.9);
      this.splashAt(to.x, to.y, to.z, 0.8);
      const pan = camera ? THREE.MathUtils.clamp((to.x - camera.position.x) * -0.9, -0.8, 0.8) : 0;
      this.sound.plop(0.8, pan);
      this.pebbles.push({ mesh: f.mesh, vy: -0.25, rest: ground + 0.008 });
      // The wave shoves whatever is close, and shakes a dunked leaf loose.
      for (const l of this.leaves) {
        if (l.state !== 'water') continue;
        const dn = l.n - n, ds = l.s - s, r = Math.hypot(dn, ds);
        if (r > 0.22) continue;
        const k = Math.exp(-(r * r) / (0.11 * 0.11)) * 0.75;
        const d = Math.max(r, 0.02);
        l.kick(k * ds / d + k * 0.25, k * dn / d, (Math.random() - 0.5) * 6, k > 0.25);
      }
      this.events.push({ type: 'splash', byPlayer: f.byPlayer });
    } else {
      this.pebbles.push({ mesh: f.mesh, vy: 0, rest: ground + 0.008 });
      f.mesh.position.y = ground + 0.008;
    }
    if (this.pebbles.length > PEBBLE_MAX) { const old = this.pebbles.shift(); this.scene.remove(old.mesh); }
  }

  updateDrops(dt) {
    const m4 = this.tmpM4 || (this.tmpM4 = new THREE.Matrix4());
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.vy -= 9.81 * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      d.life -= dt * 1.1;
      if (d.y < d.floor || d.life <= 0) this.drops.splice(i, 1);
    }
    let n = 0;
    for (const d of this.drops) {
      const sy = d.r * (1 + Math.min(2, Math.abs(d.vy) * 0.6));
      m4.makeScale(d.r, sy, d.r).setPosition(d.x, d.y, d.z);
      this.splash.setMatrixAt(n++, m4);
      if (n >= SPLASH_MAX) break;
    }
    this.splash.count = n;
    this.splash.instanceMatrix.needsUpdate = true;
  }

  // Probe points for this frame (leaves first, then the audio listener spot). All [n, s].
  probePoints(listener) {
    const pts = [];
    for (let i = 0; i < LEAF_SLOTS; i++) {
      const l = this.leaves[i];
      if (l && (l.state === 'water' || l.state === 'air' || l.state === 'falling')) l.probePoints(pts);
      else for (let k = 0; k < PROBES_PER_LEAF; k++) pts.push(null);
    }
    pts[LISTENER_PROBE] = listener;
    return pts;
  }

  clearPebbles() {
    for (const p of this.pebbles) this.scene.remove(p.mesh);
    for (const f of this.flying) this.scene.remove(f.mesh);
    this.pebbles.length = 0; this.flying.length = 0; this.drops.length = 0;
  }
}
