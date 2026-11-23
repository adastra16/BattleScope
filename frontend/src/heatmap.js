/**
 * Density heatmap layer. The API sends a sparse N x N count grid; here we blur it, normalise against a high
 * percentile (so one hotspot doesn't wash out everything else) and colourise it into a small offscreen canvas.
 * `buildDiff` renders the *difference* between two grids (share of A minus share of B) for the Compare view.
 */
const N = 256;
const BLUR_RADIUS = 2;

// transparent -> violet -> red -> orange -> yellow -> white
const STOPS = [
  [0.0, [40, 0, 90, 0]],
  [0.15, [90, 20, 160, 140]],
  [0.4, [255, 43, 170, 205]],
  [0.65, [255, 130, 20, 225]],
  [0.85, [255, 220, 60, 240]],
  [1.0, [255, 255, 230, 250]],
];
const LUT = buildLut();

function buildLut() {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 1;
    while (k < STOPS.length - 1 && STOPS[k][0] < t) k++;
    const [t0, c0] = STOPS[k - 1], [t1, c1] = STOPS[k];
    const f = (t - t0) / (t1 - t0 || 1);
    for (let c = 0; c < 4; c++) lut[i * 4 + c] = c0[c] + (c1[c] - c0[c]) * f;
  }
  return lut;
}

export const RAMP_CSS = `linear-gradient(90deg, ${STOPS.map(([t, c]) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(c[3], 60) / 255}) ${t * 100}%`).join(', ')})`;

function boxBlur(src, dst, r) {
  // separable box blur, horizontal then vertical
  const tmp = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * N + Math.min(N - 1, Math.max(0, x))];
    for (let x = 0; x < N; x++) {
      tmp[y * N + x] = acc / (2 * r + 1);
      acc += src[y * N + Math.min(N - 1, x + r + 1)] - src[y * N + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < N; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(N - 1, Math.max(0, y)) * N + x];
    for (let y = 0; y < N; y++) {
      dst[y * N + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(N - 1, y + r + 1) * N + x] - tmp[Math.max(0, y - r) * N + x];
    }
  }
}

/** API sparse grid ({n, cells, counts}) -> dense Float32Array(N*N). */
function dense(g) {
  const grid = new Float32Array(N * N);
  const scale = N / g.n;
  for (let i = 0; i < g.cells.length; i++) {
    const c = g.cells[i];
    const x = Math.floor((c % g.n) * scale), y = Math.floor(Math.floor(c / g.n) * scale);
    grid[y * N + x] += g.counts[i];
  }
  return grid;
}

function smooth(grid) {
  const a = new Float32Array(N * N), b = new Float32Array(N * N);
  boxBlur(grid, a, BLUR_RADIUS);
  boxBlur(a, b, BLUR_RADIUS); // two passes ~ gaussian
  return b;
}

export class HeatLayer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = N;
    this.ctx = this.canvas.getContext('2d');
    this.count = 0;
  }

  clear() { this.ctx.clearRect(0, 0, N, N); this.count = 0; }

  /** @param {{n:number, cells:number[], counts:number[], total:number}} g */
  build(g) {
    this.count = g.total;
    const b = smooth(dense(g));
    const nz = [];
    for (let i = 0; i < b.length; i++) if (b[i] > 0) nz.push(b[i]);
    nz.sort((x, y) => x - y);
    const max = nz.length ? nz[Math.floor((nz.length - 1) * 0.995)] : 1;

    const img = this.ctx.createImageData(N, N);
    for (let i = 0; i < b.length; i++) {
      if (b[i] <= 0) continue;
      const t = Math.min(1, Math.sqrt(b[i] / max));
      const li = Math.round(t * 255) * 4;
      img.data.set(LUT.subarray(li, li + 4), i * 4);
    }
    this.ctx.putImageData(img, 0, 0);
  }

  /**
   * Diverging difference map: where A's share of activity exceeds B's (colA) and vice versa (colB).
   * Each side is normalised by its own total first, so different sample sizes compare fairly.
   */
  buildDiff(ga, gb, colA = [198, 242, 78], colB = [232, 121, 249]) {
    this.count = ga.total + gb.total;
    const A = smooth(dense(ga)), B = smooth(dense(gb));
    const sa = ga.total || 1, sb = gb.total || 1;
    const d = new Float32Array(N * N);
    const mags = [];
    for (let i = 0; i < d.length; i++) {
      d[i] = A[i] / sa - B[i] / sb;
      if (d[i] !== 0) mags.push(Math.abs(d[i]));
    }
    mags.sort((x, y) => x - y);
    const scale = mags.length ? mags[Math.floor((mags.length - 1) * 0.995)] || 1 : 1;
    const img = this.ctx.createImageData(N, N);
    for (let i = 0; i < d.length; i++) {
      const t = Math.max(-1, Math.min(1, d[i] / scale));
      const a = Math.pow(Math.abs(t), 0.6);
      if (a < 0.04) continue;
      const col = t > 0 ? colA : colB;
      img.data[i * 4] = col[0]; img.data[i * 4 + 1] = col[1]; img.data[i * 4 + 2] = col[2];
      img.data[i * 4 + 3] = a * 235;
    }
    this.ctx.putImageData(img, 0, 0);
  }
}
