/**
 * Gradient tool presets, Photoshop "Basics" style. Presets are resolved against the
 * current foreground/background colours at paint time, so picking a new colour changes
 * what the preset paints (exactly like Photoshop's "Foreground to Background").
 */
import { parseHex } from "./pixels";

export type GradientPresetId = "fg-bg" | "fg-transparent" | "bg-transparent" | "black-white";
export type GradientStyle = "linear" | "radial";

export interface GradientSettings {
  preset: GradientPresetId;
  style: GradientStyle;
  reverse: boolean;
  /** 0.01…1, applied to the whole fill (Compositor 1.3). */
  opacity: number;
}

export interface GradientStop { offset: number; color: string }

export const GRADIENT_PRESETS: { id: GradientPresetId; name: string }[] = [
  { id: "fg-bg", name: "Foreground to Background" },
  { id: "fg-transparent", name: "Foreground to Transparent" },
  { id: "bg-transparent", name: "Background to Transparent" },
  { id: "black-white", name: "Black, White" },
];

export const DEFAULT_GRADIENT: GradientSettings = { preset: "fg-transparent", style: "linear", reverse: false, opacity: 1 };

const STORAGE_KEY = "compositor.gradient";

export function loadGradientSettings(): GradientSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GRADIENT };
    const v = JSON.parse(raw) as Partial<GradientSettings>;
    return {
      preset: GRADIENT_PRESETS.some((p) => p.id === v.preset) ? (v.preset as GradientPresetId) : DEFAULT_GRADIENT.preset,
      style: v.style === "radial" ? "radial" : "linear",
      reverse: !!v.reverse,
      opacity: typeof v.opacity === "number" && isFinite(v.opacity) ? Math.min(1, Math.max(0.01, v.opacity)) : 1,
    };
  } catch {
    return { ...DEFAULT_GRADIENT };
  }
}

export function saveGradientSettings(s: GradientSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Colour stops (rgba strings) for a preset, given the current colours. */
export function gradientStops(preset: GradientPresetId, fg: string, bg: string, reverse = false): GradientStop[] {
  let stops: GradientStop[];
  switch (preset) {
    case "fg-transparent": stops = [{ offset: 0, color: rgba(fg, 1) }, { offset: 1, color: rgba(fg, 0) }]; break;
    case "bg-transparent": stops = [{ offset: 0, color: rgba(bg, 1) }, { offset: 1, color: rgba(bg, 0) }]; break;
    case "black-white": stops = [{ offset: 0, color: rgba("#000000", 1) }, { offset: 1, color: rgba("#ffffff", 1) }]; break;
    default: stops = [{ offset: 0, color: rgba(fg, 1) }, { offset: 1, color: rgba(bg, 1) }];
  }
  if (reverse) stops = stops.map((s) => ({ offset: 1 - s.offset, color: s.color })).reverse();
  return stops;
}

/** CSS background for preview strips / preset tiles (drawn over a checkerboard). */
export function gradientCss(stops: GradientStop[], style: GradientStyle = "linear", angle = 90): string {
  const list = stops.map((s) => `${s.color} ${Math.round(s.offset * 100)}%`).join(", ");
  return style === "radial" ? `radial-gradient(circle at center, ${list})` : `linear-gradient(${angle}deg, ${list})`;
}

/** Fill the whole context with the gradient laid along the drag line. */
export function paintGradient(
  ctx: CanvasRenderingContext2D,
  settings: GradientSettings,
  line: { x1: number; y1: number; x2: number; y2: number },
  fg: string,
  bg: string,
  width: number,
  height: number,
): void {
  const stops = gradientStops(settings.preset, fg, bg, settings.reverse);
  const len = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
  const grad = settings.style === "radial"
    ? ctx.createRadialGradient(line.x1, line.y1, 0, line.x1, line.y1, Math.max(len, 0.01))
    : ctx.createLinearGradient(line.x1, line.y1, line.x2, line.y2);
  for (const s of stops) grad.addColorStop(s.offset, s.color);
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0.01, settings.opacity ?? 1));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
