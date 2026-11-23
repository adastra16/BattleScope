// 05 · DESIGN RADAR — every zone scored for risk vs reward, with auto-written findings and suggested levers.
import { api } from '../api.js';
import { MapCanvas } from '../mapview.js';
import { quadrant } from '../charts.js';
import { TAGS, fmtDay, playersFlags, prettyMap } from '../constants.js';
import { blipNote, dayChips, daysParam, field, h, latestGuard, panel, pct, quip, segmented, tagBadge, viewHead } from '../ui.js';

const hex = (c, a) => `rgba(${parseInt(c.slice(1, 3), 16)},${parseInt(c.slice(3, 5), 16)},${parseInt(c.slice(5, 7), 16)},${a})`;

/** Turn the zone table into plain-language findings, each with evidence and a suggested design lever. */
export function buildFindings(z, mapName) {
  const out = [];
  const cells = z.cells.filter((c) => c.tag !== 'none');
  const byD = [...cells].sort((a, b) => b.dShare - a.dShare);
  const kill = cells.filter((c) => c.tag === 'kill').sort((a, b) => b.dShare - a.dShare);
  if (kill.length) {
    const ids = kill.map((c) => c.id), share = kill.reduce((s, c) => s + c.dShare, 0), tr = kill.reduce((s, c) => s + c.tShare, 0);
    out.push({
      tag: 'kill', title: `${ids.slice(0, 4).join(', ')}: the meat grinder`,
      evidence: `${pct(share, 1)} of deaths on ${pct(tr, 1)} of traffic. ${kill[0].id} alone is ${kill[0].risk}× its fair share of deaths.`,
      lever: 'Spread enemy spawns or patrols out of the cluster, add cover or an alternate route, or split the loot that draws everyone in.',
    });
  } else if (byD[0]) {
    out.push({ tag: 'info', title: `${byD[0].id}: most lethal zone`, evidence: `${pct(byD[0].dShare, 1)} of deaths on ${pct(byD[0].tShare, 1)} of traffic, though no zone is a clear outlier.`, lever: 'Deaths track traffic here. Check whether enemy density is intended.' });
  }
  const farm = cells.filter((c) => c.tag === 'farm').sort((a, b) => b.lShare - a.lShare);
  if (farm.length) {
    const ids = farm.map((c) => c.id), l = farm.reduce((s, c) => s + c.lShare, 0), d = farm.reduce((s, c) => s + c.dShare, 0);
    out.push({
      tag: 'farm', title: `${ids.slice(0, 4).join(', ')}: the loot buffet`,
      evidence: `${pct(l, 1)} of loot for only ${pct(d, 1)} of deaths. That is the best reward-for-risk on the map.`,
      lever: 'Move some high-tier loot toward contested zones, or add a threat here, so safe loot doesn\'t out-earn the risky routes.',
    });
  }
  const storm = cells.filter((c) => c.tag === 'storm').sort((a, b) => b.storm - a.storm);
  if (storm.length) {
    out.push({
      tag: 'storm', title: `${storm.slice(0, 3).map((c) => c.id).join(', ')}: storm magnet`,
      evidence: `${storm.reduce((s, c) => s + c.storm, 0)} of ${z.totals.storm} storm deaths happen in these zones.`,
      lever: 'Shorten the route from here to the next safe area, add an earlier storm cue, or add an extraction nearby.',
    });
  }
  const quiet = cells.filter((c) => c.tag === 'quiet');
  const used = cells.length;
  if (quiet.length) {
    out.push({
      tag: 'quiet', title: `${quiet.length} tumbleweed zones`,
      evidence: `${quiet.map((c) => c.id).join(', ')} each get under 1% of movement. Only ${used} of 64 zones see any traffic.`,
      lever: 'Add a loot or objective anchor to pull players out, or cut the dead space so fights and the storm compress into used areas.',
    });
  }
  const byT = [...cells].sort((a, b) => b.tShare - a.tShare);
  let acc = 0, k = 0;
  for (const c of byT) { acc += c.tShare; k++; if (acc >= 0.5) break; }
  out.push({
    tag: 'info', title: 'Traffic concentration',
    evidence: `Half of all movement fits in ${k} of the ${used} zones in use (${byT.slice(0, k).map((c) => c.id).join(', ')}).`,
    lever: `Use this as a baseline: after a layout change on ${mapName}, the number should rise if routes are spreading.`,
  });
  return out;
}

export function mount(root, app) {
  const { meta } = app;
  const S = (app.state.radar ??= { days: new Set(meta.days), players: 'humans', tags: new Set(), sort: 'dShare', dir: -1 });
  const guard = latestGuard();
  let alive = true, zones = null, summ = null, hover = null, raf = 0;

  const mapSeg = segmented(Object.keys(meta.maps).map((m) => ({ value: m, label: prettyMap(m) })), app.prefs.map,
    (v) => { app.prefs.map = v; app.setQuery({ map: v }); map.setMap(meta.maps[v].image); refresh(); });
  const chips = dayChips(meta.days, null, S.days, () => refresh());
  const playersSeg = segmented([{ value: 'humans', label: 'Humans' }, { value: 'bots', label: 'Bots' }, { value: 'both', label: 'Both' }],
    S.players, (v) => { S.players = v; refresh(); });
  const tagFilter = h('div', { class: 'chips' });
  const findingsEl = h('div', { class: 'findings' }, blipNote(quip(), 44));
  const quadEl = h('div', { class: 'quad-wrap' });
  const tableEl = h('div', { class: 'ztable' });
  const mapHost = h('div', { class: 'radar-map' });
  mapHost.append(h('div', { class: 'sweep' }));

  const map = new MapCanvas(mapHost, { interactive: true, controls: true });
  map.setMap(meta.maps[app.prefs.map].image);

  root.append(h('div', { class: 'view' },
    viewHead('05 · DESIGN RADAR', 'Where does the design leak?', 'Your map\'s report card: every zone gets a type, a risk and reward score, and some honest feedback.'),
    h('section', { class: 'filters panel' }, field('🗺️ Map', mapSeg), field('📅 Dates', chips), field('👥 Players', playersSeg)),
    h('div', { class: 'grid-radar' },
      panel({ title: 'Zone map', sub: 'Tile colour = zone type · opacity = traffic' }, h('div', { class: 'panel-b' }, mapHost)),
      panel({ title: 'Risk vs reward', sub: '1× = a zone\'s fair share. Bubble size = traffic.' }, h('div', { class: 'panel-b' }, quadEl))),
    h('div', { class: 'sec-title' }, h('h2', {}, 'Findings'), h('span', { class: 'mono dim' }, 'auto-generated from the zone table'),
      h('div', { class: 'inline' },
        h('button', { type: 'button', class: 'btn', onclick: copyReport }, '📋 Copy report'),
        h('button', { type: 'button', class: 'btn ghost', onclick: downloadReport }, '⬇ .md'))),
    findingsEl,
    panel({ title: 'Zone table', sub: 'Click a header to sort · click a zone type to filter', actions: tagFilter }, tableEl)));

  // ---- zone tiles drawn over the map
  map.overlay = (ctx, view) => {
    if (!zones) return;
    const anyFilter = S.tags.size > 0;
    ctx.save();
    ctx.font = '600 11px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';
    for (const c of zones.cells) {
      if (c.tag === 'none') continue;
      const [x0, y0] = view.toScreen(c.col / 8, 1 - c.row / 8);
      const [x1, y1] = view.toScreen((c.col + 1) / 8, 1 - (c.row + 1) / 8);
      const col = TAGS[c.tag].color;
      const on = !anyFilter || S.tags.has(c.tag);
      const a = on ? 0.14 + 0.5 * Math.min(1, c.tShare / 0.1) : 0.03;
      ctx.fillStyle = hex(col, a);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = hex(col, on ? (hover === c.id ? 1 : 0.55) : 0.15);
      ctx.lineWidth = hover === c.id ? 2.5 : 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
      ctx.fillStyle = on ? 'rgba(255,255,255,.92)' : 'rgba(255,255,255,.25)';
      ctx.fillText(c.id, x0 + 5, y0 + 4);
      if (on && (c.tag === 'kill' || c.tag === 'storm')) { // sonar ping
        const ph = ((performance.now() / 1700) + c.i * 0.173) % 1;
        ctx.strokeStyle = hex(col, (1 - ph) * 0.85); ctx.lineWidth = 1 + 3 * (1 - ph);
        ctx.beginPath(); ctx.arc((x0 + x1) / 2, (y0 + y1) / 2, ((x1 - x0) / 2) * (0.2 + ph * 0.95), 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  };
  const cellAt = (e) => {
    if (!e?.inside || !zones) return null;
    return zones.cells[Math.min(7, Math.floor((1 - e.v) * 8)) * 8 + Math.min(7, Math.floor(e.u * 8))];
  };
  map.onHover = (e) => {
    const c = cellAt(e);
    setHover(c ? c.id : null);
    if (!c || c.tag === 'none') { map.hideTip(); return; }
    map.showTip(`<b>${c.id}</b> <span class="dim">· ${TAGS[c.tag].label}</span><div class="dim">${pct(c.tShare, 1)} traffic · ${pct(c.lShare, 1)} loot · ${pct(c.dShare, 1)} deaths</div>`, e.sx, e.sy);
  };

  function setHover(id) {
    if (hover === id) return;
    hover = id;
    map.invalidate();
    quadEl.querySelectorAll('.pt').forEach((n) => n.classList.toggle('hot', n.dataset.id === id));
    tableEl.querySelectorAll('tr[data-id]').forEach((n) => n.classList.toggle('hot', n.dataset.id === id));
  }

  // ---- renderers
  function renderTagFilter() {
    tagFilter.replaceChildren(...['kill', 'farm', 'storm', 'quiet', 'neutral'].map((t) => h('button', {
      type: 'button', class: `chip tagchip ${S.tags.has(t) ? 'on' : ''}`, style: { '--c': TAGS[t].color },
      onclick: () => { S.tags.has(t) ? S.tags.delete(t) : S.tags.add(t); renderTagFilter(); renderAll(); },
    }, TAGS[t].label)));
  }

  function renderQuadrant() {
    const pts = zones.cells.filter((c) => c.tag !== 'none' && c.risk != null).map((c) => ({
      id: c.id, x: c.risk, y: c.reward, r: 8 + Math.sqrt(c.tShare) * 38, color: TAGS[c.tag].color,
      dim: S.tags.size > 0 && !S.tags.has(c.tag),
      title: `${c.id} · ${TAGS[c.tag].label}: risk ${c.risk}×, reward ${c.reward}×`,
    }));
    quadEl.innerHTML = quadrant(pts);
    quadEl.querySelectorAll('.pt').forEach((n) => {
      n.addEventListener('pointerenter', () => setHover(n.dataset.id));
      n.addEventListener('pointerleave', () => setHover(null));
    });
  }

  function renderFindings() {
    const f = buildFindings(zones, prettyMap(app.prefs.map));
    findingsEl.replaceChildren(...f.map((x) => h('article', { class: 'finding', style: { '--c': TAGS[x.tag].color } },
      tagBadge(x.tag, TAGS), h('h3', {}, x.title), h('p', {}, x.evidence), h('p', { class: 'lever' }, h('b', {}, 'Lever · '), x.lever))));
  }

  function renderTable() {
    const cols = [['id', 'Zone'], ['tag', 'Type'], ['tShare', 'Traffic'], ['visits', 'Seen in'], ['lShare', 'Loot'], ['kShare', 'Kills'], ['dShare', 'Deaths'], ['storm', 'Storm'], ['risk', 'Risk'], ['reward', 'Reward']];
    const rows = zones.cells.filter((c) => c.tag !== 'none' && (!S.tags.size || S.tags.has(c.tag)))
      .sort((a, b) => ((a[S.sort] ?? -1) > (b[S.sort] ?? -1) ? 1 : -1) * S.dir);
    tableEl.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, cols.map(([k, l]) => h('th', { class: S.sort === k ? 'sorted' : '', onclick: () => { S.dir = S.sort === k ? -S.dir : -1; S.sort = k; renderTable(); } }, l, S.sort === k ? (S.dir < 0 ? ' ↓' : ' ↑') : '')))),
      h('tbody', {}, rows.map((c) => h('tr', { 'data-id': c.id, onpointerenter: () => setHover(c.id), onpointerleave: () => setHover(null) },
        h('td', { class: 'mono' }, c.id), h('td', {}, tagBadge(c.tag, TAGS)), h('td', {}, pct(c.tShare, 1)),
        h('td', {}, pct(c.visits, zones.matches)), h('td', {}, pct(c.lShare, 1)), h('td', {}, pct(c.kShare, 1)), h('td', {}, pct(c.dShare, 1)),
        h('td', {}, c.storm || '–'), h('td', {}, c.risk != null ? `${c.risk}×` : '–'), h('td', {}, c.reward != null ? `${c.reward}×` : '–'))))));
  }

  function renderAll() { renderQuadrant(); renderTable(); map.invalidate(); }

  /** The findings, as Markdown a designer can paste into Notion / Jira / Slack. */
  function reportMarkdown() {
    const name = prettyMap(app.prefs.map), o = summ.outcomes, n = summ.journeys;
    const days = S.days.size === meta.days.length ? 'all days (Feb 10–14, 2026)' : [...S.days].map(fmtDay).join(', ');
    const who = { humans: 'humans', bots: 'bots', both: 'humans + bots' }[S.players];
    const rows = zones.cells.filter((c) => c.tag !== 'none').sort((a, b) => b.dShare - a.dShare).slice(0, 10);
    return [
      `# ${name}: design report`, `_BattleScope · ${days} · ${who} · ${n.toLocaleString()} runs across ${summ.matches} matches_`, '',
      '## Headline', `- ${pct(o.combat, n)} of runs end in combat, ${pct(o.storm, n)} in the storm, ${pct(o.survived, n)} never die (likely extractions: the data has no extraction event).`, '',
      '## Findings', ...buildFindings(zones, name).flatMap((x) => [`### ${TAGS[x.tag].emoji} ${x.title}`, x.evidence, '', `**Suggested lever:** ${x.lever}`, '']),
      '## Top 10 zones by deaths', '| Zone | Type | Traffic | Loot | Deaths | Risk | Reward |', '|---|---|---|---|---|---|---|',
      ...rows.map((c) => `| ${c.id} | ${TAGS[c.tag].label} | ${pct(c.tShare, 1)} | ${pct(c.lShare, 1)} | ${pct(c.dShare, 1)} | ${c.risk ?? '–'}× | ${c.reward ?? '–'}× |`), '',
      '_Risk = share of deaths ÷ share of traffic. Reward = share of loot ÷ share of traffic. 1× is a fair share. Zone types come from simple rules (see ARCHITECTURE.md)._', '',
    ].join('\n');
  }
  function downloadReport() {
    if (!zones || !summ) return;
    const a = h('a', { href: URL.createObjectURL(new Blob([reportMarkdown()], { type: 'text/markdown' })), download: `battlescope-${app.prefs.map}-report.md` });
    a.click(); URL.revokeObjectURL(a.href);
  }
  async function copyReport() {
    if (!zones || !summ) return;
    try { await navigator.clipboard.writeText(reportMarkdown()); app.say('📋 Report copied. Paste it into Notion, Jira or Slack.'); } catch { downloadReport(); }
  }

  async function refresh() {
    const map_ = app.prefs.map;
    api.matches(map_, { limit: 1 }).then((r) => alive && chips.setCounts(r.dayCounts)).catch(() => {});
    try {
      const p = { ...playersFlags(S.players), days: daysParam(S.days, meta.days) };
      [zones, summ] = await guard('zones', Promise.all([api.zones(map_, p), api.summary(map_, p)]));
    } catch (e) { if (!e.stale) app.error(e); return; }
    renderAll(); renderFindings();
  }

  renderTagFilter();
  refresh();
  const tick = () => { if (!alive) return; map.invalidate(); raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick);
  return () => { alive = false; cancelAnimationFrame(raf); map.destroy(); };
}
