/**
 * Marching ants: the outline of the selection mask as unit edge segments (document pixels),
 * computed once per mask and drawn as an animated black/white dashed line.
 */
const outlines = new WeakMap<HTMLCanvasElement, Float32Array>();

/** Edge segments [x1, y1, x2, y2, …] between selected and unselected pixels. */
export function selectionOutline(mask: HTMLCanvasElement): Float32Array {
  const cached = outlines.get(mask);
  if (cached) return cached;
  const w = mask.width, h = mask.height;
  const d = mask.getContext("2d")!.getImageData(0, 0, w, h).data;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 127;
  const seg: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) seg.push(x, y, x + 1, y);
      if (!on(x, y + 1)) seg.push(x, y + 1, x + 1, y + 1);
      if (!on(x - 1, y)) seg.push(x, y, x, y + 1);
      if (!on(x + 1, y)) seg.push(x + 1, y, x + 1, y + 1);
    }
  }
  const out = Float32Array.from(seg);
  outlines.set(mask, out);
  return out;
}

/** Draw the ants in document space; `phase` advances the dashes (any growing number). */
export function drawAnts(ctx: CanvasRenderingContext2D, mask: HTMLCanvasElement, zoom: number, phase: number): void {
  const seg = selectionOutline(mask);
  if (!seg.length) return;
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < seg.length; i += 4) {
    ctx.moveTo(seg[i], seg[i + 1]);
    ctx.lineTo(seg[i + 2], seg[i + 3]);
  }
  ctx.lineWidth = 1 / zoom;
  ctx.strokeStyle = "#000";
  ctx.stroke();
  ctx.strokeStyle = "#fff";
  ctx.setLineDash([4 / zoom, 4 / zoom]);
  ctx.lineDashOffset = (phase % 8) / zoom;
  ctx.stroke();
  ctx.restore();
}
