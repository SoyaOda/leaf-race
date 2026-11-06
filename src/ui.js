// DOM layer: screens, HUD, labels over leaves, mini-map, toasts, settings and the thermal report.
import * as THREE from 'three';
import { LEAF_TYPES, WORLD, RACE, TIERS } from './config.js?v=a087d61d0b56';
import { toWorld, STEPS, SPOTS } from './course.js?v=a087d61d0b56';
import { leafPreviewCanvas } from './leaves.js?v=a087d61d0b56';

const $ = (id) => document.getElementById(id);
const MAP_POINTS = 120;
const fmtTime = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

export class UI {
  constructor() {
    this.screens = ['loading', 'error', 'title', 'hud', 'result', 'pause', 'settings', 'thermal'];
    this.selected = 'momiji';
    try { this.selected = localStorage.getItem('leaf') || 'momiji'; } catch { /* storage unavailable */ }
    if (!LEAF_TYPES[this.selected]) this.selected = 'momiji';
    this.tags = new Map();
    this.v = new THREE.Vector3();
    for (const key of ['high', 'mid', 'low']) {
      const o = document.querySelector(`#selQuality option[value="${key}"]`);
      if (o) o.textContent = `${{ high: 'たかい', mid: 'ふつう', low: 'ひかえめ' }[key]}（${TIERS[key].nx}×${TIERS[key].nz}）`;
    }
  }

  show(name, keep = []) {
    for (const s of this.screens) {
      if (s === name || keep.includes(s)) $(s).hidden = false;
      else $(s).hidden = true;
    }
  }
  overlay(name, on) { $(name).hidden = !on; }

  loading(p, note) {
    $('loadFill').style.width = `${Math.round(p * 100)}%`;
    if (note) $('loadNote').textContent = note;
  }

  error(msg) {
    $('errorText').textContent = msg;
    this.show('error');
  }

  buildCards(onPick) {
    const wrap = $('cards');
    wrap.textContent = '';
    for (const [key, t] of Object.entries(LEAF_TYPES)) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'card'; b.id = `card-${key}`;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(key === this.selected));
      const img = document.createElement('img');
      img.alt = '';
      img.src = leafPreviewCanvas(key).toDataURL('image/png');
      const stat = (label, v) => `<div class="stat"><span>${label}</span><span class="dots">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= v ? 'on' : ''}"></i>`).join('')}</span></div>`;
      b.innerHTML = `<span class="kn">${t.kana}</span><span class="nm">${t.name}</span><span class="bl">${t.blurb}</span>
        <div class="stats">${stat('はやさ', t.stats.speed)}${stat('すりぬけ', t.stats.slip)}${stat('たき', t.stats.fall)}</div>`;
      b.prepend(img);
      b.addEventListener('click', () => {
        this.selected = key;
        try { localStorage.setItem('leaf', key); } catch { /* storage unavailable */ }
        wrap.querySelectorAll('.card').forEach((c) => c.setAttribute('aria-checked', String(c === b)));
        onPick?.(key);
      });
      wrap.appendChild(b);
    }
  }

  // The real shape of the stream, seen from above, with the falls marked.
  buildMinimap() {
    const svg = $('minimap');
    const W = 2.6;      // metres of world per SVG unit
    const raw = [];
    for (let i = 0; i <= MAP_POINTS; i++) {
      const sv = WORLD.DROP_S + (WORLD.FINISH_S - WORLD.DROP_S) * i / MAP_POINTS;
      raw.push(toWorld(sv, 0));
    }
    const xs = raw.map((p) => p[0]), zs = raw.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const scale = Math.min(34 / Math.max(0.1, x1 - x0), 190 / Math.max(0.1, z1 - z0));
    const pts = raw.map(([x, z]) => [20 + (x - (x0 + x1) / 2) * scale, 196 - (z - z0) * scale]);
    const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const at = (sv) => pts[Math.round((sv - WORLD.DROP_S) / (WORLD.FINISH_S - WORLD.DROP_S) * MAP_POINTS)];
    const falls = STEPS.map((st) => {
      const [x, y] = at(st.s), r = 2 + st.drop * 7;
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="rgba(250,252,255,0.9)" stroke="rgba(20,16,30,0.55)" stroke-width="1"/>`;
    }).join('');
    const traps = SPOTS.filter((sp) => sp.kind === 'trap' || sp.kind === 'eddy').map((sp) => {
      const [x, y] = at(sp.s);
      return `<rect x="${(x - 2.2).toFixed(1)}" y="${(y - 2.2).toFixed(1)}" width="4.4" height="4.4" transform="rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})" fill="rgba(235,214,170,0.92)" stroke="rgba(20,16,30,0.55)" stroke-width="0.8"/>`;
    }).join('');
    const end = pts[pts.length - 1];
    svg.innerHTML = `<path d="${d}" fill="none" stroke="rgba(20,16,30,0.35)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${d}" fill="none" stroke="rgba(150,205,225,0.8)" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      ${falls}${traps}
      <g transform="translate(${end[0].toFixed(1)},${(end[1] - 3).toFixed(1)})"><path d="M-6,0 L6,0" stroke="#f4efe6" stroke-width="2"/><path d="M-6,0 L0,0" stroke="#d0322a" stroke-width="2"/></g>`;
    this.mapPts = pts;
    this.mapDots = [];
    void W;
  }

  setRacers(leaves) {
    const svg = $('minimap');
    this.mapDots.forEach((c) => c.remove());
    this.mapDots = leaves.map((l) => {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('r', l.owner.isPlayer ? '5' : '3.6');
      c.setAttribute('fill', l.owner.color);
      c.setAttribute('stroke', l.owner.isPlayer ? '#fff' : 'rgba(20,16,30,0.6)');
      c.setAttribute('stroke-width', '1.5');
      svg.appendChild(c);
      return c;
    });
    const labels = $('labels');
    labels.textContent = '';
    this.tags.clear();
    for (const l of leaves) {
      const t = document.createElement('div');
      t.className = `tag${l.owner.isPlayer ? ' me' : ''}`;
      t.innerHTML = l.owner.isPlayer ? `${l.owner.name}` : `<i style="background:${l.owner.color}"></i>${l.owner.name}`;
      labels.appendChild(t);
      this.tags.set(l, t);
    }
  }

  updateRace(race, camera, w, h) {
    const order = race.ranking();
    const myRank = order.indexOf(race.player) + 1;
    const rk = $('rank');
    $('rankNum').textContent = race.state === 'aim' ? '-' : String(myRank);
    rk.classList.toggle('first', myRank === 1 && race.state !== 'aim');
    $('clock').textContent = fmtTime(race.time);
    // pebbles
    const pb = $('pebbles');
    if (pb.childElementCount !== RACE.pebbles) pb.innerHTML = '<i></i>'.repeat(RACE.pebbles);
    [...pb.children].forEach((c, i) => c.classList.toggle('used', i >= race.playerPebbles));
    // map dots
    race.leaves.forEach((l, i) => {
      const p = Math.min(1, Math.max(0, (l.s - WORLD.DROP_S) / (WORLD.FINISH_S - WORLD.DROP_S)));
      const idx = Math.min(MAP_POINTS - 1, Math.floor(p * MAP_POINTS)), f = p * MAP_POINTS - idx;
      const a = this.mapPts[idx], b = this.mapPts[idx + 1];
      const c = this.mapDots[i];
      if (!c) return;
      c.setAttribute('cx', (a[0] + (b[0] - a[0]) * f).toFixed(1));
      c.setAttribute('cy', (a[1] + (b[1] - a[1]) * f).toFixed(1));
    });
    // labels
    for (const l of race.leaves) {
      const t = this.tags.get(l);
      if (!t) continue;
      const visible = l.mesh.visible && (l.state === 'water' || l.state === 'air' || l.state === 'hand' || l.state === 'falling');
      this.v.set(l.x, l.y + 0.035, l.z).project(camera);
      if (!visible || this.v.z > 1 || Math.abs(this.v.x) > 1.1 || Math.abs(this.v.y) > 1.1) { t.style.opacity = '0'; continue; }
      const sx = (this.v.x * 0.5 + 0.5) * w, sy = (1 - (this.v.y * 0.5 + 0.5)) * h;
      t.style.opacity = '1';
      t.style.transform = `translate(${sx.toFixed(1)}px, ${(sy - 12).toFixed(1)}px) translate(-50%, -100%)`;
      t.classList.toggle('poke', l.owner.isPlayer && race.state === 'race' && l.state === 'water' && (l.heldTime >= 1 || !!l.step));
      t.classList.toggle('under', l.zeta > 0.006);
    }
  }

  hint(html) {
    const h = $('hint');
    h.innerHTML = html || '';
    h.style.opacity = html ? '1' : '0';
  }

  // The name of the stretch ahead, set quietly in the corner like a signpost.
  spot(name) {
    const el = $('spotName');
    el.textContent = name;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  toast(msg) {
    const box = $('toasts');
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 2700);
    while (box.childElementCount > 3) box.firstElementChild.remove();
  }

  bigText(msg) {
    const g = document.createElement('div');
    g.className = 'go'; g.textContent = msg;
    $('hud').appendChild(g);
    setTimeout(() => g.remove(), 1300);
  }

  results(res, newBest) {
    const now = new Date();
    $('nbDate').textContent = `${now.getMonth() + 1}月${now.getDate()}日（${'日月火水木金土'[now.getDay()]}）　はれ`;
    const me = res.find((r) => r.isPlayer);
    $('nbTitle').textContent = me.rank === 1 ? 'いちばん！' : `${me.rank}ばんだった`;
    $('nbList').innerHTML = res.map((r) => `<li class="${r.isPlayer ? 'me' : ''}"><span class="n">${r.rank}.</span><span class="c" style="background:${r.color}"></span><span>${r.name}<span class="lf">${r.leaf}</span></span><span class="t">${r.time != null ? fmtTime(r.time) : `あと${Math.max(1, Math.round((1 - r.progress) * (WORLD.FINISH_S - WORLD.DROP_S)))}m`}</span></li>`).join('');
    $('nbNote').innerHTML = `${this.diaryLine(res)}<br>${newBest ? 'じこベスト更新。' : ''}またあした。`;
  }

  // What happened to your leaf, in the words of a kid writing it down that evening.
  diaryLine(res) {
    const me = res.find((r) => r.isPlayer);
    const longest = [...me.diary].sort((a, b) => b.seconds - a.seconds)[0];
    if (longest) {
      const sec = Math.round(longest.seconds);
      const place = SPOTS.filter((sp) => sp.s <= longest.s + 0.6).pop()?.name ?? '川';
      if (longest.kind === 'fall') return `${place}で、水におさえつけられて${sec}びょう。息をのんだ。`;
      if (longest.kind === 'rock') return `${place}で、石のあいだに${sec}びょう はさまった。`;
      if (longest.kind === 'eddy') return `${place}で、${sec}びょう ぐるぐる回ってた。`;
      return `${place}の浅いところで、${sec}びょう ひとやすみ。`;
    }
    if (me.rank === 1) return `${res[1].name}が「あしたもやろうぜ」って言った。`;
    return `${res[0].name}に、あと少しだった。`;
  }

  perf(text) { const p = $('perf'); p.hidden = !text; if (text) p.textContent = text; }

  thermalRunning(on, left) {
    $('thermalRun').hidden = !on;
    if (on) $('thermalLeft').textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
  }

  thermalReport(summary) {
    this.show('thermal', ['title']);
    $('thermalVerdict').textContent = `最初の1分 ${summary.firstMinFps} fps → 最後の1分 ${summary.lastMinFps} fps（低下 ${summary.dropPct}%）。スロットリング: ${summary.verdict}`;
    const cv = $('thermalChart');
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height, pad = 34;
    g.clearRect(0, 0, W, H);
    g.font = '12px "Zen Kaku Gothic New", sans-serif';
    const maxF = 65;
    g.strokeStyle = 'rgba(255,245,232,0.12)'; g.fillStyle = 'rgba(255,245,232,0.6)';
    for (const f of [0, 15, 30, 45, 60]) {
      const y = H - pad - (f / maxF) * (H - pad * 1.6);
      g.beginPath(); g.moveTo(pad, y); g.lineTo(W - 10, y); g.stroke();
      g.fillText(String(f), 6, y + 4);
    }
    for (const s of [0, 60, 120, 180, 240, 300]) {
      const x = pad + (s / 300) * (W - pad - 10);
      g.fillText(`${s / 60}分`, x - 8, H - 10);
    }
    const rows = summary.rows;
    const X = (t) => pad + (t / 300) * (W - pad - 10), Y = (f) => H - pad - (f / maxF) * (H - pad * 1.6);
    g.strokeStyle = 'rgba(240,128,58,0.35)'; g.lineWidth = 6; g.lineJoin = 'round';
    g.beginPath(); rows.forEach((r, i) => { const y = Y(1000 / r.p95); if (i) g.lineTo(X(r.t), y); else g.moveTo(X(r.t), y); }); g.stroke();
    g.strokeStyle = '#f0803a'; g.lineWidth = 2.5;
    g.beginPath(); rows.forEach((r, i) => { if (i) g.lineTo(X(r.t), Y(r.fps)); else g.moveTo(X(r.t), Y(r.fps)); }); g.stroke();
    if (rows.length) { const r = rows[rows.length - 1]; g.fillStyle = '#f0803a'; g.beginPath(); g.arc(X(r.t), Y(r.fps), 4, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = 'rgba(255,245,232,0.7)';
    g.fillText('平均fps（線）／p95フレームのfps（帯）', pad, 16);
    const write = () => {
      const feel = document.querySelector('input[name="feel"]:checked')?.value ?? null;
      $('thermalJson').value = JSON.stringify({ ...summary, feel }, null, 1);
    };
    write();
    document.querySelectorAll('input[name="feel"]').forEach((r) => { r.onchange = write; });
  }
}
