// 03 · REPLAY — pick a match and watch it unfold: paths draw as players move, markers appear as events happen.
import { api } from '../api.js';
import { MapCanvas } from '../mapview.js';
import { drawHead, drawMarkers, drawPath } from '../render.js';
import { CATEGORY_OF, COLORS, DEATHS, EV, describeEvent, fmtDay, fmtTime, prettyMap, shortId } from '../constants.js';
import {
  MARKER_ICONS, blip, confetti, dayChips, debounce, field, h, latestGuard, markerChips, panel, segmented, select, toggle, viewHead,
} from '../ui.js';

export function mount(root, app) {
  const { meta } = app;
  const S = (app.state.replay ??= {
    days: new Set(meta.days), search: '', sort: 'players', multi: false,
    humans: true, bots: true, paths: true, cats: { kill: true, death: true, storm: true, loot: true }, speed: 1, matchId: null,
  });
  const guard = latestGuard();
  let alive = true, match = null, list = null;
  let t = 0, tMax = 600, playing = false, focus = null, hits = [], raf = 0, lastTs = 0;

  // ---- filters (top bar): map, dates, who to show, what to mark
  const mapSeg = segmented(Object.keys(meta.maps).map((m) => ({ value: m, label: prettyMap(m) })), app.prefs.map, (v) => {
    app.prefs.map = v; app.setQuery({ map: v }); map.setMap(meta.maps[v].image); loadList();
  });
  const chips = dayChips(meta.days, null, S.days, () => loadList());
  const show = h('div', { class: 'toggles' },
    toggle('Humans', S.humans, (v) => { S.humans = v; renderPlayers(); drawHist(); map.invalidate(); }),
    toggle('Bots', S.bots, (v) => { S.bots = v; renderPlayers(); drawHist(); map.invalidate(); }),
    toggle('Paths', S.paths, (v) => { S.paths = v; map.invalidate(); }));
  const markers = markerChips(S.cats, () => { drawHist(); map.invalidate(); });

  // ---- match list (own filters: search, sort, multi-player)
  const search = h('input', { type: 'search', placeholder: 'Search match or player id…', value: S.search, oninput: debounce((e) => { S.search = e.target.value; loadList(); }, 200) });
  const sortSel = select([{ value: 'players', label: 'Most players' }, { value: 'action', label: 'Most combat' }, { value: 'long', label: 'Longest' }, { value: 'recent', label: 'Most recent' }], S.sort, (v) => { S.sort = v; loadList(); });
  const multi = toggle('2+ players', S.multi, (v) => { S.multi = v; loadList(); });
  const listEl = h('div', { class: 'match-list', role: 'listbox' });
  const countEl = h('span', { class: 'mono dim' });

  // ---- stage
  const infoEl = h('div', { class: 'match-info' });
  const mapHost = h('div', { class: 'map-host' });
  const map = new MapCanvas(mapHost, { interactive: true, controls: true });
  map.setMap(meta.maps[app.prefs.map].image);
  const legend = h('div', { class: 'legend', html: `<div class="hd">Who</div>
    <div class="li"><svg width="26" height="10"><line x1="1" y1="5" x2="25" y2="5" stroke="${COLORS.human}" stroke-width="3"/></svg>Human: solid path, round head</div>
    <div class="li"><svg width="26" height="10"><line x1="1" y1="5" x2="25" y2="5" stroke="${COLORS.bot}" stroke-width="2" stroke-dasharray="5 3"/></svg>Bot: dashed path, diamond head</div>
    <div class="hd">Events</div>
    <div class="li wrap">${[['kill', 'Kill'], ['death', 'Death'], ['storm', 'Storm death'], ['loot', 'Loot']].map(([k, l]) => `<span class="mk">${MARKER_ICONS[k]}${l}</span>`).join('')}</div>` });
  const playersEl = h('div', { class: 'players', hidden: true });
  map.wrap.append(playersEl, legend);
  const empty = h('div', { class: 'empty-state over', hidden: true }, blip(64), h('p', {}, 'Pick a match on the left and I\'ll press play.'));
  map.wrap.append(empty);

  const playBtn = h('button', { type: 'button', class: 'play', title: 'Play / pause (space)', onclick: () => { setPlaying(!playing); sync(); } }, '▶');
  const hist = h('canvas');
  const range = h('input', { type: 'range', min: 0, max: 600, step: 0.1, value: 0, 'aria-label': 'Match time' });
  range.oninput = () => { t = +range.value; syncTime(); map.invalidate(); };
  range.onchange = () => sync();
  const timeEl = h('span', { class: 'mono' }, '00:00 / 00:00');
  const SPEEDS = [0.1, 0.5, 1, 1.5, 2, 5, 10];
  if (!SPEEDS.includes(S.speed)) S.speed = 1;
  const speedSel = select(SPEEDS.map((v) => ({ value: v, label: `${v}×` })), S.speed, (v) => { S.speed = +v; });
  speedSel.title = 'Playback speed ( [ slower · ] faster )';

  root.append(h('div', { class: 'view' },
    viewHead('03 · REPLAY', 'How did this match play out?', 'Rewatch the chaos, one tiny dot at a time. Kills, deaths, storms and loot pop up the moment they happen.'),
    h('section', { class: 'filters panel' }, h('div', { class: 'frow' }, field('🗺️ Map', mapSeg), field('📅 Dates', chips), field('👀 Show', show), field('📍 Markers', markers))),
    h('div', { class: 'grid-replay' },
      panel({ title: 'Matches', actions: countEl, cls: 'list-panel' },
        h('div', { class: 'list-filters' }, search, h('div', { class: 'row' }, sortSel, multi)), listEl),
      panel({ cls: 'stage-panel' }, infoEl, mapHost,
        h('div', { class: 'timeline' }, playBtn, h('div', { class: 'tl-track' }, hist, range), timeEl, speedSel)))));

  // ---- drawing
  map.overlay = (ctx, view) => {
    hits = [];
    if (!match) return;
    const players = match.players.filter((p) => (p.bot ? S.bots : S.humans));
    const heads = [];
    const ordered = [...players].sort((a, b) => (b.bot - a.bot) || ((a.id === focus) - (b.id === focus)));
    for (const p of ordered) {
      const dim = focus && focus !== p.id;
      if (S.paths) {
        const style = p.bot ? { color: COLORS.bot, width: 1.6, dash: [5, 4], alpha: dim ? 0.2 : 0.85 } : { color: COLORS.human, width: 2.6, alpha: dim ? 0.25 : 1 };
        const head = drawPath(ctx, view, p.path, t, 1, style);
        if (head) heads.push({ p, head, dim });
      }
      for (const [et, code, u, v] of p.events) {
        if (et > t || !S.cats[CATEGORY_OF[code]]) continue;
        const [sx, sy] = view.toScreen(u, v);
        hits.push({ x: sx, y: sy, cat: CATEGORY_OF[code], bot: p.bot, code, t: et, player: p.id });
      }
    }
    for (const { p, head, dim } of heads) {
      if (p.events.some(([et, code]) => DEATHS.has(code) && et <= t)) continue; // the death marker shows where they fell
      drawHead(ctx, head.x, head.y, p.bot, dim ? 0.3 : head.ended ? 0.5 : 1, p.id === focus);
    }
    drawMarkers(ctx, hits, Math.min(1.6, Math.max(0.8, Math.pow(view.zoom, 0.35))));
    // ripples radiate from events that just happened
    const win = Math.max(2.5, 1.6 * S.speed); // match-seconds a ripple lasts
    for (const k of hits) {
      const age = t - k.t;
      if (k.cat === 'loot' || age < 0 || age > win) continue;
      const f = age / win;
      ctx.globalAlpha = 1 - f; ctx.strokeStyle = COLORS[k.cat]; ctx.lineWidth = 1 + 3 * (1 - f);
      ctx.beginPath(); ctx.arc(k.x, k.y, 8 + f * 30, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
  map.onHover = (e) => {
    if (!e) return;
    let best = null, bd = 64;
    for (const k of hits) { const d = (k.x - e.sx) ** 2 + (k.y - e.sy) ** 2; if (d < bd) { bd = d; best = k; } }
    if (!best) { map.hideTip(); return; }
    map.showTip(`<b class="c-${best.cat}">${describeEvent(best.code, best.bot)}</b> <span class="dim">· ${shortId(best.player)} · ${fmtTime(best.t)}</span>`, e.sx, e.sy);
  };

  function drawHist() {
    const r = hist.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    hist.width = Math.max(1, r.width * dpr); hist.height = Math.max(1, r.height * dpr);
    const g = hist.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    if (!match) return;
    // bin the match's own events by time; combat and loot scale separately so fights stay visible
    const B = 120, b = { loot: new Array(B).fill(0), kill: new Array(B).fill(0), death: new Array(B).fill(0), storm: new Array(B).fill(0) };
    const bw = r.width / B;
    for (const p of match.players) {
      if (p.bot ? !S.bots : !S.humans) continue;
      for (const [et, code] of p.events) {
        const cat = CATEGORY_OF[code];
        if (S.cats[cat]) b[cat][Math.min(B - 1, Math.floor((et / tMax) * B))]++;
      }
    }
    const maxLoot = Math.max(1, ...b.loot);
    let maxC = 1;
    for (let i = 0; i < B; i++) maxC = Math.max(maxC, b.kill[i] + b.death[i] + b.storm[i]);
    for (let i = 0; i < B; i++) {
      const hl = (b.loot[i] / maxLoot) * r.height * 0.5;
      g.fillStyle = 'rgba(250,219,20,0.35)'; g.fillRect(i * bw, r.height - hl, Math.max(1, bw - 1), hl);
      let y = r.height;
      for (const k of ['kill', 'death', 'storm']) {
        const hh = (b[k][i] / maxC) * r.height * 0.95;
        if (!hh) continue;
        g.fillStyle = COLORS[k]; g.globalAlpha = k === 'death' ? 0.7 : 0.9;
        g.fillRect(i * bw, y - hh, Math.max(1, bw - 1), hh); g.globalAlpha = 1; y -= hh;
      }
    }
  }

  // ---- panels
  function renderList() {
    if (!list) return;
    countEl.textContent = list.filtered === list.total ? `${list.total}` : `${list.filtered} / ${list.total}`;
    listEl.replaceChildren(...(list.matches.length ? list.matches.map((m) => {
      const c = m.counts;
      return h('div', { class: `match ${m.id === S.matchId ? 'active' : ''}`, role: 'option', onclick: () => selectMatch(m.id) },
        h('div', { class: 'l1' }, h('span', { class: 'id mono' }, m.id.slice(0, 8)), h('span', { class: 'dim' }, `${fmtDay(m.day)} · ${fmtTime(m.dur)}`)),
        h('div', { class: 'l2' }, h('span', { class: 'c-human' }, `● ${m.humans}`), h('span', { class: 'c-bot' }, `◆ ${m.bots}`),
          h('span', { class: 'c-kill' }, `kills ${c.Kill + c.BotKill}`), h('span', {}, `deaths ${c.Killed + c.BotKilled}`),
          c.KilledByStorm ? h('span', { class: 'c-storm' }, `storm ${c.KilledByStorm}`) : null, h('span', { class: 'c-loot' }, `loot ${c.Loot}`)));
    }) : [h('div', { class: 'empty' }, 'No matches for these filters.')]));
    if (list.filtered > list.matches.length) listEl.append(h('div', { class: 'empty' }, `Showing ${list.matches.length} of ${list.filtered}. Refine with search or dates.`));
  }

  function outcomeOf(p) {
    const d = p.events.find(([, code]) => DEATHS.has(code));
    if (!d) return { text: 'no death', t: null };
    return { text: { [EV.Killed]: 'killed by player', [EV.BotKilled]: p.bot ? 'killed' : 'killed by bot', [EV.KilledByStorm]: 'storm' }[d[1]], t: d[0] };
  }

  function renderPlayers() {
    if (!match) { playersEl.hidden = true; return; }
    playersEl.hidden = false;
    const ps = match.players.filter((p) => (p.bot ? S.bots : S.humans));
    playersEl.replaceChildren(
      h('h4', {}, h('span', {}, `Players (${ps.length})`), focus ? h('button', { type: 'button', class: 'link', onclick: () => { focus = null; renderPlayers(); map.invalidate(); } }, 'clear focus') : h('span', {}, 'click to focus')),
      ...ps.map((p) => {
        const o = outcomeOf(p);
        const kills = p.events.filter(([, c]) => c === EV.Kill || c === EV.BotKill).length;
        const loot = p.events.filter(([, c]) => c === EV.Loot).length;
        return h('div', { class: `player ${focus === p.id ? 'focus' : ''}`, title: p.id, onclick: () => { focus = focus === p.id ? null : p.id; renderPlayers(); map.invalidate(); } },
          h('span', { class: `dot ${p.bot ? 'bot' : ''}`, style: { background: p.bot ? COLORS.bot : COLORS.human } }),
          h('span', { class: 'pid mono' }, shortId(p.id)),
          h('span', { class: 'out' }, `${o.text}${o.t != null ? ` @ ${fmtTime(o.t)}` : ''}`),
          h('span', { class: 'sub' }, `${kills} kill${kills === 1 ? '' : 's'} · ${loot} loot · ${p.path.length / 3} samples`));
      }));
  }

  function renderInfo() {
    if (!match) { infoEl.replaceChildren(h('span', { class: 'dim' }, 'No match selected')); return; }
    infoEl.replaceChildren(
      h('b', { class: 'mono' }, match.id.slice(0, 8)),
      h('span', { class: 'dim' }, `${fmtDay(match.day)} · ${new Date(match.start * 1000).toISOString().slice(11, 19)} UTC`),
      h('span', {}, 'Duration ', h('b', {}, fmtTime(match.dur))),
      h('span', { class: 'c-human' }, `● ${match.humans} human${match.humans === 1 ? '' : 's'}`),
      h('span', { class: 'c-bot' }, `◆ ${match.bots} bot${match.bots === 1 ? '' : 's'}`));
  }

  // ---- playback
  function setPlaying(on) {
    if (on && t >= tMax) t = 0;
    playing = on;
    playBtn.textContent = on ? '❚❚' : '▶';
    playBtn.classList.toggle('idle', !on);
    lastTs = 0;
  }
  function finale() {
    const humans = match?.players.filter((p) => !p.bot) ?? [];
    if (!humans.length) return;
    if (humans.some((p) => !p.events.some(([, c]) => DEATHS.has(c)))) { confetti(); app.say('🏁 They made it out! (Probably: the data has no extraction event.)'); }
    else app.say('🪦 Nobody walked away. Classic.');
  }
  function syncTime() { range.max = tMax; range.value = t; timeEl.textContent = `${fmtTime(t)} / ${fmtTime(tMax)}`; }
  function sync() { app.setQuery({ map: app.prefs.map, match: S.matchId, t: !playing && t > 0 ? Math.round(t) : undefined }); }
  function frame(ts) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    if (playing) {
      const dt = Math.min(0.1, (ts - (lastTs || ts)) / 1000);
      t = Math.min(tMax, t + dt * S.speed);
      if (t >= tMax) { setPlaying(false); sync(); finale(); }
      syncTime(); map.invalidate();
    }
    lastTs = ts;
  }

  // ---- data
  async function loadList() {
    const map_ = app.prefs.map;
    try {
      list = await guard('list', api.matches(map_, { days: S.days.size !== meta.days.length ? [...S.days] : undefined, q: S.search, sort: S.sort, multi_only: S.multi || undefined }));
    } catch (e) { if (!e.stale) app.error(e); return; }
    chips.setCounts(list.dayCounts);
    renderList();
    if (!match && !S.matchId && list.matches.length) selectMatch(list.matches[0].id);
  }

  async function selectMatch(id, startAt = null) {
    setPlaying(false); focus = null;
    let m;
    try { m = await guard('match', api.match(id)); } catch (e) { if (!e.stale) app.error(e); return; }
    match = m; S.matchId = id; empty.hidden = true;
    if (m.map !== app.prefs.map) { app.prefs.map = m.map; mapSeg.set(m.map); await map.setMap(meta.maps[m.map].image); loadList(); }
    tMax = Math.max(1, m.dur);
    t = startAt != null ? Math.min(tMax, Math.max(0, startAt)) : 0;
    syncTime(); renderList(); renderInfo(); renderPlayers(); drawHist(); map.view.fit(); map.invalidate();
    if (startAt == null) setPlaying(true);
    sync();
  }

  const onKey = (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); sync(); }
    if (e.key === '[' || e.key === ']') {
      const i = SPEEDS.indexOf(S.speed) + (e.key === ']' ? 1 : -1);
      if (i >= 0 && i < SPEEDS.length) { S.speed = SPEEDS[i]; speedSel.value = String(S.speed); app.say(`⏩ ${S.speed}×`); }
    }
    if (e.code === 'ArrowRight') { t = Math.min(tMax, t + 10); syncTime(); map.invalidate(); }
    if (e.code === 'ArrowLeft') { t = Math.max(0, t - 10); syncTime(); map.invalidate(); }
  };
  window.addEventListener('keydown', onKey);
  const ro = new ResizeObserver(() => drawHist());
  ro.observe(hist);

  // ---- boot: deep link (?match=…&t=…) → that moment, paused; otherwise the busiest match, autoplaying
  empty.hidden = false;
  renderInfo();
  syncTime();
  raf = requestAnimationFrame(frame);
  if (app.query.match) { S.matchId = app.query.match; selectMatch(app.query.match, app.query.t != null ? +app.query.t : null); loadList(); } else if (S.matchId) { selectMatch(S.matchId, 0); loadList(); } else loadList();

  return () => { alive = false; cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey); ro.disconnect(); map.destroy(); };
}
