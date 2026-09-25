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

const loops = new WeakMap<HTMLCanvasElement, Float32Array[]>();

/**
 * The outline as closed polylines (each [x0, y0, x1, y1, …]) so a dash pattern runs along the
 * whole loop; a dash restarts on every subpath, so unit segments alone could never march.
 */
export function selectionLoops(mask: HTMLCanvasElement): Float32Array[] {
  const cached = loops.get(mask);
  if (cached) return cached;
  const seg = selectionOutline(mask);
  const n = seg.length / 4;
  const stride = mask.width + 2;
  const key = (x: number, y: number) => y * stride + x;
  // Adjacency: vertex → segment indices (every vertex has 2, or 4 where corners touch).
  const adj = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const a = key(seg[i * 4], seg[i * 4 + 1]), b = key(seg[i * 4 + 2], seg[i * 4 + 3]);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(i);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(i);
  }
  const used = new Uint8Array(n);
  const out: Float32Array[] = [];
  for (let start = 0; start < n; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const pts: number[] = [seg[start * 4], seg[start * 4 + 1], seg[start * 4 + 2], seg[start * 4 + 3]];
    let cx = seg[start * 4 + 2], cy = seg[start * 4 + 3];
    const first = key(seg[start * 4], seg[start * 4 + 1]);
    for (;;) {
      const here = key(cx, cy);
      if (here === first) break;
      const next = (adj.get(here) ?? []).find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = 1;
      const ax = seg[next * 4], ay = seg[next * 4 + 1], bx = seg[next * 4 + 2], by = seg[next * 4 + 3];
      if (ax === cx && ay === cy) { cx = bx; cy = by; } else { cx = ax; cy = ay; }
      pts.push(cx, cy);
    }
    out.push(Float32Array.from(pts));
  }
  loops.set(mask, out);
  return out;
}

/** Draw the ants in document space; `phase` advances the dashes one pixel per unit. */
export function drawAnts(ctx: CanvasRenderingContext2D, mask: HTMLCanvasElement, zoom: number, phase: number): void {
  const paths = selectionLoops(mask);
  if (!paths.length) return;
  ctx.save();
  ctx.beginPath();
  for (const p of paths) {
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
  }
  // Compositor's ants: a solid white line under a black dash of 4 on, 4 off, stepping one pixel per tick.
  ctx.lineWidth = 1 / zoom;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.strokeStyle = "#000";
  ctx.setLineDash([4 / zoom, 4 / zoom]);
  ctx.lineDashOffset = -((Math.floor(phase) % 8) / zoom);
  ctx.stroke();
  ctx.restore();
}
