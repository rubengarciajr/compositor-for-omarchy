/**
 * Brush stroke engine, ported from Compositor's BrushStroke / MetalBrushCoverage.
 *
 * A stroke owns a *coverage* buffer in document space rather than painting dabs straight
 * into the layer. Dabs accumulate optical density (soft tips) or take the maximum (hard
 * tips); the layer is then rebuilt for the touched area as `base + colour through
 * coverage at alpha = opacity`. Opacity therefore caps the whole stroke, as in Photoshop:
 * overlapping dabs never exceed it, and every publish starts from the untouched base.
 *
 * The layer bitmap grows lazily where paint lands outside it and is trimmed back to the
 * painted extent when the stroke ends, so a brush can paint anywhere on the canvas.
 */
import type { DocumentState, Layer, Transform } from "./model";
import { createCanvas } from "./model";
import { cloneCanvas } from "./pixels";
import { writableLayer, writableMask } from "./history";
import { fromLocal, toLocal } from "./transform";

export type StrokeMode = "paint" | "erase" | "clone" | "blur" | "heal" | "mask-reveal" | "mask-hide";

export interface StrokeTip {
  /** Document pixels, 1…2000. */
  diameter: number;
  /** 0 = fully soft, 1 = hard-edged. */
  hardness: number;
  /** 0.01…1, applied once to the whole stroke. */
  opacity: number;
}

export interface StrokeOptions {
  /** Paint colour as 0…255 RGB (paint mode). */
  color?: [number, number, number];
  /** Document-sized image copied through the tip (clone / blur). */
  sample?: HTMLCanvasElement;
  /** Shift of the sample relative to the pointer (clone): the pixel painted at p comes from p + offset. */
  sampleOffset?: { x: number; y: number };
  /** Document-sized selection mask (white = selected); the stroke is clipped to it. */
  selection?: HTMLCanvasElement | null;
  /** Replace pixels with the sample instead of compositing over them (warp commits). */
  replace?: boolean;
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Upstream tip falloff: u = 0 at the hardness radius, 1 at the rim. */
export function tipFalloff(u: number): number {
  const k = 2.5;
  const e = Math.exp(-k);
  return Math.max(0, (Math.exp(-k * u * u) - e) / (1 - e));
}

/** Distance between deposits along the path. */
export function tipSpacing(diameter: number, hardness: number): number {
  return Math.max(0.25, diameter * (hardness >= 1 ? 0.015 : 0.025));
}

/** Layer-bitmap pixel coordinates of a document point. */
export function docToLayer(t: Transform, cw: number, ch: number, p: { x: number; y: number }): { x: number; y: number } {
  const u = toLocal(t, p);
  const ux = t.flipH ? -u.x : u.x, uy = t.flipV ? -u.y : u.y;
  return { x: ((ux + t.width / 2) * cw) / Math.max(1, t.width), y: ((uy + t.height / 2) * ch) / Math.max(1, t.height) };
}

/** Document coordinates of a layer-bitmap pixel. */
export function layerToDoc(t: Transform, cw: number, ch: number, q: { x: number; y: number }): { x: number; y: number } {
  let lx = (q.x / Math.max(1, cw)) * t.width - t.width / 2;
  let ly = (q.y / Math.max(1, ch)) * t.height - t.height / 2;
  if (t.flipH) lx = -lx;
  if (t.flipV) ly = -ly;
  return fromLocal(t, { x: lx, y: ly });
}

/** Make a layer-bitmap context accept document coordinates. Pair with ctx.restore(). */
export function enterDocSpace(ctx: CanvasRenderingContext2D, layer: Layer): void {
  const t = layer.transform;
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const sx = t.width / Math.max(1, cw), sy = t.height / Math.max(1, ch);
  ctx.save();
  ctx.scale(1 / sx, 1 / sy);
  ctx.translate(t.width / 2, t.height / 2);
  ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
  ctx.rotate((-t.rotation * Math.PI) / 180);
  ctx.translate(-(t.x + t.width / 2), -(t.y + t.height / 2));
}

/**
 * Grow or shrink a layer's bitmap by whole pixels on each side (positive = grow), keeping
 * every existing pixel where it is on the canvas. Works for rotated, flipped and scaled layers.
 */
export function resizeLayerBitmap(layer: Layer, left: number, top: number, right: number, bottom: number): void {
  const c = layer.canvas;
  if (!c || (!left && !top && !right && !bottom)) return;
  const t = layer.transform;
  const w = Math.max(1, c.width + left + right), h = Math.max(1, c.height + top + bottom);
  const next = createCanvas(w, h);
  next.getContext("2d")!.drawImage(c, left, top);
  const sx = t.width / Math.max(1, c.width), sy = t.height / Math.max(1, c.height);
  // The bitmap's centre moves by half the asymmetry, in the layer's own (flipped, rotated) frame.
  let vx = ((right - left) / 2) * sx, vy = ((bottom - top) / 2) * sy;
  if (t.flipH) vx = -vx;
  if (t.flipV) vy = -vy;
  const rad = (t.rotation * Math.PI) / 180;
  const dx = vx * Math.cos(rad) - vy * Math.sin(rad), dy = vx * Math.sin(rad) + vy * Math.cos(rad);
  const cx = t.x + t.width / 2 + dx, cy = t.y + t.height / 2 + dy;
  t.width = w * sx;
  t.height = h * sy;
  t.x = cx - t.width / 2;
  t.y = cy - t.height / 2;
  layer.canvas = next;
}

/** Bounding box of the pixels with any alpha inside `within` (bitmap coordinates), or null. */
export function alphaBounds(canvas: HTMLCanvasElement, within?: Rect): Rect | null {
  const x0 = Math.max(0, Math.floor(within?.x ?? 0)), y0 = Math.max(0, Math.floor(within?.y ?? 0));
  const x1 = Math.min(canvas.width, Math.ceil((within?.x ?? 0) + (within?.w ?? canvas.width)));
  const y1 = Math.min(canvas.height, Math.ceil((within?.y ?? 0) + (within?.h ?? canvas.height)));
  if (x1 <= x0 || y1 <= y0) return null;
  const d = canvas.getContext("2d")!.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const w = x1 - x0;
  let minX = w, minY = y1 - y0, maxX = -1, maxY = -1;
  for (let i = 3, p = 0; i < d.length; i += 4, p++) {
    if (d[i]) {
      const x = p % w, y = (p - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: x0 + minX, y: y0 + minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const union = (a: Rect | null, b: Rect | null): Rect | null => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const intersect = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
};

/** Per-stroke lookup of the tip's coverage by distance from the centre (4 samples per pixel). */
function tipTable(r: number, hardness: number): Float32Array {
  const n = Math.ceil(r * 4) + 8;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = i / 4;
    if (hardness >= 1) t[i] = Math.min(1, Math.max(0, r - d + 0.5)); // one-pixel antialiased rim
    else t[i] = tipFalloff(Math.min(1, Math.max(0, (d / r - hardness) / (1 - hardness))));
  }
  return t;
}

export class BrushStroke {
  readonly mode: StrokeMode;
  readonly tip: StrokeTip;
  /** Pixels the stroke has changed, in document space (for redraws). */
  dirtyDocument: Rect | null = null;
  private readonly doc: DocumentState;
  private readonly layer: Layer;
  private readonly hard: boolean;
  private readonly radius: number;
  private readonly spacing: number;
  private readonly table: Float32Array;
  private readonly color: [number, number, number];
  private readonly sample: ImageData | null;
  private readonly sampleOffset: { x: number; y: number };
  private readonly selection: ImageData | null;
  private readonly replace: boolean;
  // Coverage buffer (document space), allocated for the area touched so far.
  private cov = new Float32Array(0);
  private area: Rect | null = null;
  private touched: Rect | null = null;
  // Where the target's untouched pixels live.
  private readonly base: HTMLCanvasElement;
  private readonly originalCanvas: HTMLCanvasElement;
  private readonly originalTransform: Transform;
  private origin = { x: 0, y: 0 }; // base's position inside the (possibly grown) layer bitmap
  private readonly isMask: boolean;
  private readonly scratch = createCanvas(1, 1);
  private samples: { x: number; y: number }[] = [];
  private distanceToNext = 0;
  private pending: Rect | null = null;
  private lastPoint: { x: number; y: number } | null = null;

  constructor(doc: DocumentState, layer: Layer, tip: StrokeTip, mode: StrokeMode, opts: StrokeOptions = {}) {
    this.doc = doc;
    this.layer = layer;
    this.mode = mode;
    this.tip = { diameter: Math.min(2000, Math.max(1, tip.diameter)), hardness: Math.min(1, Math.max(0, tip.hardness)), opacity: Math.min(1, Math.max(0.01, tip.opacity)) };
    this.hard = this.tip.hardness >= 1;
    this.radius = this.tip.diameter / 2;
    this.spacing = tipSpacing(this.tip.diameter, this.tip.hardness);
    this.table = tipTable(this.radius, this.tip.hardness);
    this.color = opts.color ?? [0, 0, 0];
    this.sample = opts.sample ? opts.sample.getContext("2d")!.getImageData(0, 0, opts.sample.width, opts.sample.height) : null;
    this.sampleOffset = opts.sampleOffset ?? { x: 0, y: 0 };
    this.selection = opts.selection ? opts.selection.getContext("2d")!.getImageData(0, 0, opts.selection.width, opts.selection.height) : null;
    this.replace = !!opts.replace;
    this.isMask = mode === "mask-reveal" || mode === "mask-hide";
    this.originalTransform = { ...layer.transform };
    if (this.isMask) {
      const before = layer.mask!.canvas;
      const writable = writableMask(layer)!;
      this.base = writable === before ? cloneCanvas(before) : before;
      this.originalCanvas = before;
    } else {
      const before = layer.canvas!;
      const writable = writableLayer(layer)!;
      this.base = writable === before ? cloneCanvas(before) : before;
      this.originalCanvas = before;
    }
  }

  private get target(): HTMLCanvasElement {
    return this.isMask ? this.layer.mask!.canvas : this.layer.canvas!;
  }

  /** Add a pointer sample; lays deposits along the way and updates the layer. */
  append(p: { x: number; y: number }): void {
    if (!isFinite(p.x) || !isFinite(p.y)) return;
    const last = this.lastPoint;
    if (last && last.x === p.x && last.y === p.y) return;
    if (!last) {
      this.deposit(p.x, p.y);
      this.distanceToNext = this.spacing;
    } else {
      const dx = p.x - last.x, dy = p.y - last.y;
      const len = Math.hypot(dx, dy);
      let d = this.distanceToNext;
      while (d <= len) {
        const t = d / len;
        this.deposit(last.x + dx * t, last.y + dy * t);
        d += this.spacing;
      }
      this.distanceToNext = d - len;
    }
    this.lastPoint = p;
    this.samples.push(p);
    this.publish();
  }

  /** Every point appended so far (document space). */
  get points(): { x: number; y: number }[] {
    return this.samples;
  }

  private ensureArea(r: Rect): void {
    const need = { x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.x + r.w) - Math.floor(r.x), h: Math.ceil(r.y + r.h) - Math.floor(r.y) };
    if (this.area && need.x >= this.area.x && need.y >= this.area.y && need.x + need.w <= this.area.x + this.area.w && need.y + need.h <= this.area.y + this.area.h) return;
    const grown = union(this.area, need)!;
    // Leave room so a stroke heading one way does not reallocate every few pixels.
    const pad = Math.ceil(this.tip.diameter + 64);
    const next: Rect = { x: grown.x - (need.x < (this.area?.x ?? Infinity) ? pad : 0), y: grown.y - (need.y < (this.area?.y ?? Infinity) ? pad : 0), w: 0, h: 0 };
    const right = Math.max(grown.x + grown.w, this.area ? this.area.x + this.area.w : -Infinity) + (need.x + need.w > (this.area ? this.area.x + this.area.w : -Infinity) ? pad : 0);
    const bottom = Math.max(grown.y + grown.h, this.area ? this.area.y + this.area.h : -Infinity) + (need.y + need.h > (this.area ? this.area.y + this.area.h : -Infinity) ? pad : 0);
    next.w = right - next.x;
    next.h = bottom - next.y;
    const buf = new Float32Array(next.w * next.h);
    if (this.area) {
      for (let y = 0; y < this.area.h; y++) {
        const src = y * this.area.w, dst = (y + this.area.y - next.y) * next.w + (this.area.x - next.x);
        buf.set(this.cov.subarray(src, src + this.area.w), dst);
      }
    }
    this.cov = buf;
    this.area = next;
  }

  private deposit(cx: number, cy: number): void {
    const r = this.radius + 1;
    const rect: Rect = { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
    this.ensureArea(rect);
    const a = this.area!;
    const x0 = Math.max(a.x, Math.floor(cx - r)), x1 = Math.min(a.x + a.w, Math.ceil(cx + r));
    const y0 = Math.max(a.y, Math.floor(cy - r)), y1 = Math.min(a.y + a.h, Math.ceil(cy + r));
    const table = this.table, n = table.length, hard = this.hard, cov = this.cov;
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy;
      let i = (y - a.y) * a.w + (x0 - a.x);
      for (let x = x0; x < x1; x++, i++) {
        const dx = x + 0.5 - cx;
        const k = Math.round(Math.sqrt(dx * dx + dy * dy) * 4);
        if (k >= n) continue;
        const c = table[k];
        if (c <= 0) continue;
        if (hard) { if (c > cov[i]) cov[i] = c; }
        else {
          const v = cov[i] - Math.log(Math.max(1 - c, 0.001));
          cov[i] = v > 20 ? 20 : v;
        }
      }
    }
    const touched: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    this.pending = union(this.pending, touched);
    this.touched = union(this.touched, touched);
  }

  /** Coverage 0…1 at a document pixel. */
  coverageAt(x: number, y: number): number {
    const a = this.area;
    if (!a || x < a.x || y < a.y || x >= a.x + a.w || y >= a.y + a.h) return 0;
    const v = this.cov[(y - a.y) * a.w + (x - a.x)];
    return this.hard ? v : 1 - Math.exp(-v);
  }

  /** Coverage bytes (0…255) over a document rect, selection applied; for the healer. */
  coverageBytes(r: Rect): Uint8Array {
    const out = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      let c = this.coverageAt(r.x + x, r.y + y);
      if (this.selection) c *= this.selectionAt(r.x + x, r.y + y);
      out[y * r.w + x] = Math.round(c * 255);
    }
    return out;
  }

  private selectionAt(x: number, y: number): number {
    const s = this.selection!;
    if (x < 0 || y < 0 || x >= s.width || y >= s.height) return 0;
    return s.data[(y * s.width + x) * 4 + 3] / 255;
  }

  /** Rebuild the layer where the coverage changed since the last publish. */
  private publish(): void {
    const dirty = this.pending;
    if (!dirty) return;
    this.pending = null;
    this.paintRect(dirty);
  }

  /** Rebuild the target for a document rect: base, then the stroke through the coverage. */
  private paintRect(dirtyDoc: Rect, finalImage?: { data: ImageData; rect: Rect }): void {
    const docBounds: Rect = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    if (this.isMask) {
      const docRect = dirtyDoc;
      const clipped = intersect(docRect, { x: 0, y: 0, w: this.doc.width, h: this.doc.height });
      if (!clipped) return;
      const region = { x: Math.floor(clipped.x), y: Math.floor(clipped.y), w: Math.ceil(clipped.x + clipped.w) - Math.floor(clipped.x), h: Math.ceil(clipped.y + clipped.h) - Math.floor(clipped.y) };
      const ctx = this.target.getContext("2d")!;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(region.x, region.y, region.w, region.h);
      ctx.drawImage(this.base, region.x, region.y, region.w, region.h, region.x, region.y, region.w, region.h);
      this.drawOverlay(ctx, region, finalImage);
      ctx.restore();
      this.dirtyDocument = union(this.dirtyDocument, region);
      return;
    }
    const layer = this.layer;
    const t = layer.transform;
    let c = layer.canvas!;
    // Paint reaches the existing bitmap anywhere, but grows it only inside the document.
    const layerCorners = [{ x: 0, y: 0 }, { x: c.width, y: 0 }, { x: 0, y: c.height }, { x: c.width, y: c.height }].map((q) => layerToDoc(t, c.width, c.height, q));
    const layerBox: Rect = { x: Math.min(...layerCorners.map((p) => p.x)), y: Math.min(...layerCorners.map((p) => p.y)), w: 0, h: 0 };
    layerBox.w = Math.max(...layerCorners.map((p) => p.x)) - layerBox.x;
    layerBox.h = Math.max(...layerCorners.map((p) => p.y)) - layerBox.y;
    const docRect = intersect(dirtyDoc, union(docBounds, layerBox)!);
    if (!docRect) return;
    const growRect = intersect(dirtyDoc, docBounds);
    // Layer-bitmap box of the document rect.
    const corners = [
      { x: docRect.x, y: docRect.y }, { x: docRect.x + docRect.w, y: docRect.y },
      { x: docRect.x, y: docRect.y + docRect.h }, { x: docRect.x + docRect.w, y: docRect.y + docRect.h },
    ].map((p) => docToLayer(t, c.width, c.height, p));
    let lx0 = Math.floor(Math.min(...corners.map((p) => p.x))) - 1, ly0 = Math.floor(Math.min(...corners.map((p) => p.y))) - 1;
    let lx1 = Math.ceil(Math.max(...corners.map((p) => p.x))) + 1, ly1 = Math.ceil(Math.max(...corners.map((p) => p.y))) + 1;
    if ((this.mode === "paint" || this.mode === "clone") && growRect) {
      // Paint can land outside the bitmap: grow it (and remember where the base now sits).
      const g = [
        { x: growRect.x, y: growRect.y }, { x: growRect.x + growRect.w, y: growRect.y },
        { x: growRect.x, y: growRect.y + growRect.h }, { x: growRect.x + growRect.w, y: growRect.y + growRect.h },
      ].map((p) => docToLayer(t, c.width, c.height, p));
      const gx0 = Math.floor(Math.min(...g.map((p) => p.x))), gy0 = Math.floor(Math.min(...g.map((p) => p.y)));
      const gx1 = Math.ceil(Math.max(...g.map((p) => p.x))), gy1 = Math.ceil(Math.max(...g.map((p) => p.y)));
      const left = Math.max(0, -gx0), top = Math.max(0, -gy0), right = Math.max(0, gx1 - c.width), bottom = Math.max(0, gy1 - c.height);
      if (left || top || right || bottom) {
        resizeLayerBitmap(layer, left, top, right, bottom);
        c = layer.canvas!;
        this.origin = { x: this.origin.x + left, y: this.origin.y + top };
        lx0 += left; lx1 += left; ly0 += top; ly1 += top;
      }
    }
    lx0 = Math.max(0, lx0); ly0 = Math.max(0, ly0); lx1 = Math.min(c.width, lx1); ly1 = Math.min(c.height, ly1);
    if (lx1 <= lx0 || ly1 <= ly0) return;
    // Document rect that fully covers this bitmap region (bigger than dirtyDoc when rotated).
    const back = [
      { x: lx0, y: ly0 }, { x: lx1, y: ly0 }, { x: lx0, y: ly1 }, { x: lx1, y: ly1 },
    ].map((q) => layerToDoc(t, c.width, c.height, q));
    const region = {
      x: Math.floor(Math.min(...back.map((p) => p.x))) - 1, y: Math.floor(Math.min(...back.map((p) => p.y))) - 1,
      w: 0, h: 0,
    };
    region.w = Math.ceil(Math.max(...back.map((p) => p.x))) + 1 - region.x;
    region.h = Math.ceil(Math.max(...back.map((p) => p.y))) + 1 - region.y;
    const ctx = c.getContext("2d")!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(lx0, ly0, lx1 - lx0, ly1 - ly0);
    ctx.clip();
    ctx.clearRect(lx0, ly0, lx1 - lx0, ly1 - ly0);
    ctx.drawImage(this.base, this.origin.x, this.origin.y);
    enterDocSpace(ctx, layer);
    this.drawOverlay(ctx, region, finalImage);
    ctx.restore();
    ctx.restore();
    this.dirtyDocument = union(this.dirtyDocument, region);
  }

  /** Composite the stroke's pixels for a document region onto a context in document space. */
  private drawOverlay(ctx: CanvasRenderingContext2D, region: Rect, finalImage?: { data: ImageData; rect: Rect }): void {
    if (finalImage) {
      this.scratch.width = finalImage.rect.w;
      this.scratch.height = finalImage.rect.h;
      this.scratch.getContext("2d")!.putImageData(finalImage.data, 0, 0);
      ctx.drawImage(this.scratch, finalImage.rect.x, finalImage.rect.y);
      return;
    }
    const img = this.overlayImage(region);
    if (!img) return;
    this.scratch.width = region.w;
    this.scratch.height = region.h;
    this.scratch.getContext("2d")!.putImageData(img, 0, 0);
    ctx.globalAlpha = this.mode === "heal" ? 1 : this.tip.opacity;
    ctx.globalCompositeOperation = this.mode === "erase" || this.mode === "mask-hide" ? "destination-out" : this.replace ? "copy" : "source-over";
    if (this.replace) {
      // "copy" would clear the whole clip; replace only where the coverage says so.
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(this.scratch, region.x, region.y);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(this.scratch, region.x, region.y);
  }

  /** RGBA pixels of the stroke over a document region (straight alpha = coverage). */
  private overlayImage(region: Rect): ImageData | null {
    const a = this.area;
    if (!a) return null;
    const img = new ImageData(region.w, region.h);
    const d = img.data;
    const [cr, cg, cb] = this.mode === "heal" ? [31, 31, 31] : this.mode === "mask-reveal" ? [255, 255, 255] : this.color;
    const wash = this.mode === "heal" ? 0.45 : 1;
    const s = this.sample, off = this.sampleOffset;
    for (let y = 0; y < region.h; y++) {
      const dy = region.y + y;
      for (let x = 0; x < region.w; x++) {
        const dx = region.x + x;
        let cov = this.coverageAt(dx, dy);
        if (cov <= 0) continue;
        if (this.selection) cov *= this.selectionAt(dx, dy);
        if (cov <= 0) continue;
        const o = (y * region.w + x) * 4;
        if (s) {
          const sx = Math.round(dx + off.x), sy = Math.round(dy + off.y);
          if (sx < 0 || sy < 0 || sx >= s.width || sy >= s.height) continue;
          const si = (sy * s.width + sx) * 4;
          d[o] = s.data[si]; d[o + 1] = s.data[si + 1]; d[o + 2] = s.data[si + 2];
          d[o + 3] = Math.round((s.data[si + 3] / 255) * cov * 255);
        } else {
          d[o] = cr; d[o + 1] = cg; d[o + 2] = cb;
          d[o + 3] = Math.round(cov * wash * 255);
        }
      }
    }
    return img;
  }

  /** Document rect of everything deposited so far. */
  get bounds(): Rect | null {
    return this.touched;
  }

  /** Write a finished image (e.g. a healed patch) through the coverage; `rect` in document space. */
  applyResult(data: ImageData, rect: Rect): void {
    this.paintRect(rect, { data, rect });
  }

  /** Undo everything: the layer is exactly as before the stroke. */
  cancel(): void {
    if (this.isMask) this.layer.mask!.canvas = this.originalCanvas;
    else this.layer.canvas = this.originalCanvas;
    this.layer.transform = this.originalTransform;
  }

  /** Trim a grown bitmap back to the painted extent. Returns false when nothing was painted. */
  finish(): boolean {
    this.publish();
    if (!this.touched) { this.cancel(); return false; }
    if (this.isMask) return true;
    const c = this.layer.canvas!;
    const baseRect: Rect = { x: this.origin.x, y: this.origin.y, w: this.base.width, h: this.base.height };
    if (c.width === this.base.width && c.height === this.base.height) return true;
    const painted = alphaBounds(c);
    const keep = union(painted, baseRect) ?? baseRect;
    resizeLayerBitmap(this.layer, -keep.x, -keep.y, keep.x + keep.w - c.width, keep.y + keep.h - c.height);
    return true;
  }
}

/** Draw a layer's bitmap into a document-sized context at its transform (no mask, no effects). */
export function drawLayerInDocument(ctx: CanvasRenderingContext2D, layer: Layer): void {
  const c = layer.canvas;
  if (!c) return;
  const t = layer.transform;
  ctx.save();
  ctx.translate(t.x + t.width / 2, t.y + t.height / 2);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
  ctx.drawImage(c, -t.width / 2, -t.height / 2, t.width, t.height);
  ctx.restore();
}

/** A layer rendered into a fresh document-sized canvas. */
export function layerInDocument(doc: DocumentState, layer: Layer): HTMLCanvasElement {
  const out = createCanvas(doc.width, doc.height);
  drawLayerInDocument(out.getContext("2d")!, layer);
  return out;
}

/**
 * Liquify and Smudge (Compositor's WarpStroke): the active layer is drawn into a
 * document-sized working copy that the dabs push or smear in place; while the stroke
 * runs the layer shows that copy, and on finish the result is written back through a
 * hard tip a little wider than the brush.
 */
export class WarpStroke {
  readonly mode: "liquify" | "smudge";
  readonly diameter: number;
  readonly hardness: number;
  readonly strength: number;
  readonly points: { x: number; y: number }[] = [];
  readonly preview: HTMLCanvasElement;
  private readonly pixels: ImageData;
  private readonly layer: Layer;
  private readonly originalCanvas: HTMLCanvasElement;
  private readonly originalTransform: Transform;
  private last: { x: number; y: number } | null = null;
  private carried: Float32Array | null = null;
  private dirty: Rect | null = null;

  constructor(doc: DocumentState, layer: Layer, tip: StrokeTip, mode: "liquify" | "smudge") {
    this.mode = mode;
    this.layer = layer;
    this.diameter = Math.max(2, tip.diameter);
    this.hardness = Math.min(0.98, Math.max(0, tip.hardness));
    this.strength = Math.min(1, Math.max(0.01, tip.opacity));
    this.preview = layerInDocument(doc, layer);
    this.pixels = this.preview.getContext("2d")!.getImageData(0, 0, doc.width, doc.height);
    this.originalCanvas = layer.canvas!;
    this.originalTransform = { ...layer.transform };
    // Show the working copy in the layer's place.
    layer.canvas = this.preview;
    layer.transform = { x: 0, y: 0, width: doc.width, height: doc.height, rotation: 0, flipH: false, flipV: false };
  }

  private weight(u: number): number {
    if (u >= 1) return 0;
    if (u <= this.hardness) return 1;
    const t = (1 - u) / (1 - this.hardness);
    return t * t * (3 - 2 * t);
  }

  append(p: { x: number; y: number }): void {
    if (!isFinite(p.x) || !isFinite(p.y)) return;
    if (!this.last) {
      this.last = p;
      this.points.push(p);
      if (this.mode === "smudge") this.pickUp(p);
      return;
    }
    const spacing = Math.max(1, this.diameter * (this.mode === "smudge" ? 0.08 : 0.025));
    const dist = Math.hypot(p.x - this.last.x, p.y - this.last.y);
    if (dist < spacing) return; // too short a move: nothing happens at all
    const steps = Math.ceil(dist / spacing);
    let prev = this.last;
    for (let i = 1; i <= steps; i++) {
      const q = { x: this.last.x + ((p.x - this.last.x) * i) / steps, y: this.last.y + ((p.y - this.last.y) * i) / steps };
      if (this.mode === "smudge") this.smudge(q);
      else this.push(prev, q);
      this.points.push(q);
      prev = q;
    }
    this.last = p;
    this.flushPreview();
  }

  private mark(cx: number, cy: number, extra = 0): void {
    const r = Math.ceil(this.diameter / 2) + extra + 1;
    const rect = { x: Math.floor(cx) - r, y: Math.floor(cy) - r, w: r * 2 + 1, h: r * 2 + 1 };
    this.dirty = union(this.dirty, rect);
  }

  private flushPreview(): void {
    const d = this.dirty;
    if (!d) return;
    this.dirty = null;
    const c = intersect(d, { x: 0, y: 0, w: this.pixels.width, h: this.pixels.height });
    if (!c) return;
    this.preview.getContext("2d")!.putImageData(this.pixels, 0, 0, c.x, c.y, c.w, c.h);
  }

  private pickUp(p: { x: number; y: number }): void {
    const r = Math.ceil(this.diameter / 2), side = 2 * r + 1;
    const { width: w, height: h, data } = this.pixels;
    const x0 = Math.round(p.x) - r, y0 = Math.round(p.y) - r;
    const out = new Float32Array(side * side * 4);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const px = x0 + x, py = y0 + y;
      const o = (y * side + x) * 4;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 4;
      out[o] = data[i]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2]; out[o + 3] = data[i + 3];
    }
    this.carried = out;
  }

  private smudge(p: { x: number; y: number }): void {
    const carried = this.carried;
    if (!carried) return;
    const r = Math.ceil(this.diameter / 2), side = 2 * r + 1, half = this.diameter / 2;
    const { width: w, height: h, data } = this.pixels;
    const x0 = Math.round(p.x) - r, y0 = Math.round(p.y) - r;
    const keep = this.strength;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const px = x0 + x, py = y0 + y;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const wgt = this.weight(Math.hypot(x - r, y - r) / half);
      if (wgt <= 0) continue;
      const o = (y * side + x) * 4, i = (py * w + px) * 4;
      for (let c = 0; c < 4; c++) {
        const under = data[i + c];
        const painted = under + (carried[o + c] - under) * wgt;
        data[i + c] = Math.min(255, Math.max(0, Math.round(painted)));
        carried[o + c] = painted + (carried[o + c] - painted) * keep;
      }
    }
    this.mark(p.x, p.y);
  }

  private push(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const mx = (b.x - a.x) * this.strength, my = (b.y - a.y) * this.strength;
    const r = Math.ceil(this.diameter / 2), half = this.diameter / 2;
    const margin = Math.ceil(Math.max(Math.abs(mx), Math.abs(my))) + 2;
    const { width: w, height: h, data } = this.pixels;
    const cx = Math.round(b.x), cy = Math.round(b.y);
    // Sample only the pixels as they were before this dab.
    const sx0 = Math.max(0, cx - r - margin), sy0 = Math.max(0, cy - r - margin);
    const sx1 = Math.min(w, cx + r + margin + 1), sy1 = Math.min(h, cy + r + margin + 1);
    const sw = sx1 - sx0, sh = sy1 - sy0;
    if (sw <= 0 || sh <= 0) return;
    const scratch = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) scratch.set(data.subarray(((sy0 + y) * w + sx0) * 4, ((sy0 + y) * w + sx1) * 4), y * sw * 4);
    for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const wgt = this.weight(Math.hypot(x - cx, y - cy) / half);
      if (wgt <= 0) continue;
      const fx = Math.min(sx1 - 1.001, Math.max(sx0, x - mx * wgt)), fy = Math.min(sy1 - 1.001, Math.max(sy0, y - my * wgt));
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const i00 = ((iy - sy0) * sw + (ix - sx0)) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = scratch[i00 + c] * (1 - tx) + scratch[i10 + c] * tx;
        const bot = scratch[i01 + c] * (1 - tx) + scratch[i11 + c] * tx;
        data[o + c] = top * (1 - ty) + bot * ty;
      }
    }
    this.mark(b.x, b.y, margin);
  }

  /** Put the layer back exactly as it was. */
  cancel(): void {
    this.layer.canvas = this.originalCanvas;
    this.layer.transform = this.originalTransform;
  }

  /**
   * Restore the original layer and write the warped pixels through a hard tip slightly wider
   * than the brush, so everything the stroke moved is replaced. Returns the committing stroke.
   */
  finish(doc: DocumentState, selection: HTMLCanvasElement | null): BrushStroke | null {
    this.flushPreview();
    this.cancel();
    if (this.points.length === 0) return null;
    const stroke = new BrushStroke(doc, this.layer, { diameter: this.diameter + 4, hardness: 1, opacity: 1 }, "clone", { sample: this.preview, selection, replace: true });
    for (const p of this.points) stroke.append(p);
    return stroke;
  }
}
