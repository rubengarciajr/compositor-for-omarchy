/**
 * Free-transform geometry for the Move tool: handle positions, hit testing, and
 * scale/rotate maths. Pure functions so the self-test can cover them.
 *
 * A layer's `Transform` is its unrotated box (x, y, width, height) plus a rotation
 * about the box centre, matching how the compositor draws it.
 */
import type { Transform } from "./model";

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export interface HandleSpec { id: HandleId; hx: -1 | 0 | 1; hy: -1 | 0 | 1 }
export interface Handle extends HandleSpec { x: number; y: number }

export const HANDLES: HandleSpec[] = [
  { id: "nw", hx: -1, hy: -1 }, { id: "n", hx: 0, hy: -1 }, { id: "ne", hx: 1, hy: -1 },
  { id: "e", hx: 1, hy: 0 }, { id: "se", hx: 1, hy: 1 }, { id: "s", hx: 0, hy: 1 },
  { id: "sw", hx: -1, hy: 1 }, { id: "w", hx: -1, hy: 0 },
];

export type Hit =
  | { kind: "handle"; handle: Handle }
  | { kind: "rotate"; handle: Handle }
  | { kind: "inside" }
  | { kind: "outside" };

const rad = (deg: number) => (deg * Math.PI) / 180;

export function center(t: Transform): { x: number; y: number } {
  return { x: t.x + t.width / 2, y: t.y + t.height / 2 };
}

function rotate(x: number, y: number, deg: number): { x: number; y: number } {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  return { x: x * c - y * s, y: x * s + y * c };
}

/** Document point → the layer's unrotated frame centred on the box. */
export function toLocal(t: Transform, p: { x: number; y: number }): { x: number; y: number } {
  const c = center(t);
  return rotate(p.x - c.x, p.y - c.y, -t.rotation);
}

/** Point in the layer's unrotated, centred frame → document point. */
export function fromLocal(t: Transform, l: { x: number; y: number }): { x: number; y: number } {
  const c = center(t);
  const r = rotate(l.x, l.y, t.rotation);
  return { x: c.x + r.x, y: c.y + r.y };
}

/** The four corners in document space: nw, ne, se, sw. */
export function boxCorners(t: Transform): { x: number; y: number }[] {
  const w = t.width / 2, h = t.height / 2;
  return [{ x: -w, y: -h }, { x: w, y: -h }, { x: w, y: h }, { x: -w, y: h }].map((l) => fromLocal(t, l));
}

export function handlePositions(t: Transform): Handle[] {
  return HANDLES.map((h) => ({ ...h, ...fromLocal(t, { x: (h.hx * t.width) / 2, y: (h.hy * t.height) / 2 }) }));
}

/**
 * What a document-space pointer position is over. `zoom` converts document units to
 * screen pixels so handle size and the rotation band stay constant on screen.
 */
export function hitTest(t: Transform, p: { x: number; y: number }, zoom: number, handlePx = 7, rotateBandPx = 22): Hit {
  const tol = handlePx / zoom;
  const handles = handlePositions(t);
  let best: Handle | null = null, bestD = Infinity;
  for (const h of handles) {
    const d = Math.hypot(p.x - h.x, p.y - h.y);
    if (d <= tol && d < bestD) { best = h; bestD = d; }
  }
  if (best) return { kind: "handle", handle: best };
  const l = toLocal(t, p);
  const inside = Math.abs(l.x) <= t.width / 2 && Math.abs(l.y) <= t.height / 2;
  if (inside) return { kind: "inside" };
  // Just outside a corner: rotate.
  const band = rotateBandPx / zoom;
  for (const h of handles) {
    if (h.hx === 0 || h.hy === 0) continue;
    if (Math.hypot(p.x - h.x, p.y - h.y) <= band) return { kind: "rotate", handle: h };
  }
  return { kind: "outside" };
}

export interface ScaleOptions {
  /** Keep the aspect ratio (default for corner handles, like Photoshop). */
  proportional: boolean;
  /** Scale about the centre instead of the opposite edge/corner (Alt). */
  fromCenter: boolean;
}

/** New transform when `handle` is dragged to document point `p`, starting from `start`. */
export function scaleByHandle(start: Transform, handle: HandleSpec, p: { x: number; y: number }, opts: ScaleOptions): Transform {
  const l = toLocal(start, p);
  const w0 = Math.max(1, start.width), h0 = Math.max(1, start.height);
  // Anchor: the opposite handle, or the centre.
  const ax = opts.fromCenter ? 0 : (-handle.hx * w0) / 2;
  const ay = opts.fromCenter ? 0 : (-handle.hy * h0) / 2;
  const hx0 = (handle.hx * w0) / 2, hy0 = (handle.hy * h0) / 2;

  let w = w0, h = h0;
  if (opts.proportional && handle.hx !== 0 && handle.hy !== 0) {
    // Project the pointer onto the anchor→handle diagonal.
    const dx = hx0 - ax, dy = hy0 - ay;
    const s = ((l.x - ax) * dx + (l.y - ay) * dy) / (dx * dx + dy * dy);
    const k = Math.max(0.01, s);
    w = w0 * k;
    h = h0 * k;
  } else {
    if (handle.hx !== 0) w = Math.abs(l.x - ax) * (opts.fromCenter ? 2 : 1);
    if (handle.hy !== 0) h = Math.abs(l.y - ay) * (opts.fromCenter ? 2 : 1);
    if (opts.proportional && (handle.hx === 0 || handle.hy === 0)) {
      // Edge handle with Shift: scale the other axis to match.
      const k = handle.hx !== 0 ? w / w0 : h / h0;
      w = w0 * k;
      h = h0 * k;
    }
  }
  w = Math.max(1, w);
  h = Math.max(1, h);

  // Keep the anchor fixed: new local centre relative to the old one.
  const cx = opts.fromCenter ? 0 : ax + (handle.hx * w) / 2 * (handle.hx !== 0 || opts.proportional ? 1 : 0);
  const cy = opts.fromCenter ? 0 : ay + (handle.hy * h) / 2 * (handle.hy !== 0 || opts.proportional ? 1 : 0);
  // Axes the handle does not touch keep their centre at 0 (unless proportional moved them).
  const lcx = handle.hx === 0 && !opts.proportional ? 0 : cx;
  const lcy = handle.hy === 0 && !opts.proportional ? 0 : cy;
  const c = fromLocal(start, { x: lcx, y: lcy });
  return { ...start, x: c.x - w / 2, y: c.y - h / 2, width: w, height: h };
}

/** Rotation for a pointer at `p`, given where the drag started. Shift snaps to 15°. */
export function rotateByPointer(
  start: Transform,
  startPointer: { x: number; y: number },
  p: { x: number; y: number },
  snap: boolean,
): Transform {
  const c = center(start);
  const a0 = Math.atan2(startPointer.y - c.y, startPointer.x - c.x);
  const a1 = Math.atan2(p.y - c.y, p.x - c.x);
  let deg = start.rotation + ((a1 - a0) * 180) / Math.PI;
  if (snap) deg = Math.round(deg / 15) * 15;
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  return { ...start, rotation: deg };
}

/** CSS cursor for a hit, roughly following the handle's screen direction. */
export function cursorFor(hit: Hit, rotation: number): string {
  if (hit.kind === "inside") return "move";
  if (hit.kind === "rotate") return "grab";
  if (hit.kind === "outside") return "default";
  const { hx, hy } = hit.handle;
  // Direction of the handle from the centre, rotated onto the screen.
  const d = rotate(hx, hy, rotation);
  const ang = ((Math.atan2(d.y, d.x) * 180) / Math.PI + 360) % 180;
  if (ang < 22.5 || ang >= 157.5) return "ew-resize";
  if (ang < 67.5) return "nwse-resize";
  if (ang < 112.5) return "ns-resize";
  return "nesw-resize";
}
