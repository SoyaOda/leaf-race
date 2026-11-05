// Frame-time statistics, dynamic resolution, and the 5-minute thermal run.
export class PerfMonitor {
  constructor() {
    this.samples = new Float32Array(240);   // last ~4 s of frame intervals (ms)
    this.n = 0; this.head = 0;
    this.emaMs = 16.7;
    this.slowFor = 0; this.fastFor = 0;
    this.thermal = null;
  }

  push(ms) {
    this.samples[this.head] = ms;
    this.head = (this.head + 1) % this.samples.length;
    this.n = Math.min(this.n + 1, this.samples.length);
    this.emaMs += (ms - this.emaMs) * 0.05;
    if (this.thermal) this.thermal.bucket.push(ms);
  }

  stats() {
    const a = Array.from(this.samples.subarray(0, this.n)).sort((x, y) => x - y);
    if (!a.length) return { fps: 0, p50: 0, p95: 0 };
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    return { fps: 1000 / mean, p50: a[Math.floor(a.length * 0.5)], p95: a[Math.floor(a.length * 0.95)] };
  }

  // Returns a new scale or null. Steps down quickly when frames are missed, creeps up slowly.
  adapt(dt, scale, minScale, maxScale, targetMs) {
    if (this.thermal && this.thermal.lockScale) return null;
    if (this.emaMs > targetMs * 1.12) { this.slowFor += dt; this.fastFor = 0; }
    else if (this.emaMs < targetMs * 1.03) { this.fastFor += dt; this.slowFor = 0; }
    else { this.slowFor = 0; this.fastFor = 0; }
    if (this.slowFor > 0.8 && scale > minScale) { this.slowFor = 0; return Math.max(minScale, scale - 0.06); }
    if (this.fastFor > 6 && scale < maxScale) { this.fastFor = 0; return Math.min(maxScale, scale + 0.03); }
    return null;
  }

  startThermal(durationSec, info) {
    this.thermal = { start: performance.now(), duration: durationSec * 1000, bucket: [], rows: [], info, lockScale: true, done: false };
  }

  // call once per frame; returns true when the run just finished
  tickThermal(scale) {
    const t = this.thermal;
    if (!t || t.done) return false;
    const el = performance.now() - t.start;
    const bucketIndex = Math.floor(el / 10000);
    if (bucketIndex > t.rows.length && t.bucket.length) {
      const a = t.bucket.slice().sort((x, y) => x - y);
      const mean = a.reduce((s, v) => s + v, 0) / a.length;
      t.rows.push({ t: t.rows.length * 10 + 10, fps: +(1000 / mean).toFixed(1), p50: +a[Math.floor(a.length / 2)].toFixed(1), p95: +a[Math.floor(a.length * 0.95)].toFixed(1), scale: +scale.toFixed(2) });
      t.bucket = [];
    }
    if (el >= t.duration) { t.done = true; return true; }
    return false;
  }

  thermalSummary() {
    const t = this.thermal;
    const rows = t.rows;
    const avg = (r) => r.reduce((s, x) => s + x.fps, 0) / Math.max(1, r.length);
    const first = avg(rows.slice(0, 6)), last = avg(rows.slice(-6));
    const drop = first > 0 ? (1 - last / first) : 0;
    const verdict = drop < 0.05 ? 'なし' : drop < 0.15 ? '軽度' : '顕著';
    return { firstMinFps: +first.toFixed(1), lastMinFps: +last.toFixed(1), dropPct: +(drop * 100).toFixed(1), verdict, rows, info: t.info };
  }
}
