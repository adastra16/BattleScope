import { COLORS, PATH_GAP_S } from './constants.js';

/**
 * Draws one marker shape. Filled = human-owned event, hollow = bot-owned event.
 *   kill  — crosshair ring (red)
 *   death — X (white)
 *   storm — lightning bolt (violet)
 *   loot  — small crate (mint)
 */
function markerPath(ctx, cat, x, y, r) {
  switch (cat) {
    case 'kill':
      ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2);
      break;
    case 'death': {
      const d = r * 0.85;
      ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
      ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d);
      break;
    }
    case 'storm':
      ctx.moveTo(x + 0.2 * r, y - 1.4 * r); ctx.lineTo(x - 0.85 * r, y + 0.2 * r); ctx.lineTo(x - 0.05 * r, y + 0.2 * r);
      ctx.lineTo(x - 0.35 * r, y + 1.4 * r); ctx.lineTo(x + 0.9 * r, y - 0.35 * r); ctx.lineTo(x + 0.1 * r, y - 0.35 * r); ctx.closePath();
      break;
    case 'loot': {
      const s = r * 0.7;
      ctx.rect(x - s, y - s, s * 2, s * 2);
      break;
    }
  }
}

/** Batched drawing: one path per (category, owner) group keeps 10k+ markers fast. */
export function drawMarkers(ctx, markers, scale) {
  const r = { kill: 5, death: 5, storm: 6, loot: 3 };
  const groups = new Map();
  for (const m of markers) {
    const key = `${m.cat}|${m.bot ? 1 : 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  // draw loot first so combat markers sit on top
  const order = ['loot', 'kill', 'storm', 'death'];
  const keys = [...groups.keys()].sort((a, b) => order.indexOf(a.split('|')[0]) - order.indexOf(b.split('|')[0]));
  for (const key of keys) {
    const [cat, bot] = key.split('|');
    const isBot = bot === '1';
    const rad = r[cat] * scale;
    ctx.beginPath();
    for (const m of groups.get(key)) markerPath(ctx, cat, m.x, m.y, rad);
    const color = COLORS[cat];
    ctx.lineJoin = 'round';
    if (cat === 'death') {
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = (isBot ? 3.5 : 4.5) * scale; ctx.stroke();
      ctx.strokeStyle = isBot ? COLORS.bot : color; ctx.lineWidth = (isBot ? 1.5 : 2.2) * scale; ctx.stroke();
    } else if (cat === 'kill') {
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 4 * scale; ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = 2 * scale; ctx.stroke();
      if (!isBot) { ctx.fillStyle = 'rgba(255,61,110,0.45)'; ctx.fill(); }
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 1.2 * scale;
      if (isBot) { ctx.stroke(); ctx.strokeStyle = color; ctx.lineWidth = 1.4 * scale; ctx.stroke(); }
      else { ctx.fillStyle = color; ctx.fill(); ctx.stroke(); }
    }
  }
}

/**
 * Draws a player's path up to time `now` and returns the interpolated head position (or null).
 * path is a flat int array [t, u, v, t, u, v, ...] with u/v scaled by `prec`.
 */
export function drawPath(ctx, view, path, now, prec, style) {
  if (path.length < 3 || path[0] > now) return null;
  ctx.beginPath();
  let prevT = path[0];
  let [px, py] = view.toScreen(path[1] / prec, path[2] / prec);
  ctx.moveTo(px, py);
  let head = [px, py];
  for (let i = 3; i < path.length; i += 3) {
    const t = path[i];
    const [x, y] = view.toScreen(path[i + 1] / prec, path[i + 2] / prec);
    const gap = t - prevT > PATH_GAP_S;
    if (t > now) {
      // interpolate the head between the last sample and the next one
      if (!gap) {
        const f = (now - prevT) / Math.max(1e-6, t - prevT);
        head = [px + (x - px) * f, py + (y - py) * f];
        ctx.lineTo(head[0], head[1]);
      }
      break;
    }
    if (gap) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    px = x; py = y; prevT = t; head = [x, y];
  }
  ctx.globalAlpha = style.alpha;
  ctx.setLineDash(style.dash || []);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = style.width + 2; ctx.stroke();
  ctx.strokeStyle = style.color; ctx.lineWidth = style.width; ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  return { x: head[0], y: head[1], ended: path[path.length - 3] <= now };
}

export function drawHead(ctx, x, y, isBot, alpha, focused) {
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  if (isBot) {
    const r = focused ? 6 : 4.5;
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
    ctx.fillStyle = COLORS.bot;
  } else {
    ctx.arc(x, y, focused ? 7.5 : 6, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.human;
  }
  ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = '#07041a'; ctx.stroke();
  // googly eyes: a little personality for every dot
  const e = focused ? 2.2 : 1.8;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  if (isBot) ctx.arc(x, y - 0.5, e, 0, Math.PI * 2);
  else { ctx.arc(x - 2.2, y - 1, e, 0, Math.PI * 2); ctx.moveTo(x + 2.2 + e, y - 1); ctx.arc(x + 2.2, y - 1, e, 0, Math.PI * 2); }
  ctx.fill();
  ctx.fillStyle = '#07041a';
  ctx.beginPath();
  if (isBot) ctx.arc(x + 0.5, y - 0.5, 0.8, 0, Math.PI * 2);
  else { ctx.arc(x - 1.8, y - 0.7, 0.8, 0, Math.PI * 2); ctx.moveTo(x + 2.6 + 0.8, y - 0.7); ctx.arc(x + 2.6, y - 0.7, 0.8, 0, Math.PI * 2); }
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** 8x8 reference grid (columns A-H west->east, rows 1-8 north->south) so designers can name locations. */
export function drawGrid(ctx, view, n = 8) {
  const { x, y, s } = view.rect;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,232,20,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const o = Math.round((i / n) * s) + 0.5;
    ctx.moveTo(x + o, y); ctx.lineTo(x + o, y + s);
    ctx.moveTo(x, y + o); ctx.lineTo(x + s, y + o);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '600 11px Inter, sans-serif';
  ctx.textBaseline = 'top';
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) {
      ctx.fillText(`${'ABCDEFGH'[c]}${r + 1}`, x + (c / n) * s + 4, y + (r / n) * s + 4);
    }
  }
  ctx.restore();
}
