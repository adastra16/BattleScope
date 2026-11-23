// Shell: left rail navigation + hash router. Each section is its own module in views/ with its own filters.
import { api, apiBase } from './api.js';
import { blip, confetti, h } from './ui.js';
import * as overview from './views/overview.js';
import * as explore from './views/explore.js';
import * as replay from './views/replay.js';
import * as compare from './views/compare.js';
import * as radar from './views/radar.js';

const VIEWS = {
  overview: { mod: overview, label: 'Briefing', emoji: '🔥' },
  explore: { mod: explore, label: 'Map Lab', emoji: '🧭' },
  replay: { mod: replay, label: 'Replay', emoji: '🎬' },
  compare: { mod: compare, label: 'Compare', emoji: '⚔️' },
  radar: { mod: radar, label: 'Radar', emoji: '📡' },
};

const app = {
  meta: null,
  prefs: { map: 'AmbroseValley' },
  state: {},        // per-section filter state, kept while you move between sections
  query: {},
  view: 'overview',
  setQuery(obj) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...obj })) if (v != null && v !== '') q.set(k, v);
    history.replaceState(null, '', `#/${app.view}${q.size ? `?${q}` : ''}`);
  },
  go(view, query = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v != null && v !== '') q.set(k, v);
    location.hash = `#/${view}${q.size ? `?${q}` : ''}`;
  },
  say(text) { // friendly (non-error) toast
    const t = document.getElementById('toast');
    t.textContent = text; t.classList.add('fun'); t.hidden = false;
    clearTimeout(app._toast);
    app._toast = setTimeout(() => { t.hidden = true; t.classList.remove('fun'); }, 5000);
  },
  error(e) {
    console.error(e);
    const t = document.getElementById('toast');
    t.textContent = `Oops, something broke: ${e.message}`;
    t.classList.remove('fun'); t.hidden = false;
    clearTimeout(app._toast);
    app._toast = setTimeout(() => { t.hidden = true; }, 7000);
  },
};

function parseHash() {
  const [v, q = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { view: VIEWS[v] ? v : 'overview', query: Object.fromEntries(new URLSearchParams(q)) };
}

let cleanup = null;
function route() {
  const { view, query } = parseHash();
  cleanup?.();
  app.view = view;
  document.body.dataset.view = view; // each section has its own accent colour
  app.query = query;
  if (query.map && app.meta.maps[query.map]) app.prefs.map = query.map;
  const root = document.getElementById('view');
  root.replaceChildren();
  document.getElementById('content').scrollTo(0, 0);
  document.querySelectorAll('.rail a[data-view]').forEach((a) => a.classList.toggle('on', a.dataset.view === view));
  try { cleanup = VIEWS[view].mod.mount(root, app); } catch (e) { app.error(e); }
}

function buildRail() {
  const rail = document.getElementById('rail');
  rail.replaceChildren(
    h('a', { class: 'logo', href: '#/overview', title: 'BattleScope' }, blip(46), h('b', {}, 'BATTLE', h('br'), 'SCOPE')),
    h('div', { class: 'rail-nav' }, Object.entries(VIEWS).map(([k, v]) => h('a', { href: `#/${k}`, 'data-view': k, html: `<span class="ni">${v.emoji}</span><span>${v.label}</span>` }))),
    h('div', { class: 'rail-foot' },
      h('button', { type: 'button', class: 'about-btn', title: 'About the data', onclick: openAbout }, 'i'),
      h('span', { class: 'live', title: `API: ${apiBase}` })));
}

function openAbout() {
  const rep = app.meta.report;
  const evRows = Object.entries(rep.events_by_owner).flatMap(([owner, ev]) =>
    Object.entries(ev).map(([k, v]) => `<tr><td>${owner}</td><td>${k}</td><td>${v.toLocaleString()}</td></tr>`)).join('');
  document.getElementById('aboutBody').innerHTML = `
    <p>5 days (Feb 10–14, 2026) of LILA BLACK production telemetry. Each source file is one player's (or bot's) journey through one match.</p>
    <ul>
      <li><b>Humans vs bots</b>: decided by the file's <code>user_id</code> (UUID = human, numeric = bot).</li>
      <li><b>Timestamps</b>: <code>ts</code> is typed as milliseconds but holds Unix <i>seconds</i>; times are seconds since the match's first event.</li>
      <li><b>Events</b> belong to the file's owner. In a bot's file, <i>BotKilled</i> means that bot died.</li>
      <li><b>Coverage</b>: most matches contain one human's file, so Replay usually shows a single journey plus bots. Aggregate views (Map Lab, Compare, Radar) are where the signal is.</li>
      <li><b>No extraction event</b>: "no death" is the closest proxy for a successful run.</li>
      <li><b>Zones</b>: the A–H × 1–8 grid. Zone types come from rules in <code>backend/app/store.py</code> (risk = deaths per share of traffic, reward = loot per share of traffic).</li>
    </ul>
    <table><tr><th>Files read</th><td>${rep.files_read}</td><th>Matches</th><td>${rep.matches}</td></tr>
      <tr><th>Humans</th><td>${rep.humans}</td><th>Bots</th><td>${rep.bots}</td></tr>
      <tr><th>Rows (raw → clean)</th><td>${rep.rows_raw.toLocaleString()} → ${rep.rows_clean.toLocaleString()}</td><th>Out of bounds</th><td>${rep.out_of_bounds_points}</td></tr></table>
    <table><tr><th>Owner</th><th>Event</th><th>Rows</th></tr>${evRows}</table>
    <p class="dim">API: <code>${apiBase}</code> · <a href="${apiBase}/docs" target="_blank" rel="noopener">interactive API docs</a></p>`;
  document.getElementById('about').showModal();
}

async function boot() {
  buildRail();
  try {
    app.meta = await api.meta();
  } catch {
    document.getElementById('view').replaceChildren(h('div', { class: 'boot-error' }, h('h1', {}, 'Can\'t reach the BattleScope API'),
      h('p', {}, `Tried ${apiBase}. Start the backend (cd backend && uvicorn app.main:app --port 8000) or set apiBase in frontend/config.js.`),
      h('button', { class: 'btn', onclick: () => location.reload() }, 'Retry')));
    return;
  }
  buildFloaters();
  document.querySelector('.rail .blip').addEventListener('click', pokeBlip);
  window.addEventListener('hashchange', route);
  route();
}
window.addEventListener('unhandledrejection', (e) => app.error(e.reason));

/** Slow-drifting emoji over the whole app. */
function buildFloaters() {
  const set = ['🕹️', '👾', '🪙', '🏆', '💣'];
  const layer = h('div', { class: 'floaters', 'aria-hidden': 'true' });
  for (let i = 0; i < 5; i++) {
    layer.append(h('span', { style: {
      left: `${(i * 21 + Math.random() * 10) % 100}%`, '--d': `${50 + Math.random() * 30}s`, '--dx': `${(Math.random() - 0.5) * 180}px`,
      '--rot': `${(Math.random() - 0.5) * 540}deg`, '--sz': `${14 + Math.random() * 10}px`, 'animation-delay': `${-Math.random() * 70}s`,
    } }, set[i % set.length]));
  }
  document.body.append(layer);
}

/** Poke Zorp: it jumps and says something rude. Five pokes = confetti. */
const POKES = ['Boo!', 'Ow. That was my only eye!', 'Have you checked GTA 6 yet?', 'GTA 6 is out any day now. Any day.', 'Hot take: GTA 6 ships before Lockdown gets rebalanced.',
  'Take me to your level designer.', 'I come in peace. Mostly.', 'Zorp approves this heatmap.', 'Stop poking the alien.', 'Loot first, questions later.', 'Still no GTA 6 trailer. Anyway.'];
let pokes = 0;
function pokeBlip(e) {
  e.preventDefault(); e.stopPropagation();
  const b = e.currentTarget, r = b.getBoundingClientRect();
  b.classList.remove('jump'); void b.offsetWidth; b.classList.add('jump');
  const say = h('div', { class: 'speech' }, POKES[Math.floor(Math.random() * POKES.length)]);
  say.style.left = `${r.right + 14}px`; say.style.top = `${r.top + 4}px`;
  document.body.append(say); setTimeout(() => say.remove(), 1700);
  if (++pokes % 5 === 0) confetti();
}

// Zorp's eye follows the cursor
window.addEventListener('pointermove', (e) => {
  document.querySelectorAll('.blip').forEach((b) => {
    const r = b.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), d = Math.hypot(dx, dy) || 1;
    const k = Math.min(1, d / 140) * 4;
    b.querySelectorAll('.pupil').forEach((p) => { p.style.transform = `translate(${(dx / d) * k}px, ${(dy / d) * k}px)`; });
  });
}, { passive: true });
boot();
