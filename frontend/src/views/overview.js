// 01 · BRIEFING — one-screen read of how runs go, per map.
import { api } from '../api.js';
import { MapCanvas } from '../mapview.js';
import { COLORS, TAGS, fmtTime, playersFlags, prettyMap } from '../constants.js';
import { stackedColumns } from '../charts.js';
import { blipNote, dayChips, daysParam, field, h, kpi, latestGuard, panel, pct, quip, segmented, viewHead } from '../ui.js';

export function mount(root, app) {
  const { meta } = app;
  const S = (app.state.overview ??= { days: new Set(meta.days), players: 'humans' });
  const guard = latestGuard();
  let alive = true;
  const fp = () => ({ ...playersFlags(S.players), days: daysParam(S.days, meta.days) });
  const who = () => ({ humans: 'human', bots: 'bot', both: 'player' })[S.players];

  // ---- filters (this section's own)
  const mapSeg = segmented(Object.keys(meta.maps).map((m) => ({ value: m, label: prettyMap(m) })), app.prefs.map,
    (v) => { app.prefs.map = v; app.setQuery({ map: v }); refresh(); });
  const chips = dayChips(meta.days, null, S.days, () => refresh());
  const playersSeg = segmented([{ value: 'humans', label: 'Humans' }, { value: 'bots', label: 'Bots' }, { value: 'both', label: 'Both' }],
    S.players, (v) => { S.players = v; refresh(); });

  const briefEl = h('div', { class: 'brief panel' }, blipNote(quip(), 48));
  const kpiEl = h('div', { class: 'kpis' });
  const awardsEl = h('div', { class: 'awards' });
  const fateBody = h('div', { class: 'panel-b' });
  const timingBody = h('div', { class: 'panel-b' });

  // ---- map cards: every map at a glance, with a live death-heat thumbnail
  const cards = Object.keys(meta.maps).map((id) => {
    const thumb = h('div', { class: 'thumb' });
    const stats = h('div', { class: 'card-stats' });
    const el = h('article', {
      class: 'mapcard',
      onclick: () => { app.prefs.map = id; mapSeg.set(id); app.setQuery({ map: id }); refresh(); },
    },
    h('div', { class: 'card-h' }, h('h3', {}, prettyMap(id)), h('span', { class: 'mono dim' }, 'DEATH HEAT')),
    thumb, stats,
    h('button', { type: 'button', class: 'btn', onclick: (e) => { e.stopPropagation(); app.go('explore', { map: id }); } }, 'Open in Map Lab →'));
    const canvas = new MapCanvas(thumb, { interactive: false, controls: false });
    canvas.setMap(meta.maps[id].image);
    return { id, el, canvas, stats };
  });

  root.append(h('div', { class: 'view' },
    viewHead('01 · BRIEFING', 'How do runs end?', 'Drop in, grab the loot, get out alive. Here\'s how that actually went.'),
    h('section', { class: 'filters panel' }, field('🗺️ Map', mapSeg), field('📅 Dates', chips), field('👥 Players', playersSeg)),
    briefEl, kpiEl,
    h('div', { class: 'sec-title' }, h('h2', {}, 'Hall of shame & fame'), h('span', { class: 'mono dim' }, 'the zones that earned a title · click one for the full report card')),
    awardsEl,
    h('div', { class: 'grid-fate' },
      panel({ title: 'How runs end', sub: 'Share of runs by outcome' }, fateBody),
      panel({ title: 'When players die', sub: 'Deaths per minute of match time' }, timingBody)),
    h('div', { class: 'sec-title' }, h('h2', {}, 'Maps at a glance'), h('span', { class: 'mono dim' }, 'respects the dates and players filters above')),
    h('div', { class: 'mapcards' }, cards.map((c) => c.el))));

  // ---- renderers
  function renderBrief(sum, zones) {
    const j = sum.journeys, o = sum.outcomes;
    const top = [...zones.cells].sort((a, b) => b.dShare - a.dShare)[0];
    const med = sum.median_death_t.combat;
    briefEl.innerHTML = `<span class="eyebrow">// INTEL</span>
      <p><b>${prettyMap(sum.map)}</b>: ${j.toLocaleString()} ${who()} runs across ${sum.matches} matches.
      <b>${pct(o.combat, j)}</b> end in combat, <b>${pct(o.storm, j)}</b> in the storm and <b>${pct(o.survived, j)}</b> never die (likely extractions).
      ${med != null ? `The typical combat death lands at <b>${fmtTime(med)}</b>. ` : ''}${top && top.dShare > 0 ? `The deadliest zone is <b>${top.id}</b>, with <b>${pct(top.dShare, 1)}</b> of deaths on <b>${pct(top.tShare, 1)}</b> of the traffic.` : ''}</p>`;
  }

  function renderAwards(z) {
    const cells = z.cells.filter((c) => c.tag !== 'none');
    const grinder = [...cells].sort((a, b) => b.dShare - a.dShare)[0];
    // most loot among the genuinely safe zones; fall back to well-trafficked zones if none qualify
    const safe = cells.filter((c) => c.tag === 'farm');
    const buffet = [...(safe.length ? safe : cells.filter((c) => c.tShare >= 0.01))].sort((a, b) => b.lShare - a.lShare)[0];
    const magnet = [...cells].sort((a, b) => b.storm - a.storm)[0];
    const tumble = cells.filter((c) => c.visits > 0).sort((a, b) => a.tShare - b.tShare)[0];
    const items = [
      grinder?.dShare > 0 && { tag: 'kill', c: grinder, text: `${pct(grinder.dShare, 1)} of deaths on ${pct(grinder.tShare, 1)} of the traffic` },
      buffet && { tag: 'farm', c: buffet, text: `${pct(buffet.lShare, 1)} of loot for ${pct(buffet.dShare, 1)} of deaths` },
      magnet?.storm > 0 && { tag: 'storm', c: magnet, text: `${magnet.storm} storm deaths (${pct(magnet.sShare, 1)} of all)` },
      tumble && { tag: 'quiet', c: tumble, text: `only ${tumble.visits} of ${z.matches} matches ever walked here` },
    ].filter(Boolean);
    awardsEl.replaceChildren(...items.map(({ tag, c, text }) => h('a', { class: 'award', href: `#/radar?map=${app.prefs.map}`, style: { '--c': TAGS[tag].color } },
      h('span', { class: 'a-emoji' }, TAGS[tag].emoji), h('span', { class: 'a-t' }, TAGS[tag].label), h('b', { class: 'a-id' }, c.id), h('span', { class: 'a-s' }, text))));
  }

  function renderKpis(sum) {
    const k = sum.kpis;
    kpiEl.replaceChildren(
      kpi({ icon: '🎮', label: 'MATCHES', value: sum.matches, sub: `${sum.journeys.toLocaleString()} ${who()} runs`, color: '#ffe814' }),
      kpi({ icon: '💥', label: 'KILLS', value: k.kills, sub: `${(k.kills / Math.max(1, sum.journeys)).toFixed(1)} per run`, color: COLORS.kill }),
      kpi({ icon: '🪦', label: 'RUNS KILLED', value: sum.outcomes.combat, sub: pct(sum.outcomes.combat, sum.journeys) + ' of runs', color: COLORS.death }),
      kpi({ icon: '🌩️', label: 'STORM DEATHS', value: k.storm, sub: pct(k.storm, sum.journeys) + ' of runs', color: COLORS.storm }),
      kpi({ icon: '💎', label: 'LOOT PICKUPS', value: k.loot, sub: `${(k.loot / Math.max(1, sum.journeys)).toFixed(1)} per run`, color: COLORS.loot }));
  }

  function renderFate(sum) {
    const j = Math.max(1, sum.journeys), o = sum.outcomes;
    const rows = [['combat', 'Killed in combat', COLORS.kill], ['storm', 'Died to the storm', COLORS.storm], ['survived', 'No death (likely extracted)', COLORS.loot]];
    fateBody.replaceChildren(
      h('div', { class: 'stackbar' }, rows.map(([k, , c]) => h('span', { style: { width: `${(o[k] / j) * 100}%`, background: c }, title: `${o[k]} runs` }))),
      h('ul', { class: 'legend-list' }, rows.map(([k, label, c]) => h('li', {},
        h('i', { style: { background: c } }), h('span', {}, label), h('b', {}, pct(o[k], j)), h('small', {}, `${o[k].toLocaleString()} runs`)))),
      h('p', { class: 'note' }, 'The dataset has no extraction event, so "no death" is the closest proxy for a successful run.'));
  }

  function renderTiming(sum) {
    const { combat, storm } = sum.death_hist;
    const labels = combat.map((_, i) => `${i}m`);
    timingBody.innerHTML = stackedColumns({
      labels, every: Math.max(1, Math.ceil(labels.length / 12)),
      series: [{ label: 'combat deaths', color: 'var(--kill)', values: combat }, { label: 'storm deaths', color: 'var(--storm)', values: storm }],
    });
    timingBody.append(h('div', { class: 'chart-legend' },
      h('span', {}, h('i', { style: { background: COLORS.kill } }), 'Combat'), h('span', {}, h('i', { style: { background: COLORS.storm } }), 'Storm'),
      sum.median_death_t.storm != null ? h('span', { class: 'dim' }, `median storm death ${fmtTime(sum.median_death_t.storm)}`) : null));
  }

  async function refreshCards() {
    const p = fp();
    await Promise.all(cards.map(async (c) => {
      c.el.classList.toggle('sel', c.id === app.prefs.map);
      try {
        const [sum, g] = await Promise.all([api.summary(c.id, p), api.heatmap(c.id, { ...p, layer: 'death' })]);
        if (!alive) return;
        c.canvas.heat.build(g); c.canvas.heatOn = true; c.canvas.invalidate();
        const o = sum.outcomes, j = sum.journeys;
        c.stats.innerHTML = `<div><b>${sum.matches}</b><span>matches</span></div><div><b>${pct(o.combat, j)}</b><span>combat</span></div><div><b>${pct(o.storm, j)}</b><span>storm</span></div><div><b>${pct(o.survived, j)}</b><span>survive</span></div>`;
      } catch (e) { if (!e.stale) app.error(e); }
    }));
  }

  async function refresh() {
    const map = app.prefs.map, p = fp();
    api.matches(map, { limit: 1 }).then((r) => alive && chips.setCounts(r.dayCounts)).catch(() => {});
    try {
      const [sum, zones] = await Promise.all([guard('sum', api.summary(map, p)), guard('zones', api.zones(map, p))]);
      renderBrief(sum, zones); renderAwards(zones); renderKpis(sum); renderFate(sum); renderTiming(sum);
    } catch (e) { if (!e.stale) app.error(e); }
    refreshCards();
  }

  refresh();
  return () => { alive = false; cards.forEach((c) => c.canvas.destroy()); };
}
