import { View } from './view.js';
import { HeatLayer } from './heatmap.js';
import { drawGrid } from './render.js';
import { loadImage } from './api.js';
import { h } from './ui.js';

/**
 * A self-contained minimap canvas: image + heat layer + optional grid + a caller-supplied overlay,
 * with pan / zoom, hover and click. Used by every section that shows a map.
 *
 *   const map = new MapCanvas(parentEl);
 *   await map.setMap('minimaps/AmbroseValley.jpg');
 *   map.overlay = (ctx, view) => { ... };          // draw markers, paths, zone tiles...
 *   map.onHover = (e) => ...; map.onClick = (e) => ...;   // e = {sx, sy, u, v, inside}
 */
export class MapCanvas {
  constructor(parent, { interactive = true, controls = true } = {}) {
    this.view = new View();
    this.heat = new HeatLayer();
    this.heatOn = false;
    this.heatOpacity = 0.75;
    this.grid = false;
    this.overlay = null;
    this.onHover = null;
    this.onClick = null;
    this.onViewChange = null;
    this.img = null;
    this._dirty = false;
    this._alive = true;

    this.canvas = h('canvas');
    this.tip = h('div', { class: 'tooltip', hidden: true });
    this.wrap = h('div', { class: 'mapwrap' }, this.canvas, this.tip);
    parent.append(this.wrap);
    this.ctx = this.canvas.getContext('2d');
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.wrap);

    if (interactive) this._bind();
    if (controls) {
      const zoom = (f) => { this.view.zoomAt(this.view.w / 2, this.view.h / 2, f); this.invalidate(); this.onViewChange?.(this); };
      this.wrap.append(h('div', { class: 'zoom' },
        h('button', { type: 'button', title: 'Zoom in', onclick: () => zoom(1.4) }, '+'),
        h('button', { type: 'button', title: 'Zoom out', onclick: () => zoom(1 / 1.4) }, '−'),
        h('button', { type: 'button', title: 'Fit map', onclick: () => { this.view.fit(); this.invalidate(); this.onViewChange?.(this); } }, '⤢')));
    }
  }

  async setMap(src) {
    this._src = src;
    const img = await loadImage(src);
    if (this._src !== src || !this._alive) return;
    this.img = img;
    this.invalidate();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.view.resize(r.width, r.height);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw(); // resizing clears the canvas, so repaint immediately (no blank flash)
  }

  invalidate() {
    if (this._dirty || !this._alive) return;
    this._dirty = true;
    requestAnimationFrame(() => { this._dirty = false; if (this._alive) this.draw(); });
  }

  draw() {
    const { ctx, view } = this;
    ctx.clearRect(0, 0, view.w, view.h);
    const { x, y, s } = view.rect;
    if (this.img) { ctx.imageSmoothingQuality = 'high'; ctx.drawImage(this.img, x, y, s, s); }
    if (this.heatOn) {
      ctx.save();
      ctx.globalAlpha = this.heatOpacity;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.heat.canvas, x, y, s, s);
      ctx.restore();
    }
    if (this.grid) drawGrid(ctx, view);
    try { this.overlay?.(ctx, view); } catch (e) { console.error(e); }
  }

  /** Copy another map's camera (used to keep Compare panels in lock-step). */
  syncFrom(other) {
    this.view.zoom = other.view.zoom; this.view.cx = other.view.cx; this.view.cy = other.view.cy;
    this.invalidate();
  }

  showTip(html, sx, sy) {
    this.tip.innerHTML = html;
    this.tip.style.left = `${sx}px`; this.tip.style.top = `${sy}px`;
    this.tip.hidden = false;
  }
  hideTip() { this.tip.hidden = true; }

  _evt(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [ix, iy] = this.view.toImage(sx, sy);
    return { sx, sy, u: ix, v: 1 - iy, inside: ix >= 0 && ix <= 1 && iy >= 0 && iy <= 1 };
  }

  _bind() {
    const c = this.canvas;
    let drag = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
      c.setPointerCapture(e.pointerId); c.classList.add('dragging');
    });
    c.addEventListener('pointerup', (e) => {
      const moved = drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 4;
      drag = null; c.classList.remove('dragging');
      if (!moved) this.onClick?.(this._evt(e));
    });
    c.addEventListener('pointermove', (e) => {
      if (drag) {
        this.view.pan(e.clientX - drag.x, e.clientY - drag.y);
        drag.x = e.clientX; drag.y = e.clientY;
        this.hideTip(); this.invalidate(); this.onViewChange?.(this);
        return;
      }
      this.onHover?.(this._evt(e));
    });
    c.addEventListener('pointerleave', () => { this.hideTip(); this.onHover?.(null); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.view.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      this.invalidate(); this.onViewChange?.(this);
    }, { passive: false });
  }

  destroy() { this._alive = false; this.ro.disconnect(); this.wrap.remove(); }
}
