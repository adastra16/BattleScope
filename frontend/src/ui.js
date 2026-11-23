// Tiny DOM toolkit + reusable filter controls shared by every dashboard section.
import { CATEGORIES, COLORS, fmtDay, fmtTime } from './constants.js';

/** Hyperscript: h('div', {class:'x', onclick}, child, 'text', [more]) */
export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) e.style.setProperty(sk, sv);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

// ---------------------------------------------------------------- async helpers
export const STALE = Object.assign(new Error('stale'), { stale: true });
/** Only the latest request of each kind may apply its result: guard('heat', promise). Throws STALE otherwise. */
export function latestGuard() {
  const tokens = {};
  return async (kind, promise) => {
    const tok = (tokens[kind] = Symbol(kind));
    const res = await promise;
    if (tokens[kind] !== tok) throw STALE;
    return res;
  };
}
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const daysParam = (sel, all) => (sel.size === all.length ? undefined : [...sel]);
export const pct = (n, d, digits = 0) => (d ? `${((n / d) * 100).toFixed(digits)}%` : '–');

// ---------------------------------------------------------------- layout atoms
const SECTION_EMOJI = { '01': '🔥', '02': '🧭', '03': '🎬', '04': '⚔️', '05': '📡' };
export function viewHead(eyebrow, title, sub) {
  return h('header', { class: 'vhead' }, h('span', { class: 'eyebrow' }, eyebrow),
    h('div', { class: 'h-row' }, h('h1', {}, title), h('span', { class: 'h-emoji', 'aria-hidden': 'true' }, SECTION_EMOJI[eyebrow.slice(0, 2)] || '✨')),
    sub ? h('p', {}, sub) : null);
}

/** Animate a number from 0 up to `to` (eased). Respects prefers-reduced-motion. */
export function countUp(el, to, { dur = 900, suffix = '', format = (v) => Math.round(v).toLocaleString() } = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = format(to) + suffix; return; }
  const t0 = performance.now();
  const step = (now) => {
    const x = Math.max(0, Math.min(1, (now - t0) / dur)); // rAF's timestamp can precede t0 by a few ms
    const e = 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2); // easeOutBack: tiny overshoot
    el.textContent = format(to * e) + suffix;
    if (x < 1) requestAnimationFrame(step); else el.textContent = format(to) + suffix;
  };
  requestAnimationFrame(step);
}

/** Burst of falling emoji. */
export function confetti(emojis = ['🎉', '✨', '💎', '⚡', '🎯', '🪩'], n = 30) {
  const layer = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  for (let i = 0; i < n; i++) {
    layer.append(h('span', { style: {
      left: `${Math.random() * 100}%`, '--dx': `${(Math.random() - 0.5) * 260}px`, '--rot': `${(Math.random() - 0.5) * 720}deg`,
      '--d': `${1.8 + Math.random() * 1.6}s`, '--sz': `${18 + Math.random() * 22}px`, 'animation-delay': `${Math.random() * 0.5}s`,
    } }, emojis[i % emojis.length]));
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 4500);
}

export function panel({ title, sub, actions, cls = '' }, ...body) {
  return h('section', { class: `panel ${cls}` },
    title || actions ? h('div', { class: 'panel-h' }, h('div', {}, title ? h('h2', {}, title) : null, sub ? h('p', {}, sub) : null), actions || null) : null,
    ...body);
}

export function field(label, control, cls = '') {
  return h('div', { class: `field ${cls}` }, h('span', { class: 'flabel' }, label), control);
}

export function kpi({ icon, label, value, sub, color }) {
  const v = h('span', { class: 'kpi-v' }, typeof value === 'number' ? '0' : value);
  if (typeof value === 'number') countUp(v, value);
  return h('div', { class: 'kpi', style: color ? { '--k': color } : null },
    icon ? h('span', { class: 'kpi-i' }, icon) : null, h('span', { class: 'kpi-l' }, label), v, sub ? h('span', { class: 'kpi-s' }, sub) : null);
}

// ---------------------------------------------------------------- filter controls
export function segmented(options, value, onChange) {
  const root = h('div', { class: 'seg', role: 'group' });
  const render = (v) => root.replaceChildren(...options.map((o) => h('button', {
    type: 'button', class: o.value === v ? 'on' : '', title: o.title,
    onclick: () => { render(o.value); onChange(o.value); },
  }, o.label)));
  root.set = render;
  render(value);
  return root;
}

export function select(options, value, onChange) {
  return h('select', { onchange: (e) => onChange(e.target.value) },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
}

/** Multi-select date chips bound to a Set. `.setCounts({day: n})` shows match counts on the chips. */
export function dayChips(days, counts, selected, onChange, { compact = false } = {}) {
  const root = h('div', { class: `chips ${compact ? 'compact' : ''}` });
  const render = () => root.replaceChildren(
    ...days.map((d) => h('button', {
      type: 'button', class: `chip ${selected.has(d) ? 'on' : ''}`,
      onclick: () => { if (selected.has(d)) { if (selected.size > 1) selected.delete(d); } else selected.add(d); render(); onChange(); },
    }, fmtDay(d).replace('Feb ', compact ? '' : 'Feb '), counts?.[d] != null && !compact ? h('small', {}, counts[d]) : null)),
    ...(selected.size === days.length ? [] : [h('button', { type: 'button', class: 'chip ghost', onclick: () => { days.forEach((d) => selected.add(d)); render(); onChange(); } }, 'All')]));
  root.setCounts = (c) => { counts = c; render(); };
  root.render = render;
  render();
  return root;
}

export const MARKER_ICONS = {
  kill: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="rgba(255,61,110,.45)" stroke="${COLORS.kill}" stroke-width="2"/></svg>`,
  death: `<svg viewBox="0 0 16 16"><path d="M3 3L13 13M13 3L3 13" stroke="${COLORS.death}" stroke-width="2.6" stroke-linecap="round"/></svg>`,
  storm: `<svg viewBox="0 0 16 16"><path d="M9 1L3 9h4l-1 6 7-9H9z" fill="${COLORS.storm}" stroke="#07041a" stroke-width=".8" stroke-linejoin="round"/></svg>`,
  loot: `<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="${COLORS.loot}" stroke="#07041a" stroke-width="1"/></svg>`,
};

/** Zorp, the mascot: a one-eyed neon-pink alien whose eye follows the cursor (see app.js). */
export function blip(size = 44) {
  return h('span', { class: 'blip', style: { '--s': `${size}px` }, html: `<svg viewBox="0 0 64 64" aria-hidden="true">
    <g stroke="#07041a" stroke-width="2.6" stroke-linecap="round"><path d="M24 16 L17 6"/><path d="M40 16 L47 6"/></g>
    <circle cx="16" cy="5.5" r="4.2" fill="#ffe814" stroke="#07041a" stroke-width="2.5"/><circle cx="48" cy="5.5" r="4.2" fill="#ffe814" stroke="#07041a" stroke-width="2.5"/>
    <path d="M9 37C9 21 19 12 32 12s23 9 23 25-10 21-23 21S9 53 9 37Z" fill="#ff2bd6" stroke="#07041a" stroke-width="3" stroke-linejoin="round"/>
    <circle cx="17.5" cy="26" r="2.4" fill="#ffe814"/><circle cx="48" cy="23" r="2" fill="#ffe814"/><circle cx="50" cy="41" r="2.2" fill="#ffe814"/>
    <path d="M16 21 Q19 16 25 14.5" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="2.4" stroke-linecap="round"/>
    <g class="eye"><circle cx="32" cy="29" r="11.5" fill="#fff" stroke="#07041a" stroke-width="2.6"/><g class="pupil"><circle cx="32" cy="29" r="5.4" fill="#07041a"/><circle cx="34" cy="27" r="1.7" fill="#fff"/></g></g>
    <path d="M20 46 Q32 58 44 46 Z" fill="#07041a" stroke="#07041a" stroke-width="2" stroke-linejoin="round"/>
    <rect x="25" y="46" width="4.2" height="4.4" rx=".9" fill="#fff"/><rect x="34.8" y="46" width="4.2" height="4.4" rx=".9" fill="#fff"/>
    <path d="M28 52 Q32 57.5 36 52 Q32 49.5 28 52Z" fill="#ff7aa8"/></svg>` });
}

const QUIPS = ['Counting bodies…', 'Asking the bots nicely…', 'Polishing the storm…', 'Sniffing out loot…', 'Teaching dots to run…', 'Reading the tea leaves (and the telemetry)…'];
export const quip = () => QUIPS[Math.floor(Math.random() * QUIPS.length)];
/** Loading / empty placeholder with Blip and a line of text. */
export function blipNote(text, size = 40) {
  return h('div', { class: 'blip-note' }, blip(size), h('p', {}, text));
}

/** Toggle chips for the four marker categories, bound to the `cats` object. */
export function markerChips(cats, onChange) {
  const root = h('div', { class: 'chips' });
  const render = () => root.replaceChildren(...CATEGORIES.map(({ key, label }) => h('button', {
    type: 'button', class: `chip mk ${cats[key] ? 'on' : ''}`,
    onclick: () => { cats[key] = !cats[key]; render(); onChange(); },
  }, h('span', { class: 'ic', html: MARKER_ICONS[key] }), label)));
  render();
  return root;
}

export function toggle(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle' }, input, h('span', { class: 'sw' }), label);
}

/** Two-handle range slider for a match-time window (seconds). onChange(from, to). */
export function timeWindow({ max, from = 0, to = max, onChange }) {
  let M = Math.max(1, max);
  const a = h('input', { type: 'range', min: 0, max: M, step: 1, value: from, 'aria-label': 'Window start' });
  const b = h('input', { type: 'range', min: 0, max: M, step: 1, value: to, 'aria-label': 'Window end' });
  const fill = h('div', { class: 'fill' });
  const label = h('div', { class: 'tw-label mono' });
  const root = h('div', { class: 'timewin' }, h('div', { class: 'dual' }, h('div', { class: 'track' }), fill, a, b), label);
  const paint = () => {
    const lo = +a.value, hi = +b.value;
    fill.style.left = `${(lo / M) * 100}%`;
    fill.style.width = `${((hi - lo) / M) * 100}%`;
    label.textContent = `${fmtTime(lo)} → ${fmtTime(hi)}`;
  };
  a.oninput = () => { if (+a.value > +b.value) a.value = b.value; paint(); onChange?.(+a.value, +b.value); };
  b.oninput = () => { if (+b.value < +a.value) b.value = a.value; paint(); onChange?.(+a.value, +b.value); };
  root.set = (lo, hi, newMax) => {
    if (newMax != null) { M = Math.max(1, newMax); a.max = b.max = M; }
    a.value = lo; b.value = hi; paint();
  };
  paint();
  return root;
}

export function tagBadge(tag, TAGS) {
  const t = TAGS[tag];
  return h('span', { class: 'tag', style: { '--c': t.color } }, t.label);
}
