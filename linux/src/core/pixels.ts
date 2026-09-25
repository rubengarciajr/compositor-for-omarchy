import type { AdjustmentParams, BlendMode, Layer, LayerEffect } from "./model";
import { createCanvas } from "./model";

export type RGBA = Uint8ClampedArray;

/* ── Blend modes (separable + non-separable) ─────────────────────────── */

function mix(b: number, s: number, mode: BlendMode): number {
  switch (mode) {
    case "normal": return s;
    case "darken": return Math.min(b, s);
    case "multiply": return b * s;
    case "color-burn": return s === 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    case "linear-burn": return Math.max(0, b + s - 1);
    case "lighten": return Math.max(b, s);
    case "screen": return b + s - b * s;
    case "color-dodge": return s === 1 ? 1 : Math.min(1, b / (1 - s));
    case "linear-dodge": return Math.min(1, b + s);
    case "overlay": return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case "soft-light":
      return s <= 0.5
        ? b - (1 - 2 * s) * b * (1 - b)
        : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b);
    case "hard-light": return s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case "vivid-light":
      return s <= 0.5 ? (s === 0 ? 0 : 1 - Math.min(1, (1 - b) / (2 * s))) : s === 1 ? 1 : Math.min(1, b / (2 * (1 - s)));
    case "linear-light": return Math.min(1, Math.max(0, b + 2 * s - 1));
    case "pin-light": return s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1);
    case "hard-mix": return b + s < 1 ? 0 : 1;
    case "difference": return Math.abs(b - s);
    case "exclusion": return b + s - 2 * b * s;
    case "subtract": return Math.max(0, b - s);
    case "divide": return s === 0 ? (b >= 1 ? 1 : 0) : Math.min(1, b / s);
    // non-separable handled outside for hue/sat/color/luma
    case "hue": case "saturation": case "color": case "luminosity":
      return s;
  }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

/** Blend src over dst into out (same size ImageData buffers). */
export function blendImage(
  dst: ImageData,
  src: ImageData,
  mode: BlendMode,
  opacity: number,
  out = dst,
): void {
  const d = dst.data, s = src.data, o = out.data;
  const n = d.length;
  const nonSep = mode === "hue" || mode === "saturation" || mode === "color" || mode === "luminosity";

  for (let i = 0; i < n; i += 4) {
    const ab = (d[i + 3] / 255);
    const as_ = (s[i + 3] / 255) * opacity;
    if (as_ <= 0) {
      o[i] = d[i]; o[i + 1] = d[i + 1]; o[i + 2] = d[i + 2]; o[i + 3] = d[i + 3];
      continue;
    }

    let br = d[i] / 255, bg = d[i + 1] / 255, bb = d[i + 2] / 255;
    let sr = s[i] / 255, sg = s[i + 1] / 255, sb = s[i + 2] / 255;

    let cr: number, cg: number, cb: number;
    if (nonSep) {
      const [bh, bs, bl] = rgbToHsl(br, bg, bb);
      const [sh, ss, sl] = rgbToHsl(sr, sg, sb);
      let h = bh, sat = bs, li = bl;
      if (mode === "hue") { h = sh; }
      else if (mode === "saturation") { sat = ss; }
      else if (mode === "color") { h = sh; sat = ss; }
      else if (mode === "luminosity") { li = sl; }
      [cr, cg, cb] = hslToRgb(h, sat, li);
    } else {
      cr = mix(br, sr, mode);
      cg = mix(bg, sg, mode);
      cb = mix(bb, sb, mode);
    }

    const ao = as_ + ab * (1 - as_);
    if (ao <= 0) {
      o[i] = 0; o[i + 1] = 0; o[i + 2] = 0; o[i + 3] = 0;
      continue;
    }
    // W3C compositing with blend: result = (1-ab)*Cs*as + ab*B(Cs,Cb)*as + (1-as)*Cb*ab
    const wr = (1 - ab) * sr * as_ + ab * cr * as_ + (1 - as_) * br * ab;
    const wg = (1 - ab) * sg * as_ + ab * cg * as_ + (1 - as_) * bg * ab;
    const wb = (1 - ab) * sb * as_ + ab * cb * as_ + (1 - as_) * bb * ab;
    o[i] = Math.round((wr / ao) * 255);
    o[i + 1] = Math.round((wg / ao) * 255);
    o[i + 2] = Math.round((wb / ao) * 255);
    o[i + 3] = Math.round(ao * 255);
  }
}

/* ── Canvas helpers ─────────────────────────────────────────────────── */

export function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = createCanvas(src.width, src.height);
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

export function canvasFromImageData(data: ImageData): HTMLCanvasElement {
  const c = createCanvas(data.width, data.height);
  c.getContext("2d")!.putImageData(data, 0, 0);
  return c;
}

export function imageDataOf(canvas: HTMLCanvasElement): ImageData {
  return canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
}

export function applyMask(src: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const out = cloneCanvas(src);
  const ctx = out.getContext("2d")!;
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(mask, 0, 0, out.width, out.height);
  ctx.globalCompositeOperation = "source-over";
  return out;
}

/* ── Effects ────────────────────────────────────────────────────────── */

export function applyEffects(src: HTMLCanvasElement, effects: LayerEffect[]): HTMLCanvasElement {
  const active = effects.filter((e) => e.enabled);
  if (!active.length) return src;
  const pad = Math.ceil(Math.max(0, ...active.map((e) => e.size * 2 + e.distance + e.spread))) + 4;
  const out = createCanvas(src.width + pad * 2, src.height + pad * 2);
  const ctx = out.getContext("2d")!;
  // Photoshop's light angle: 120° means light from the upper-left, shadow to the lower-right.
  const offset = (fx: LayerEffect) => {
    const rad = (fx.angle * Math.PI) / 180;
    return { dx: -Math.cos(rad) * fx.distance, dy: Math.sin(rad) * fx.distance };
  };
  // Silhouette of the layer in a flat colour (used for strokes).
  const silhouette = (color: string, alpha: number) => {
    const c = createCanvas(src.width, src.height);
    const cctx = c.getContext("2d")!;
    cctx.fillStyle = hexToRgba(color, alpha);
    cctx.fillRect(0, 0, c.width, c.height);
    cctx.globalCompositeOperation = "destination-in";
    cctx.drawImage(src, 0, 0);
    return c;
  };

  /* 1. Behind the layer: drop shadow, outer glow, outside stroke */
  const farAway = out.width * 4; // draw the source off-canvas so only its shadow lands
  for (const fx of active) {
    if (fx.kind === "drop-shadow" || fx.kind === "outer-glow") {
      const { dx, dy } = fx.kind === "drop-shadow" ? offset(fx) : { dx: 0, dy: 0 };
      ctx.save();
      ctx.shadowColor = hexToRgba(fx.color, fx.opacity);
      ctx.shadowBlur = fx.size;
      ctx.shadowOffsetX = dx + farAway;
      ctx.shadowOffsetY = dy;
      ctx.drawImage(src, pad - farAway, pad);
      ctx.restore();
    }
  }
  for (const fx of active) {
    if (fx.kind === "stroke" && fx.size > 0) {
      // Outside stroke by dilating the silhouette around a circle.
      const sil = silhouette(fx.color, 1);
      const steps = Math.max(12, Math.min(48, Math.round(fx.size * 4)));
      const dilate = createCanvas(out.width, out.height);
      const dctx = dilate.getContext("2d")!;
      for (let r = fx.size; r > 0; r -= Math.max(1, fx.size / 4)) {
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          dctx.drawImage(sil, pad + Math.cos(a) * r, pad + Math.sin(a) * r);
        }
      }
      ctx.save();
      ctx.globalAlpha = fx.opacity;
      ctx.drawImage(dilate, 0, 0);
      ctx.restore();
    }
  }

  /* 2. The layer itself */
  ctx.drawImage(src, pad, pad);

  /* 3. On top, clipped to the layer: colour overlay, inner shadow */
  for (const fx of active) {
    if (fx.kind === "color-overlay") {
      ctx.drawImage(silhouette(fx.color, fx.opacity), pad, pad);
    } else if (fx.kind === "inner-shadow" || fx.kind === "inner-glow") {
      // Shadow cast by the area *outside* the layer, clipped to the layer.
      const inverse = createCanvas(src.width + pad * 2, src.height + pad * 2);
      const ictx = inverse.getContext("2d")!;
      ictx.fillStyle = "#000";
      ictx.fillRect(0, 0, inverse.width, inverse.height);
      ictx.globalCompositeOperation = "destination-out";
      ictx.drawImage(src, pad, pad);

      const shadow = createCanvas(src.width, src.height);
      const sctx = shadow.getContext("2d")!;
      const { dx, dy } = fx.kind === "inner-glow" ? { dx: 0, dy: 0 } : offset(fx);
      sctx.shadowColor = hexToRgba(fx.color, fx.opacity);
      sctx.shadowBlur = fx.size;
      sctx.shadowOffsetX = dx + farAway;
      sctx.shadowOffsetY = dy;
      sctx.drawImage(inverse, -pad - farAway, -pad);
      sctx.shadowColor = "transparent";
      sctx.globalCompositeOperation = "destination-in";
      sctx.drawImage(src, 0, 0);
      ctx.drawImage(shadow, pad, pad);
    }
  }
  return out;
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* ── Adjustments ────────────────────────────────────────────────────── */

export function applyAdjustment(src: ImageData, params: AdjustmentParams): ImageData {
  const out = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
  const d = out.data;

  if (params.hue !== undefined || params.saturation !== undefined || params.lightness !== undefined) {
    const hue = (params.hue ?? 0) / 360;
    const sat = (params.saturation ?? 0) / 100;
    const light = (params.lightness ?? 0) / 100;
    for (let i = 0; i < d.length; i += 4) {
      let [h, s, l] = rgbToHsl(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
      if (params.colorize) {
        h = hue;
        s = Math.min(1, Math.max(0, 0.5 + sat));
        l = Math.min(1, Math.max(0, 0.5 + light));
      } else {
        h = (h + hue + 1) % 1;
        s = Math.min(1, Math.max(0, s + sat));
        l = Math.min(1, Math.max(0, l + light));
      }
      const [r, g, b] = hslToRgb(h, s, l);
      d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
    }
  }

  if (params.levels) {
    const { black, white, gamma, outBlack, outWhite } = params.levels;
    const inv = 1 / Math.max(1e-6, white - black);
    const g = 1 / Math.max(0.01, gamma);
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        let v = (d[i + c] / 255 - black) * inv;
        v = Math.min(1, Math.max(0, v));
        v = Math.pow(v, g);
        v = outBlack + v * (outWhite - outBlack);
        d[i + c] = Math.min(255, Math.max(0, v * 255));
      }
    }
  }

  if (params.curves) {
    const lut = buildCurveLut(params.curves);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut.r[d[i]];
      d[i + 1] = lut.g[d[i + 1]];
      d[i + 2] = lut.b[d[i + 2]];
    }
  }

  if (params.exposure) {
    const { exposure, offset, gamma } = params.exposure;
    const mult = Math.pow(2, exposure);
    const g = 1 / Math.max(0.01, gamma);
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        let v = (d[i + c] / 255) * mult + offset;
        v = Math.pow(Math.min(1, Math.max(0, v)), g);
        d[i + c] = v * 255;
      }
    }
  }

  if (params.blackWhite) {
    const w = params.blackWhite;
    const weights = [w.red, w.yellow, w.green, w.cyan, w.blue, w.magenta].map((x) => x / 100);
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
      // simple channel mix approximation of PS B&W
      const v = r * weights[0] * 0.5 + g * weights[2] * 0.3 + b * weights[4] * 0.2
        + (r + g) / 2 * weights[1] * 0.15 + (g + b) / 2 * weights[3] * 0.1 + (r + b) / 2 * weights[5] * 0.1;
      const n = Math.min(255, Math.max(0, v * 255 * 1.4));
      d[i] = d[i + 1] = d[i + 2] = n;
    }
  }

  if (params.colorBalance) {
    const { shadows, mids, highs } = params.colorBalance;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = d[i + c] / 255;
        const tone = v < 0.33 ? shadows[c] : v > 0.66 ? highs[c] : mids[c];
        d[i + c] = Math.min(255, Math.max(0, d[i + c] + tone));
      }
    }
  }

  if (params.gradientMap?.stops?.length) {
    const stops = [...params.gradientMap.stops].sort((a, b) => a.t - b.t);
    for (let i = 0; i < d.length; i += 4) {
      let v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
      if (params.gradientMap.reverse) v = 1 - v;
      const [r, g, b] = sampleGradient(stops, v);
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
  }

  if (params.grain || params.noise) {
    const amount = (params.grain?.amount ?? params.noise?.amount ?? 0.1);
    const mono = params.noise?.monochrome ?? true;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * amount * 255;
      d[i] += n;
      d[i + 1] += mono ? n : (Math.random() - 0.5) * amount * 255;
      d[i + 2] += mono ? n : (Math.random() - 0.5) * amount * 255;
    }
  }

  return out;
}

function buildCurveLut(curves: NonNullable<AdjustmentParams["curves"]>) {
  const map = (points: number[][]) => {
    const lut = new Uint8ClampedArray(256);
    const pts = [...points].sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let y = x;
      if (pts.length >= 2) {
        for (let p = 0; p < pts.length - 1; p++) {
          const [x0, y0] = pts[p];
          const [x1, y1] = pts[p + 1];
          if (x >= x0 && x <= x1) {
            const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
            y = y0 + (y1 - y0) * t;
            break;
          }
          if (x < pts[0][0]) y = pts[0][1];
          if (x > pts[pts.length - 1][0]) y = pts[pts.length - 1][1];
        }
      }
      lut[i] = Math.min(255, Math.max(0, y * 255));
    }
    return lut;
  };
  return {
    rgb: map(curves.rgb ?? [[0, 0], [1, 1]]),
    r: map(curves.r ?? [[0, 0], [1, 1]]),
    g: map(curves.g ?? [[0, 0], [1, 1]]),
    b: map(curves.b ?? [[0, 0], [1, 1]]),
  };
}

function sampleGradient(stops: { t: number; color: string }[], v: number): [number, number, number] {
  if (v <= stops[0].t) return parseHex(stops[0].color);
  if (v >= stops[stops.length - 1].t) return parseHex(stops[stops.length - 1].color);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (v >= a.t && v <= b.t) {
      const t = (v - a.t) / Math.max(1e-6, b.t - a.t);
      const [r1, g1, b1] = parseHex(a.color);
      const [r2, g2, b2] = parseHex(b.color);
      return [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t];
    }
  }
  return parseHex(stops[0].color);
}

/* ── Filters ────────────────────────────────────────────────────────── */

export function invertImage(src: ImageData): ImageData {
  const out = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
  }
  return out;
}

/** A Gaussian-blurred copy (standard deviation `radius` px); the source is untouched. */
export function gaussianBlur(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const out = createCanvas(src.width, src.height);
  const ctx = out.getContext("2d")!;
  ctx.filter = `blur(${Math.max(0, radius)}px)`;
  ctx.drawImage(src, 0, 0);
  ctx.filter = "none";
  return out;
}

export function motionBlur(src: HTMLCanvasElement, angleDeg: number, distance: number): HTMLCanvasElement {
  const out = cloneCanvas(src);
  const ctx = out.getContext("2d")!;
  const steps = Math.max(2, Math.round(distance));
  const rad = (angleDeg * Math.PI) / 180;
  ctx.globalAlpha = 1 / steps;
  for (let i = 0; i < steps; i++) {
    const t = (i / (steps - 1) - 0.5) * distance;
    ctx.drawImage(src, Math.cos(rad) * t, Math.sin(rad) * t);
  }
  ctx.globalAlpha = 1;
  return out;
}

/* ── Painting ───────────────────────────────────────────────────────── */

export function stampBrush(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  hardness: number,
  color: string,
  alpha: number,
  erase = false,
): void {
  const r = size / 2;
  if (r <= 0) return;
  ctx.save();
  if (erase) ctx.globalCompositeOperation = "destination-out";
  else ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = alpha;
  const [pr, pg, pb] = erase ? [0, 0, 0] : parseHex(color);
  if (hardness >= 1) {
    // A radial gradient whose inner and outer radii coincide paints nothing: hard brushes fill solid.
    ctx.fillStyle = `rgb(${pr},${pg},${pb})`;
  } else {
    const grad = ctx.createRadialGradient(x, y, r * Math.max(0, hardness), x, y, r);
    grad.addColorStop(0, `rgba(${pr},${pg},${pb},1)`);
    grad.addColorStop(1, `rgba(${pr},${pg},${pb},0)`);
    ctx.fillStyle = grad;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The wand's reference colour: the clicked pixel, or the average of the (2r+1)² pixels around it. */
function wandReference(d: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, radius: number): [number, number, number, number] {
  if (radius <= 0) { const i = (sy * w + sx) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; }
  const acc = [0, 0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, sy - radius); y <= Math.min(h - 1, sy + radius); y++) for (let x = Math.max(0, sx - radius); x <= Math.min(w - 1, sx + radius); x++) {
    const i = (y * w + x) * 4;
    acc[0] += d[i]; acc[1] += d[i + 1]; acc[2] += d[i + 2]; acc[3] += d[i + 3];
    n++;
  }
  return [acc[0] / n, acc[1] / n, acc[2] / n, acc[3] / n];
}

/** Compositor's wand match: every channel, alpha included, within `tolerance` (0–255) of the reference. */
function wandMatches(d: Uint8ClampedArray, i: number, ref: [number, number, number, number], tolerance: number): boolean {
  return Math.abs(d[i] - ref[0]) <= tolerance && Math.abs(d[i + 1] - ref[1]) <= tolerance && Math.abs(d[i + 2] - ref[2]) <= tolerance && Math.abs(d[i + 3] - ref[3]) <= tolerance;
}

/** Magic Wand with "Contiguous" on: pixels connected to the click within tolerance. Null when nothing matches. */
export function floodSelect(src: ImageData, sx: number, sy: number, tolerance: number, sampleRadius = 0): HTMLCanvasElement | null {
  const w = src.width, h = src.height;
  const mask = createCanvas(w, h);
  const mctx = mask.getContext("2d")!;
  const img = mctx.createImageData(w, h);
  const d = src.data, out = img.data;
  const ref = wandReference(d, w, h, sx, sy, sampleRadius);
  const tol = Math.min(255, Math.max(0, tolerance)) + 1e-6;
  const visited = new Uint8Array(w * h);
  const stack: number[] = [sy * w + sx];
  let count = 0;
  while (stack.length) {
    const p = stack.pop()!;
    if (visited[p]) continue;
    visited[p] = 1;
    const i = p * 4;
    if (!wandMatches(d, i, ref, tol)) continue;
    out[i] = out[i + 1] = out[i + 2] = 255;
    out[i + 3] = 255;
    count++;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  if (!count) return null;
  mctx.putImageData(img, 0, 0);
  return mask;
}

/** Magic Wand with "Contiguous" off: every pixel within tolerance of the clicked colour. Null when nothing matches. */
export function colorSelect(src: ImageData, sx: number, sy: number, tolerance: number, sampleRadius = 0): HTMLCanvasElement | null {
  const w = src.width, h = src.height;
  const mask = createCanvas(w, h);
  const mctx = mask.getContext("2d")!;
  const img = mctx.createImageData(w, h);
  const d = src.data, out = img.data;
  const ref = wandReference(d, w, h, sx, sy, sampleRadius);
  const tol = Math.min(255, Math.max(0, tolerance)) + 1e-6;
  let count = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (!wandMatches(d, i, ref, tol)) continue;
    out[i] = out[i + 1] = out[i + 2] = 255;
    out[i + 3] = 255;
    count++;
  }
  if (!count) return null;
  mctx.putImageData(img, 0, 0);
  return mask;
}

/** Hard pixel edges: alpha at or above half becomes full, the rest transparent (Anti-alias off). */
export function thresholdMask(mask: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = mask.getContext("2d")!;
  const img = ctx.getImageData(0, 0, mask.width, mask.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) { const on = d[i] >= 128; d[i] = on ? 255 : 0; d[i - 1] = d[i - 2] = d[i - 3] = on ? 255 : 0; }
  ctx.putImageData(img, 0, 0);
  return mask;
}

/** Shift a document-sized mask by whole pixels; what leaves the canvas is dropped. */
export function translateMask(mask: HTMLCanvasElement, dx: number, dy: number): HTMLCanvasElement {
  const out = createCanvas(mask.width, mask.height);
  out.getContext("2d")!.drawImage(mask, Math.round(dx), Math.round(dy));
  return out;
}

/** Blur tool: soften the disc of radius `r` around (x, y) in layer pixels; `strength` 0–1. */
export function blurSpot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, strength: number): void {
  const R = Math.ceil(r * 2);
  const x0 = Math.floor(x - R), y0 = Math.floor(y - R), side = R * 2;
  if (side < 2) return;
  const region = createCanvas(side, side);
  region.getContext("2d")!.drawImage(ctx.canvas, x0, y0, side, side, 0, 0, side, side);
  const soft = createCanvas(side, side);
  const sctx = soft.getContext("2d")!;
  sctx.filter = `blur(${Math.max(0.5, r / 3)}px)`;
  sctx.drawImage(region, 0, 0);
  sctx.filter = "none";
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalAlpha = Math.min(1, strength);
  ctx.drawImage(soft, x0, y0);
  ctx.restore();
}

/**
 * Spot Healing: fill the disc of radius `r` with a smooth blend of its surroundings (the
 * spot itself is ignored), like a light content-aware patch for dust, blemishes and marks.
 */
export function healSpot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const R = Math.ceil(r * 3);
  const x0 = Math.floor(x - R), y0 = Math.floor(y - R), side = R * 2;
  if (side < 4) return;
  const cx = x - x0, cy = y - y0;
  // Surroundings only: cut the spot out, then let a blur pull the neighbours into the hole.
  const region = createCanvas(side, side);
  const rctx = region.getContext("2d")!;
  rctx.drawImage(ctx.canvas, x0, y0, side, side, 0, 0, side, side);
  rctx.globalCompositeOperation = "destination-out";
  rctx.beginPath();
  rctx.arc(cx, cy, r * 1.1, 0, Math.PI * 2);
  rctx.fill();
  const filled = createCanvas(side, side);
  const fctx = filled.getContext("2d")!;
  fctx.filter = `blur(${Math.max(1, r * 0.8)}px)`;
  fctx.drawImage(region, 0, 0);
  fctx.filter = "none";
  // Un-premultiply inside the hole so the blended colour keeps full coverage.
  const img = fctx.getImageData(0, 0, side, side);
  const d = img.data;
  for (let py = 0; py < side; py++) {
    for (let px = 0; px < side; px++) {
      const dx = px - cx, dy = py - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const i = (py * side + px) * 4;
      const a = d[i + 3];
      if (a === 0) continue;
      d[i] = Math.min(255, (d[i] * 255) / a);
      d[i + 1] = Math.min(255, (d[i + 1] * 255) / a);
      d[i + 2] = Math.min(255, (d[i + 2] * 255) / a);
      d[i + 3] = 255;
    }
  }
  fctx.putImageData(img, 0, 0);
  // Soft-edged patch so it melts into the surroundings.
  fctx.globalCompositeOperation = "destination-in";
  const feather = fctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r);
  feather.addColorStop(0, "rgba(0,0,0,1)");
  feather.addColorStop(1, "rgba(0,0,0,0)");
  fctx.fillStyle = feather;
  fctx.fillRect(0, 0, side, side);
  ctx.drawImage(filled, x0, y0);
}

/** Bounding box of the opaque area of a mask canvas, or null when it is empty. */
export function maskBounds(mask: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
  const { width: w, height: h } = mask;
  const d = mask.getContext("2d")!.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function fillSelection(
  layer: HTMLCanvasElement,
  mask: HTMLCanvasElement | null,
  color: string,
): void {
  const ctx = layer.getContext("2d")!;
  ctx.save();
  if (mask) {
    const tmp = createCanvas(layer.width, layer.height);
    const tctx = tmp.getContext("2d")!;
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, tmp.width, tmp.height);
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(mask, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, layer.width, layer.height);
  }
  ctx.restore();
}

export function clearSelection(layer: HTMLCanvasElement, mask: HTMLCanvasElement | null): void {
  const ctx = layer.getContext("2d")!;
  if (!mask) {
    ctx.clearRect(0, 0, layer.width, layer.height);
    return;
  }
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

/** CSS font shorthand for a text layer; family names are quoted so "Noto Sans" style names work. */
export function cssFont(t: { weight: number; fontSize: number; fontFamily: string }): string {
  const family = t.fontFamily.includes(",") ? t.fontFamily : `"${t.fontFamily.replace(/"/g, "")}", sans-serif`;
  return `${t.weight} ${t.fontSize}px ${family}`;
}

/** Natural (unscaled) size of each text layer's bitmap, so a scaled transform can be told apart from a re-fit. */
const textNatural = new WeakMap<Layer, { w: number; h: number }>();

/** Largest text bitmap we will rasterize; beyond this the transform stretches it (Photoshop-style budget). */
const MAX_TEXT_SIDE = 8192;
const MAX_TEXT_PIXELS = 32 * 1024 * 1024;

/** Size the text needs at its font size, before any transform scaling. */
export function textNaturalSize(layer: Layer): { w: number; h: number } {
  const t = layer.text!;
  const ctx = (layer.canvas ?? createCanvas(1, 1)).getContext("2d")!;
  ctx.font = cssFont(t);
  const lines = t.text.split("\n");
  let maxW = 1;
  for (const line of lines) {
    const chars = [...line];
    const w = t.letterSpacing
      ? chars.reduce((acc, ch) => acc + ctx.measureText(ch).width + t.letterSpacing, 0)
      : ctx.measureText(line).width;
    maxW = Math.max(maxW, w);
  }
  const pad = textPad(t);
  // The last line needs only its em height, not a full leading, so the box hugs the glyphs.
  return { w: Math.ceil(maxW + pad * 2), h: Math.ceil((lines.length - 1) * t.fontSize * t.lineHeight + t.fontSize + pad * 2) };
}

/** Breathing room around the glyphs (overhangs, italics) in natural units. */
export function textPad(t: { fontSize: number }): number {
  return Math.ceil(t.fontSize * 0.1);
}

/** How much the transform stretches a text layer beyond its font size (1 = unscaled). */
export function textScale(layer: Layer): { sx: number; sy: number } {
  if (!layer.text) return { sx: 1, sy: 1 };
  const n = textNatural.get(layer) ?? textNaturalSize(layer);
  return { sx: layer.transform.width / n.w, sy: layer.transform.height / n.h };
}

/**
 * Resize a text layer's bitmap (and transform) so the whole text fits, keeping its top-left in place.
 * A transform that was scaled (by the handles, or loaded from disk) keeps its scale: the transform
 * becomes natural size × scale and the bitmap is rasterized at that size, so scaled type stays sharp.
 */
export function fitTextLayer(layer: Layer, scale?: { sx: number; sy: number }): void {
  if (!layer.text || !layer.canvas) return;
  const natural = textNaturalSize(layer);
  const prev = textNatural.get(layer);
  const tr = layer.transform;
  let sx = 1, sy = 1;
  if (scale) { sx = scale.sx; sy = scale.sy; }
  else if (prev) { sx = tr.width / prev.w; sy = tr.height / prev.h; }
  else if (tr.width > 1 && tr.height > 1) { sx = tr.width / natural.w; sy = tr.height / natural.h; }
  if (!(sx > 0) || !isFinite(sx)) sx = 1;
  if (!(sy > 0) || !isFinite(sy)) sy = 1;
  textNatural.set(layer, natural);
  tr.width = Math.max(1, Math.round(natural.w * sx)); // whole pixels, so the bitmap is never resampled
  tr.height = Math.max(1, Math.round(natural.h * sy));
  // Bitmap at the displayed size, capped so a huge headline cannot eat memory.
  let bw = Math.max(1, Math.round(natural.w * sx));
  let bh = Math.max(1, Math.round(natural.h * sy));
  const shrink = Math.min(1, MAX_TEXT_SIDE / bw, MAX_TEXT_SIDE / bh, Math.sqrt(MAX_TEXT_PIXELS / (bw * bh)));
  if (shrink < 1) { bw = Math.max(1, Math.floor(bw * shrink)); bh = Math.max(1, Math.floor(bh * shrink)); }
  if (layer.canvas.width !== bw || layer.canvas.height !== bh) {
    layer.canvas.width = bw;
    layer.canvas.height = bh;
  }
}

export function drawTextLayer(layer: Layer): void {
  if (!layer.text || !layer.canvas) return;
  fitTextLayer(layer);
  const { text: t, canvas } = layer;
  const natural = textNatural.get(layer)!;
  const ctx = canvas.getContext("2d")!;
  const pad = textPad(t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(canvas.width / natural.w, canvas.height / natural.h); // glyphs are laid out in natural units
  ctx.translate(pad, pad);
  ctx.fillStyle = t.color;
  ctx.font = cssFont(t);
  ctx.textAlign = t.align;
  ctx.textBaseline = "top";
  const lines = t.text.split("\n");
  const lineH = t.fontSize * t.lineHeight;
  const inner = natural.w - pad * 2;
  const x = t.align === "center" ? inner / 2 : t.align === "right" ? inner : 0;
  lines.forEach((line, i) => {
    if (t.letterSpacing) {
      // approximate letter-spacing
      let cx = x;
      const chars = [...line];
      const total = chars.reduce((acc, ch) => acc + ctx.measureText(ch).width + t.letterSpacing, 0) - t.letterSpacing;
      if (t.align === "center") cx = x - total / 2;
      if (t.align === "right") cx = x - total;
      ctx.textAlign = "left";
      for (const ch of chars) {
        ctx.fillText(ch, cx, i * lineH);
        cx += ctx.measureText(ch).width + t.letterSpacing;
      }
      ctx.textAlign = t.align;
    } else {
      ctx.fillText(line, x, i * lineH);
    }
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function drawShapeLayer(layer: Layer): void {
  if (!layer.shape || !layer.canvas) return;
  const { shape: s, canvas } = layer;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = s.fill;
  ctx.strokeStyle = s.stroke;
  ctx.lineWidth = s.strokeWidth;
  const w = canvas.width, h = canvas.height;
  ctx.beginPath();
  if (s.kind === "ellipse") {
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (s.kind === "line") {
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
  } else if (s.kind === "rounded") {
    const r = Math.min(s.radius, w / 2, h / 2);
    ctx.roundRect(0, 0, w, h, r);
  } else {
    ctx.rect(0, 0, w, h);
  }
  if (s.kind !== "line") ctx.fill();
  if (s.strokeWidth > 0) ctx.stroke();
}
