// Procedural soundscape (Web Audio, no sample files): brook babble, small falls, autumn insects,
// pebble plops, leaf drops, a distant evening chime, and small UI sounds.
const PENTA = [0, 2, 4, 7, 9]; // major pentatonic degrees

export class SoundScape {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.turbulence = 0.3;
    this.nextBubble = 0;
    this.nextInsect = [0, 0, 0];
  }

  // Must run inside a user gesture (iOS).
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);
    // shared echo for the chime and splashes
    this.echo = ctx.createDelay(1.5); this.echo.delayTime.value = 0.42;
    const fb = ctx.createGain(); fb.gain.value = 0.38;
    const echoLp = ctx.createBiquadFilter(); echoLp.type = 'lowpass'; echoLp.frequency.value = 1800;
    this.echo.connect(echoLp).connect(fb).connect(this.echo);
    this.echoOut = ctx.createGain(); this.echoOut.gain.value = 0.55;
    echoLp.connect(this.echoOut).connect(this.master);
    this.buildRiver();
    // Some browsers (iOS Safari among them) can hand back a context that is created inside the tap
    // yet still suspended; resuming here keeps the first tap from being silent.
    if (ctx.state !== 'running') ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.1);
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  noiseBuffer(seconds) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029591; b1 = 0.985 * b1 + w * 0.032534; b2 = 0.95 * b2 + w * 0.048056;
      d[i] = (b0 + b1 + b2 + w * 0.05) * 0.9;
    }
    return buf;
  }

  buildRiver() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(4); src.loop = true;
    this.riverBands = [];
    this.riverGain = ctx.createGain(); this.riverGain.gain.value = 0.0;
    for (const [f, q, g] of [[320, 0.8, 0.5], [900, 1.1, 0.35], [2300, 1.3, 0.18], [5200, 1.6, 0.06]]) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const gg = ctx.createGain(); gg.gain.value = g;
      src.connect(bp).connect(gg).connect(this.riverGain);
      this.riverBands.push({ bp, gg, base: g, f });
    }
    this.riverGain.connect(this.master);
    src.start();
    this.riverGain.gain.setTargetAtTime(0.55, ctx.currentTime, 1.2);
    this.bubbleBus = ctx.createGain(); this.bubbleBus.gain.value = 0.22;
    this.bubbleBus.connect(this.master);
    // Falling water: broadband roar with a low thump underneath, brought up as the camera nears a fall.
    const fallSrc = ctx.createBufferSource();
    fallSrc.buffer = this.noiseBuffer(5); fallSrc.loop = true;
    this.fallGain = ctx.createGain(); this.fallGain.gain.value = 0;
    const roar = ctx.createBiquadFilter(); roar.type = 'bandpass'; roar.frequency.value = 1500; roar.Q.value = 0.35;
    const thump = ctx.createBiquadFilter(); thump.type = 'lowpass'; thump.frequency.value = 280;
    const thumpGain = ctx.createGain(); thumpGain.gain.value = 1.5;
    fallSrc.connect(roar).connect(this.fallGain);
    fallSrc.connect(thump).connect(thumpGain).connect(this.fallGain);
    this.fallGain.connect(this.master);
    fallSrc.start();
  }

  // A single water bubble: resonance that rises as the bubble collapses at the surface.
  bubble(t, pan) {
    const ctx = this.ctx;
    const f0 = 380 + Math.random() * 900;
    const osc = ctx.createOscillator(); osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * (1.6 + Math.random()), t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25 + Math.random() * 0.25, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06 + Math.random() * 0.05);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    osc.connect(g).connect(p).connect(this.bubbleBus);
    osc.start(t); osc.stop(t + 0.15);
  }

  insect(t, kind, pan) {
    const ctx = this.ctx;
    const out = ctx.createGain(); out.gain.value = 0.035;
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    out.connect(p).connect(this.master);
    if (kind === 0) {
      // suzumushi: a clear "riiin"
      const o = ctx.createOscillator(); o.frequency.value = 4300 + Math.random() * 120;
      const am = ctx.createOscillator(); am.frequency.value = 38;
      const amg = ctx.createGain(); amg.gain.value = 0.5;
      const g = ctx.createGain(); g.gain.value = 0;
      am.connect(amg).connect(g.gain);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.6, t + 0.04); g.gain.setValueAtTime(0.6, t + 0.38); g.gain.linearRampToValueAtTime(0, t + 0.5);
      o.connect(g).connect(out);
      o.start(t); am.start(t); o.stop(t + 0.55); am.stop(t + 0.55);
    } else {
      // korogi: short rolling trills
      for (let i = 0; i < 3; i++) {
        const s = t + i * 0.13;
        const o = ctx.createOscillator(); o.frequency.value = 3600 + Math.random() * 200;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.5, s + 0.01); g.gain.exponentialRampToValueAtTime(0.001, s + 0.08);
        o.connect(g).connect(out); o.start(s); o.stop(s + 0.1);
      }
    }
  }

  // called every frame with how rough the water near the camera is and how close a fall is (0..1)
  update(dt, turbulence, fall = 0) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, now = ctx.currentTime;
    this.turbulence += (turbulence - this.turbulence) * Math.min(1, dt * 1.5);
    const tb = Math.min(1, this.turbulence + fall * 0.5);
    this.fallGain.gain.setTargetAtTime(fall * 0.95, now, 0.25);
    for (const b of this.riverBands) {
      const wob = 1 + 0.25 * Math.sin(now * (0.7 + b.f * 0.0003)) * Math.sin(now * 1.37 + b.f);
      b.gg.gain.setTargetAtTime(b.base * (0.55 + tb * 0.9) * wob, now, 0.2);
    }
    // babble: bubbles arrive faster where the water is broken
    while (this.nextBubble < now + 0.1) {
      if (this.nextBubble < now) this.nextBubble = now;
      this.bubble(this.nextBubble, Math.random() * 1.6 - 0.8);
      this.nextBubble += -Math.log(1 - Math.random()) / (6 + tb * 40);
    }
    for (let i = 0; i < 3; i++) {
      if (this.nextInsect[i] < now) {
        this.insect(now + Math.random() * 0.2, i === 2 ? 1 : 0, i === 0 ? -0.7 : i === 1 ? 0.75 : 0.1);
        this.nextInsect[i] = now + 0.9 + Math.random() * (i === 2 ? 3.5 : 1.4);
      }
    }
  }

  plop(size = 1, pan = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    p.connect(this.master); p.connect(this.echo);
    // impact splash
    const n = ctx.createBufferSource(); n.buffer = this.splashBuf || (this.splashBuf = this.noiseBuffer(0.4));
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1400;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.35 * size, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(hp).connect(ng).connect(p); n.start(t); n.stop(t + 0.3);
    // the "pochan": cavity resonance sweeping up
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(260 / size, t + 0.02); o.frequency.exponentialRampToValueAtTime(900 / size, t + 0.11);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t + 0.02); g.gain.linearRampToValueAtTime(0.55 * size, t + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    o.connect(g).connect(p); o.start(t); o.stop(t + 0.25);
  }

  leafLand() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(1500, t + 0.04);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.1);
  }

  tick() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.splashBuf || (this.splashBuf = this.noiseBuffer(0.4));
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 6;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    n.connect(bp).connect(g).connect(this.master); n.start(t); n.stop(t + 0.08);
  }

  // A soft bell-like note (two detuned partials).
  bell(t, freq, vol, dest) {
    const ctx = this.ctx;
    for (const [m, a] of [[1, 1], [2.01, 0.25], [3.02, 0.08]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq * m;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol * a, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0005, t + 1.6);
      o.connect(g).connect(dest); o.start(t); o.stop(t + 1.7);
    }
  }

  // Far-away town chime at dusk: an original pentatonic phrase, filtered and echoing.
  chime() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500;
    const g = ctx.createGain(); g.gain.value = 0.16;
    lp.connect(g); g.connect(this.master); g.connect(this.echo);
    const phrase = [4, 4, 5, 4, 2, 1, 2, 4, 3, 2, 1, 0];
    const dur = [1, 1, 1, 1, 2, 1, 1, 2, 1, 1, 1, 3];
    const base = 392; // G4
    let t = ctx.currentTime + 0.2;
    phrase.forEach((d, i) => {
      const oct = Math.floor(d / 5), deg = PENTA[d % 5] + oct * 12;
      this.bell(t, base * Math.pow(2, deg / 12) * 0.5, 0.5, lp);
      t += dur[i] * 0.42;
    });
  }

  fanfare(rank) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const g = ctx.createGain(); g.gain.value = 0.22; g.connect(this.master); g.connect(this.echo);
    const notes = rank === 1 ? [0, 2, 4, 7, 9, 12] : [0, 4, 7, 9];
    let t = ctx.currentTime + 0.05;
    for (const n of notes) { this.bell(t, 523.25 * Math.pow(2, n / 12), 0.5, g); t += 0.12; }
  }
}
