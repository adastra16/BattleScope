// 02 · MAP LAB — heatmaps and event markers over a time window, with a click-to-inspect zone card.
import { api } from '../api.js';
import { MapCanvas } from '../mapview.js';
import { drawMarkers } from '../render.js';
import { RAMP_CSS } from '../heatmap.js';
import { CATEGORY_OF, COLORS, HEAT_LAYERS, TAGS, cellId, describeEvent, fmtTime, playersFlags, prettyMap } from '../constants.js';
import {
  MARKER_ICONS, blip, dayChips, daysParam, debounce, field, h, latestGuard, markerChips, panel, pct, segmented, tagBadge, timeWindow, toggle, viewHead,
} from '../ui.js';

export function mount(root, app) {
  const { meta } = app;
  const S = (app.state.explore ??= {
    days: new Set(meta.days), players: 'humans', layer: 'death',
    cats: { kill: false, death: false, storm: false, loot: false },
    tMax: 0, tFrom: 0, tTo: 0, lastMap: null, opacity: 0.75, grid: false, cell: null,
  });
  if (app.query.layer && HEAT_LAYERS.some((l) => l.key === app.query.layer)) S.layer = app.query.layer;
  const guard = latestGuard();
  let alive = true, events = null, zones = null, hits = [], hoverHit = null, raf = 0, sweeping = false, heatTotal = 0;
  let flow = null, flowHits = [], animRaf = 0;
  const fp = () => ({ ...playersFlags(S.players), days: daysParam(S.days, meta.days) });

  // ---- filters
  const mapSeg = segmented(Object.keys(meta.maps).map((m) => ({ value: m, label: prettyMap(m) })), app.prefs.map, (v) => {
    app.prefs.map = v; S.cell = null; app.setQuery({ map: v, layer: S.layer }); map.setMap(meta.maps[v].image); refresh();
  });
  const chips = dayChips(meta.days, null, S.days, () => refresh());
  const playersSeg = segmented([{ value: 'humans', label: 'Humans' }, { value: 'bots', label: 'Bots' }, { value: 'both', label: 'Both' }],
    S.players, (v) => { S.players = v; refresh(); });
  const layerSeg = segmented(HEAT_LAYERS.map((l) => ({ value: l.key, label: l.label })), S.layer, (v) => {
    S.layer = v; app.setQuery({ map: app.prefs.map, layer: v }); refreshHeat(); renderLegend();
  });
  const markers = markerChips(S.cats, () => { refreshEvents(); renderLegend(); map.invalidate(); });
  const heatSoon = debounce(() => refreshHeat(), 120);
  const tw = timeWindow({ max: S.tMax || 600, from: S.tFrom, to: S.tTo || S.tMax || 600, onChange: (lo, hi) => { S.tFrom = lo; S.tTo = hi; map.invalidate(); heatSoon(); renderStats(); } });
  const sweepBtn = h('button', { type: 'button', class: 'btn ghost', onclick: () => toggleSweep() }, '▶ Sweep');
  const opacity = h('input', { type: 'range', min: 0.2, max: 1, step: 0.05, value: S.opacity, 'aria-label': 'Heat opacity', oninput: (e) => { S.opacity = +e.target.value; map.heatOpacity = S.opacity; map.invalidate(); } });
  const gridToggle = toggle('Zone grid', S.grid, (v) => { S.grid = v; map.grid = v; map.invalidate(); });

  const statsEl = h('span', { class: 'mono dim' });
  const legendEl = h('div', { class: 'legend' });
  const inspector = h('div', { class: 'inspector' });
  const mapHost = h('div', { class: 'map-host' });
  const map = new MapCanvas(mapHost, { interactive: true, controls: true });
  map.heatOpacity = S.opacity; map.grid = S.grid;
  map.wrap.append(legendEl);
  map.setMap(meta.maps[app.prefs.map].image);

  root.append(h('div', { class: 'view' },
    viewHead('02 · MAP LAB', 'Where does it happen?', 'Paint the map with where things happen, or switch to Flow to watch where players actually walk. Click a zone to hear it gossip.'),
    h('section', { class: 'filters panel' },
      h('div', { class: 'frow' }, field('🗺️ Map', mapSeg), field('📅 Dates', chips), field('👥 Players', playersSeg)),
      h('div', { class: 'frow' }, field('🔥 Heatmap', layerSeg), field('📍 Markers', markers), field('⏱️ Match-time window', h('div', { class: 'inline' }, tw, sweepBtn)), field('🌫️ Heat opacity', opacity), field('🔲 Overlay', gridToggle))),
    h('div', { class: 'grid-explore' },
      panel({ title: 'Map', actions: statsEl }, mapHost),
      panel({ title: 'Zone inspector', sub: 'Click anywhere on the map' }, inspector))));

  // ---- overlay: selected-zone outline + markers inside the time window
  map.overlay = (ctx, view) => {
    if (S.cell != null) {
      const col = S.cell % 8, row = Math.floor(S.cell / 8);
      const [x0, y0] = view.toScreen(col / 8, 1 - row / 8);
      const [x1, y1] = view.toScreen((col + 1) / 8, 1 - (row + 1) / 8);
      ctx.save();
      ctx.fillStyle = 'rgba(255,232,20,.10)'; ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = '#ffe814'; ctx.lineWidth = 2; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    }
    drawFlow(ctx, view);
    hits = [];
    if (!events) return;
    for (let i = 0; i < events.count; i++) {
      const cat = CATEGORY_OF[events.code[i]];
      const t = events.t[i];
      if (!S.cats[cat] || t < S.tFrom || t > S.tTo) continue;
      const [sx, sy] = view.toScreen(events.u[i], events.v[i]);
      if (sx < -10 || sy < -10 || sx > view.w + 10 || sy > view.h + 10) continue;
      hits.push({ x: sx, y: sy, cat, bot: !!events.bot[i], code: events.code[i], t, matchId: events.matchIds[events.match[i]] });
    }
    drawMarkers(ctx, hits, Math.min(1.6, Math.max(0.6, Math.pow(view.zoom, 0.35) * 0.75)));
  };

  // ---- flow layer: curved arrows between zone centres; thickness = crossings, dashes march the way players walk
  const zoneCentre = (view, i) => view.toScreen(((i % 8) + 0.5) / 8, 1 - (Math.floor(i / 8) + 0.5) / 8);
  const mixHex = (a, b, t) => `rgb(${[0, 2, 4].map((k) => Math.round(parseInt(a.slice(1 + k, 3 + k), 16) * (1 - t) + parseInt(b.slice(1 + k, 3 + k), 16) * t)).join(',')})`;
  function drawFlow(ctx, view) {
    flowHits = [];
    if (S.layer !== 'flow' || !flow?.edges.length) return;
    const top = flow.edges.slice(0, 32), max = top[0].n, clock = performance.now() / 1000;
    const nodes = new Set();
    ctx.save();
    ctx.lineCap = 'round';
    for (const e of top) {
      const [ax, ay] = zoneCentre(view, e.from), [bx, by] = zoneCentre(view, e.to);
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      const cx = (ax + bx) / 2 - (dy / len) * Math.min(18, len * 0.22), cy = (ay + by) / 2 + (dx / len) * Math.min(18, len * 0.22); // bow sideways so A→B and B→A don't overlap
      const k = Math.sqrt(e.n / max), w = 1.5 + 6.5 * k, col = k < 0.5 ? mixHex('#4cc9ff', '#ff3df0', k * 2) : mixHex('#ff3df0', '#ffe814', (k - 0.5) * 2); // blue → magenta → yellow
      nodes.add(e.from); nodes.add(e.to);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by);
      ctx.setLineDash([]); ctx.strokeStyle = 'rgba(7,4,26,.85)'; ctx.lineWidth = w + 3; ctx.stroke();
      ctx.setLineDash([w * 2.4, w * 1.8]); ctx.lineDashOffset = -clock * (28 + 30 * k); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke();
      // arrowhead at 62% along the curve
      const t = 0.62, mt = 1 - t;
      const px = mt * mt * ax + 2 * mt * t * cx + t * t * bx, py = mt * mt * ay + 2 * mt * t * cy + t * t * by;
      const tx = 2 * mt * (cx - ax) + 2 * t * (bx - cx), ty = 2 * mt * (cy - ay) + 2 * t * (by - cy), tl = Math.hypot(tx, ty) || 1;
      const ux = tx / tl, uy = ty / tl, s = 5 + w * 1.5;
      ctx.setLineDash([]); ctx.fillStyle = col; ctx.strokeStyle = '#07041a'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(px + ux * s, py + uy * s); ctx.lineTo(px - ux * s * 0.6 - uy * s * 0.8, py - uy * s * 0.6 + ux * s * 0.8); ctx.lineTo(px - ux * s * 0.6 + uy * s * 0.8, py - uy * s * 0.6 - ux * s * 0.8); ctx.closePath(); ctx.stroke(); ctx.fill();
      flowHits.push({ x: px, y: py, e });
    }
    for (const i of nodes) { // zone nodes
      const [x, y] = zoneCentre(view, i);
      ctx.beginPath(); ctx.arc(x, y, i === S.cell ? 7 : 4.5, 0, Math.PI * 2); ctx.fillStyle = i === S.cell ? '#ffe814' : '#fff'; ctx.strokeStyle = '#07041a'; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  function animate(on) {
    cancelAnimationFrame(animRaf);
    if (!on) return;
    const tick = () => { if (!alive || S.layer !== 'flow') return; map.invalidate(); animRaf = requestAnimationFrame(tick); };
    animRaf = requestAnimationFrame(tick);
  }

  const cellAt = (e) => (e?.inside ? Math.min(7, Math.floor((1 - e.v) * 8)) * 8 + Math.min(7, Math.floor(e.u * 8)) : null);
  const nearest = (e) => {
    let best = null, bd = 64;
    for (const k of hits) { const d = (k.x - e.sx) ** 2 + (k.y - e.sy) ** 2; if (d < bd) { bd = d; best = k; } }
    return best;
  };
  map.onHover = (e) => {
    if (!e) { hoverHit = null; return; }
    hoverHit = nearest(e);
    if (hoverHit) {
      map.showTip(`<b class="c-${hoverHit.cat}">${describeEvent(hoverHit.code, hoverHit.bot)}</b> <span class="dim">· ${hoverHit.bot ? 'bot' : 'human'} · ${fmtTime(hoverHit.t)}</span><div class="dim">match ${hoverHit.matchId.slice(0, 8)} · click to replay</div>`, e.sx, e.sy);
      map.canvas.style.cursor = 'pointer';
      return;
    }
    const fe = flowHits.find((k) => (k.x - e.sx) ** 2 + (k.y - e.sy) ** 2 < 256);
    if (fe) { map.showTip(`<b>${cellId(fe.e.from % 8, fe.e.from >> 3)} ➜ ${cellId(fe.e.to % 8, fe.e.to >> 3)}</b> <span class="dim">· ${fe.e.n} crossings by ${fe.e.runs} runs</span>`, e.sx, e.sy); map.canvas.style.cursor = 'help'; return; }
    map.canvas.style.cursor = '';
    const c = zones?.cells[cellAt(e)];
    if (c && c.tag !== 'none') map.showTip(`<b>${c.id}</b> <span class="dim">· ${TAGS[c.tag].label}</span>`, e.sx, e.sy); else map.hideTip();
  };
  map.onClick = (e) => {
    const hit = nearest(e);
    if (hit) { app.go('replay', { map: app.prefs.map, match: hit.matchId, t: Math.max(0, Math.round(hit.t - 15)) }); return; }
    S.cell = cellAt(e);
    renderInspector(); map.invalidate();
  };

  // ---- panels
  function renderLegend() {
    const layer = HEAT_LAYERS.find((l) => l.key === S.layer);
    const on = Object.entries(S.cats).filter(([, v]) => v).map(([k]) => k);
    legendEl.hidden = S.layer === 'off' && !on.length;
    legendEl.innerHTML = `${S.layer === 'flow' ? '<div class="hd">Player flow</div><div class="li wrap"><span>➜ thicker + hotter (blue → pink → yellow) = more crossings</span><span>dashes move the way players walk</span></div>' : ''}${S.layer !== 'off' && S.layer !== 'flow' ? `<div class="hd">${layer.label} density</div><div class="li"><span class="dim">low</span><span class="ramp" style="background:${RAMP_CSS}"></span><span class="dim">high</span></div>` : ''}
      ${on.length ? `<div class="hd">Markers <span class="dim">(filled = human, hollow = bot)</span></div><div class="li wrap">${on.map((k) => `<span class="mk">${MARKER_ICONS[k]}${k}</span>`).join('')}</div>` : ''}`;
  }

  function renderStats() {
    statsEl.textContent = `${S.layer === 'off' ? 'no heat layer' : S.layer === 'flow' ? `${heatTotal.toLocaleString()} zone crossings` : `${heatTotal.toLocaleString()} ${S.layer} points`} · ${fmtTime(S.tFrom)}–${fmtTime(S.tTo)}${zones ? ` · ${zones.matches} matches` : ''}`;
  }

  function renderInspector() {
    const c = S.cell != null && zones ? zones.cells[S.cell] : null;
    if (!c) {
      inspector.replaceChildren(h('div', { class: 'empty-state' }, blip(64), h('p', {}, 'Click a zone and I\'ll gossip: how busy it is, what it pays out, and how lethal it is.')));
      return;
    }
    const flowBox = h('div', { class: 'flowbox' }, h('span', { class: 'dim' }, 'tracing routes…'));
    const max = (k) => Math.max(0.0001, ...zones.cells.map((z) => z[k]));
    const meter = (label, key, color) => h('div', { class: 'meter' },
      h('div', { class: 'm-top' }, h('span', {}, label), h('b', {}, pct(c[key], 1))),
      h('div', { class: 'm-bar' }, h('i', { style: { width: `${(c[key] / max(key)) * 100}%`, background: color } })));
    inspector.replaceChildren(
      h('div', { class: 'insp-head' }, h('span', { class: 'zid' }, c.id), tagBadge(c.tag, TAGS)),
      h('p', { class: 'blurb' }, TAGS[c.tag].blurb),
      meter('Traffic', 'tShare', COLORS.human), meter('Loot', 'lShare', COLORS.loot), meter('Kills', 'kShare', COLORS.kill),
      meter('Deaths', 'dShare', COLORS.death), meter('Storm deaths', 'sShare', COLORS.storm),
      h('dl', { class: 'facts' },
        h('div', {}, h('dt', {}, 'Seen in'), h('dd', {}, `${pct(c.visits, zones.matches)} of matches`)),
        h('div', {}, h('dt', {}, 'Risk'), h('dd', {}, c.risk != null ? `${c.risk}× fair share` : '–')),
        h('div', {}, h('dt', {}, 'Reward'), h('dd', {}, c.reward != null ? `${c.reward}× fair share` : '–'))),
      flowBox,
      h('button', { type: 'button', class: 'btn', onclick: () => app.go('radar', { map: app.prefs.map }) }, 'See all zones in Design Radar →'));
    api.flow(app.prefs.map, fp()).then((fl) => {
      if (!alive || S.cell !== c.i) return;
      const top = (edges, key, other) => edges.filter((e) => e[key] === c.i).slice(0, 3).map((e) => h('li', {}, h('b', { class: 'mono' }, cellId(e[other] % 8, e[other] >> 3)), h('span', { class: 'dim' }, ` ${e.n}×`)));
      const inn = top(fl.edges, 'to', 'from'), out = top(fl.edges, 'from', 'to');
      flowBox.replaceChildren(
        h('div', {}, h('h5', {}, '⬅ Arrive from'), h('ul', {}, inn.length ? inn : h('li', { class: 'dim' }, 'nobody (spawn?)'))),
        h('div', {}, h('h5', {}, '➡ Leave to'), h('ul', {}, out.length ? out : h('li', { class: 'dim' }, 'nowhere (dead end)'))));
    }).catch(() => {});
  }

  // ---- data
  async function refresh() {
    const map_ = app.prefs.map, p = fp();
    api.matches(map_, { limit: 1 }).then((r) => alive && chips.setCounts(r.dayCounts)).catch(() => {});
    try {
      const [sum, z] = await Promise.all([guard('sum', api.summary(map_, p)), guard('zones', api.zones(map_, p))]);
      zones = z;
      const grew = S.lastMap !== map_ || S.tTo >= S.tMax;
      S.tMax = Math.max(60, sum.t_max);
      if (grew) { S.tFrom = 0; S.tTo = S.tMax; } else { S.tFrom = Math.min(S.tFrom, S.tMax); S.tTo = Math.min(S.tTo, S.tMax); }
      S.lastMap = map_;
      tw.set(S.tFrom, S.tTo, S.tMax);
    } catch (e) { if (!e.stale) app.error(e); return; }
    renderInspector(); renderLegend();
    refreshHeat(); refreshEvents();
  }

  async function refreshHeat() {
    const win = { ...fp(), t_min: S.tFrom > 0 ? S.tFrom : undefined, t_max: S.tTo < S.tMax ? S.tTo : undefined };
    if (S.layer === 'flow') {
      map.heatOn = false;
      try { flow = await guard('flow', api.flow(app.prefs.map, win)); heatTotal = flow.crossings; map.invalidate(); renderStats(); animate(true); } catch (e) { if (!e.stale) app.error(e); }
      return;
    }
    flow = null; animate(false);
    if (S.layer === 'off') { map.heatOn = false; heatTotal = 0; map.invalidate(); renderStats(); return; }
    const params = { ...win, layer: S.layer };
    try {
      const g = await guard('heat', api.heatmap(app.prefs.map, params));
      map.heat.build(g); map.heatOn = true; heatTotal = g.total;
      map.invalidate(); renderStats();
    } catch (e) { if (!e.stale) app.error(e); }
  }

  async function refreshEvents() {
    if (!Object.values(S.cats).some(Boolean)) { events = null; map.invalidate(); return; }
    try { events = await guard('events', api.events(app.prefs.map, fp())); map.invalidate(); } catch (e) { if (!e.stale) app.error(e); }
  }

  // ---- sweep: grow the window's end from its start to the end of the match, so the map "fills in"
  function toggleSweep() {
    if (sweeping) { stopSweep(); return; }
    sweeping = true; sweepBtn.textContent = '❚❚ Pause';
    if (S.tTo >= S.tMax) S.tTo = S.tFrom;
    let last = performance.now(), lastBucket = -1;
    const step = (now) => {
      if (!sweeping || !alive) return;
      S.tTo = Math.min(S.tMax, S.tTo + ((now - last) / 1000) * Math.max(20, S.tMax / 20));
      last = now;
      tw.set(S.tFrom, S.tTo);
      map.invalidate(); renderStats();
      const bucket = Math.floor(S.tTo / 10);
      if (bucket !== lastBucket) { lastBucket = bucket; refreshHeat(); }
      if (S.tTo >= S.tMax) { stopSweep(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  function stopSweep() { sweeping = false; sweepBtn.textContent = '▶ Sweep'; cancelAnimationFrame(raf); refreshHeat(); }

  refresh();
  return () => { alive = false; sweeping = false; cancelAnimationFrame(raf); cancelAnimationFrame(animRaf); map.destroy(); };
}
