// Boot, game states and the frame loop.
import * as THREE from 'three';
import { TIERS, WORLD } from './config.js?v=e79679972dca';
import { buildBed, buildKappa, nearest, groundHeight, restEta, STEPS, toWorld } from './course.js?v=e79679972dca';
import { ShallowWater } from './sim.js?v=e79679972dca';
import { makeDetailTexture, loadAssets } from './textures.js?v=e79679972dca';
import { WaterSurface, Caustics, Curtains, makeWaterUniforms } from './water.js?v=e79679972dca';
import { buildTerrain, createRockMaterial, buildRocks } from './terrain.js?v=e79679972dca';
import { Scenery } from './scenery.js?v=e79679972dca';
import { Race, LISTENER_PROBE } from './race.js?v=e79679972dca';
import { CameraRig, setGroundLookup } from './camera.js?v=e79679972dca';
import { Pipeline, LAYER_WATER, LAYER_FLOAT } from './post.js?v=e79679972dca';
import { SoundScape } from './audio.js?v=e79679972dca';
import { PerfMonitor } from './perf.js?v=e79679972dca';
import { UI } from './ui.js?v=e79679972dca';

const SPIN_FACTOR = 3;        // the pre-run uses a grid this many times coarser
const SPIN_SECONDS = 75;      // long enough for water to reach steady flow over the whole course
const SETTLE_SECONDS = 1.6;   // then this long on the real grid
const CAUSTIC_BEHIND = 2, CAUSTIC_AHEAD = 7;

const params = new URLSearchParams(location.search);
const ui = new UI();
const sound = new SoundScape();
const perf = new PerfMonitor();
const BASE = new URL('.', import.meta.url).href.replace(/src\/$/, '');

function storage(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch { /* storage unavailable */ }
  return null;
}

function gpuName(gl) {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
}

function pickTier(gl) {
  const forced = params.get('q') || storage('quality');
  if (forced && TIERS[forced]) return forced;
  const name = gpuName(gl) || '';
  const mobile = matchMedia('(pointer: coarse)').matches || /iPhone|iPad|Android/i.test(navigator.userAgent);
  if (!mobile) return 'high';
  if (/Mali-G(3|5)\d|Mali-T|Adreno \(TM\) [3-5]\d\d|Adreno \(TM\) 6[01]\d|PowerVR/i.test(name)) return 'low';
  return 'mid';
}

// Settle the stream: a coarse run reaches steady flow quickly (a third of the cells and a third of the
// steps), then the real grid takes over and only has to sharpen the details.
async function pourStream(renderer, tier, sim, onProgress) {
  const cnx = Math.round(tier.nx / SPIN_FACTOR);
  const cdx = WORLD.W / cnx;
  const cgrid = { nx: cnx, nz: Math.ceil(WORLD.L / cdx), maxSub: 4 };
  const coarse = new ShallowWater(renderer, cgrid, buildBed(cgrid.nx, cgrid.nz), buildKappa(cgrid.nz, cdx), false);
  await coarse.advance(SPIN_SECONDS, (p) => onProgress(p * 0.8));
  sim.pourFrom(coarse);
  coarse.dispose();
  await sim.advance(SETTLE_SECONDS, (p) => onProgress(0.8 + p * 0.2));
}

async function boot() {
  const canvas = document.getElementById('gl');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false });
  } catch (e) {
    ui.error(`WebGL2 を初期化できませんでした。${e.message}`);
    return;
  }
  const gl = renderer.getContext();
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('[leaf] context lost at', performance.now().toFixed(0), window.__leafRace?.state?.()); });
  const tierName = pickTier(gl);
  const tier = TIERS[tierName];
  renderer.autoClear = false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.NoToneMapping;
  const dprCap = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dprCap);
  renderer.setSize(innerWidth, innerHeight, false);

  ui.loading(0.05, 'テクスチャをよみこみ中');
  const tex = await loadAssets(renderer, BASE, (p) => ui.loading(0.05 + p * 0.45));

  ui.loading(0.5, '川底をならしています');
  await new Promise((r) => setTimeout(r, 0));
  const bed = buildBed(tier.nx, tier.nz);
  const kappaData = buildKappa(tier.nz, WORLD.W / tier.nx);
  let sim;
  try {
    sim = new ShallowWater(renderer, tier, bed, kappaData);
  } catch (e) {
    ui.error(e.message);
    return;
  }

  ui.loading(0.55, '水をながしています');
  await pourStream(renderer, tier, sim, (p) => ui.loading(0.55 + p * 0.25));
  sim.updateSurface();

  ui.loading(0.8, '小道をつくっています');
  await new Promise((r) => setTimeout(r, 0));
  const detail = makeDetailTexture(renderer);
  const caustics = new Caustics(renderer, sim, detail);
  const waterU = makeWaterUniforms(sim, caustics.texture, tier.caustics);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.03, 500);
  scene.add(buildTerrain(tex, waterU, tier));
  scene.add(buildRocks(createRockMaterial(tex, waterU), tier));
  ui.loading(0.9, '草をはやしています');
  await new Promise((r) => setTimeout(r, 0));
  const scenery = new Scenery(scene, tex, tier, renderer);
  scenery.sun.layers.enableAll();
  scenery.sun.shadow.camera.layers.enableAll();
  const water = new WaterSurface(sim, detail, tex.sky, tier);
  water.setLayer(LAYER_WATER);
  water.uniforms.uFogColor.value.copy(scenery.fogColor);
  water.uniforms.uFogDensity.value = scene.fog.density;
  scene.add(water.group);
  const curtains = new Curtains(sim, detail, waterU);
  curtains.setLayer(LAYER_FLOAT);
  scene.add(curtains.group);

  const pipeline = new Pipeline(renderer, tier);
  const rig = new CameraRig(camera);
  setGroundLookup((x, z) => { const c = nearest(x, z, 12); return groundHeight(c.s, c.n); });
  const race = new Race(scene, sim, sound);

  // Everything is ready: compile while the loading screen is still up.
  ui.loading(0.97, '');
  rig.update(0.016, null, camera.aspect);
  renderer.compile(scene, camera);

  // A lost context wipes the water (it only lives on the GPU). Pour it in again on restore.
  canvas.addEventListener('webglcontextrestored', async () => {
    console.warn('[leaf] context restored');
    sim.probePending = false;
    sim.reset();
    await pourStream(renderer, tier, sim, () => {});
    makeDetailTexture(renderer, 512, detail);
  });

  // ---------------- state ----------------
  let state = 'title';
  let paused = false;
  let scale = tier.scale;
  let lastT = performance.now(), lastRender = 0;
  let cap60 = storage('cap60') !== '0';
  let perfOn = params.has('perf') || storage('perf') === '1';
  let thermal = false;
  let chimePlayed = false;
  let wakeLock = null;
  let best = Number(storage('best')) || null;

  ui.buildMinimap();
  ui.buildCards();
  document.getElementById('deviceMeta').textContent = `GPU: ${gpuName(gl)} / 画質: ${tierName} (${tier.nx}×${tier.nz}) / DPR ${dprCap}`;
  document.getElementById('selQuality').value = params.get('q') || storage('quality') || 'auto';
  document.getElementById('chkPerf').checked = perfOn;
  document.getElementById('chkCap').checked = cap60;

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  function goTitle() {
    state = 'title';
    race.state = 'idle';
    race.clearPebbles();
    for (const l of race.leaves) l.mesh.visible = false;
    rig.setMode('title');
    ui.show('title');
    ui.hint('');
  }

  function goAim() {
    sound.start();
    race.clearPebbles();
    race.autopilot = thermal;
    race.setup(ui.selected);
    ui.setRacers(race.leaves);
    state = 'aim';
    rig.setMode('aim');
    ui.show('hud');
    document.getElementById('hudBottom').style.opacity = '0';
    ui.hint('<span class="hand"></span>葉っぱをつまんで、川のほうへ<br>スッとはなそう');
    if (thermal) setTimeout(() => { if (state === 'aim') release(0.3, (Math.random() - 0.5) * 0.3); }, 1500);
  }

  function release(vs, vn) {
    race.release(vs, vn);
    ui.hint('');
    ui.bigText('せーの！');
    sound.tick();
    state = 'race';
    rig.setMode('race');
    document.getElementById('hudBottom').style.opacity = '1';
  }

  function finish() {
    state = 'result';
    rig.setMode('finish');
    const res = race.results;
    const me = res.find((r) => r.isPlayer);
    const newBest = me.time != null && best != null && me.time < best;
    if (me.time != null && (best == null || me.time < best)) { best = me.time; storage('best', String(best)); }
    ui.results(res, newBest);
    sound.fanfare(me.rank);
    if (thermal) { setTimeout(() => { if (thermal) goAim(); }, 2500); ui.show('hud'); return; }
    const showResult = () => {
      if (state !== 'result') return;           // already left via retry or home
      if (paused) { setTimeout(showResult, 300); return; }
      ui.show('result');
    };
    setTimeout(showResult, 1600);
  }

  // ---------------- input ----------------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  // Pick a channel point by intersecting the screen ray with the water level near the given s.
  function pick(ev, sRef, lift = 0) {
    ndc.set(ev.clientX / innerWidth * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    plane.constant = -(restEta(sRef) + lift);
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return nearest(hit.x, hit.z, 4);
  }
  let drag = null;
  canvas.addEventListener('pointerdown', (ev) => {
    sound.start();
    if (paused) return;
    if (state === 'aim') {
      const p = pick(ev, WORLD.DROP_S, 0.24);
      if (!p) return;
      drag = { id: ev.pointerId, hist: [[performance.now(), p.s, p.n]] };
      race.holdPlayer(p.s, p.n);
      canvas.setPointerCapture(ev.pointerId);
    } else if (state === 'race') {
      const p = pick(ev, Math.min(WORLD.L, rig.focusS + 0.3));
      if (!p) return;
      const r = race.tap(p.s, p.n);
      if (r === 'empty') ui.toast('小石がない…（すこしまつと拾える）');
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id || state !== 'aim') return;
    const p = pick(ev, WORLD.DROP_S, 0.24);
    if (!p) return;
    drag.hist.push([performance.now(), p.s, p.n]);
    if (drag.hist.length > 6) drag.hist.shift();
    race.holdPlayer(p.s, p.n);
  });
  const endDrag = (ev) => {
    if (!drag || ev.pointerId !== drag.id || state !== 'aim') { drag = null; return; }
    const h = drag.hist, a = h[0], b = h[h.length - 1];
    const dtm = Math.max(16, b[0] - a[0]) / 1000;
    drag = null;
    release((b[1] - a[1]) / dtm * 0.6, (b[2] - a[2]) / dtm * 0.6);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // ---------------- buttons ----------------
  const on = (id, fn) => document.getElementById(id).addEventListener('click', () => { sound.start(); sound.tick(); fn(); });
  on('btnStart', goAim);
  on('btnAgain', goAim);
  on('btnChange', goTitle);
  on('btnPause', () => setPaused(true));
  on('btnResume', () => setPaused(false));
  on('btnRetry', () => { setPaused(false); goAim(); });
  on('btnHome', () => { setPaused(false); goTitle(); });
  on('btnSettings', () => ui.overlay('settings', true));
  on('btnCloseSettings', () => ui.overlay('settings', false));
  const soundBtn = document.getElementById('btnSound');
  soundBtn.setAttribute('aria-pressed', 'true');
  soundBtn.addEventListener('click', () => { sound.start(); const v = soundBtn.getAttribute('aria-pressed') !== 'true'; soundBtn.setAttribute('aria-pressed', String(v)); sound.setEnabled(v); });
  document.getElementById('selQuality').addEventListener('change', (e) => {
    storage('quality', e.target.value === 'auto' ? '' : e.target.value);
    const u = new URL(location.href); u.searchParams.delete('q'); location.href = u.href;
  });
  document.getElementById('chkPerf').addEventListener('change', (e) => { perfOn = e.target.checked; storage('perf', perfOn ? '1' : '0'); if (!perfOn) ui.perf(''); });
  document.getElementById('chkCap').addEventListener('change', (e) => { cap60 = e.target.checked; storage('cap60', cap60 ? '1' : '0'); });
  on('btnThermal', async () => {
    ui.overlay('settings', false);
    thermal = true;
    perfOn = true;
    perf.startThermal(params.has('thermal') ? Number(params.get('thermal')) : 300, {
      ua: navigator.userAgent, gpu: gpuName(gl), tier: tierName, grid: `${tier.nx}x${tier.nz}`, dpr: dprCap, scale: +scale.toFixed(2),
      viewport: `${innerWidth}x${innerHeight}`, cap60, started: new Date().toISOString(),
    });
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
    goAim();
  });
  on('btnCloseThermal', () => { ui.overlay('thermal', false); goTitle(); });
  on('btnCopyThermal', async () => {
    const ta = document.getElementById('thermalJson');
    try { await navigator.clipboard.writeText(ta.value); ui.toast('コピーしました'); } catch { ta.select(); }
  });

  function setPaused(p) {
    if (p === paused) return;
    paused = p;
    ui.overlay('pause', p);
    if (p) sound.suspend(); else { sound.resume(); lastT = performance.now(); }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (state === 'race' || state === 'aim') setPaused(true); else sound.suspend(); }
    else if (!paused) { sound.resume(); lastT = performance.now(); }
  });

  // ---------------- what is said during a race ----------------
  const HELD_TEXT = {
    fall: '滝の下でおさえつけられてる！',
    rock: '石にはさまった！',
    shallow: '浅瀬で止まった！',
    eddy: 'うずで回ってる！',
  };
  function handleEvents() {
    for (const e of race.events) {
      if (e.type === 'finish') {
        if (e.leaf.owner.isPlayer) { ui.bigText(e.rank === 1 ? 'いちばん！' : `${e.rank}ばん！`); rig.shake = 0.6; }
        else ui.toast(`${e.leaf.owner.name}の${e.leaf.type.name}がゴール`);
      } else if (e.type === 'rivalThrow') ui.toast(`${e.name}が小石で葉っぱをおした`);
      else if (e.type === 'poke') ui.toast('えだでつついた');
      else if (e.type === 'spot') ui.spot(e.spot.name);
      else if (e.type === 'held') { ui.toast(`${HELD_TEXT[e.kind] ?? '止まった！'}　葉っぱをタップ`); rig.closeUp = 1; }
      else if (e.type === 'freed') { ui.toast('ぬけた！'); rig.closeUp = 0; }
      else if (e.type === 'plunge') rig.shake = 0.35;
      else if (e.type === 'done') finish();
    }
  }

  // How loud the nearest fall is at the camera: inverse-square from its landing point, scaled by height.
  const fallPos = STEPS.map((st) => { const w = toWorld(st.s + 0.1, st.nCenter ?? 0); return { x: w[0], z: w[1], y: restEta(st.s + 0.2), k: st.drop }; });
  function fallLoudness() {
    let v = 0;
    for (const f of fallPos) {
      const d2 = (f.x - camera.position.x) ** 2 + (f.z - camera.position.z) ** 2 + (f.y - camera.position.y) ** 2;
      v += f.k * 1.4 / (0.3 + d2);
    }
    return Math.min(1, v);
  }

  // ---------------- frame ----------------
  function frame(now) {
    requestAnimationFrame(frame);
    if (paused || document.hidden) { lastT = now; return; }
    if (cap60 && now - lastRender < 14.5) return;
    const ms = now - lastT;
    lastT = now; lastRender = now;
    const dt = Math.min(0.1, ms / 1000);
    perf.push(ms);

    // physics
    const simT = sim.step(dt);
    sim.updateSurface();
    race.update(simT, camera);
    sim.requestProbes(race.probePoints([0, rig.focusS]));
    if (tier.caustics) caustics.render(sim.time, rig.focusS - CAUSTIC_BEHIND, rig.focusS + CAUSTIC_AHEAD, waterU.uCausticWin.value);

    handleEvents();

    // camera, scenery, water
    rig.update(dt, state === 'race' ? race.player : null, camera.aspect);
    if (state === 'race' && race.player.state === 'gone') rig.setMode('finish');
    scenery.update(sim.time, camera, rig.focus);
    water.uniforms.uTime.value = sim.time;
    curtains.update(sim.time, pipeline.refr.texture, pipeline.width, pipeline.height);

    // render at a dynamic internal resolution
    const outW = renderer.domElement.width, outH = renderer.domElement.height;
    pipeline.setSize(outW * scale, outH * scale);
    pipeline.renderFrame(scene, camera, water, outW, outH, now / 1000);

    if (state === 'aim' || state === 'race' || thermal) ui.updateRace(race, camera, innerWidth, innerHeight);

    // sound follows how broken the water is where we look
    if (sim.probeReady) {
      const pr = sim.probe(LISTENER_PROBE);
      sound.update(dt, Math.min(1, Math.hypot(pr[0], pr[1]) * 0.9), fallLoudness());
    }
    if (state === 'title' && !chimePlayed && sound.ctx) { chimePlayed = true; setTimeout(() => sound.chime(), 1800); }

    // adapt resolution, report
    const ns = perf.adapt(dt, scale, tier.minScale, tier.scale + 0.1, 1000 / 60);
    if (ns != null) scale = ns;
    if (thermal) {
      const left = (perf.thermal.duration - (performance.now() - perf.thermal.start)) / 1000;
      ui.thermalRunning(true, Math.max(0, left));
      if (perf.tickThermal(scale)) {
        thermal = false; race.autopilot = false;
        ui.thermalRunning(false);
        wakeLock?.release?.();
        ui.thermalReport(perf.thermalSummary());
      }
    }
    if (perfOn) {
      const s = perf.stats();
      ui.perf(`${s.fps.toFixed(1)} fps  p50 ${s.p50.toFixed(1)}ms  p95 ${s.p95.toFixed(1)}ms\n` +
        `sim ${tier.nx}x${tier.nz} × ${sim.lastSubsteps}sub  dt ${(simT * 1000).toFixed(1)}ms\n` +
        `render ${pipeline.width}x${pipeline.height} (${(scale * 100).toFixed(0)}%)  tier ${tierName}\n` +
        `probe ${sim.probeLatency.toFixed(1)}ms  calls ${renderer.info.render.calls}`);
    }
  }

  // Physics without a screen: same code path as a frame, in step with the solver. Used by the course checks.
  function fastForward(seconds, opts = {}) {
    sim.syncProbes = true;
    const dt = 1 / 60;
    const steps = Math.ceil(seconds / dt);
    for (let i = 0; i < steps; i++) {
      const simT = sim.step(dt);
      race.update(simT, camera);
      sim.requestProbes(race.probePoints([0, rig.focusS]));
      if (opts.events) for (const e of race.events) opts.events(e);
      if (race.state === 'done') break;
    }
    sim.syncProbes = false;
    sim.probePending = false;
    return race.state;
  }

  ui.show('title');
  rig.setMode('title');
  rig.snap = true;
  requestAnimationFrame(frame);
  window.__leafRace = { sim, race, rig, renderer, pipeline, camera, goAim, release, finish, state: () => state, setState: (v) => { state = v; }, perf, fastForward };
  if (params.has('autostart')) {
    goAim();
    setTimeout(() => release(0.3, 0), 800);
  }
}

boot().catch((e) => {
  console.error(e);
  ui.error(`${e.message || e}`);
});
