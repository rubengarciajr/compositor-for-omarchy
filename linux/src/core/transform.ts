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

/** Screen distance of the rotation knob beyond the top-centre handle (Compositor: 28 pt). */
export const ROTATION_HANDLE_OFFSET = 28;

/** Where the rotation knob sits: 28 screen pixels beyond the top-centre handle, along the box's outward normal. */
export function rotationHandle(t: Transform, zoom: number): { x: number; y: number } {
  return fromLocal(t, { x: 0, y: -t.height / 2 - ROTATION_HANDLE_OFFSET / zoom });
}

/**
 * What a document-space pointer position is over, as Compositor's TransformOverlayGeometry
 * decides it: the rotation knob within `handlePx`, then any handle within `handlePx`, then
 * an edge within `handlePx` (which counts as that edge's middle handle), then inside.
 * `rotateBandPx` of 0 hides the rotation knob (crop boxes).
 */
export function hitTest(t: Transform, p: { x: number; y: number }, zoom: number, handlePx = 10, rotateBandPx = 1): Hit {
  const tol = handlePx / zoom;
  const handles = handlePositions(t);
  const top = handles.find((h) => h.id === "n")!;
  if (rotateBandPx > 0) {
    const knob = rotationHandle(t, zoom);
    if (Math.hypot(p.x - knob.x, p.y - knob.y) <= tol) return { kind: "rotate", handle: top };
  }
  let best: Handle | null = null, bestD = Infinity;
  for (const h of handles) {
    const d = Math.hypot(p.x - h.x, p.y - h.y);
    if (d <= tol && d < bestD) { best = h; bestD = d; }
  }
  if (best) return { kind: "handle", handle: best };
  // Along an edge: the edge's middle handle.
  const corners = boxCorners(t); // nw, ne, se, sw
  const edges: [number, number, HandleId][] = [[0, 1, "n"], [1, 2, "e"], [2, 3, "s"], [3, 0, "w"]];
  for (const [a, b, id] of edges) {
    const ax = corners[a].x, ay = corners[a].y, bx = corners[b].x, by = corners[b].y;
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    if (len2 <= 0) continue;
    const u = ((p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / len2;
    if (u < 0 || u > 1) continue;
    const d = Math.hypot(p.x - (ax + (bx - ax) * u), p.y - (ay + (by - ay) * u));
    if (d <= tol) return { kind: "handle", handle: handles.find((h) => h.id === id)! };
  }
  const l = toLocal(t, p);
  const inside = Math.abs(l.x) <= t.width / 2 && Math.abs(l.y) <= t.height / 2;
  return inside ? { kind: "inside" } : { kind: "outside" };
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
  // Dragging a handle past the opposite side flips the layer on that axis instead of stopping.
  let flipH = start.flipH, flipV = start.flipV;
  if (handle.hx !== 0 && Math.sign(l.x - ax) === -handle.hx && l.x !== ax) flipH = !flipH;
  if (handle.hy !== 0 && Math.sign(l.y - ay) === -handle.hy && l.y !== ay) flipV = !flipV;
  if (opts.proportional && handle.hx !== 0 && handle.hy !== 0) {
    // Project the pointer onto the anchor→handle diagonal.
    const dx = hx0 - ax, dy = hy0 - ay;
    const s = ((l.x - ax) * dx + (l.y - ay) * dy) / (dx * dx + dy * dy);
    const k = Math.max(0.01, Math.abs(s));
    w = w0 * k;
    h = h0 * k;
    flipH = start.flipH; flipV = start.flipV;
    if (s < 0) { flipH = !flipH; flipV = !flipV; }
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

  // Keep the anchor fixed: new local centre relative to the old one (mirrored when flipped past it).
  const dirX = flipH !== start.flipH ? -handle.hx : handle.hx;
  const dirY = flipV !== start.flipV ? -handle.hy : handle.hy;
  const cx = opts.fromCenter ? 0 : ax + (dirX * w) / 2 * (handle.hx !== 0 || opts.proportional ? 1 : 0);
  const cy = opts.fromCenter ? 0 : ay + (dirY * h) / 2 * (handle.hy !== 0 || opts.proportional ? 1 : 0);
  // Axes the handle does not touch keep their centre at 0 (unless proportional moved them).
  const lcx = handle.hx === 0 && !opts.proportional ? 0 : cx;
  const lcy = handle.hy === 0 && !opts.proportional ? 0 : cy;
  const c = fromLocal(start, { x: lcx, y: lcy });
  return { ...start, x: c.x - w / 2, y: c.y - h / 2, width: w, height: h, flipH, flipV };
}

/** Compositor commits drags on whole pixels and whole degrees (typed values stay exact). */
export function roundedTransform(t: Transform): Transform {
  return { ...t, x: Math.round(t.x), y: Math.round(t.y), width: Math.max(1, Math.round(t.width)), height: Math.max(1, Math.round(t.height)), rotation: Math.round(t.rotation) };
}

export interface SnapTarget { axis: "x" | "y"; pos: number }

/**
 * Snap a moving box: on each axis independently, whichever of its min / mid / max lands
 * nearest a target within `tolerance` wins. Returns the shifted box and the lines that matched.
 */
export function snapMove(t: Transform, targets: SnapTarget[], tolerance: number): { transform: Transform; lines: SnapTarget[] } {
  const corners = boxCorners(t);
  const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
  const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const lines: SnapTarget[] = [];
  let dx = 0, dy = 0, bestX = tolerance, bestY = tolerance;
  for (const s of targets) {
    if (s.axis === "x") {
      for (const v of [box.minX, (box.minX + box.maxX) / 2, box.maxX]) {
        const d = Math.abs(s.pos - v);
        if (d < bestX) { bestX = d; dx = s.pos - v; }
      }
    } else {
      for (const v of [box.minY, (box.minY + box.maxY) / 2, box.maxY]) {
        const d = Math.abs(s.pos - v);
        if (d < bestY) { bestY = d; dy = s.pos - v; }
      }
    }
  }
  if (bestX < tolerance) lines.push({ axis: "x", pos: Math.round((box.minX + dx) * 1000) / 1000 });
  if (bestY < tolerance) lines.push({ axis: "y", pos: Math.round((box.minY + dy) * 1000) / 1000 });
  // Report the matched target positions rather than the box edges.
  const matched: SnapTarget[] = [];
  if (bestX < tolerance) { const nb = { minX: box.minX + dx, maxX: box.maxX + dx }; matched.push(...targets.filter((s) => s.axis === "x" && [nb.minX, (nb.minX + nb.maxX) / 2, nb.maxX].some((v) => Math.abs(v - s.pos) < 1e-6))); }
  if (bestY < tolerance) { const nb = { minY: box.minY + dy, maxY: box.maxY + dy }; matched.push(...targets.filter((s) => s.axis === "y" && [nb.minY, (nb.minY + nb.maxY) / 2, nb.maxY].some((v) => Math.abs(v - s.pos) < 1e-6))); }
  return { transform: { ...t, x: t.x + dx, y: t.y + dy }, lines: matched };
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
