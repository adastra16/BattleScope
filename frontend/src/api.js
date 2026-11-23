// Thin client for the BattleScope API (backend/app/main.py). Responses are cached per URL.
const base = (new URLSearchParams(location.search).get('api')
  ?? window.BATTLESCOPE_CONFIG?.apiBase ?? 'http://localhost:8000').replace(/\/$/, '');

const cache = new Map();
const MAX_CACHE = 300;

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function get(path, params = {}) {
  const url = `${base}/api${path}${qs(params)}`;
  if (!cache.has(url)) {
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    const p = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`API ${r.status}: ${(await r.json().catch(() => ({}))).detail ?? url}`);
      return r.json();
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url);
}

export const apiBase = base;
export const api = {
  meta: () => get('/meta'),
  matches: (map, params) => get(`/maps/${map}/matches`, params),
  match: (id) => get(`/matches/${encodeURIComponent(id)}`),
  heatmap: (map, params) => get(`/maps/${map}/heatmap`, params),
  events: (map, params) => get(`/maps/${map}/events`, params),
  summary: (map, params) => get(`/maps/${map}/summary`, params),
  zones: (map, params) => get(`/maps/${map}/zones`, params),
  flow: (map, params) => get(`/maps/${map}/flow`, params),
};

const images = new Map();
export function loadImage(src) {
  if (!images.has(src)) {
    images.set(src, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load ${src}`));
      img.src = src;
    }));
  }
  return images.get(src);
}
