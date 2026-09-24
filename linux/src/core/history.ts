import type { DocumentState, Layer } from "./model";
import { cloneCanvas } from "./pixels";

export interface HistoryEntry {
  label: string;
  layers: Layer[];
  selection: DocumentState["selection"];
  width: number;
  height: number;
}

/**
 * History entries share bitmaps with the live document instead of copying every layer on
 * every step (copy-on-write). A canvas that any entry holds is *frozen*; code that wants to
 * draw into a layer asks for `writableLayer(layer)`, which swaps in a private copy first.
 * Memory and commit time are therefore proportional to what changed, not to the document.
 */
const frozen = new WeakSet<HTMLCanvasElement>();

function freeze<T extends HTMLCanvasElement | null | undefined>(c: T): T {
  if (c) frozen.add(c);
  return c;
}

/** True when a history entry holds this bitmap, so it must not be drawn into. */
export function isFrozen(c: HTMLCanvasElement | null | undefined): boolean {
  return !!c && frozen.has(c);
}

/** The layer's bitmap, made safe to draw into (copied first if history shares it). */
export function writableLayer(layer: Layer): HTMLCanvasElement | null {
  if (layer.canvas && frozen.has(layer.canvas)) layer.canvas = cloneCanvas(layer.canvas);
  return layer.canvas;
}

/** The layer mask's bitmap, made safe to draw into. */
export function writableMask(layer: Layer): HTMLCanvasElement | null {
  if (!layer.mask) return null;
  if (frozen.has(layer.mask.canvas)) layer.mask.canvas = cloneCanvas(layer.mask.canvas);
  return layer.mask.canvas;
}

/** A layer record that shares (and freezes) the bitmaps but owns its scalar fields. */
function shareLayer(layer: Layer): Layer {
  return {
    ...layer,
    canvas: freeze(layer.canvas),
    transform: { ...layer.transform },
    mask: layer.mask ? { ...layer.mask, canvas: freeze(layer.mask.canvas) } : null,
    effects: layer.effects.map((e) => ({ ...e })),
    text: layer.text ? { ...layer.text } : undefined,
    shape: layer.shape ? { ...layer.shape } : undefined,
    adjustment: layer.adjustment ? { ...layer.adjustment } : undefined,
  };
}

function shareSelection(sel: DocumentState["selection"]): DocumentState["selection"] {
  return sel ? { ...sel, path: { ...sel.path }, mask: freeze(sel.mask) } : null;
}

export function snapshot(doc: DocumentState, label: string): HistoryEntry {
  return {
    label,
    layers: doc.layers.map(shareLayer),
    selection: shareSelection(doc.selection),
    width: doc.width,
    height: doc.height,
  };
}

export class History {
  private stack: HistoryEntry[] = [];
  private index = -1;
  private limit = 40;

  reset(entry: HistoryEntry): void {
    this.stack = [entry];
    this.index = 0;
  }

  push(entry: HistoryEntry): void {
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(entry);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index < this.stack.length - 1;
  }

  undo(doc: DocumentState): boolean {
    if (!this.canUndo()) return false;
    this.index--;
    this.apply(doc, this.stack[this.index]);
    return true;
  }

  redo(doc: DocumentState): boolean {
    if (!this.canRedo()) return false;
    this.index++;
    this.apply(doc, this.stack[this.index]);
    return true;
  }

  /** Entries in order (oldest first) and the current position; for tests and a future panel. */
  entries(): { stack: readonly HistoryEntry[]; index: number } {
    return { stack: this.stack, index: this.index };
  }

  private apply(doc: DocumentState, entry: HistoryEntry): void {
    // Fresh layer records so later edits never reach into the entry; bitmaps stay shared.
    doc.layers = entry.layers.map(shareLayer);
    doc.selection = shareSelection(entry.selection);
    doc.width = entry.width;
    doc.height = entry.height;
    doc.dirty = true;
  }
}
