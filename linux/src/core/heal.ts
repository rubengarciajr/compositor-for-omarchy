/**
 * Spot Healing, ported from Compositor's HealPixels.c (`spot_heal`).
 *
 * The painted area (the "hole") is rebuilt from its surroundings: a ring of pixels around it
 * is matched against nearby patches of the image (Content-Aware searches far, Proximity Match
 * stays close, Create Texture skips the search and synthesises grain), and a Poisson-style
 * membrane blends the chosen patch seamlessly into the ring.
 */
import type { HealMode } from "./model";

const HOLE = 1, RING = 2, OUTSIDE = 0;

function hash32(x: number): number {
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}
const unit = (k: number) => (hash32(k) >>> 8) / 16777216;

/** Gauss–Seidel / SOR solve of the Laplace equation inside HOLE pixels, RING pixels fixed. */
function solve(value: Float32Array, role: Uint8Array, w: number, h: number, depth: number): void {
  const iterations = depth === 0 && !(w > 32 && h > 32) ? 300 : 40;
  if (w > 32 && h > 32 && depth < 16) {
    // Multigrid: solve a half-size problem first, then refine.
    const hw = w >> 1, hh = h >> 1;
    const cv = new Float32Array(hw * hh * 4), cr = new Uint8Array(hw * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
      let hole = 0, sum = [0, 0, 0, 0], n = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = (y * 2 + dy) * w + (x * 2 + dx);
        if (role[i] === HOLE) hole++;
        if (role[i] !== OUTSIDE) { n++; for (let c = 0; c < 4; c++) sum[c] += value[i * 4 + c]; }
      }
      const o = y * hw + x;
      cr[o] = hole > 0 ? HOLE : n > 0 ? RING : OUTSIDE;
      if (n > 0) for (let c = 0; c < 4; c++) cv[o * 4 + c] = sum[c] / n;
    }
    solve(cv, cr, hw, hh, depth + 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (role[i] !== HOLE) continue;
      const o = Math.min(hh - 1, y >> 1) * hw + Math.min(hw - 1, x >> 1);
      if (cr[o] === HOLE) for (let c = 0; c < 4; c++) value[i * 4 + c] = cv[o * 4 + c];
    }
  }
  const omega = 1.8;
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (role[i] !== HOLE) continue;
      let n = 0;
      const acc = [0, 0, 0, 0];
      const take = (j: number) => { if (role[j] !== OUTSIDE) { n++; for (let c = 0; c < 4; c++) acc[c] += value[j * 4 + c]; } };
      if (x > 0) take(i - 1);
      if (x < w - 1) take(i + 1);
      if (y > 0) take(i - w);
      if (y < h - 1) take(i + w);
      if (!n) continue;
      for (let c = 0; c < 4; c++) {
        const cur = value[i * 4 + c];
        value[i * 4 + c] = cur + omega * (acc[c] / n - cur);
      }
    }
  }
}

/**
 * Heal `rgba` (straight alpha, `w`×`h`) where `coverage` (0…255) is set. `opacity` scales the
 * result toward the original. Returns false when nothing was covered.
 */
export function spotHeal(rgba: Uint8ClampedArray, coverage: Uint8Array, w: number, h: number, opacity: number, mode: HealMode, seed: number): boolean {
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (coverage[y * w + x]) {
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  if (bx1 < 0) return false;
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const size = Math.max(bw, bh);
  const ring = Math.min(16, Math.max(2, Math.floor(size / 8)));
  const wx0 = Math.max(0, bx0 - ring), wy0 = Math.max(0, by0 - ring);
  const wx1 = Math.min(w - 1, bx1 + ring), wy1 = Math.min(h - 1, by1 + ring);
  const ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1;
  const role = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) role[y * ww + x] = coverage[(wy0 + y) * w + (wx0 + x)] ? HOLE : OUTSIDE;
  // RING = outside pixels within Chebyshev distance `ring` of a hole (square dilation).
  const rowHit = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    let last = -1e9;
    for (let x = 0; x < ww; x++) { if (role[y * ww + x] === HOLE) last = x; if (x - last <= ring) rowHit[y * ww + x] = 1; }
    last = 1e9;
    for (let x = ww - 1; x >= 0; x--) { if (role[y * ww + x] === HOLE) last = x; if (last - x <= ring) rowHit[y * ww + x] = 1; }
  }
  let ringCount = 0;
  for (let x = 0; x < ww; x++) {
    let last = -1e9;
    for (let y = 0; y < wh; y++) { if (rowHit[y * ww + x]) last = y; if (y - last <= ring && role[y * ww + x] === OUTSIDE) { role[y * ww + x] = RING; } }
    last = 1e9;
    for (let y = wh - 1; y >= 0; y--) { if (rowHit[y * ww + x]) last = y; if (last - y <= ring && role[y * ww + x] === OUTSIDE) { role[y * ww + x] = RING; } }
  }
  for (let i = 0; i < role.length; i++) if (role[i] === RING) ringCount++;
  if (!ringCount) return false;

  const px = (x: number, y: number, c: number) => rgba[((wy0 + y) * w + (wx0 + x)) * 4 + c];
  // Source patch search: mean squared difference over the ring, skipped for Create Texture.
  let best: { dx: number; dy: number } | null = null;
  if (mode !== "create-texture") {
    const score = (dx: number, dy: number): number => {
      if (Math.abs(dx) < ww && Math.abs(dy) < wh) return Infinity; // overlaps the spot
      if (wx0 + dx < 0 || wy0 + dy < 0 || wx1 + dx >= w || wy1 + dy >= h) return Infinity;
      let sum = 0, n = 0;
      for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
        if (role[y * ww + x] !== RING) continue;
        for (let c = 0; c < 4; c++) { const d = px(x, y, c) - px(x + dx, y + dy, c); sum += d * d; }
        n++;
      }
      return n ? sum / n : Infinity;
    };
    const factors = [1.05, 1.35, 1.75, 2.25, 2.8];
    const count = mode === "proximity-match" ? 2 : 5;
    let bestScore = Infinity;
    for (let f = 0; f < count; f++) for (let a = 0; a < 24; a++) {
      const angle = (a * Math.PI) / 12;
      const dx = Math.round(Math.cos(angle) * factors[f] * ww), dy = Math.round(Math.sin(angle) * factors[f] * wh);
      let s = score(dx, dy);
      if (!isFinite(s)) continue;
      s *= mode === "proximity-match" ? 1 + 0.6 * f : 1 + 0.1 * f; // nearer patches win ties
      if (s < bestScore) { bestScore = s; best = { dx, dy }; }
    }
    if (best) {
      const b = best;
      for (let ddy = -3; ddy <= 3; ddy++) for (let ddx = -3; ddx <= 3; ddx++) {
        const s = score(b.dx + ddx, b.dy + ddy);
        if (s < bestScore) { bestScore = s; best = { dx: b.dx + ddx, dy: b.dy + ddy }; }
      }
    }
  }

  // Membrane: ring values are original − source (or original), holes start at the mean.
  const value = new Float32Array(ww * wh * 4);
  const mean = [0, 0, 0, 0];
  for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
    const i = y * ww + x;
    if (role[i] !== RING) continue;
    for (let c = 0; c < 4; c++) {
      const v = px(x, y, c) - (best ? px(x + best.dx, y + best.dy, c) : 0);
      value[i * 4 + c] = v;
      mean[c] += v;
    }
  }
  for (let c = 0; c < 4; c++) mean[c] /= ringCount;
  const detail = [0, 0, 0, 0];
  if (!best) {
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
      if (role[y * ww + x] !== RING) continue;
      for (let c = 0; c < 4; c++) {
        let n = 0, sum = 0;
        if (x > 0) { sum += px(x - 1, y, c); n++; }
        if (x < ww - 1) { sum += px(x + 1, y, c); n++; }
        if (y > 0) { sum += px(x, y - 1, c); n++; }
        if (y < wh - 1) { sum += px(x, y + 1, c); n++; }
        const d = px(x, y, c) - sum / n;
        detail[c] += d * d;
      }
    }
    for (let c = 0; c < 4; c++) detail[c] = Math.sqrt(detail[c] / ringCount) * 0.9;
  }
  for (let i = 0; i < ww * wh; i++) if (role[i] === HOLE) for (let c = 0; c < 4; c++) value[i * 4 + c] = mean[c];
  solve(value, role, ww, wh, 0);

  // Composite the healed pixels back through the coverage.
  for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
    const i = y * ww + x;
    if (role[i] !== HOLE) continue;
    const gx = wx0 + x, gy = wy0 + y;
    const amount = (coverage[gy * w + gx] / 255) * opacity;
    let grain = 0;
    if (!best) {
      const k = (seed ^ hash32(gy * w + gx)) >>> 0;
      const u1 = Math.max(1e-6, unit(k)), u2 = unit(k + 1);
      grain = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    const o = (gy * w + gx) * 4;
    const out = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      const healed = (best ? px(x + best.dx, y + best.dy, c) : 0) + value[i * 4 + c] + (c < 3 ? grain * detail[c] : 0);
      out[c] = rgba[o + c] + (healed - rgba[o + c]) * amount;
    }
    const alpha = Math.min(255, Math.max(0, out[3]));
    rgba[o + 3] = alpha;
    for (let c = 0; c < 3; c++) rgba[o + c] = Math.min(255, Math.max(0, out[c]));
  }
  return true;
}
