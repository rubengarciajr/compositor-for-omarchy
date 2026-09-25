/**
 * Photoshop-style cursors per tool. Paint tools return "none": the shell draws a
 * size-accurate brush circle at the pointer instead of an arrow.
 */
import type { ToolId } from "../core/model";

export const PAINT_TOOLS: ToolId[] = ["brush", "blur", "clone-stamp", "spot-healing"];

const svgCursor = (svg: string, hx: number, hy: number, fallback: string) =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;

/** Eyedropper: pipette pointing to the bottom-left, hotspot at the tip. */
export const EYEDROPPER_CURSOR = svgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M3 21l1-4 9-9 3 3-9 9z" fill="#fff" stroke="#000" stroke-width="1.2"/><path d="M14 5l2-2a2.1 2.1 0 013 3l-2 2 1 1-2 2-5-5 2-2z" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>',
  2, 22, "crosshair",
);

/** Magnifier cursors drawn here: the theme-provided zoom-in / zoom-out cursors are missing on many Linux cursor themes. */
const magnifier = (sign: string) => svgCursor(
  `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><circle cx="10.5" cy="10.5" r="7.5" fill="rgba(255,255,255,0.85)" stroke="#000" stroke-width="1.6"/><path d="M16 16l7 7" stroke="#000" stroke-width="3" stroke-linecap="round"/><path d="M16 16l7 7" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>${sign}</svg>`,
  10, 10, "crosshair",
);
export const ZOOM_IN_CURSOR = magnifier('<path d="M7 10.5h7M10.5 7v7" stroke="#000" stroke-width="1.8" stroke-linecap="round"/>');
export const ZOOM_OUT_CURSOR = magnifier('<path d="M7 10.5h7" stroke="#000" stroke-width="1.8" stroke-linecap="round"/>');

/** Small "+" / "−" badge at the bottom-right of a cursor, as Photoshop shows for add / subtract. */
const badge = (sign: "+" | "-" | "") => sign === "" ? "" :
  `<circle cx="20" cy="20" r="4.5" fill="#fff" stroke="#000" stroke-width="1"/>` +
  (sign === "+" ? '<path d="M17.5 20h5M20 17.5v5" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>' : '<path d="M17.5 20h5" stroke="#000" stroke-width="1.4" stroke-linecap="round"/>');

/** Magic wand: stick from bottom-left to the sparkle at the tip (hotspot). */
const wand = (sign: "+" | "-" | "") => svgCursor(
  `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M4 22 15 11" stroke="#000" stroke-width="3.4" stroke-linecap="round"/><path d="M4 22 15 11" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><path d="M18 2v4M18 10v4M12 8h4M20 8h4M14.5 4.5l2 2M19.5 9.5l2 2M21.5 4.5l-2 2M16.5 9.5l-2 2" stroke="#000" stroke-width="2.6" stroke-linecap="round"/><path d="M18 2v4M18 10v4M12 8h4M20 8h4M14.5 4.5l2 2M19.5 9.5l2 2M21.5 4.5l-2 2M16.5 9.5l-2 2" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/>${badge(sign)}</svg>`,
  18, 8, "crosshair",
);
export const WAND_CURSOR = wand("");
export const WAND_ADD_CURSOR = wand("+");
export const WAND_SUBTRACT_CURSOR = wand("-");

/** Crosshair with an add / subtract badge for Marquee and Lasso while Shift / Alt is held. */
const crosshair = (sign: "+" | "-") => svgCursor(
  `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M11 2v18M2 11h18" stroke="#fff" stroke-width="3"/><path d="M11 2v18M2 11h18" stroke="#000" stroke-width="1.2"/>${badge(sign)}</svg>`,
  11, 11, "crosshair",
);
export const SELECT_ADD_CURSOR = crosshair("+");
export const SELECT_SUBTRACT_CURSOR = crosshair("-");

export interface CursorContext { tool: ToolId; shift: boolean; alt: boolean; dragging: boolean; space?: boolean }

export function cursorForTool({ tool, shift, alt, dragging, space }: CursorContext): string {
  if (space) return dragging ? "grabbing" : "grab"; // Space: temporary Hand with any tool
  switch (tool) {
    case "idle": return "default";
    case "move": return "move"; // refined per hit (handles / rotate) by the caller
    case "hand": return dragging ? "grabbing" : "grab";
    case "zoom": return shift || alt ? ZOOM_OUT_CURSOR : ZOOM_IN_CURSOR;
    case "type": return "text";
    case "eyedropper": return EYEDROPPER_CURSOR;
    case "clone-stamp": return alt ? "crosshair" : "none"; // Alt = pick the source point
    case "brush": case "spot-healing": return alt ? EYEDROPPER_CURSOR : "none"; // Alt = sample a colour
    case "blur": return "none";
    case "wand": return shift ? WAND_ADD_CURSOR : alt ? WAND_SUBTRACT_CURSOR : WAND_CURSOR;
    case "marquee": case "lasso": return shift ? SELECT_ADD_CURSOR : alt ? SELECT_SUBTRACT_CURSOR : "crosshair";
    case "crop": case "gradient": case "shape": return "crosshair";
  }
}
