// Dependency-free SVG charts. Colours are CSS variables so they follow the theme.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return v;
}

/** Stacked columns. series: [{label, color, values[]}], labels: string[] (one per column). */
export function stackedColumns({ series, labels, every = 2 }) {
  const W = 640, H = 190, pl = 34, pr = 6, pt = 8, pb = 22;
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const bw = (W - pl - pr) / n;
  const gap = Math.min(4, bw * 0.25);
  let out = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">`;
  for (const f of [0, 0.5, 1]) {
    const y = pt + (H - pt - pb) * (1 - f);
    out += `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}" class="gridline"/><text x="${pl - 6}" y="${y + 3}" class="ax" text-anchor="end">${Math.round(max * f)}</text>`;
  }
  labels.forEach((lab, i) => {
    let y = H - pb;
    const x = pl + i * bw + gap / 2;
    for (const s of series) {
      const v = s.values[i] || 0;
      const hgt = (v / max) * (H - pt - pb);
      if (hgt <= 0) continue;
      y -= hgt;
      out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${hgt.toFixed(1)}" rx="2" style="fill:${s.color}"><title>${esc(lab)} · ${v} ${esc(s.label)}</title></rect>`;
    }
    if (i % every === 0) out += `<text x="${(x + (bw - gap) / 2).toFixed(1)}" y="${H - 6}" class="ax" text-anchor="middle">${esc(lab)}</text>`;
  });
  return `${out}</svg>`;
}

/**
 * Risk / reward quadrant. points: [{id, x, y, r, color, dim}] where x = risk, y = reward (1.0 = fair share).
 * Circles carry data-id so the caller can link hover to other views.
 */
export function quadrant(points, { maxX = 4, maxY = 4 } = {}) {
  const W = 560, H = 380, pl = 46, pr = 14, pt = 14, pb = 40;
  const X = (v) => pl + (Math.min(v, maxX) / maxX) * (W - pl - pr);
  const Y = (v) => H - pb - (Math.min(v, maxY) / maxY) * (H - pt - pb);
  let out = `<svg viewBox="0 0 ${W} ${H}" class="chart quad" role="img">`;
  out += `<rect x="${X(0)}" y="${Y(maxY)}" width="${X(1) - X(0)}" height="${Y(1) - Y(maxY)}" class="q-good"/>`;
  out += `<rect x="${X(1)}" y="${Y(1)}" width="${X(maxX) - X(1)}" height="${Y(0) - Y(1)}" class="q-bad"/>`;
  for (let v = 0; v <= maxX; v++) {
    out += `<text x="${X(v)}" y="${H - pb + 16}" class="ax" text-anchor="middle">${v}×</text>`;
    out += `<text x="${pl - 8}" y="${Y(v) + 3}" class="ax" text-anchor="end">${v}×</text>`;
  }
  out += `<line x1="${X(1)}" x2="${X(1)}" y1="${Y(maxY)}" y2="${Y(0)}" class="refline"/><line x1="${X(0)}" x2="${X(maxX)}" y1="${Y(1)}" y2="${Y(1)}" class="refline"/>`;
  out += `<text x="${X(0) + 8}" y="${Y(maxY) + 16}" class="qlab">FREE LOOT</text>`;
  out += `<text x="${X(maxX) - 8}" y="${Y(maxY) + 16}" class="qlab" text-anchor="end">HIGH STAKES</text>`;
  out += `<text x="${X(0) + 8}" y="${Y(0) - 8}" class="qlab">LOW VALUE</text>`;
  out += `<text x="${X(maxX) - 8}" y="${Y(0) - 8}" class="qlab" text-anchor="end">DEATH TRAPS</text>`;
  out += `<text x="${(pl + W - pr) / 2}" y="${H - 6}" class="axt" text-anchor="middle">RISK · deaths per share of traffic →</text>`;
  out += `<text transform="rotate(-90)" x="${-(pt + H - pb) / 2}" y="12" class="axt" text-anchor="middle">REWARD · loot per share of traffic →</text>`;
  for (const p of [...points].sort((a, b) => b.r - a.r)) {
    out += `<g class="pt ${p.dim ? 'dim' : ''}" data-id="${esc(p.id)}"><circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${p.r.toFixed(1)}" style="--c:${p.color}"/>`
      + `<text x="${X(p.x).toFixed(1)}" y="${(Y(p.y) + 3).toFixed(1)}" text-anchor="middle">${esc(p.id)}</text><title>${esc(p.title || p.id)}</title></g>`;
  }
  return `${out}</svg>`;
}
