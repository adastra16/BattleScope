/**
 * Pan/zoom camera over the minimap.
 *
 * Everything is placed in normalised minimap UV space (u, v in [0, 1]) produced by the pipeline:
 *   u = (x - originX) / scale,  v = (z - originZ) / scale
 * The minimap image covers exactly the unit square, with v pointing *up* (image rows point down), so:
 *   screenX = offsetX + u * size
 *   screenY = offsetY + (1 - v) * size
 * Because we never use the image's pixel dimensions, the mapping is correct for any image resolution.
 */
export class View {
  constructor() {
    this.w = 1; this.h = 1;
    this.zoom = 1; this.cx = 0.5; this.cy = 0.5; // centre of view in image space (0..1, y down)
  }

  resize(w, h) { this.w = w; this.h = h; }

  /** Size in CSS px of the full map at the current zoom. */
  get size() { return Math.min(this.w, this.h) * 0.96 * this.zoom; }

  get rect() {
    const s = this.size;
    return { x: this.w / 2 - this.cx * s, y: this.h / 2 - this.cy * s, s };
  }

  toScreen(u, v) {
    const { x, y, s } = this.rect;
    return [x + u * s, y + (1 - v) * s];
  }

  toImage(sx, sy) {
    const { x, y, s } = this.rect;
    return [(sx - x) / s, (sy - y) / s];
  }

  fit() { this.zoom = 1; this.cx = 0.5; this.cy = 0.5; }

  zoomAt(sx, sy, factor) {
    const [ix, iy] = this.toImage(sx, sy);
    this.zoom = Math.min(16, Math.max(0.6, this.zoom * factor));
    // keep the image point under the cursor fixed
    const s = this.size;
    this.cx = ix - (sx - this.w / 2) / s;
    this.cy = iy - (sy - this.h / 2) / s;
  }

  pan(dx, dy) {
    const s = this.size;
    this.cx = Math.min(1.2, Math.max(-0.2, this.cx - dx / s));
    this.cy = Math.min(1.2, Math.max(-0.2, this.cy - dy / s));
  }
}
