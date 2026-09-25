import type { BlendMode, DocumentState, Layer, SessionState } from "../core/model";
import { createCanvas } from "../core/model";
import { writableLayer } from "../core/history";
import {
  applyAdjustment,
  applyEffects,
  blendImage,
  cloneCanvas,
  drawShapeLayer,
  drawTextLayer,
  gaussianBlur,
  invertImage,
  motionBlur,
} from "../core/pixels";

/**
 * Blend modes Canvas 2D implements natively (GPU-accelerated in Chromium).
 * Everything else goes through the per-pixel `blendImage` path.
 * `lighter` is additive, which is what Linear Dodge (Add) means.
 */
const NATIVE_OPS: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
  "linear-dodge": "lighter",
};

interface LayerImage {
  canvas: HTMLCanvasElement;
  /** Padding (in layer-canvas pixels) added around the content by effects such as shadows. */
  pad: number;
}

/** Layer whose pixels are hidden while an on-canvas editor shows it live (text editing). */
let editingLayerId: string | null = null;
export function setEditingLayer(id: string | null): void {
  editingLayerId = id;
}

/** Last rasterized parameters of text/shape layers, so unchanged ones are not redrawn every frame. */
const vectorKeys = new WeakMap<Layer, string>();

/** Rasterize a single layer in its own local space (no transform, no mask). */
function layerImage(layer: Layer): LayerImage | null {
  if (!layer.visible || layer.kind === "group" || layer.kind === "adjustment" || layer.id === editingLayerId) return null;
  let base = layer.canvas;
  if (!base) return null;
  if (layer.kind === "text" || layer.kind === "shape") {
    const key = JSON.stringify(layer.kind === "text" ? [layer.text, Math.round(layer.transform.width), Math.round(layer.transform.height)] : [layer.shape, layer.transform.width, layer.transform.height]);
    if (vectorKeys.get(layer) !== key) {
      base = writableLayer(layer)!; // history may share the old raster
      if (layer.kind === "text") drawTextLayer(layer);
      else {
        base.width = Math.max(1, Math.round(layer.transform.width));
        base.height = Math.max(1, Math.round(layer.transform.height));
        drawShapeLayer(layer);
      }
      vectorKeys.set(layer, key);
    }
  }
  if (layer.effects.some((e) => e.enabled)) {
    const fx = applyEffects(base, layer.effects);
    return { canvas: fx, pad: Math.round((fx.width - base.width) / 2) };
  }
  return { canvas: base, pad: 0 };
}

/** Draw a layer image into a document-space context, honouring its transform. */
function drawTransformed(ctx: CanvasRenderingContext2D, layer: Layer, img: LayerImage): void {
  const t = layer.transform;
  const baseW = img.canvas.width - img.pad * 2;
  const baseH = img.canvas.height - img.pad * 2;
  const sx = t.width / Math.max(1, baseW);
  const sy = t.height / Math.max(1, baseH);
  ctx.save();
  ctx.translate(t.x + t.width / 2, t.y + t.height / 2);
  ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
  if (t.sampling === "nearest") ctx.imageSmoothingEnabled = false;
  else { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = t.sampling === "smooth" ? "low" : "high"; }
  ctx.drawImage(
    img.canvas,
    -t.width / 2 - img.pad * sx,
    -t.height / 2 - img.pad * sy,
    img.canvas.width * sx,
    img.canvas.height * sy,
  );
  ctx.restore();
}

/** Composite a document-sized source onto a document-sized target with a blend mode and opacity. */
function compositeOnto(
  target: HTMLCanvasElement,
  source: HTMLCanvasElement,
  mode: BlendMode,
  opacity: number,
): void {
  const tctx = target.getContext("2d")!;
  const op = NATIVE_OPS[mode];
  if (op) {
    tctx.save();
    tctx.globalCompositeOperation = op;
    tctx.globalAlpha = opacity;
    tctx.drawImage(source, 0, 0);
    tctx.restore();
    return;
  }
  const dst = tctx.getImageData(0, 0, target.width, target.height);
  const src = source.getContext("2d")!.getImageData(0, 0, source.width, source.height);
  const out = new ImageData(target.width, target.height);
  blendImage(dst, src, mode, opacity, out);
  tctx.putImageData(out, 0, 0);
}

/** Keep only the parts of `canvas` where `mask` (document-sized, white = keep) is opaque. */
function maskInPlace(canvas: HTMLCanvasElement, mask: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d")!;
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/** Apply an adjustment layer to everything already composited into `target`. */
function applyAdjustmentLayer(target: HTMLCanvasElement, layer: Layer): void {
  const tctx = target.getContext("2d")!;
  const params = layer.adjustment ?? {};
  let adjusted: HTMLCanvasElement;
  if (layer.adjustmentKind === "gaussian-blur") {
    adjusted = gaussianBlur(target, params.blurRadius ?? 4);
  } else if (layer.adjustmentKind === "motion-blur") {
    adjusted = motionBlur(target, params.motion?.angle ?? 0, params.motion?.distance ?? 10);
  } else {
    const img = tctx.getImageData(0, 0, target.width, target.height);
    const out = layer.adjustmentKind === "invert" ? invertImage(img) : applyAdjustment(img, params);
    adjusted = createCanvas(target.width, target.height);
    adjusted.getContext("2d")!.putImageData(out, 0, 0);
  }
  if (layer.mask?.enabled) maskInPlace(adjusted, layer.mask.canvas);
  tctx.save();
  tctx.globalAlpha = layer.opacity;
  tctx.drawImage(adjusted, 0, 0);
  tctx.restore();
}

/** The most recent non-clipping sibling; rendered lazily only if a clipping layer needs it. */
type ClipBase = { layer: Layer; img: LayerImage; canvas: HTMLCanvasElement | null } | null;

function clipMask(doc: DocumentState, base: ClipBase): HTMLCanvasElement | null {
  if (!base) return null;
  if (!base.canvas) {
    base.canvas = createCanvas(doc.width, doc.height);
    drawTransformed(base.canvas.getContext("2d")!, base.layer, base.img);
  }
  return base.canvas;
}

function compositeChildren(doc: DocumentState, target: HTMLCanvasElement, parentId: string | null): void {
  compositeLayers(doc, target, doc.layers.filter((l) => l.parentId === parentId));
}

/** Composite a run of sibling layers, in order, onto `target`. */
function compositeLayers(doc: DocumentState, target: HTMLCanvasElement, children: Layer[]): void {
  let clipBase: ClipBase = null;

  for (const layer of children) {
    if (!layer.visible || layer.opacity <= 0) continue;

    if (layer.kind === "adjustment") {
      applyAdjustmentLayer(target, layer);
      continue;
    }

    if (layer.kind === "group") {
      const buffer = createCanvas(doc.width, doc.height);
      compositeChildren(doc, buffer, layer.id);
      if (layer.mask?.enabled) maskInPlace(buffer, layer.mask.canvas);
      compositeOnto(target, buffer, layer.blendMode, layer.opacity);
      clipBase = null;
      continue;
    }

    const img = layerImage(layer);
    if (!img) continue;

    const clip = layer.clipping ? clipMask(doc, clipBase) : null;
    const needsBuffer = !!layer.mask?.enabled || !!clip || !NATIVE_OPS[layer.blendMode];

    if (!needsBuffer) {
      // Fast path: let Canvas 2D composite directly (GPU-accelerated).
      const tctx = target.getContext("2d")!;
      tctx.save();
      tctx.globalCompositeOperation = NATIVE_OPS[layer.blendMode]!;
      tctx.globalAlpha = layer.opacity;
      drawTransformed(tctx, layer, img);
      tctx.restore();
    } else {
      const buffer = createCanvas(doc.width, doc.height);
      drawTransformed(buffer.getContext("2d")!, layer, img);
      if (layer.mask?.enabled) maskInPlace(buffer, layer.mask.canvas);
      if (clip) maskInPlace(buffer, clip);
      compositeOnto(target, buffer, layer.blendMode, layer.opacity);
    }

    if (!layer.clipping) clipBase = { layer, img, canvas: null };
  }
}

let flatCache: { docId: string; version: number; width: number; height: number; canvas: HTMLCanvasElement } | null = null;

/**
 * Brush strokes change one layer many times a second. While a stroke is in progress the
 * layers below and above it are composited once and reused, so each frame is three
 * `drawImage` calls instead of a full re-composite of every layer (Photoshop does the same).
 * Only safe when nothing above the layer depends on its pixels: no clipping layer on it,
 * no adjustment layer and no blend mode other than Normal above it, at the top level.
 */
interface StrokeCache {
  docId: string;
  layers: Layer[];
  layerId: string;
  width: number;
  height: number;
  eligible: boolean;
  below: HTMLCanvasElement | null;
  above: HTMLCanvasElement | null;
}
let stroke: StrokeCache | null = null;

function strokeEligible(doc: DocumentState, layerId: string): boolean {
  const top = doc.layers.filter((l) => l.parentId === null);
  const i = top.findIndex((l) => l.id === layerId);
  if (i < 0) return false;
  const layer = top[i];
  if (layer.kind !== "raster" || layer.clipping || !layer.visible) return false;
  if (top[i + 1]?.clipping) return false;
  for (const l of top.slice(i + 1)) {
    if (!l.visible || l.opacity <= 0) continue;
    if (l.kind === "adjustment" || l.blendMode !== "normal") return false;
  }
  return true;
}

export function beginStroke(doc: DocumentState, layerId: string): void {
  stroke = { docId: doc.id, layers: doc.layers, layerId, width: doc.width, height: doc.height, eligible: strokeEligible(doc, layerId), below: null, above: null };
}

export function endStroke(): void {
  stroke = null;
}

/** True while frames are being composited incrementally around a stroke (for tests). */
export function isStrokeCached(doc: DocumentState): boolean {
  return !!stroke && stroke.eligible && stroke.docId === doc.id && stroke.layers === doc.layers;
}

function flattenAroundStroke(doc: DocumentState, s: StrokeCache): HTMLCanvasElement | null {
  const top = doc.layers.filter((l) => l.parentId === null);
  const i = top.findIndex((l) => l.id === s.layerId);
  if (i < 0) return null;
  if (!s.below) {
    s.below = createCanvas(doc.width, doc.height);
    compositeLayers(doc, s.below, top.slice(0, i));
  }
  if (!s.above) {
    s.above = createCanvas(doc.width, doc.height);
    compositeLayers(doc, s.above, top.slice(i + 1));
  }
  const out = createCanvas(doc.width, doc.height);
  const ctx = out.getContext("2d")!;
  ctx.drawImage(s.below, 0, 0);
  compositeLayers(doc, out, [top[i]]);
  ctx.drawImage(s.above, 0, 0);
  return out;
}

/** Flatten the document bottom→top. Cached per `doc.version`. */
export function flattenDocument(doc: DocumentState): HTMLCanvasElement {
  if (
    flatCache &&
    flatCache.docId === doc.id &&
    flatCache.version === doc.version &&
    flatCache.width === doc.width &&
    flatCache.height === doc.height
  ) {
    return flatCache.canvas;
  }
  if (stroke && stroke.eligible && stroke.docId === doc.id && stroke.layers === doc.layers && stroke.width === doc.width && stroke.height === doc.height) {
    const fast = flattenAroundStroke(doc, stroke);
    if (fast) {
      flatCache = { docId: doc.id, version: doc.version, width: doc.width, height: doc.height, canvas: fast };
      return fast;
    }
  }
  const out = createCanvas(doc.width, doc.height);
  compositeChildren(doc, out, null);
  flatCache = { docId: doc.id, version: doc.version, width: doc.width, height: doc.height, canvas: out };
  return out;
}

/** A copy of the flattened document that callers may draw into. */
export function flattenDocumentCopy(doc: DocumentState): HTMLCanvasElement {
  return cloneCanvas(flattenDocument(doc));
}

export interface Viewport {
  scale: number;
  panX: number;
  panY: number;
}

let checkerPattern: CanvasPattern | null = null;
function checker(ctx: CanvasRenderingContext2D): CanvasPattern {
  if (checkerPattern) return checkerPattern;
  const tile = createCanvas(16, 16);
  const t = tile.getContext("2d")!;
  t.fillStyle = "#999";
  t.fillRect(0, 0, 16, 16);
  t.fillStyle = "#ccc";
  t.fillRect(0, 0, 8, 8);
  t.fillRect(8, 8, 8, 8);
  checkerPattern = ctx.createPattern(tile, "repeat")!;
  return checkerPattern;
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function drawEditor(
  view: HTMLCanvasElement,
  doc: DocumentState | null,
  session: SessionState,
  overlay?: (ctx: CanvasRenderingContext2D, vp: Viewport) => void,
): void {
  const ctx = view.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  const cssW = view.clientWidth;
  const cssH = view.clientHeight;
  if (view.width !== Math.round(cssW * dpr) || view.height !== Math.round(cssH * dpr)) {
    view.width = Math.round(cssW * dpr);
    view.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  ctx.fillStyle = cssVar("--canvas-chrome", "#0e0e14");
  ctx.fillRect(0, 0, cssW, cssH);

  if (!doc) return;

  const scale = session.zoom;
  const ox = cssW / 2 + session.panX - (doc.width * scale) / 2;
  const oy = cssH / 2 + session.panY - (doc.height * scale) / 2;

  // shadow under canvas
  ctx.fillStyle = cssVar("--shadow", "rgba(0,0,0,0.35)");
  ctx.fillRect(ox + 6, oy + 8, doc.width * scale, doc.height * scale);

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.imageSmoothingQuality = "high";

  ctx.fillStyle = checker(ctx);
  ctx.fillRect(0, 0, doc.width, doc.height);

  ctx.drawImage(flattenDocument(doc), 0, 0);

  // guides
  const accent = cssVar("--accent", "#7aa2f7");
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1 / scale;
  for (const g of doc.guides) {
    ctx.beginPath();
    if (g.axis === "x") {
      ctx.moveTo(g.pos, 0);
      ctx.lineTo(g.pos, doc.height);
    } else {
      ctx.moveTo(0, g.pos);
      ctx.lineTo(doc.width, g.pos);
    }
    ctx.stroke();
  }

  // pixel grid when zoomed in
  if (session.showPixelGrid && scale >= 8) {
    ctx.strokeStyle = "rgba(128,128,128,0.25)";
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    for (let x = 0; x <= doc.width; x++) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, doc.height);
    }
    for (let y = 0; y <= doc.height; y++) {
      ctx.moveTo(0, y);
      ctx.lineTo(doc.width, y);
    }
    ctx.stroke();
  }

  ctx.restore();

  if (overlay) {
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    overlay(ctx, { scale, panX: session.panX, panY: session.panY });
    ctx.restore();
  }
}

export function screenToDoc(
  view: HTMLCanvasElement,
  doc: DocumentState,
  session: SessionState,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = view.getBoundingClientRect();
  const scale = session.zoom;
  const ox = rect.width / 2 + session.panX - (doc.width * scale) / 2;
  const oy = rect.height / 2 + session.panY - (doc.height * scale) / 2;
  return {
    x: (clientX - rect.left - ox) / scale,
    y: (clientY - rect.top - oy) / scale,
  };
}

export function fitZoom(doc: DocumentState, view: HTMLCanvasElement): number {
  const pad = 96; // Compositor's fit leaves 96 points of margin in all
  const w = view.clientWidth || view.parentElement?.clientWidth || 800;
  const h = view.clientHeight || view.parentElement?.clientHeight || 600;
  const zx = (w - pad) / doc.width;
  const zy = (h - pad) / doc.height;
  return Math.max(0.05, Math.min(zx, zy, 1));
}

export function ensureLayerBitmap(layer: Layer): void {
  if (layer.canvas) return;
  layer.canvas = createCanvas(Math.max(1, Math.round(layer.transform.width)), Math.max(1, Math.round(layer.transform.height)));
}
