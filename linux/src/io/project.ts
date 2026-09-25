/**
 * Compositor project files (.comp).
 *
 * The macOS app saves a document *package*: a folder with `manifest.json` and
 * `images/<LAYER UUID>.png` (masks as `<UUID>.mask.png`). On Linux the same layout
 * is stored inside one ZIP file, so a `.comp` from here unzips into a Mac package
 * and the manifest follows `docs/project-format.md` (format version 9).
 * Fields the Mac app does not know (font weight, adjustment parameters, folder
 * collapse) sit under `linux` keys, which other readers ignore.
 */
import type { AdjustmentKind, BlendMode, DocumentState, Layer, LayerEffect, ShapeKind, Transform } from "../core/model";
import { BLEND_LABELS, createCanvas, createDocument, createLayer, defaultTransform, parentOf } from "../core/model";
import { parseHex } from "../core/pixels";
import { readZip, writeZip } from "./zip";

export const PROJECT_FORMAT = "com.compositor.project";
export const PROJECT_VERSION = 9;
export const PROJECT_EXTENSION = ".comp";
export const PROJECT_MIME = "application/x-compositor-project";

const ADJUSTMENT_NAMES: Record<AdjustmentKind, string> = {
  hsv: "Hue/Saturation", levels: "Levels", curves: "Curves", exposure: "Exposure", "gradient-map": "Gradient Map",
  grain: "Grain", "add-noise": "Add Noise", "gaussian-blur": "Gaussian Blur", "motion-blur": "Motion Blur",
  invert: "Invert", "black-white": "Black & White", "color-balance": "Color Balance",
};
const BLEND_BY_LABEL = Object.fromEntries(Object.entries(BLEND_LABELS).map(([k, v]) => [v, k])) as Record<string, BlendMode>;
const ADJUSTMENT_BY_NAME = Object.fromEntries(Object.entries(ADJUSTMENT_NAMES).map(([k, v]) => [v, k])) as Record<string, AdjustmentKind>;

interface ManifestTransform { origin: [number, number]; size: [number, number]; rotation: number; flipX: boolean; flipY: boolean; sampling: string }
interface ManifestLayer {
  id: string; name: string; isVisible: boolean; transform: ManifestTransform; imageFile: string | null;
  parentID?: string; isGroup?: boolean; opacity?: number; blendMode?: string;
  maskFile?: string; maskEnabled?: boolean; maskLinked?: boolean; maskSourceID?: string;
  adjustment?: Record<string, unknown>; shape?: Record<string, unknown>; effects?: Record<string, unknown>; text?: Record<string, unknown>;
  linux?: { collapsed?: boolean; clipping?: boolean; locked?: boolean };
}
interface Manifest {
  format: string; version: number; colorSpace: string; resolution: number; documentID: string;
  width: number; height: number; activeLayerID: string | null; layers: ManifestLayer[];
  guides: { id: string; axis: "horizontal" | "vertical"; position: number }[];
  linux?: { name: string; app: string; savedAt: string };
}

const rgb = (hex: string) => { const [r, g, b] = parseHex(hex); return { red: r / 255, green: g / 255, blue: b / 255 }; };
const hex = (o: { red?: number; green?: number; blue?: number }) =>
  "#" + [o.red ?? 0, o.green ?? 0, o.blue ?? 0].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
const upperUuid = () => crypto.randomUUID().toUpperCase();

function pngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error("PNG encode failed"))), "image/png");
  });
}

/** Our masks are alpha coverage; the package stores them as opaque grayscale (white reveals). */
function maskToGray(mask: HTMLCanvasElement): HTMLCanvasElement {
  const out = createCanvas(mask.width, mask.height);
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(mask, 0, 0);
  return out;
}
function grayToMask(img: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = img.getContext("2d")!;
  const d = ctx.getImageData(0, 0, img.width, img.height);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const lum = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114) * (p[i + 3] / 255);
    p[i] = p[i + 1] = p[i + 2] = 255;
    p[i + 3] = lum;
  }
  ctx.putImageData(d, 0, 0);
  return img;
}

function effectsRecord(effects: LayerEffect[]): Record<string, unknown> | undefined {
  const rec: Record<string, unknown> = {};
  for (const fx of effects) {
    const base = { enabled: fx.enabled, ...rgb(fx.color), opacity: fx.opacity };
    if (fx.kind === "stroke") rec.stroke = { ...base, size: fx.size, inside: false };
    else if (fx.kind === "drop-shadow") rec.shadow = { ...base, angle: fx.angle, distance: fx.distance, blur: fx.size };
    else if (fx.kind === "color-overlay") rec.colorOverlay = base;
    else if (fx.kind === "inner-shadow") rec.innerShadow = { ...base, angle: fx.angle, distance: fx.distance, blur: fx.size };
    else if (fx.kind === "outer-glow") rec.outerGlow = { ...base, size: fx.size };
    else if (fx.kind === "inner-glow") rec.innerGlow = { ...base, size: fx.size };
  }
  return Object.keys(rec).length ? rec : undefined;
}
function effectsFromRecord(rec: Record<string, unknown> | undefined): LayerEffect[] {
  if (!rec) return [];
  const out: LayerEffect[] = [];
  const get = (key: string, kind: LayerEffect["kind"]) => {
    const e = rec[key] as Record<string, number | boolean> | undefined;
    if (!e) return;
    out.push({
      kind, enabled: e.enabled !== false, color: hex(e as { red: number; green: number; blue: number }),
      opacity: Number(e.opacity ?? 1), size: Number(e.blur ?? e.size ?? 4), distance: Number(e.distance ?? 0),
      angle: Number(e.angle ?? 120), spread: 0,
    });
  };
  get("stroke", "stroke"); get("shadow", "drop-shadow"); get("colorOverlay", "color-overlay"); get("innerShadow", "inner-shadow"); get("outerGlow", "outer-glow"); get("innerGlow", "inner-glow");
  return out;
}

function transformRecord(t: Transform): ManifestTransform {
  return { origin: [t.x, t.y], size: [t.width, t.height], rotation: t.rotation, flipX: t.flipH, flipY: t.flipV, sampling: "High quality" };
}
function transformFrom(m: ManifestTransform | undefined, w: number, h: number): Transform {
  if (!m) return defaultTransform(w, h);
  const [x, y] = m.origin ?? [0, 0];
  const [width, height] = m.size ?? [w, h];
  return { x, y, width, height, rotation: m.rotation ?? 0, flipH: !!m.flipX, flipV: !!m.flipY };
}

/** Serialize a document into a .comp ZIP (manifest.json + images/). */
export async function serializeProject(doc: DocumentState, activeLayerId: string | null): Promise<Blob> {
  return writeZip(await buildProject(doc, activeLayerId));
}

/** The files of a .comp package: `manifest.json` first, then `images/<ID>.png` and masks. */
export async function buildProject(doc: DocumentState, activeLayerId: string | null): Promise<{ name: string; data: Uint8Array }[]> {
  const files: { name: string; data: Uint8Array }[] = [];
  const ids = new Map<string, string>();
  for (const l of doc.layers) ids.set(l.id, /^[0-9A-F-]{36}$/.test(l.id) ? l.id : l.id.toUpperCase());
  const layers: ManifestLayer[] = [];
  for (const l of doc.layers) {
    const id = ids.get(l.id)!;
    const rec: ManifestLayer = {
      id, name: l.name, isVisible: l.visible, transform: transformRecord(l.transform), imageFile: null,
      opacity: l.opacity, blendMode: BLEND_LABELS[l.blendMode],
      linux: { collapsed: l.collapsed, clipping: l.clipping, locked: l.locked },
    };
    const parent = parentOf(doc, l);
    if (parent) rec.parentID = ids.get(parent);
    if (l.kind === "group") rec.isGroup = true;
    if (l.canvas && l.kind !== "group" && l.kind !== "adjustment") {
      rec.imageFile = `${id}.png`;
      files.push({ name: `images/${id}.png`, data: await pngBytes(l.canvas) });
    }
    if (l.mask) {
      rec.maskFile = `${id}.mask.png`;
      rec.maskEnabled = l.mask.enabled;
      rec.maskLinked = l.mask.linked;
      files.push({ name: `images/${id}.mask.png`, data: await pngBytes(maskToGray(l.mask.canvas)) });
    }
    if (l.clipping) {
      // Photoshop-style clipping = Mac "live mask" from the nearest non-clipping sibling below.
      const siblings = doc.layers.filter((s) => parentOf(doc, s) === parent);
      for (let i = siblings.indexOf(l) - 1; i >= 0; i--) if (!siblings[i].clipping) { rec.maskSourceID = ids.get(siblings[i].id); break; }
    }
    if (l.kind === "adjustment" && l.adjustmentKind) {
      const a = l.adjustment ?? {};
      rec.adjustment = { kind: ADJUSTMENT_NAMES[l.adjustmentKind], hue: a.hue ?? 0, saturation: a.saturation ?? 0, lightness: a.lightness ?? 0, colorize: !!a.colorize, linux: a };
    }
    if (l.kind === "shape" && l.shape) {
      rec.shape = {
        kind: l.shape.kind === "ellipse" ? "Ellipse" : l.shape.kind === "line" ? "Line" : "Rectangle",
        ...rgb(l.shape.fill), cornerRadius: l.shape.kind === "rounded" ? l.shape.radius : 0, lineWidth: l.shape.strokeWidth,
        linux: { kind: l.shape.kind, stroke: l.shape.stroke },
      };
    }
    if (l.kind === "text" && l.text) {
      const t = l.text;
      rec.text = {
        content: t.text, fontName: t.fontFamily, fontSize: t.fontSize, ...rgb(t.color),
        alignment: t.align === "center" ? "Center" : t.align === "right" ? "Right" : "Left",
        tracking: t.letterSpacing, leading: t.fontSize * t.lineHeight, linux: { weight: t.weight, lineHeight: t.lineHeight },
      };
    }
    const fx = effectsRecord(l.effects);
    if (fx) rec.effects = fx;
    layers.push(rec);
  }
  const manifest: Manifest = {
    format: PROJECT_FORMAT, version: PROJECT_VERSION, colorSpace: "sRGB", resolution: doc.resolution,
    documentID: /^[0-9A-F-]{36}$/.test(doc.id) ? doc.id : doc.id.toUpperCase(),
    width: doc.width, height: doc.height,
    activeLayerID: activeLayerId ? ids.get(activeLayerId) ?? null : null,
    layers,
    guides: doc.guides.map((g) => ({ id: upperUuid(), axis: g.axis === "x" ? "vertical" : "horizontal", position: g.pos })),
    linux: { name: doc.name, app: "compositor-linux/1.0.0", savedAt: new Date().toISOString() },
  };
  files.unshift({ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  return files;
}

async function decodePng(bytes: Uint8Array): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("Damaged image inside project")); img.src = url; });
    const c = createCanvas(img.naturalWidth, img.naturalHeight);
    c.getContext("2d")!.drawImage(img, 0, 0);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Parse a .comp ZIP into a document. Returns the document and the id of its active layer. */
export async function parseProject(buffer: ArrayBuffer, fallbackName: string): Promise<{ doc: DocumentState; activeLayerId: string | null }> {
  const files = await readZip(buffer);
  // Accept a zipped package with a top-level folder too (e.g. "Name.comp/manifest.json").
  const prefix = [...files.keys()].find((k) => k.endsWith("manifest.json"))?.replace(/manifest\.json$/, "") ?? "";
  return parseProjectFrom(async (path) => files.get(`${prefix}${path}`) ?? null, fallbackName);
}

/** Parse a package from any reader of `manifest.json` / `images/<file>` (ZIP, folder, URL). */
export async function parseProjectFrom(read: (path: string) => Promise<Uint8Array | null>, fallbackName: string): Promise<{ doc: DocumentState; activeLayerId: string | null }> {
  const manifestBytes = await read("manifest.json");
  if (!manifestBytes) throw new Error("Not a Compositor project (manifest.json missing)");
  const m = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  if (m.format !== PROJECT_FORMAT) throw new Error("Not a Compositor project");
  if (!(m.version >= 1 && m.version <= PROJECT_VERSION)) throw new Error(`Project format version ${m.version} is newer than this app supports (${PROJECT_VERSION})`);
  const doc = createDocument(m.width, m.height, m.linux?.name ?? fallbackName);
  doc.id = m.documentID ?? doc.id;
  doc.resolution = m.resolution ?? 72;
  doc.guides = (m.guides ?? []).map((g) => ({ axis: g.axis === "vertical" ? "x" : "y", pos: g.position }));
  const idBySource = new Map<string, string>();
  const byId = new Map<string, ManifestLayer>(m.layers.map((r) => [r.id, r]));
  for (const rec of m.layers) {
    const isGroup = rec.isGroup === true;
    const kind: Layer["kind"] = isGroup ? "group" : rec.adjustment ? "adjustment" : rec.text ? "text" : rec.shape ? "shape" : "raster";
    let canvas: HTMLCanvasElement | null = null;
    if (rec.imageFile) {
      const bytes = await read(`images/${rec.imageFile}`);
      if (!bytes) throw new Error(`Image missing inside project: ${rec.imageFile}`);
      canvas = await decodePng(bytes);
    }
    const transform = transformFrom(rec.transform, canvas?.width ?? m.width, canvas?.height ?? m.height);
    const layer = createLayer({
      name: rec.name, kind, canvas: kind === "group" || kind === "adjustment" ? null : canvas ?? createCanvas(transform.width, transform.height),
      transform, visible: rec.isVisible !== false, opacity: rec.opacity ?? 1,
      blendMode: (rec.blendMode && BLEND_BY_LABEL[rec.blendMode]) || "normal",
      effects: effectsFromRecord(rec.effects), clipping: !!rec.maskSourceID || !!rec.linux?.clipping,
      locked: !!rec.linux?.locked, collapsed: rec.linux?.collapsed,
    });
    layer.id = rec.id;
    idBySource.set(rec.id, layer.id);
    if (rec.maskFile) {
      const bytes = await read(`images/${rec.maskFile}`);
      if (bytes) layer.mask = { canvas: grayToMask(await decodePng(bytes)), enabled: rec.maskEnabled !== false, linked: rec.maskLinked !== false };
    }
    if (kind === "adjustment" && rec.adjustment) {
      const a = rec.adjustment as { kind?: string; linux?: Record<string, unknown>; hue?: number; saturation?: number; lightness?: number; colorize?: boolean };
      layer.adjustmentKind = ADJUSTMENT_BY_NAME[a.kind ?? ""] ?? "hsv";
      layer.adjustment = (a.linux as Layer["adjustment"]) ?? { hue: a.hue ?? 0, saturation: a.saturation ?? 0, lightness: a.lightness ?? 0, colorize: !!a.colorize };
    }
    if (kind === "shape" && rec.shape) {
      const s = rec.shape as { kind?: string; red?: number; green?: number; blue?: number; cornerRadius?: number; lineWidth?: number; linux?: { kind?: string; stroke?: string } };
      const k = s.linux?.kind ?? (s.kind === "Ellipse" ? "ellipse" : s.kind === "Line" ? "line" : (s.cornerRadius ?? 0) > 0 ? "rounded" : "rect");
      layer.shape = { kind: k as ShapeKind, fill: hex(s), stroke: s.linux?.stroke ?? "#000000", strokeWidth: s.lineWidth ?? 0, radius: s.cornerRadius ?? 0 };
    }
    if (kind === "text" && rec.text) {
      const t = rec.text as { content?: string; fontName?: string; fontSize?: number; red?: number; green?: number; blue?: number; alignment?: string; tracking?: number; leading?: number; linux?: { weight?: number; lineHeight?: number } };
      const fontSize = t.fontSize ?? 48;
      layer.text = {
        text: t.content ?? "", fontFamily: t.fontName ?? "Noto Sans", fontSize, color: hex(t),
        align: t.alignment === "Center" ? "center" : t.alignment === "Right" ? "right" : "left",
        lineHeight: t.linux?.lineHeight ?? (t.leading && t.leading > 0 ? t.leading / fontSize : 1.2),
        letterSpacing: t.tracking ?? 0, weight: t.linux?.weight ?? 400,
      };
    }
    doc.layers.push(layer);
  }
  for (const rec of m.layers) {
    const layer = doc.layers.find((l) => l.id === rec.id)!;
    layer.parentId = rec.parentID && byId.has(rec.parentID) ? rec.parentID : null;
  }
  return { doc, activeLayerId: m.activeLayerID && idBySource.has(m.activeLayerID) ? m.activeLayerID : doc.layers[doc.layers.length - 1]?.id ?? null };
}

export function isProjectFile(name: string): boolean {
  return name.toLowerCase().endsWith(PROJECT_EXTENSION);
}
