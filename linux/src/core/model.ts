import type { GradientSettings } from "./gradient";
import type { ProjectSource } from "../io/package";
/** Core document model — mirrors Compositor's ImageLayer / CanvasDocument. */

export type BlendMode =
  | "normal"
  | "darken" | "multiply" | "color-burn" | "linear-burn"
  | "lighten" | "screen" | "color-dodge" | "linear-dodge"
  | "overlay" | "soft-light" | "hard-light" | "vivid-light" | "linear-light" | "pin-light" | "hard-mix"
  | "difference" | "exclusion" | "subtract" | "divide"
  | "hue" | "saturation" | "color" | "luminosity";

export const BLEND_GROUPS: { label: string; modes: BlendMode[] }[] = [
  { label: "Normal", modes: ["normal"] },
  { label: "Darken", modes: ["darken", "multiply", "color-burn", "linear-burn"] },
  { label: "Lighten", modes: ["lighten", "screen", "color-dodge", "linear-dodge"] },
  {
    label: "Contrast",
    modes: ["overlay", "soft-light", "hard-light", "vivid-light", "linear-light", "pin-light", "hard-mix"],
  },
  { label: "Inversion", modes: ["difference", "exclusion", "subtract", "divide"] },
  { label: "Component", modes: ["hue", "saturation", "color", "luminosity"] },
];

export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: "Normal",
  darken: "Darken",
  multiply: "Multiply",
  "color-burn": "Color Burn",
  "linear-burn": "Linear Burn",
  lighten: "Lighten",
  screen: "Screen",
  "color-dodge": "Color Dodge",
  "linear-dodge": "Linear Dodge (Add)",
  overlay: "Overlay",
  "soft-light": "Soft Light",
  "hard-light": "Hard Light",
  "vivid-light": "Vivid Light",
  "linear-light": "Linear Light",
  "pin-light": "Pin Light",
  "hard-mix": "Hard Mix",
  difference: "Difference",
  exclusion: "Exclusion",
  subtract: "Subtract",
  divide: "Divide",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

export type AdjustmentKind =
  | "hsv" | "levels" | "curves" | "exposure" | "gradient-map" | "grain"
  | "add-noise" | "gaussian-blur" | "motion-blur" | "invert" | "black-white" | "color-balance";

export type EffectKind = "stroke" | "drop-shadow" | "color-overlay" | "inner-shadow" | "outer-glow" | "inner-glow";

export type ToolId =
  | "idle" | "move" | "marquee" | "lasso" | "wand" | "crop"
  | "brush" | "spot-healing" | "clone-stamp" | "blur"
  | "gradient" | "shape" | "type" | "eyedropper" | "hand" | "zoom";

export type MarqueeShape = "rect" | "ellipse";
export type LassoMode = "free" | "polygon";
export type ShapeKind = "rect" | "rounded" | "ellipse" | "line";

export interface Transform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // degrees
  flipH: boolean;
  flipV: boolean;
}

export interface LayerMask {
  canvas: HTMLCanvasElement;
  enabled: boolean;
  linked: boolean;
}

export interface AdjustmentParams {
  hue?: number;
  saturation?: number;
  lightness?: number;
  colorize?: boolean;
  levels?: { black: number; white: number; gamma: number; outBlack: number; outWhite: number };
  curves?: { rgb: number[][]; r: number[][]; g: number[][]; b: number[][] };
  exposure?: { exposure: number; offset: number; gamma: number };
  gradientMap?: { stops: { t: number; color: string }[]; reverse: boolean };
  grain?: { amount: number; size: number };
  noise?: { amount: number; monochrome: boolean };
  blurRadius?: number;
  motion?: { angle: number; distance: number };
  blackWhite?: { red: number; yellow: number; green: number; cyan: number; blue: number; magenta: number };
  colorBalance?: { shadows: [number, number, number]; mids: [number, number, number]; highs: [number, number, number] };
}

export interface LayerEffect {
  kind: EffectKind;
  enabled: boolean;
  color: string;
  opacity: number;
  size: number;
  distance: number;
  angle: number;
  spread: number;
}

export interface TextLayerData {
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  align: CanvasTextAlign;
  lineHeight: number;
  letterSpacing: number;
  weight: number;
}

export interface ShapeLayerData {
  kind: ShapeKind;
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;
}

export type LayerKind = "raster" | "group" | "adjustment" | "text" | "shape";

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  parentId: string | null;
  locked: boolean;
  /** Pixel content for raster layers; live raster for text/shape once rasterized for effects. */
  canvas: HTMLCanvasElement | null;
  transform: Transform;
  mask: LayerMask | null;
  adjustmentKind?: AdjustmentKind;
  adjustment?: AdjustmentParams;
  effects: LayerEffect[];
  text?: TextLayerData;
  shape?: ShapeLayerData;
  clipping: boolean;
  /** Groups only: folded in the layers panel (UI state, kept in history copies). */
  collapsed?: boolean;
}

export interface Guide {
  axis: "x" | "y";
  pos: number;
}

export type SelectionPath = { type: "rect"; x: number; y: number; w: number; h: number; ellipse?: boolean }
  | { type: "path"; points: [number, number][] };

export interface Selection {
  path: SelectionPath;
  /** Cached mask canvas of document size; white = selected. */
  mask: HTMLCanvasElement | null;
  mode: "replace" | "add" | "subtract" | "intersect";
}

export interface DocumentState {
  id: string;
  name: string;
  width: number;
  height: number;
  resolution: number;
  layers: Layer[]; // bottom → top
  guides: Guide[];
  selection: Selection | null;
  dirty: boolean;
  /** Bumped whenever pixels or structure change; the renderer caches the flattened result per version. */
  version: number;
  /** Where this document was opened from / last saved to (session only). */
  fileName?: string;
  fileHandle?: FileSystemFileHandle;
  /** The package on disk this document is bound to; watched for outside changes and used by Save. */
  source?: ProjectSource;
  /** Fingerprint of the package when it was last read or written, to notice outside changes. */
  diskState?: string | null;
}

/** The brush tip shared by Brush, Spot Healing, Clone Stamp and Smear (Compositor's BrushSettings). */
export interface BrushSettings {
  /** Diameter in document pixels, 1…2000. */
  size: number;
  /** 0 = fully soft, 1 = hard-edged. */
  hardness: number;
  /** Caps the whole stroke, 0.01…1 ("Strength" for Smear). */
  opacity: number;
  /** 0–100: the brush trails the pointer on a string this long (screen points). Brush only. */
  smoothing: number;
}

export type BrushMode = "paint" | "erase";
export type SmearMode = "liquify" | "blur" | "smudge";
export type HealMode = "content-aware" | "create-texture" | "proximity-match";

export interface SessionState {
  tool: ToolId;
  brush: BrushSettings;
  /** Brush tool: paint with the foreground colour (B) or erase (E). */
  brushMode: BrushMode;
  /** Smear tool: Liquify pushes pixels, Blur softens, Smudge drags colour along. */
  smearMode: SmearMode;
  /** Spot Healing type. */
  healMode: HealMode;
  clone: { aligned: boolean; sampleAll: boolean };
  /** The active layer's mask is the paint target (its thumbnail was clicked). */
  maskSelected: boolean;
  /** On a mask: paint white (reveal) instead of black (hide). */
  maskPaintWhite: boolean;
  foreground: string;
  background: string;
  marqueeShape: MarqueeShape;
  lassoMode: LassoMode;
  wandTolerance: number;
  /** Magic Wand: only pixels connected to the click (Photoshop "Contiguous"). */
  wandContiguous: boolean;
  shapeKind: ShapeKind;
  activeLayerId: string | null;
  selectedLayerIds: string[];
  zoom: number;
  panX: number;
  panY: number;
  showRulers: boolean;
  showGrid: boolean;
  showPixelGrid: boolean;
  snap: { guides: boolean; grid: boolean; layers: boolean; bounds: boolean };
  text: TextLayerData;
  /** Gradient tool preset, style and direction (remembered between sessions). */
  gradient: GradientSettings;
  cropRect: { x: number; y: number; w: number; h: number } | null;
  /** Crop tool aspect ratio (width / height), null for free. */
  cropRatio: number | null;
  /** Start→end of a gradient drag, drawn as a guide line while dragging. */
  dragLine: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Pointer position over the canvas in document space (for the brush size preview). */
  hover: { x: number; y: number } | null;
  /** In-canvas text editing session (Type tool), null when not editing. */
  textEdit: { layerId: string; original: string; created: boolean } | null;
  /** Lasso outline in progress (document space), drawn live by the shell. */
  lassoPath: [number, number][] | null;
}

export function uid(): string {
  return crypto.randomUUID();
}

export function defaultTransform(w: number, h: number, x = 0, y = 0): Transform {
  return { x, y, width: w, height: h, rotation: 0, flipH: false, flipV: false };
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function createLayer(
  partial: Partial<Layer> & { name: string; kind: LayerKind },
): Layer {
  const w = partial.transform?.width ?? 1;
  const h = partial.transform?.height ?? 1;
  return {
    id: uid(),
    visible: true,
    opacity: 1,
    blendMode: "normal",
    parentId: null,
    locked: false,
    canvas: partial.kind === "group" || partial.kind === "adjustment" ? null : createCanvas(w, h),
    transform: defaultTransform(w, h),
    mask: null,
    effects: [],
    clipping: false,
    ...partial,
  };
}

export function createDocument(width: number, height: number, name = "Untitled"): DocumentState {
  return {
    id: uid(),
    name,
    width,
    height,
    resolution: 72,
    layers: [],
    guides: [],
    selection: null,
    dirty: false,
    version: 0,
  };
}

export function createRasterLayer(
  name: string,
  width: number,
  height: number,
  x = 0,
  y = 0,
  fill?: string,
): Layer {
  const layer = createLayer({
    name,
    kind: "raster",
    transform: defaultTransform(width, height, x, y),
  });
  if (fill && layer.canvas) {
    const ctx = layer.canvas.getContext("2d")!;
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, width, height);
  }
  return layer;
}

export function createBlankLayer(doc: DocumentState, name: string): Layer {
  return createRasterLayer(name, doc.width, doc.height);
}

/** Bottom-to-top visual order among siblings, groups expand. */
export function effectiveVisibleLayers(doc: DocumentState): Layer[] {
  const byParent = new Map<string | null, Layer[]>();
  for (const l of doc.layers) {
    const key = l.parentId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(l);
  }
  const out: Layer[] = [];
  const walk = (parentId: string | null) => {
    const list = byParent.get(parentId) ?? [];
    // layers array is bottom→top; UI lists top→bottom but render uses this order
    for (const layer of list) {
      if (!layer.visible) continue;
      if (layer.kind === "group") walk(layer.id);
      else out.push(layer);
    }
  };
  walk(null);
  return out;
}

/** Top-to-bottom for the layers panel (flat). */
export function panelOrder(doc: DocumentState): Layer[] {
  return [...doc.layers].reverse();
}

/** A layer's parent id, treating dangling parent ids as top level. */
export function parentOf(doc: DocumentState, layer: Layer): string | null {
  return layer.parentId && doc.layers.some((l) => l.id === layer.parentId) ? layer.parentId : null;
}

export interface TreeRow { layer: Layer; depth: number }

/** Top-to-bottom rows for the layers panel, nesting group children and skipping collapsed ones. */
export function layerTree(doc: DocumentState, parentId: string | null = null, depth = 0, out: TreeRow[] = []): TreeRow[] {
  const kids = doc.layers.filter((l) => parentOf(doc, l) === parentId).reverse();
  for (const layer of kids) {
    out.push({ layer, depth });
    if (layer.kind === "group" && !layer.collapsed) layerTree(doc, layer.id, depth + 1, out);
  }
  return out;
}

/** All descendants of a group (any depth), in array order. */
export function descendants(doc: DocumentState, groupId: string): Layer[] {
  const out: Layer[] = [];
  for (const l of doc.layers) {
    if (parentOf(doc, l) === groupId) {
      out.push(l);
      if (l.kind === "group") out.push(...descendants(doc, l.id));
    }
  }
  return out;
}
