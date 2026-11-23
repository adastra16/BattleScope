// 04 · COMPARE — two filtered slices of the same map side by side, plus a difference map between them.
import { api } from '../api.js';
import { MapCanvas } from '../mapview.js';
import { HEAT_LAYERS, SIDE_COLORS, cellId, fmtDay, fmtTime, playersFlags, prettyMap } from '../constants.js';
import { countUp, dayChips, daysParam, field, h, latestGuard, panel, segmented, select, timeWindow, viewHead } from '../ui.js';

const LAYERS = HEAT_LAYERS.filter((l) => l.key !== 'off' && l.key !== 'flow');
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

export function mount(root, app) {
  const { meta } = app;
  const freshSide = () => ({ layer: 'traffic', days: new Set(meta.days), players: 'humans', tFrom: 0, tTo: null });
  const PRESETS = {
    players: { label: 'Humans vs Bots', desc: 'Do bots roam where humans do?', apply: (a, b) => { a.players = 'humans'; b.players = 'bots'; } },
    fight: { label: 'Kills vs Deaths', desc: 'Where players win fights vs lose them', apply: (a, b) => { a.layer = 'kill'; b.layer = 'death'; } },
    risk: { label: 'Loot vs Deaths', desc: 'Is reward matched with risk?', apply: (a, b) => { a.layer = 'loot'; b.layer = 'death'; } },
    phase: { label: 'Early vs Late', desc: 'First 5 minutes vs the rest', apply: (a, b) => { a.tTo = 300; b.tFrom = 300; } },
    days: { label: 'Day vs Day', desc: 'Did a day look different?', apply: (a, b) => { a.days = new Set([meta.days[0]]); b.days = new Set([meta.days[meta.days.length - 2]]); } },
  };
  const S = (app.state.compare ??= { preset: 'risk', A: null, B: null });
  const applyPreset = (key) => {
    S.preset = key; S.A = freshSide(); S.B = freshSide();
    if (PRESETS[key]) PRESETS[key].apply(S.A, S.B);
  };
  if (!S.A) applyPreset(S.preset);
  const guard = latestGuard();
  let alive = true, tMax = 600, syncing = false;
  const side = { A: S.A, B: S.B };

  const mapSeg = segmented(Object.keys(meta.maps).map((m) => ({ value: m, label: prettyMap(m) })), app.prefs.map, (v) => {
    app.prefs.map = v; app.setQuery({ map: v }); [mapA, mapB, mapD].forEach((m) => m.setMap(meta.maps[v].image)); refresh();
  });
  const presetBar = h('div', { class: 'presets' });
  const stripA = h('div', { class: 'strip' }), stripB = h('div', { class: 'strip' });
  const statsEl = h('div', { class: 'diff-stats' });
  const titleA = h('span', { class: 'mono dim' }), titleB = h('span', { class: 'mono dim' });

  const mk = (parent) => { const m = new MapCanvas(parent, { interactive: true, controls: false }); m.setMap(meta.maps[app.prefs.map].image); return m; };
  const hostA = h('div', { class: 'map-host sq' }), hostB = h('div', { class: 'map-host sq' }), hostD = h('div', { class: 'map-host sq' });
  const mapA = mk(hostA), mapB = mk(hostB), mapD = mk(hostD);
  const maps = [mapA, mapB, mapD];
  maps.forEach((m) => { m.onViewChange = (src) => { if (syncing) return; syncing = true; maps.forEach((o) => o !== src && o.syncFrom(src)); syncing = false; }; });
  mapA.heatOpacity = mapB.heatOpacity = 0.8; mapD.heatOpacity = 0.95;

  root.append(h('div', { class: 'view' },
    viewHead('04 · COMPARE', 'What changes between two slices?', 'Spot the difference (there\'s even a score). The centre map shows where one side dominates; all three maps pan and zoom together.'),
    h('section', { class: 'filters panel' }, h('div', { class: 'frow' }, field('🗺️ Map', mapSeg), field('🆚 Comparison', presetBar))),
    h('div', { class: 'grid-compare' },
      panel({ title: h('span', {}, h('i', { class: 'sidedot', style: { background: SIDE_COLORS.A } }), 'Side A'), actions: titleA, cls: 'side-a' }, hostA, stripA),
      panel({ title: 'Difference', sub: 'Share of A\'s activity minus share of B\'s', cls: 'diff-panel' }, hostD, statsEl),
      panel({ title: h('span', {}, h('i', { class: 'sidedot', style: { background: SIDE_COLORS.B } }), 'Side B'), actions: titleB, cls: 'side-b' }, hostB, stripB))));

  // ---- controls
  function renderPresets() {
    presetBar.replaceChildren(...Object.entries(PRESETS).map(([k, p]) => h('button', {
      type: 'button', class: `preset ${S.preset === k ? 'on' : ''}`, title: p.desc,
      onclick: () => { applyPreset(k); side.A = S.A; side.B = S.B; renderPresets(); renderStrips(); refresh(); },
    }, p.label)), h('span', { class: 'dim preset-desc' }, PRESETS[S.preset]?.desc || 'Custom comparison'));
  }
  function custom() { S.preset = 'custom'; renderPresets(); }

  function strip(key, host) {
    const sd = side[key];
    const chips = dayChips(meta.days, null, sd.days, () => { custom(); refresh(); }, { compact: true });
    const layer = select(LAYERS.map((l) => ({ value: l.key, label: l.label })), sd.layer, (v) => { sd.layer = v; custom(); refresh(); });
    const players = segmented([{ value: 'humans', label: 'H' }, { value: 'bots', label: 'B' }, { value: 'both', label: 'H+B' }], sd.players, (v) => { sd.players = v; custom(); refresh(); });
    const tw = timeWindow({ max: tMax, from: sd.tFrom, to: sd.tTo ?? tMax, onChange: (lo, hi) => { sd.tFrom = lo; sd.tTo = hi >= tMax ? null : hi; custom(); soon(); } });
    host.replaceChildren(field('🎚️ Layer', layer), field('👥 Players', players), field('📅 Days', chips), field('⏱️ Match time', tw));
    host.tw = tw;
  }
  const soon = (() => { let t; return () => { clearTimeout(t); t = setTimeout(refresh, 150); }; })();
  function renderStrips() { strip('A', stripA); strip('B', stripB); }

  const label = (sd) => `${HEAT_LAYERS.find((l) => l.key === sd.layer).label} · ${{ humans: 'humans', bots: 'bots', both: 'all' }[sd.players]} · ${sd.days.size === meta.days.length ? 'all days' : [...sd.days].map(fmtDay).join(', ')} · ${fmtTime(sd.tFrom)}–${sd.tTo == null ? 'end' : fmtTime(sd.tTo)}`;
  const params = (sd) => ({ ...playersFlags(sd.players), days: daysParam(sd.days, meta.days), layer: sd.layer, t_min: sd.tFrom > 0 ? sd.tFrom : undefined, t_max: sd.tTo ?? undefined });

  // ---- diff statistics on the 8x8 zone grid
  function zoneShares(g) {
    const a = new Float64Array(64);
    for (let i = 0; i < g.cells.length; i++) {
      const c = g.cells[i], f = g.n / 8;
      a[Math.floor(Math.floor(c / g.n) / f) * 8 + Math.floor((c % g.n) / f)] += g.counts[i];
    }
    const tot = a.reduce((x, y) => x + y, 0) || 1;
    return a.map((v) => v / tot);
  }
  function renderStats(ga, gb) {
    const A = zoneShares(ga), B = zoneShares(gb);
    let sim = 0;
    for (let i = 0; i < 64; i++) sim += Math.min(A[i], B[i]);
    const diffs = [...A].map((a, i) => ({ id: cellId(i % 8, (i / 8) | 0), d: a - B[i] }));
    const top = (arr) => arr.slice(0, 3).map((x) => `<b>${x.id}</b> <span class="dim">${x.d > 0 ? '+' : '−'}${(Math.abs(x.d) * 100).toFixed(1)} pts</span>`).join('<br>') || '<span class="dim">none</span>';
    const aHeavy = diffs.filter((x) => x.d > 0.002).sort((x, y) => y.d - x.d), bHeavy = diffs.filter((x) => x.d < -0.002).sort((x, y) => x.d - y.d);
    statsEl.innerHTML = `<div class="sim"><b>${Math.round(sim * 100)}%</b><span>similar</span><small>${ga.total.toLocaleString()} vs ${gb.total.toLocaleString()} points</small></div>
      <div class="dom a"><span style="color:${SIDE_COLORS.A}">More of A in</span>${top(aHeavy)}</div>
      <div class="dom b"><span style="color:${SIDE_COLORS.B}">More of B in</span>${top(bHeavy)}</div>
      <div class="diff-key"><i style="background:${SIDE_COLORS.A}"></i>A-heavy<i style="background:${SIDE_COLORS.B}"></i>B-heavy</div>`;
    countUp(statsEl.querySelector('.sim b'), Math.round(sim * 100), { suffix: '%' });
  }

  async function refresh() {
    const map_ = app.prefs.map;
    try {
      const ms = await guard('t', api.matches(map_, { limit: 1 }));
      if (ms.tMax && ms.tMax !== tMax) { tMax = Math.max(60, ms.tMax); stripA.tw?.set(side.A.tFrom, side.A.tTo ?? tMax, tMax); stripB.tw?.set(side.B.tFrom, side.B.tTo ?? tMax, tMax); }
      const [ga, gb] = await guard('heat', Promise.all([api.heatmap(map_, params(side.A)), api.heatmap(map_, params(side.B))]));
      mapA.heat.build(ga); mapA.heatOn = true;
      mapB.heat.build(gb); mapB.heatOn = true;
      mapD.heat.buildDiff(ga, gb, rgb(SIDE_COLORS.A), rgb(SIDE_COLORS.B)); mapD.heatOn = true;
      maps.forEach((m) => m.invalidate());
      titleA.textContent = label(side.A); titleB.textContent = label(side.B);
      renderStats(ga, gb);
    } catch (e) { if (!e.stale) app.error(e); }
  }

  renderPresets(); renderStrips();
  api.matches(app.prefs.map, { limit: 1 }).then((r) => { if (alive && r.tMax) { tMax = Math.max(60, r.tMax); renderStrips(); } }).finally(refresh);
  return () => { alive = false; maps.forEach((m) => m.destroy()); };
}
