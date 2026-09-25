import type {
  BrushMode,
  DocumentState,
  Layer,
  LayerEffect,
  SessionState,
  TextLayerData,
  ToolId,
  Selection,
  SelectionPath,
  ShapeLayerData,
} from "./model";
import {
  createBlankLayer,
  createDocument,
  createLayer,
  createRasterLayer,
  createCanvas,
  defaultTransform,
  descendants,
  layerTree,
  parentOf,
  uid,
} from "./model";
import { History, snapshot, writableLayer, writableMask } from "./history";

/** The crop box as an (unrotated) transform, so the Move tool's handle maths applies to it. */
function cropTransform(r: { x: number; y: number; w: number; h: number }): Transform {
  return { x: r.x, y: r.y, width: r.w, height: r.h, rotation: 0, flipH: false, flipV: false };
}

/** Photoshop's selection modifiers: Option subtracts, Shift adds, otherwise the header's Mode. */
function selectionMode(e: { shiftKey?: boolean; altKey?: boolean }, choice: Selection["mode"] = "replace"): Selection["mode"] {
  if (e.altKey) return "subtract";
  if (e.shiftKey) return "add";
  return choice;
}
import { cursorFor, fromLocal, hitTest, rotateByPointer, scaleByHandle } from "./transform";
import { PROJECT_EXTENSION, PROJECT_MIME, buildProject, isProjectFile, parseProject, parseProjectFrom, serializeProject } from "../io/project";
import { folderSource, urlFolderSource, zipFileSource } from "../io/package";
import type { ProjectSource } from "../io/package";
import type { HandleSpec } from "./transform";
import type { Transform } from "./model";
import {
  applyAdjustment,
  cloneCanvas,
  drawShapeLayer,
  drawTextLayer,
  floodSelect,
  gaussianBlur,
  invertImage,
  imageDataOf,
  colorSelect,
  thresholdMask,
  translateMask,
  maskBounds,
  canvasFromImageData,
  parseHex,
} from "./pixels";
import { BrushStroke, WarpStroke, layerInDocument, resizeLayerBitmap, docToLayer } from "./stroke";
import { selectionOutline } from "../render/ants";
import type { StrokeMode, StrokeOptions, StrokeTip } from "./stroke";
import { spotHeal } from "./heal";
import { flattenDocument, flattenDocumentCopy, fitZoom, screenToDoc, ensureLayerBitmap, setEditingLayer, beginStroke, endStroke } from "../render/compositor";
import { toLocal } from "./transform";
import { enterDocSpace } from "./stroke";
import { fitTextLayer, textNaturalSize, textScale } from "./pixels";
import { loadGradientSettings, paintGradient, saveGradientSettings } from "./gradient";
import type { GradientSettings } from "./gradient";

export class App {
  docs: DocumentState[] = [];
  activeDocId: string | null = null;
  session: SessionState;
  history = new History();
  onChange: () => void = () => {};
  /**
   * A watched package changed on disk while the document has unsaved edits: ask whether to
   * revert to the on-disk version or keep the edits (the shell shows a dialog).
   */
  onExternalChange: (doc: DocumentState) => Promise<"revert" | "keep"> = async () => "revert";
  /** Canvas-only refresh (no panel rebuild) — used while typing or dragging a live control. */
  onDraw: () => void = () => {};
  /** Brush stroke in progress (Brush, Spot Healing, Clone Stamp, Smear · Blur). */
  private stroke: BrushStroke | null = null;
  /** Liquify / Smudge stroke in progress. */
  private warp: WarpStroke | null = null;
  /** Clone Stamp: Option-clicked source, and the source→pointer offset of the current alignment. */
  cloneSource: { x: number; y: number } | null = null;
  private cloneOffset: { x: number; y: number } | null = null;
  /** Where the brush string is anchored (Smoothing) and where the pointer is. */
  private brushAnchor: { x: number; y: number } | null = null;
  private brushPointer: { x: number; y: number } | null = null;
  /** Shift while painting locks the stroke to an axis from where Shift went down. */
  private brushAxisAnchor: { x: number; y: number } | null = null;
  private brushAxisHorizontal: boolean | null = null;
  private brushLastPixel: { x: number; y: number } | null = null;
  /** Last accepted paint sample: Shift-click continues from here with a straight line. */
  private lastBrushPoint: { point: { x: number; y: number }; layerId: string; mask: boolean } | null = null;
  /** Brush tips parked per family when switching tools (0 brush/heal, 1 clone, 2 smear). */
  private parkedTips: Record<number, { size: number; hardness: number; opacity: number }> = { 1: { size: 40, hardness: 0, opacity: 1 }, 2: { size: 40, hardness: 0, opacity: 1 } };
  private pendingOpacityDigit: { digit: number; time: number } | null = null;
  /** Right-drag over the canvas resizes the tip (Shift: hardness). */
  private tipDrag: { x: number; size: number; hardness: number; hardnessShown: boolean; moved: boolean } | null = null;
  /** Message from the last failed paint action (e.g. no clone source), for the shell to show. */
  brushError: string | null = null;
  private marqueeStart: { x: number; y: number } | null = null;
  /** Marquee: Shift already held at the press chose Add; only a fresh Shift squares the box. */
  private marqueeConstrainArmed = true;
  private marqueeDragPixel: { x: number; y: number } | null = null;
  /** Dragging the selection outline (New mode, inside the selection). */
  private selectionMove: { origin: HTMLCanvasElement; outline: HTMLCanvasElement | null; start: { x: number; y: number }; moved: boolean } | null = null;
  /** Dragging the selected pixels (⌘-drag inside the selection) on a temporary floating layer. */
  private pixelMove: { sourceId: string; floatingId: string; sourceBefore: HTMLCanvasElement; originMask: HTMLCanvasElement; originOutline: HTMLCanvasElement | null; base: { x: number; y: number }; start: { x: number; y: number }; offset: { x: number; y: number }; duplicate: boolean } | null = null;
  private lassoPoints: [number, number][] = [];
  private dragMode: "none" | "pan" | "move" | "crop" | "crop-handle" | "crop-move" | "marquee" | "brush" | "tip" | "scale" | "rotate" | "select-move" | "pixel-move" = "none";
  private moveStart: { x: number; y: number } | null = null;
  private transformStart: Transform | null = null;
  private transformHandle: HandleSpec | null = null;
  private pendingFit = true;

  /** How often watched packages are checked for outside changes (ms). */
  static WATCH_INTERVAL = 400;
  private checking = false;

  constructor() {
    setInterval(() => void this.checkExternalChanges(), App.WATCH_INTERVAL);
    this.session = {
      tool: "move",
      brush: { size: 40, hardness: 1, opacity: 1, smoothing: 0 },
      brushMode: "paint",
      smearMode: "liquify",
      healMode: "content-aware",
      clone: { aligned: true, sampleAll: false },
      maskSelected: false,
      maskPaintWhite: false,
      foreground: "#000000",
      background: "#ffffff",
      marqueeShape: "rect",
      lassoMode: "free",
      wandContiguous: true,
      selectionModeChoice: "replace",
      heldSelectionMode: null,
      selectionAntialiased: true,
      selectionExpandAmount: 1,
      selectionContractAmount: 1,
      selectionFeatherAmount: 2,
      wandSampleSize: 0,
      wandSampleAll: false,
      wandTolerance: 32,
      shapeKind: "rect",
      activeLayerId: null,
      selectedLayerIds: [],
      zoom: 1,
      panX: 0,
      panY: 0,
      showRulers: true,
      showGrid: false,
      showPixelGrid: true,
      snap: { guides: true, grid: false, layers: true, bounds: true },
      text: {
        text: "Type here",
        fontFamily: "Noto Sans",
        fontSize: 48,
        color: "#c0caf5",
        align: "left",
        lineHeight: 1.25,
        letterSpacing: 0,
        weight: 500,
      },
      gradient: loadGradientSettings(),
      cropRect: null,
      cropRatio: null,
      dragLine: null,
      hover: null,
      textEdit: null,
      lassoPath: null,
    };
    this.newDocument(1280, 800, "Untitled");
  }

  get doc(): DocumentState | null {
    return this.docs.find((d) => d.id === this.activeDocId) ?? null;
  }

  get activeLayer(): Layer | null {
    const doc = this.doc;
    if (!doc) return null;
    return doc.layers.find((l) => l.id === this.session.activeLayerId) ?? null;
  }

  /** Pixels or structure changed: invalidate the render cache and redraw. */
  emit(): void {
    const doc = this.doc;
    if (doc) doc.version++;
    endStroke(); // any structural change invalidates the incremental stroke composite
    this.onChange();
  }

  /** Space is held: any tool pans, like Photoshop's temporary Hand. */
  tempHand = false;
  private moveOrigin: { x: number; y: number } | null = null;
  private moveApplied = { x: 0, y: 0 };
  private downMode: Selection["mode"] = "replace";

  /** Only an overlay changed (drag outlines): repaint the canvas from the cached composite. */
  overlay(): void {
    this.onDraw();
  }

  /** Only the viewport, tool or colours changed: redraw without re-flattening. */
  emitView(): void {
    this.onChange();
  }

  /** Pixels changed but the panels must stay put (a control is being edited). */
  redraw(): void {
    const doc = this.doc;
    if (doc) doc.version++;
    this.onDraw();
  }

  /** Live-edit the active text layer (and the defaults for the next one). */
  setText(patch: Partial<TextLayerData>): void {
    Object.assign(this.session.text, patch);
    const layer = this.activeLayer;
    if (layer?.kind === "text" && layer.text) {
      Object.assign(layer.text, patch);
      if (this.session.textEdit?.layerId === layer.id) { writableLayer(layer); fitTextLayer(layer); }
    }
    this.redraw();
  }

  commit(label: string): void {
    const doc = this.doc;
    if (!doc) return;
    doc.dirty = true;
    this.history.push(snapshot(doc, label));
    this.emit();
  }

  newDocument(width: number, height: number, name = "Untitled"): void {
    const doc = createDocument(width, height, name);
    const bg = createRasterLayer("Background", width, height, 0, 0, "#ffffff");
    doc.layers.push(bg);
    this.docs.push(doc);
    this.activeDocId = doc.id;
    this.session.activeLayerId = bg.id;
    this.session.selectedLayerIds = [bg.id];
    this.session.zoom = 1;
    this.session.panX = 0;
    this.session.panY = 0;
    this.history.reset(snapshot(doc, "New document"));
    this.pendingFit = true;
    this.emit();
  }

  openImageFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    return this.openImageUrl(url, file.name).finally(() => URL.revokeObjectURL(url));
  }

  /** Paste an image (from the system clipboard or a drop) as a new layer, centred on the canvas. */
  /** Add an image file as a new layer fitted inside the canvas (Paste, drop, Layer › Add Image…). */
  pasteImageFile(file: File | Blob, name = "Pasted", label = "Paste"): Promise<void> {
    const doc = this.doc;
    if (!doc) return this.openImageFile(file instanceof File ? file : new File([file], `${name}.png`));
    const url = URL.createObjectURL(file);
    return new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
        if (file.type === "image/svg+xml") {
          // Vector: rasterise sharp at a size that fits the canvas (Compositor 1.2.10).
          const k = Math.min(doc.width / w, doc.height / h);
          w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
        }
        const canvas = createCanvas(w, h);
        canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
        // Never overgrow the canvas: fit inside it (the bitmap keeps its full resolution; only the
        // transform shrinks, so scaling back up later loses nothing).
        const k = Math.min(1, doc.width / w, doc.height / h);
        const tw = Math.round(w * k), th = Math.round(h * k);
        const layer = createLayer({
          name,
          kind: "raster",
          canvas,
          transform: defaultTransform(tw, th, Math.round((doc.width - tw) / 2), Math.round((doc.height - th) / 2)),
        });
        this.trimLayer(layer); // PNGs often carry transparent padding; keep the pixels, drop the empty box
        const active = this.activeLayer;
        const idx = active ? doc.layers.indexOf(active) : doc.layers.length - 1;
        doc.layers.splice(idx + 1, 0, layer);
        layer.parentId = active?.kind === "group" ? active.id : (active?.parentId ?? null);
        this.session.activeLayerId = layer.id;
        this.session.selectedLayerIds = [layer.id];
        this.setTool("move");
        this.commit(label);
        resolve();
      };
      img.onerror = () => reject(new Error("Clipboard image could not be decoded"));
      img.src = url;
    }).finally(() => URL.revokeObjectURL(url));
  }

  /**
   * Pixels to copy: the active layer (or everything, `merged`), limited to the
   * selection when there is one. Returns null when there is nothing to copy.
   */
  copyPixels(merged = false): HTMLCanvasElement | null {
    return this.cutout(merged)?.canvas ?? null;
  }

  /** The active layer's (or merged) pixels inside the selection, cropped to its bounds, in document space. */
  private cutout(merged: boolean): { canvas: HTMLCanvasElement; bounds: { x: number; y: number; w: number; h: number } } | null {
    const doc = this.doc;
    if (!doc) return null;
    let src: HTMLCanvasElement;
    if (merged || !this.activeLayer || this.activeLayer.kind === "group" || this.activeLayer.kind === "adjustment") {
      src = flattenDocumentCopy(doc);
    } else {
      // The layer's own pixels placed by its transform: full opacity, Normal, no effects or mask.
      const temp = createDocument(doc.width, doc.height, "copy");
      temp.layers = [{ ...this.activeLayer, parentId: null, clipping: false, opacity: 1, blendMode: "normal", effects: [], mask: null }];
      src = flattenDocumentCopy(temp);
    }
    let bounds = { x: 0, y: 0, w: doc.width, h: doc.height };
    if (doc.selection?.mask) {
      const b = maskBounds(doc.selection.mask);
      if (!b) return null;
      bounds = b;
      const ctx = src.getContext("2d")!;
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(doc.selection.mask, 0, 0);
    }
    const canvas = createCanvas(bounds.w, bounds.h);
    canvas.getContext("2d")!.drawImage(src, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
    return { canvas, bounds };
  }

  /** Copy to the system clipboard as PNG (so it can be pasted here, in GIMP, a browser, …). */
  async copyToClipboard(merged = false): Promise<boolean> {
    const canvas = this.copyPixels(merged);
    if (!canvas) return false;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) return false;
    // No selection: the layers themselves are copied too, so Ctrl+V here pastes editable layers
    // while other apps still get the PNG. The PNG's size tells the two apart on paste.
    if (!merged && !this.doc?.selection?.mask) this.copyLayers(blob.size);
    else this.layerClipboard = null;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  }

  /** True when a pasted image is the PNG that Ctrl+C wrote for the layers in the layer clipboard. */
  isLayerClipboardImage(blob: Blob): boolean {
    return !!this.layerClipboard && this.layerClipboard.pngSize > 0 && blob.size === this.layerClipboard.pngSize;
  }

  /** Paste from the system clipboard via the async API (menu item); Ctrl+V uses the paste event instead. */
  async pasteFromClipboard(): Promise<boolean> {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) {
        const blob = await item.getType(type);
        if (this.isLayerClipboardImage(blob)) return this.pasteLayers();
        await this.pasteImageFile(blob);
        return true;
      }
    }
    return false;
  }

  /* ── Project files (.comp) ───────────────────────────────────────── */

  /** Open a .comp project (a ZIP of manifest.json + images/, see docs/project-format.md). */
  async openProject(source: Blob | ArrayBuffer, fileName: string, handle?: FileSystemFileHandle): Promise<void> {
    const buffer = source instanceof Blob ? await source.arrayBuffer() : source;
    const base = fileName.replace(/\.[^.]+$/, "") || "Project";
    const { doc, activeLayerId } = await parseProject(buffer, base);
    doc.fileName = fileName;
    doc.fileHandle = handle;
    if (handle) { doc.source = zipFileSource(handle); doc.diskState = await doc.source.fingerprint(); }
    this.docs.push(doc);
    this.activeDocId = doc.id;
    this.session.activeLayerId = activeLayerId;
    this.session.selectedLayerIds = activeLayerId ? [activeLayerId] : [];
    this.history.reset(snapshot(doc, "Open project"));
    this.pendingFit = true;
    this.emit();
  }

  /**
   * Open a project from a package source (a `.comp` folder handle, a folder URL, or a ZIP
   * handle) and keep watching it: when a script or AI agent rewrites the package, the
   * canvas reloads (Compositor 1.3 "Watch AI design").
   */
  async openProjectSource(source: ProjectSource): Promise<void> {
    const base = source.label.replace(/\.[^.]+$/, "") || "Project";
    const { doc, activeLayerId } = await parseProjectFrom((p) => source.read(p), base);
    doc.fileName = source.label;
    doc.source = source;
    doc.diskState = await source.fingerprint();
    this.docs.push(doc);
    this.activeDocId = doc.id;
    this.session.activeLayerId = activeLayerId;
    this.session.selectedLayerIds = activeLayerId ? [activeLayerId] : [];
    this.history.reset(snapshot(doc, "Open project"));
    this.pendingFit = true;
    this.emit();
  }

  /** Open a `.comp` package folder chosen with the directory picker (read and write). */
  async openFolder(dir: FileSystemDirectoryHandle): Promise<void> {
    return this.openProjectSource(folderSource(dir));
  }

  /** Poll every watched document's package; reload the ones that changed on disk. */
  async checkExternalChanges(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const doc of [...this.docs]) {
        if (!doc.source || doc.diskState === undefined) continue;
        const now = await doc.source.fingerprint();
        if (now === null || now === doc.diskState) continue;
        if (doc.dirty && (await this.onExternalChange(doc)) === "keep") { doc.diskState = now; continue; }
        await this.reloadFromDisk(doc, now);
      }
    } finally {
      this.checking = false;
    }
  }

  /** Replace a document's contents with the package on disk, keeping zoom, scroll and selection. */
  private async reloadFromDisk(doc: DocumentState, state: string): Promise<void> {
    const source = doc.source!;
    let parsed: { doc: DocumentState; activeLayerId: string | null };
    try {
      parsed = await parseProjectFrom((p) => source.read(p), doc.name);
    } catch (err) {
      // A half-written or invalid package: ignore it until the next change, like the Mac app.
      console.warn("Package on disk could not be read:", err);
      doc.diskState = state;
      return;
    }
    if (this.session.textEdit?.layerId && doc === this.doc) this.endTextEdit(false);
    const sameSize = parsed.doc.width === doc.width && parsed.doc.height === doc.height;
    doc.layers = parsed.doc.layers;
    doc.guides = parsed.doc.guides;
    doc.width = parsed.doc.width;
    doc.height = parsed.doc.height;
    doc.resolution = parsed.doc.resolution;
    if (!sameSize) doc.selection = null;
    doc.dirty = false;
    doc.diskState = state;
    if (doc === this.doc) {
      const keep = this.session.activeLayerId && doc.layers.some((l) => l.id === this.session.activeLayerId) ? this.session.activeLayerId : parsed.activeLayerId;
      this.session.activeLayerId = keep;
      this.session.selectedLayerIds = this.session.selectedLayerIds.filter((id) => doc.layers.some((l) => l.id === id));
      if (!this.session.selectedLayerIds.length && keep) this.session.selectedLayerIds = [keep];
    }
    this.history.reset(snapshot(doc, "Reloaded from disk"));
    this.emit();
  }

  /** Save the active document into a package folder chosen with the directory picker. */
  async saveProjectToFolder(): Promise<boolean> {
    const doc = this.doc;
    const picker = (window as unknown as { showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!doc || !picker) return false;
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await picker.call(window, { mode: "readwrite", id: "compositor-package" });
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return false;
      throw err;
    }
    const source = folderSource(dir);
    await source.write!(await buildProject(doc, this.session.activeLayerId));
    doc.source = source;
    doc.fileHandle = undefined;
    doc.fileName = dir.name;
    if (!doc.name || doc.name === "Untitled") doc.name = dir.name.replace(/\.[^.]+$/, "");
    doc.diskState = await source.fingerprint();
    doc.dirty = false;
    this.emitView();
    return true;
  }

  /** Open any file the app understands: a .comp project or an image (as a new document). */
  openFile(file: File, handle?: FileSystemFileHandle): Promise<void> {
    return isProjectFile(file.name) ? this.openProject(file, file.name, handle) : this.openImageFile(file);
  }

  /** Bytes of the active document as a .comp file. */
  async projectBlob(): Promise<Blob | null> {
    const doc = this.doc;
    if (!doc) return null;
    return serializeProject(doc, this.session.activeLayerId);
  }

  /**
   * Save the active document. Uses the file it came from unless `saveAs`; otherwise a
   * native save dialog (File System Access API), or a download where that is unavailable.
   */
  async saveProject(saveAs = false): Promise<boolean> {
    const doc = this.doc;
    if (!doc) return false;
    if (!saveAs && doc.source?.write) {
      // Bound to a package on disk (folder or file): write it in place and remember its new state.
      await doc.source.write(await buildProject(doc, this.session.activeLayerId));
      doc.diskState = await doc.source.fingerprint();
      doc.dirty = false;
      this.emitView();
      return true;
    }
    const blob = await this.projectBlob();
    if (!blob) return false;
    const suggested = (doc.fileName && isProjectFile(doc.fileName) ? doc.fileName : `${doc.name}${PROJECT_EXTENSION}`);
    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    let handle = !saveAs ? doc.fileHandle : undefined;
    if (!handle && picker) {
      try {
        handle = await picker.call(window, {
          suggestedName: suggested,
          types: [{ description: "Compositor project", accept: { [PROJECT_MIME]: [PROJECT_EXTENSION] } }],
        });
      } catch (err) {
        if ((err as DOMException).name === "AbortError") return false;
        throw err;
      }
    }
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      doc.fileHandle = handle;
      doc.fileName = handle.name;
      doc.source = zipFileSource(handle);
      doc.diskState = await doc.source.fingerprint();
      if (!doc.name || doc.name === "Untitled") doc.name = handle.name.replace(/\.[^.]+$/, "");
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = suggested;
      a.click();
      URL.revokeObjectURL(url);
      doc.fileName = suggested;
    }
    doc.dirty = false;
    this.emitView();
    return true;
  }

  /** Open an image from any URL the page may read (blob:, file:// when the launcher allows it, http). */
  openImageUrl(url: string, fileName?: string): Promise<void> {
    if (url.endsWith("/")) return this.openProjectSource(urlFolderSource(url)); // a .comp package folder
    if (isProjectFile(fileName ?? url)) {
      return fetch(url).then((r) => { if (!r.ok) throw new Error(`Could not read ${url}`); return r.arrayBuffer(); })
        .then((buf) => this.openProject(buf, fileName ?? decodeURIComponent(url.split("/").pop() ?? "Project.comp")));
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const base = fileName ?? decodeURIComponent(url.split("/").pop() ?? "") ?? "Image";
        const name = base.replace(/\.[^.]+$/, "") || "Image";
        const doc = createDocument(img.naturalWidth, img.naturalHeight, name);
        const canvas = createCanvas(img.naturalWidth, img.naturalHeight);
        canvas.getContext("2d")!.drawImage(img, 0, 0);
        const layer = createLayer({
          name: base,
          kind: "raster",
          canvas,
          transform: defaultTransform(img.naturalWidth, img.naturalHeight),
        });
        doc.layers.push(layer);
        this.docs.push(doc);
        this.activeDocId = doc.id;
        this.session.activeLayerId = layer.id;
        this.session.selectedLayerIds = [layer.id];
        this.history.reset(snapshot(doc, "Open"));
        this.pendingFit = true;
        this.emit();
        resolve();
      };
      img.onerror = () => reject(new Error(`Could not load image: ${fileName ?? url}`));
      img.src = url;
    });
  }

  switchDocument(id: string): void {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc || doc.id === this.activeDocId) return;
    this.activeDocId = doc.id;
    const top = doc.layers[doc.layers.length - 1];
    this.session.activeLayerId = top?.id ?? null;
    this.session.selectedLayerIds = top ? [top.id] : [];
    this.session.cropRect = null;
    // History is a single stack shared by all documents; switching starts it afresh.
    this.history.reset(snapshot(doc, "Switch document"));
    this.pendingFit = true;
    this.emitView();
  }

  closeDocument(id = this.activeDocId): void {
    if (!id) return;
    this.docs = this.docs.filter((d) => d.id !== id);
    const next = this.docs[this.docs.length - 1];
    this.activeDocId = null;
    if (next) this.switchDocument(next.id);
    else this.emitView();
  }

  addBlankLayer(): void {
    const doc = this.doc;
    if (!doc) return;
    const n = doc.layers.filter((l) => l.name.startsWith("Layer")).length + 1;
    const layer = createBlankLayer(doc, `Layer ${n}`);
    const active = this.activeLayer;
    if (active) {
      const idx = doc.layers.indexOf(active);
      doc.layers.splice(idx + 1, 0, layer);
      layer.parentId = active.parentId;
    } else {
      doc.layers.push(layer);
    }
    this.session.activeLayerId = layer.id;
    this.session.selectedLayerIds = [layer.id];
    this.commit("Add layer");
  }

  /** Put the selected layers into a new folder placed where the top-most of them was. */
  addGroup(): void {
    const doc = this.doc;
    if (!doc) return;
    const selected = doc.layers.filter((l) => this.session.selectedLayerIds.includes(l.id));
    if (!selected.length && this.activeLayer) selected.push(this.activeLayer);
    if (!selected.length) return;
    // Only the outermost selected layers move; their descendants come along implicitly.
    const selectedIds = new Set(selected.map((l) => l.id));
    const members = selected.filter((l) => {
      let p = parentOf(doc, l);
      while (p) { if (selectedIds.has(p)) return false; p = parentOf(doc, doc.layers.find((x) => x.id === p)!); }
      return true;
    });
    const parentId = parentOf(doc, members[0]);
    const n = doc.layers.filter((l) => l.kind === "group").length + 1;
    const group = createLayer({ name: `Group ${n}`, kind: "group", transform: defaultTransform(doc.width, doc.height) });
    group.canvas = null;
    group.parentId = parentId;
    const topIndex = Math.max(...members.map((l) => doc.layers.indexOf(l)));
    doc.layers.splice(topIndex + 1, 0, group);
    for (const l of members) l.parentId = group.id;
    this.session.activeLayerId = group.id;
    this.session.selectedLayerIds = [group.id];
    this.commit("Group layers");
  }

  /** Dissolve the selected folders; their contents move up one level. */
  ungroupSelected(): void {
    const doc = this.doc;
    if (!doc) return;
    const groups = doc.layers.filter((l) => l.kind === "group" && (this.session.selectedLayerIds.includes(l.id) || l.id === this.session.activeLayerId));
    if (!groups.length) return;
    const freed: string[] = [];
    for (const g of groups) {
      for (const l of doc.layers) if (l.parentId === g.id) { l.parentId = g.parentId; freed.push(l.id); }
    }
    doc.layers = doc.layers.filter((l) => !groups.includes(l));
    this.session.selectedLayerIds = freed;
    this.session.activeLayerId = freed[freed.length - 1] ?? doc.layers[doc.layers.length - 1]?.id ?? null;
    this.commit("Ungroup layers");
  }

  /** Fold or unfold a folder in the layers panel (no history entry). */
  toggleCollapsed(layer: Layer): void {
    if (layer.kind !== "group") return;
    layer.collapsed = !layer.collapsed;
    this.emitView();
  }

  /** Panel click: plain selects, `toggle` (Ctrl) adds/removes, `range` (Shift) extends from the active layer. */
  selectLayer(id: string, opts: { toggle?: boolean; range?: boolean; mask?: boolean } = {}): void {
    const doc = this.doc;
    if (!doc) return;
    if (id !== this.session.activeLayerId || !opts.mask) this.session.maskSelected = false;
    if (opts.mask) this.session.maskSelected = true;
    const sel = new Set(this.session.selectedLayerIds);
    if (opts.range && this.session.activeLayerId) {
      const rows = layerTree(doc).map((r) => r.layer.id);
      const a = rows.indexOf(this.session.activeLayerId), b = rows.indexOf(id);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(rows[i]);
      else sel.add(id);
    } else if (opts.toggle) {
      if (sel.has(id) && sel.size > 1) { sel.delete(id); if (this.session.activeLayerId === id) this.session.activeLayerId = [...sel][0]; }
      else { sel.add(id); this.session.activeLayerId = id; }
    } else {
      if (this.session.activeLayerId === id && sel.size === 1 && sel.has(id)) return; // already the selection: no re-render
      sel.clear();
      sel.add(id);
      this.session.activeLayerId = id;
    }
    this.session.selectedLayerIds = [...sel];
    this.emitView();
  }

  /** Move a layer (and its contents) next to another row: above it, or into it when it is a folder. */
  moveLayer(id: string, targetId: string, into: boolean): void {
    const doc = this.doc;
    if (!doc || id === targetId) return;
    const layer = doc.layers.find((l) => l.id === id);
    const target = doc.layers.find((l) => l.id === targetId);
    if (!layer || !target) return;
    if (layer.kind === "group" && (target.id === layer.id || descendants(doc, layer.id).includes(target))) return;
    const block = [layer, ...(layer.kind === "group" ? descendants(doc, layer.id) : [])];
    doc.layers = doc.layers.filter((l) => !block.includes(l));
    const at = doc.layers.indexOf(target);
    if (into && target.kind === "group") {
      layer.parentId = target.id;
      doc.layers.splice(at, 0, ...block); // just below the folder row = top of its contents
    } else {
      layer.parentId = target.parentId;
      doc.layers.splice(at + 1, 0, ...block); // above the target in the panel
    }
    this.commit("Reorder layers");
  }

  toggleVisibility(ids = this.session.selectedLayerIds): void {
    const doc = this.doc;
    if (!doc) return;
    const layers = doc.layers.filter((l) => ids.includes(l.id));
    const show = layers.some((l) => !l.visible);
    for (const l of layers) l.visible = show;
    this.commit("Toggle visibility");
  }

  addAdjustment(kind: NonNullable<Layer["adjustmentKind"]>): void {
    const doc = this.doc;
    if (!doc) return;
    const layer = createLayer({
      name: labelForAdjustment(kind),
      kind: "adjustment",
      adjustmentKind: kind,
      adjustment: defaultAdjustment(kind),
      transform: defaultTransform(doc.width, doc.height),
    });
    layer.canvas = null;
    const active = this.activeLayer;
    const idx = active ? doc.layers.indexOf(active) : doc.layers.length - 1;
    doc.layers.splice(idx + 1, 0, layer);
    this.session.activeLayerId = layer.id;
    this.session.selectedLayerIds = [layer.id];
    this.commit("Add adjustment");
  }

  addEffect(kind: LayerEffect["kind"]): void {
    const layer = this.activeLayer;
    if (!layer) return;
    layer.effects.push({
      kind,
      enabled: true,
      color: kind === "drop-shadow" ? "#000000" : this.session.foreground,
      opacity: 0.75,
      size: 8,
      distance: 4,
      angle: 135,
      spread: 0,
    });
    this.commit(`Add ${kind}`);
  }

  deleteSelection(): void {
    const doc = this.doc;
    if (!doc) return;
    if (this.session.selectedLayerIds.length) {
      const ids = new Set(this.session.selectedLayerIds);
      // Deleting a folder deletes its contents too (as in Photoshop).
      for (const l of [...doc.layers]) if (ids.has(l.id) && l.kind === "group") for (const d of descendants(doc, l.id)) ids.add(d.id);
      doc.layers = doc.layers.filter((l) => !ids.has(l.id));
      this.session.activeLayerId = doc.layers[doc.layers.length - 1]?.id ?? null;
      this.session.selectedLayerIds = this.session.activeLayerId ? [this.session.activeLayerId] : [];
      this.commit("Delete layer");
    }
  }

  /** Duplicate every selected layer (folders with their contents). */
  duplicateLayer(offset = 8): void {
    const doc = this.doc;
    if (!doc) return;
    const selected = doc.layers.filter((l) => this.session.selectedLayerIds.includes(l.id));
    if (!selected.length && this.activeLayer) selected.push(this.activeLayer);
    // Copies are stacked together above the topmost selected layer, in the same order (Compositor 1.2.5).
    const ordered = selected.slice().sort((a, b) => doc.layers.indexOf(a) - doc.layers.indexOf(b));
    const copies = this.cloneLayers(doc, ordered, " copy", offset);
    const top = Math.max(...ordered.map((l) => Math.max(doc.layers.indexOf(l), ...descendants(doc, l.id).map((d) => doc.layers.indexOf(d)))));
    doc.layers.splice(top + 1, 0, ...copies.all);
    const newIds = copies.roots.map((l) => l.id);
    if (!newIds.length) return;
    this.session.activeLayerId = newIds[newIds.length - 1];
    this.session.selectedLayerIds = newIds;
    this.commit("Duplicate layer");
  }

  /** Deep copies of layers (folders bring their contents) with fresh ids and re-linked parents. */
  private cloneLayers(doc: DocumentState, layers: Layer[], suffix: string, offset = 0): { all: Layer[]; roots: Layer[] } {
    const all: Layer[] = [], roots: Layer[] = [];
    const idMap = new Map<string, string>();
    for (const layer of layers) {
      const block = layer.kind === "group" ? [layer, ...descendants(doc, layer.id)] : [layer];
      for (const l of block) {
        if (idMap.has(l.id)) continue; // already copied as part of a selected folder
        const c = this.cloneLayerShallow(l, l === layer ? suffix : "");
        idMap.set(l.id, c.id);
        if (l === layer) {
          roots.push(c);
          if (l.kind !== "group") c.transform = { ...c.transform, x: c.transform.x + offset, y: c.transform.y + offset };
        }
        all.push(c);
      }
    }
    for (const c of all) if (c.parentId && idMap.has(c.parentId)) c.parentId = idMap.get(c.parentId)!;
    return { all, roots };
  }

  /* ── Layer clipboard: Ctrl+C / Ctrl+V with no selection copy whole layers (Compositor 1.2.5) ── */

  /** Whole layers copied with Ctrl+C (no selection): editable text, masks, effects and folders survive. */
  layerClipboard: { layers: Layer[]; parents: Map<string, string | null>; pngSize: number } | null = null;

  copyLayers(pngSize = 0): boolean {
    const doc = this.doc;
    if (!doc) return false;
    const selected = doc.layers.filter((l) => this.session.selectedLayerIds.includes(l.id));
    if (!selected.length && this.activeLayer) selected.push(this.activeLayer);
    if (!selected.length) return false;
    const ordered = selected.slice().sort((a, b) => doc.layers.indexOf(a) - doc.layers.indexOf(b));
    const copies = this.cloneLayers(doc, ordered, "");
    this.layerClipboard = { layers: copies.all, parents: new Map(copies.all.map((l) => [l.id, l.parentId])), pngSize };
    return true;
  }

  /** Paste copied layers above the active layer of the current document (any document). */
  pasteLayers(): boolean {
    const doc = this.doc;
    const clip = this.layerClipboard;
    if (!doc || !clip?.layers.length) return false;
    const temp = createDocument(1, 1, "clip");
    temp.layers = clip.layers.map((l) => ({ ...l, parentId: clip.parents.get(l.id) ?? null }));
    const roots = temp.layers.filter((l) => !l.parentId || !temp.layers.some((p) => p.id === l.parentId));
    const copies = this.cloneLayers(temp, roots, "");
    const active = this.activeLayer;
    const parentId = active?.kind === "group" ? active.id : (active?.parentId ?? null);
    for (const r of copies.roots) r.parentId = parentId;
    const at = active ? Math.max(doc.layers.indexOf(active), ...descendants(doc, active.id).map((d) => doc.layers.indexOf(d))) : doc.layers.length - 1;
    doc.layers.splice(at + 1, 0, ...copies.all);
    this.session.selectedLayerIds = copies.roots.map((l) => l.id);
    this.session.activeLayerId = this.session.selectedLayerIds[this.session.selectedLayerIds.length - 1] ?? null;
    this.setTool("move");
    this.commit("Paste layers");
    return true;
  }

  private cloneLayerShallow(layer: Layer, suffix: string): Layer {
    return createLayer({
      ...layer,
      id: uid(),
      name: layer.name + suffix,
      canvas: layer.canvas ? cloneCanvas(layer.canvas) : null,
      transform: { ...layer.transform },
      mask: layer.mask ? { ...layer.mask, canvas: cloneCanvas(layer.mask.canvas) } : null,
      effects: layer.effects.map((e) => ({ ...e })),
      text: layer.text ? { ...layer.text } : undefined,
      shape: layer.shape ? { ...layer.shape } : undefined,
      adjustment: layer.adjustment ? { ...layer.adjustment } : undefined,
    });
  }

  mergeDown(): void {
    const doc = this.doc;
    const layer = this.activeLayer;
    if (!doc || !layer) return;
    const idx = doc.layers.indexOf(layer);
    if (idx <= 0) return;
    const below = doc.layers[idx - 1];
    if (below.kind === "group" || below.kind === "adjustment" || below.parentId !== layer.parentId) return;
    ensureLayerBitmap(layer);
    ensureLayerBitmap(below);
    // Composite the two layers exactly as the renderer would, into a document-sized bitmap.
    const temp = createDocument(doc.width, doc.height, "merge");
    temp.layers = [
      { ...below, parentId: null, opacity: 1, blendMode: "normal" },
      { ...layer, parentId: null },
    ];
    const merged = flattenDocumentCopy(temp);
    below.canvas = merged;
    below.transform = defaultTransform(doc.width, doc.height);
    below.kind = "raster";
    below.mask = null;
    below.effects = [];
    below.text = undefined;
    below.shape = undefined;
    doc.layers.splice(idx, 1);
    this.session.activeLayerId = below.id;
    this.commit("Merge down");
  }

  flattenImage(): void {
    const doc = this.doc;
    if (!doc) return;
    const flat = flattenDocumentCopy(doc);
    const layer = createLayer({
      name: "Background",
      kind: "raster",
      canvas: flat,
      transform: defaultTransform(doc.width, doc.height),
    });
    doc.layers = [layer];
    this.session.activeLayerId = layer.id;
    this.session.selectedLayerIds = [layer.id];
    this.commit("Flatten image");
  }

  setTool(tool: ToolId): void {
    if (this.stroke || this.warp) return; // a stroke keeps its tool until it ends
    if (this.session.textEdit && tool !== "type") this.endTextEdit(true);
    const before = this.session.tool;
    if (before !== tool) {
      const from = this.tipFamily(before), to = this.tipFamily(tool);
      if (from !== to) {
        const b = this.session.brush;
        this.parkedTips[from] = { size: b.size, hardness: b.hardness, opacity: b.opacity };
        const parked = this.parkedTips[to] ?? { size: 40, hardness: 1, opacity: 1 };
        Object.assign(b, parked);
      }
    }
    if (before !== tool) this.cancelLasso(); // switching tools drops an outline in progress
    this.session.tool = tool;
    if (tool === "crop" && this.doc?.selection?.mask && !this.session.cropRect) {
      // With a selection, the crop box starts at its bounds (Compositor 1.2.5).
      const b = maskBounds(this.doc.selection.mask);
      if (b) this.session.cropRect = { ...b };
    }
    this.emitView();
  }

  /** Brush, Spot Healing, Clone Stamp and Smear share the tip, size keys and opacity digits. */
  isBrushTool(tool: ToolId = this.session.tool): boolean {
    return tool === "brush" || tool === "spot-healing" || tool === "clone-stamp" || tool === "blur";
  }

  /** Which parked tip a tool uses: Clone Stamp and Smear start soft and keep their own size. */
  private tipFamily(tool: ToolId): number {
    return tool === "clone-stamp" ? 1 : tool === "blur" ? 2 : 0;
  }

  /** B / E: the Brush tool in Paint or Erase mode. */
  setBrushMode(mode: BrushMode): void {
    if (this.stroke || this.warp) return;
    this.session.brushMode = mode;
    if (this.session.tool !== "brush") this.setTool("brush");
    else this.emitView();
  }

  /** Tab: step the mode shown at the left of the current tool's header. */
  cycleToolMode(): void {
    if (this.stroke || this.warp) return;
    const s = this.session;
    const next = <T,>(all: readonly T[], v: T): T => all[(all.indexOf(v) + 1) % all.length];
    switch (s.tool) {
      case "marquee": s.marqueeShape = s.marqueeShape === "rect" ? "ellipse" : "rect"; this.cancelLasso(); break;
      case "lasso": s.lassoMode = s.lassoMode === "free" ? "polygon" : "free"; this.cancelLasso(); break;
      case "shape": s.shapeKind = next(["rect", "ellipse", "line"] as const, s.shapeKind === "rounded" ? "rect" : s.shapeKind); break;
      case "brush": s.brushMode = s.brushMode === "paint" ? "erase" : "paint"; break;
      case "blur": s.smearMode = next(["liquify", "blur", "smudge"] as const, s.smearMode); break;
      case "spot-healing": s.healMode = next(["content-aware", "create-texture", "proximity-match"] as const, s.healMode); break;
      case "clone-stamp": s.clone.sampleAll = !s.clone.sampleAll; break;
      case "gradient": this.setGradient({ style: s.gradient.style === "linear" ? "radial" : "linear" }); return;
      default: return;
    }
    this.emitView();
  }

  /** 1–9 = 10–90 %, 0 = 100 %; two digits within 0.6 s give an exact value (4, 5 → 45 %). */
  typeOpacityDigit(digit: number, time = performance.now() / 1000): void {
    const tool = this.session.tool;
    if (!(this.isBrushTool(tool) || tool === "gradient" || tool === "move") || this.stroke || this.warp || digit < 0 || digit > 9) return;
    let percent = digit === 0 ? 100 : digit * 10;
    const pending = this.pendingOpacityDigit;
    if (pending && time - pending.time < 0.6) {
      percent = Math.max(1, pending.digit * 10 + digit);
      this.pendingOpacityDigit = null;
    } else this.pendingOpacityDigit = { digit, time };
    if (tool === "move") {
      const layer = this.activeLayer;
      if (!layer) return;
      layer.opacity = percent / 100;
      this.commit("Layer opacity");
      return;
    }
    if (tool === "gradient") { this.setGradient({ opacity: percent / 100 }); return; }
    this.session.brush.opacity = percent / 100;
    this.emitView();
  }

  undo(): void {
    const doc = this.doc;
    if (!doc) return;
    if (this.history.undo(doc)) this.emit();
  }

  redo(): void {
    const doc = this.doc;
    if (!doc) return;
    if (this.history.redo(doc)) this.emit();
  }

  /** Fill the selection (or the whole layer) with a colour; on a mask, black hides and white reveals. */
  fillActive(color = this.session.foreground): void {
    const doc = this.doc;
    const target = this.paintTarget();
    if (!doc || !target) return;
    const { layer, mask } = target;
    if (mask) {
      const white = color.toLowerCase() === "#ffffff" || (this.session.maskSelected && this.session.maskPaintWhite && color === this.session.foreground);
      const mctx = writableMask(layer)!.getContext("2d")!;
      mctx.save();
      if (doc.selection?.mask) { mctx.beginPath(); }
      mctx.globalCompositeOperation = white ? "source-over" : "destination-out";
      mctx.fillStyle = "#fff";
      if (doc.selection?.mask) mctx.drawImage(doc.selection.mask, 0, 0);
      else mctx.fillRect(0, 0, doc.width, doc.height);
      mctx.restore();
      this.commit("Fill Mask");
      return;
    }
    if (!layer.canvas) return;
    // Paint in document space so the fill respects the layer's transform and the selection.
    const fill = createCanvas(doc.width, doc.height);
    const fctx = fill.getContext("2d")!;
    fctx.fillStyle = color;
    fctx.fillRect(0, 0, doc.width, doc.height);
    if (doc.selection?.mask) {
      fctx.globalCompositeOperation = "destination-in";
      fctx.drawImage(doc.selection.mask, 0, 0);
    }
    const ctx = writableLayer(layer)!.getContext("2d")!;
    enterDocSpace(ctx, layer);
    ctx.drawImage(fill, 0, 0);
    ctx.restore();
    this.commit("Fill");
  }

  clearActive(): void {
    const doc = this.doc;
    const layer = this.activeLayer;
    if (!doc || !layer || !layer.canvas) return;
    if (this.session.maskSelected && layer.mask) { this.fillActive(this.session.background); return; } // a mask clears to the background colour
    if (doc.selection?.mask) this.eraseSelection(layer);
    else {
      const c = writableLayer(layer)!;
      c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    }
    this.commit("Clear");
  }

  /** Erase the selected area from a layer, honouring its transform. */
  private eraseSelection(layer: Layer): void {
    const mask = this.doc?.selection?.mask;
    if (!mask || !layer.canvas) return;
    const ctx = writableLayer(layer)!.getContext("2d")!;
    enterDocSpace(ctx, layer);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(mask, 0, 0);
    ctx.restore();
  }

  /* ── Selection commands (Photoshop's Select menu) ──────────────────────── */

  hasSelection(): boolean {
    return !!this.doc?.selection?.mask;
  }

  /**
   * Shift / Option went down or up: remember the held mode for the header, and reshape a
   * marquee in progress the moment Shift changes, without waiting for mouse motion.
   */
  modifiersChanged(view: HTMLCanvasElement, e: { shiftKey: boolean; altKey: boolean }): void {
    this.session.heldSelectionMode = e.altKey ? "subtract" : e.shiftKey ? "add" : null;
    if (this.dragMode === "marquee" && this.session.tool === "marquee" && this.marqueeDragPixel && this.doc) {
      const p = this.marqueeDragPixel;
      const z = this.session.zoom || 1;
      const rect = view.getBoundingClientRect();
      const ox = rect.left + rect.width / 2 + this.session.panX - (this.doc.width * z) / 2;
      const oy = rect.top + rect.height / 2 + this.session.panY - (this.doc.height * z) / 2;
      this.pointerMove(view, { clientX: ox + p.x * z, clientY: oy + p.y * z, shiftKey: e.shiftKey, altKey: e.altKey } as PointerEvent);
    }
  }

  /** What the header's Mode picker highlights: a held modifier, else the chosen mode. */
  displayedSelectionMode(): Selection["mode"] {
    return this.session.heldSelectionMode ?? this.session.selectionModeChoice;
  }

  selectAll(): void {
    const doc = this.doc;
    if (!doc) return;
    const mask = createCanvas(doc.width, doc.height);
    const ctx = mask.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, doc.width, doc.height);
    doc.selection = { path: { type: "rect", x: 0, y: 0, w: doc.width, h: doc.height }, mask, mode: "replace", feather: 0, outline: null };
    this.commit("Select All");
  }

  deselect(): void {
    const doc = this.doc;
    if (!doc?.selection) return;
    doc.selection = null;
    this.commit("Deselect");
  }

  invertSelection(): void {
    const doc = this.doc;
    const outline = this.selectionOutlineMask();
    if (!doc || !outline) return;
    const mask = createCanvas(doc.width, doc.height);
    const ctx = mask.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, doc.width, doc.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(outline, 0, 0);
    doc.selection = this.featheredSelection(mask, doc.selection?.feather ?? 0); // keeps the feather
    this.commit("Inverse");
  }

  /**
   * Layer via Copy / Layer via Cut (Ctrl+J / Ctrl+Shift+J): the selected pixels of the active
   * layer become a new layer just above it, sized to the selection. Without a selection,
   * Layer via Copy duplicates the layer like Photoshop.
   */
  layerViaCopy(cut = false): void {
    const doc = this.doc;
    const source = this.activeLayer;
    if (!doc || !source) return;
    if (!doc.selection?.mask) { if (!cut) this.duplicateLayer(); return; }
    if (source.kind === "group" || source.kind === "adjustment") return;
    const cutout = this.cutout(false);
    if (!cutout) return;
    const { canvas, bounds } = cutout;
    const layer = createLayer({
      name: `${source.name} ${cut ? "cut" : "copy"}`,
      kind: "raster",
      canvas,
      transform: defaultTransform(bounds.w, bounds.h, bounds.x, bounds.y),
    });
    if (cut && source.canvas) this.eraseSelection(source);
    this.insertLayerAboveActive(layer);
    doc.selection = null;
    this.setTool("move");
    this.commit(cut ? "Layer via Cut" : "Layer via Copy");
  }

  /**
   * Trim transparent pixels (Photoshop's Image › Trim): crop a raster layer's bitmap to its
   * visible pixels. The pixels stay exactly where they are on the canvas; only the bounding
   * box (and the transform handles) shrink. Returns true when something was trimmed.
   */
  trimLayer(layer: Layer | null = this.activeLayer): boolean {
    if (!layer || layer.kind !== "raster" || !layer.canvas) return false;
    const c = layer.canvas;
    const b = maskBounds(c);
    if (!b || (b.x === 0 && b.y === 0 && b.w === c.width && b.h === c.height)) return false;
    const t = layer.transform;
    const sx = t.width / c.width, sy = t.height / c.height;
    // Centre of the trimmed area in the layer's unrotated frame (flips mirror it), then to the document.
    let dx = (b.x + b.w / 2 - c.width / 2) * sx;
    let dy = (b.y + b.h / 2 - c.height / 2) * sy;
    if (t.flipH) dx = -dx;
    if (t.flipV) dy = -dy;
    const centre = fromLocal(t, { x: dx, y: dy });
    const cropped = createCanvas(b.w, b.h);
    cropped.getContext("2d")!.drawImage(c, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    layer.canvas = cropped;
    const w = b.w * sx, h = b.h * sy;
    layer.transform = { ...t, width: w, height: h, x: centre.x - w / 2, y: centre.y - h / 2 };
    return true;
  }

  /** Layer › Trim Transparent Pixels on the selected layers. */
  trimSelected(): void {
    const doc = this.doc;
    if (!doc) return;
    const ids = this.session.selectedLayerIds.length ? this.session.selectedLayerIds : [this.session.activeLayerId];
    let any = false;
    for (const id of ids) any = this.trimLayer(doc.layers.find((l) => l.id === id) ?? null) || any;
    if (any) this.commit("Trim transparent pixels");
  }

  /** Turn the selection into a layer mask on the active layer (Photoshop's "Add layer mask" with a selection). */
  maskFromSelection(): void {
    const doc = this.doc;
    const layer = this.activeLayer;
    if (!doc || !layer || !doc.selection?.mask) return;
    const mask = createCanvas(doc.width, doc.height);
    const ctx = mask.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, doc.width, doc.height);
    ctx.drawImage(doc.selection.mask, 0, 0);
    layer.mask = { canvas: mask, enabled: true, linked: true };
    doc.selection = null;
    this.commit("Layer mask from selection");
  }

  invertActive(): void {
    const layer = this.activeLayer;
    if (!layer?.canvas) return;
    const img = imageDataOf(layer.canvas);
    layer.canvas = canvasFromImageData(invertImage(img));
    this.commit("Invert");
  }

  applyAdjustmentToActive(kind: string, params: Record<string, number>): void {
    const layer = this.activeLayer;
    if (!layer?.canvas) return;
    const img = imageDataOf(layer.canvas);
    let out = img;
    if (kind === "invert") out = invertImage(img);
    else if (kind === "gaussian-blur") {
      const c = gaussianBlur(layer.canvas, params.radius ?? 4);
      layer.canvas = c;
      this.commit("Gaussian blur");
      return;
    } else out = applyAdjustment(img, params as never);
    layer.canvas = canvasFromImageData(out);
    this.commit(kind);
  }

  /** Eyedropper: read the merged colour under a document point into the foreground (or background). */
  sampleColor(p: { x: number; y: number }, toBackground = false): void {
    const doc = this.doc;
    if (!doc) return;
    const data = imageDataOf(flattenDocument(doc));
    const x = Math.min(data.width - 1, Math.max(0, Math.round(p.x)));
    const y = Math.min(data.height - 1, Math.max(0, Math.round(p.y)));
    const i = (y * data.width + x) * 4;
    const hex = "#" + [data.data[i], data.data[i + 1], data.data[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    if (toBackground) this.session.background = hex;
    else this.session.foreground = hex;
    this.emitView();
  }

  /** A document point in a layer's bitmap pixels (transform undone) plus pixels per document unit. */
  private layerPixel(layer: Layer, p: { x: number; y: number }): { x: number; y: number; scale: number } | null {
    if (!layer.canvas) return null;
    const t = layer.transform;
    const u = toLocal(t, p);
    const ux = t.flipH ? -u.x : u.x, uy = t.flipV ? -u.y : u.y;
    const sx = layer.canvas.width / Math.max(1, t.width), sy = layer.canvas.height / Math.max(1, t.height);
    return { x: (ux + t.width / 2) * sx, y: (uy + t.height / 2) * sy, scale: (sx + sy) / 2 };
  }

  /** Top-most visible layer with pixels (or text / shape bounds) under a document point. */
  layerAt(p: { x: number; y: number }): Layer | null {
    const doc = this.doc;
    if (!doc) return null;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (!l.visible || l.kind === "group" || l.kind === "adjustment" || !l.canvas) continue;
      const u = toLocal(l.transform, p);
      if (Math.abs(u.x) > l.transform.width / 2 || Math.abs(u.y) > l.transform.height / 2) continue;
      if (l.kind !== "raster") return l;
      const q = this.layerPixel(l, p);
      if (!q) continue;
      const a = l.canvas.getContext("2d")!.getImageData(Math.min(l.canvas.width - 1, Math.max(0, Math.floor(q.x))), Math.min(l.canvas.height - 1, Math.max(0, Math.floor(q.y))), 1, 1).data[3];
      if (a > 0) return l;
    }
    return null;
  }

  /** Topmost visible text layer under a document point. */
  textLayerAt(p: { x: number; y: number }): Layer | null {
    const doc = this.doc;
    if (!doc) return null;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (l.kind !== "text" || !l.visible) continue;
      const u = toLocal(l.transform, p);
      if (Math.abs(u.x) <= l.transform.width / 2 && Math.abs(u.y) <= l.transform.height / 2) return l;
    }
    return null;
  }

  /* ── In-canvas text editing ─────────────────────────────────────── */

  beginTextEdit(layerId: string, created: boolean): void {
    const layer = this.doc?.layers.find((l) => l.id === layerId);
    if (!layer?.text) return;
    this.session.textEdit = { layerId, original: layer.text.text, created };
    setEditingLayer(layerId);
    this.redraw();
  }

  /** Commit (or cancel) the on-canvas edit. Empty text layers are discarded, as in Photoshop. */
  endTextEdit(commit: boolean): void {
    const edit = this.session.textEdit;
    const doc = this.doc;
    if (!edit || !doc) return;
    const layer = doc.layers.find((l) => l.id === edit.layerId);
    this.session.textEdit = null;
    setEditingLayer(null);
    if (!layer?.text) { this.emit(); return; }
    if (!commit) {
      layer.text.text = edit.original;
      writableLayer(layer);
      fitTextLayer(layer);
      if (edit.created) doc.layers = doc.layers.filter((l) => l !== layer);
      this.history.undo(doc); // drop the "Add type layer" step
      this.history.redo(doc);
      if (edit.created) { this.session.activeLayerId = doc.layers[doc.layers.length - 1]?.id ?? null; this.session.selectedLayerIds = this.session.activeLayerId ? [this.session.activeLayerId] : []; }
      this.emit();
      return;
    }
    if (!layer.text.text.trim()) {
      doc.layers = doc.layers.filter((l) => l !== layer);
      this.session.activeLayerId = doc.layers[doc.layers.length - 1]?.id ?? null;
      this.session.selectedLayerIds = this.session.activeLayerId ? [this.session.activeLayerId] : [];
      this.commit("Discard empty text");
      return;
    }
    if (layer.text.text !== edit.original || edit.created) this.commit("Edit text");
    else this.emit();
  }

  addTextLayer(x: number, y: number, text = this.session.text.text): void {
    const doc = this.doc;
    if (!doc) return;
    const data: TextLayerData = { ...this.session.text, text };
    const layer = createLayer({
      name: "Type",
      kind: "text",
      text: data,
      canvas: createCanvas(1, 1),
      transform: defaultTransform(1, 1, Math.round(x), Math.round(y)), // whole pixels keep the glyphs sharp
    });
    drawTextLayer(layer); // sizes the bitmap to the text
    doc.layers.push(layer);
    this.session.activeLayerId = layer.id;
    this.session.selectedLayerIds = [layer.id];
    this.commit("Add type layer");
  }

  /** Edit the active shape layer (fill, stroke, width, corner radius); the raster follows. */
  setShape(patch: Partial<ShapeLayerData>): void {
    const layer = this.activeLayer;
    if (layer?.kind !== "shape" || !layer.shape) return;
    Object.assign(layer.shape, patch);
    this.redraw();
  }

  addShapeLayer(x: number, y: number, w: number, h: number): void {
    const doc = this.doc;
    if (!doc) return;
    const canvas = createCanvas(Math.max(1, w), Math.max(1, h));
    const layer = createLayer({
      name: this.session.shapeKind,
      kind: "shape",
      shape: {
        kind: this.session.shapeKind,
        fill: this.session.foreground,
        stroke: this.session.background,
        strokeWidth: 0,
        radius: 12,
      },
      canvas,
      transform: defaultTransform(Math.max(1, w), Math.max(1, h), x, y),
    });
    drawShapeLayer(layer);
    doc.layers.push(layer);
    this.session.activeLayerId = layer.id;
    this.commit("Add shape");
  }

  applyCrop(): void {
    const doc = this.doc;
    const r = this.session.cropRect;
    if (!doc || !r) return;
    const nw = Math.max(1, Math.round(r.w));
    const nh = Math.max(1, Math.round(r.h));
    for (const layer of doc.layers) {
      if (!layer.canvas) continue;
      const c = createCanvas(nw, nh);
      c.getContext("2d")!.drawImage(
        layer.canvas,
        -r.x + layer.transform.x,
        -r.y + layer.transform.y,
      );
      layer.canvas = c;
      layer.transform = defaultTransform(nw, nh, 0, 0);
    }
    doc.width = nw;
    doc.height = nh;
    this.session.cropRect = null;
    this.setTool("move");
    this.commit("Crop");
  }

  /* ── Pointer events ─────────────────────────────────────────────── */

  pointerDown(view: HTMLCanvasElement, e: PointerEvent): void {
    const doc = this.doc;
    if (!doc) return;
    const p = screenToDoc(view, doc, this.session, e.clientX, e.clientY);
    const tool = this.session.tool;
    if (e.button === 1 || tool === "hand" || this.tempHand) {
      this.dragMode = "pan";
      this.moveStart = { x: e.clientX - this.session.panX, y: e.clientY - this.session.panY };
      return;
    }

    if (this.isBrushTool(tool)) {
      if (e.button === 2) {
        // Right-drag resizes the tip (Shift: hardness); a plain right-click still opens the menu.
        if (this.stroke || this.warp) return;
        const b = this.session.brush;
        this.tipDrag = { x: e.clientX, size: b.size, hardness: b.hardness, hardnessShown: e.shiftKey, moved: false };
        this.dragMode = "tip";
        return;
      }
      if (e.altKey && (tool === "brush" || tool === "spot-healing")) {
        // Option with a paint tool samples a colour, like Photoshop's temporary Eyedropper.
        this.sampleColor(p, false);
        return;
      }
      if (tool === "clone-stamp" && e.altKey) {
        this.setCloneSource(p);
        this.emitView();
        return;
      }
      const from = e.shiftKey ? this.shiftLineStart() : null;
      if (from) { this.beginBrush(from); this.continueBrush(p); }
      else this.beginBrush(p);
      if (!this.stroke && !this.warp) { this.emitView(); return; }
      this.brushAxisAnchor = e.shiftKey ? p : null;
      this.brushAxisHorizontal = null;
      this.brushLastPixel = p;
      this.dragMode = "brush";
      this.redraw();
      return;
    }
    if (tool === "marquee" || tool === "lasso" || tool === "wand") {
      const polygonDraft = tool === "lasso" && this.session.lassoMode === "polygon" && this.lassoPoints.length > 0;
      if (!polygonDraft) {
        const inside = this.pointInSelection(p);
        if ((e.ctrlKey || e.metaKey) && inside) {
          // ⌘-drag inside the selection moves its pixels; ⌘⌥ copies them.
          if (this.beginPixelMove(e.altKey, p)) this.dragMode = "pixel-move";
          return;
        }
        const mode = selectionMode(e, this.session.selectionModeChoice);
        if (mode === "replace" && inside && tool !== "wand") {
          const outline = this.selectionOutlineMask()!;
          this.selectionMove = { origin: outline, outline: this.doc?.selection?.outline ?? null, start: p, moved: false };
          this.dragMode = "select-move";
          return;
        }
      }
      if (tool === "wand") { this.magicWand(p, selectionMode(e, this.session.selectionModeChoice)); return; }
      if (tool === "lasso" && this.session.lassoMode === "polygon") {
        // Click adds a corner; the first corner (within 8 screen px), a double-click or Enter closes.
        const first = this.lassoPoints[0];
        if (first && this.lassoPoints.length >= 3 && Math.hypot(p.x - first[0], p.y - first[1]) * this.session.zoom <= 8) {
          this.finishLasso(selectionMode(e, this.session.selectionModeChoice));
          return;
        }
        this.lassoPoints.push([p.x, p.y]);
        this.session.lassoPath = this.lassoPoints;
        this.overlay();
        return;
      }
      this.dragMode = "marquee";
      this.marqueeStart = tool === "marquee" ? { x: Math.round(p.x), y: Math.round(p.y) } : p; // marquees snap to whole pixels
      this.marqueeConstrainArmed = !e.shiftKey; // Shift at the press means Add; a fresh Shift squares
      this.marqueeDragPixel = null;
      this.downMode = selectionMode(e, this.session.selectionModeChoice);
      if (tool === "lasso") {
        this.lassoPoints = [[p.x, p.y]];
        this.session.lassoPath = this.lassoPoints;
      }
      return;
    }
    if (tool === "move") {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl-click: auto-select the top-most layer with pixels under the pointer.
        const hit = this.layerAt(p);
        if (hit) this.selectLayer(hit.id, { toggle: e.shiftKey });
      } else if (e.altKey && this.activeLayer) {
        this.duplicateLayer(0); // Alt-drag moves a copy, starting in place
      }
      const layer = this.activeLayer;
      if (layer && this.isTransformable(layer)) {
        const hit = hitTest(layer.transform, p, this.session.zoom);
        if (hit.kind === "handle" || hit.kind === "rotate") {
          this.dragMode = hit.kind === "handle" ? "scale" : "rotate";
          this.transformStart = { ...layer.transform };
          this.transformHandle = hit.handle;
          this.moveStart = p;
          return;
        }
      }
      this.dragMode = "move";
      this.moveStart = p;
      this.moveOrigin = p;
      this.moveApplied = { x: 0, y: 0 };
      return;
    }
    if (tool === "crop") {
      const r = this.session.cropRect;
      if (r && r.w > 0 && r.h > 0) {
        // An existing crop box: drag a handle to resize it, drag inside to move it.
        const t = cropTransform(r);
        const hit = hitTest(t, p, this.session.zoom, 7, 0);
        if (hit.kind === "handle") {
          this.dragMode = "crop-handle";
          this.transformStart = t;
          this.transformHandle = hit.handle;
          return;
        }
        if (hit.kind === "inside") {
          this.dragMode = "crop-move";
          this.moveStart = p;
          return;
        }
      }
      this.dragMode = "crop";
      this.marqueeStart = p;
      this.session.cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
      return;
    }
    if (tool === "eyedropper") {
      this.sampleColor(p, e.altKey); // Alt sets the background colour, as in Photoshop
      return;
    }
    if (tool === "type") {
      if (this.session.textEdit) return; // the editor handles clicks while open
      const hit = this.textLayerAt(p);
      if (hit) {
        this.session.activeLayerId = hit.id;
        this.session.selectedLayerIds = [hit.id];
        this.beginTextEdit(hit.id, false);
      } else {
        this.addTextLayer(p.x, p.y, "");
        this.beginTextEdit(this.session.activeLayerId!, true);
      }
      return;
    }
    if (tool === "gradient" || tool === "shape") {
      this.dragMode = "marquee";
      this.marqueeStart = p;
      this.session.cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
      if (tool === "gradient") this.session.dragLine = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      return;
    }
    if (tool === "zoom") {
      this.session.zoom = e.shiftKey || e.altKey ? Math.max(0.05, this.session.zoom / 1.25) : Math.min(32, this.session.zoom * 1.25);
      this.emitView();
    }
  }

  pointerMove(view: HTMLCanvasElement, e: PointerEvent): void {
    const doc = this.doc;
    if (!doc) return;
    let p = screenToDoc(view, doc, this.session, e.clientX, e.clientY);
    if (this.dragMode === "pan" && this.moveStart) {
      this.session.panX = e.clientX - this.moveStart.x;
      this.session.panY = e.clientY - this.moveStart.y;
      this.emitView();
      return;
    }
    if (this.dragMode === "tip" && this.tipDrag) {
      const d = this.tipDrag, b = this.session.brush;
      const dx = e.clientX - d.x;
      if (Math.abs(dx) >= 3) d.moved = true;
      if (e.shiftKey) {
        d.hardnessShown = true;
        b.hardness = Math.min(1, Math.max(0, d.hardness + dx / 200)); // the full range across 200 points
        b.size = d.size;
      } else {
        d.hardnessShown = false;
        b.hardness = d.hardness;
        b.size = Math.min(2000, Math.max(1, Math.round(d.size + (2 * dx) / (this.session.zoom || 1)))); // the rim follows the pointer
      }
      this.emitView();
      return;
    }
    if (this.dragMode === "brush") {
      let pixel = p;
      if (e.shiftKey) {
        const anchor = this.brushAxisAnchor ?? this.brushLastPixel ?? p; // pressing Shift mid-stroke locks from here
        if (!this.brushAxisAnchor) { this.brushAxisAnchor = anchor; this.brushAxisHorizontal = null; }
        if (this.brushAxisHorizontal === null && Math.hypot(p.x - anchor.x, p.y - anchor.y) >= 3) {
          this.brushAxisHorizontal = Math.abs(p.x - anchor.x) >= Math.abs(p.y - anchor.y);
        }
        pixel = this.brushAxisHorizontal === null ? anchor : this.brushAxisHorizontal ? { x: p.x, y: anchor.y } : { x: anchor.x, y: p.y };
      } else {
        this.brushAxisAnchor = null;
        this.brushAxisHorizontal = null;
      }
      this.brushLastPixel = p;
      this.continueBrush(pixel);
      this.redraw();
      return;
    }
    if ((this.dragMode === "scale" || this.dragMode === "rotate") && this.transformStart && this.moveStart) {
      const layer = this.activeLayer;
      if (!layer) return;
      if (this.dragMode === "scale" && this.transformHandle) {
        const corner = this.transformHandle.hx !== 0 && this.transformHandle.hy !== 0;
        layer.transform = scaleByHandle(this.transformStart, this.transformHandle, p, {
          proportional: corner ? !e.shiftKey : e.shiftKey, // corners keep the ratio unless Shift; edges the opposite
          fromCenter: e.altKey,
        });
      } else {
        layer.transform = rotateByPointer(this.transformStart, this.moveStart, p, e.shiftKey);
      }
      this.redraw();
      return;
    }
    if (this.dragMode === "move" && this.moveStart) {
      const layer = this.activeLayer;
      if (!layer) return;
      // Shift constrains the drag to the dominant axis (measured from where it started).
      const origin = this.moveOrigin ?? this.moveStart;
      let tx = p.x - origin.x, ty = p.y - origin.y;
      if (e.shiftKey) { if (Math.abs(tx) >= Math.abs(ty)) ty = 0; else tx = 0; }
      tx = Math.round(tx); ty = Math.round(ty); // move by whole pixels, as Photoshop does, so nothing gets resampled
      const dx = tx - this.moveApplied.x;
      const dy = ty - this.moveApplied.y;
      this.moveApplied = { x: tx, y: ty };
      if (this.session.selectedLayerIds.length > 1) {
        for (const id of this.session.selectedLayerIds) {
          const l = doc.layers.find((x) => x.id === id);
          if (l) {
            l.transform.x += dx;
            l.transform.y += dy;
          }
        }
      } else {
        layer.transform.x += dx;
        layer.transform.y += dy;
      }
      this.moveStart = p;
      this.redraw();
      return;
    }
    if (this.dragMode === "select-move" && this.selectionMove) {
      const sm = this.selectionMove;
      const dx = Math.round(p.x - sm.start.x), dy = Math.round(p.y - sm.start.y);
      if (dx || dy) sm.moved = true;
      doc.selection = this.translatedSelection(sm.origin, dx, dy, doc.selection?.feather ?? 0);
      this.overlay();
      return;
    }
    if (this.dragMode === "pixel-move" && this.pixelMove) {
      this.movePixels({ x: p.x - this.pixelMove.start.x, y: p.y - this.pixelMove.start.y });
      return;
    }
    if (this.dragMode === "marquee" && this.marqueeStart) {
      const s0 = this.marqueeStart;
      const marquee = this.session.tool === "marquee";
      if (marquee && !e.shiftKey) this.marqueeConstrainArmed = true;
      if (marquee) { p = { x: Math.round(p.x), y: Math.round(p.y) }; this.marqueeDragPixel = p; }
      let dx = p.x - s0.x, dy = p.y - s0.y;
      const constrain = e.shiftKey && (marquee ? this.marqueeConstrainArmed : this.session.tool === "shape");
      if (constrain) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; } // square / circle
      const fromCenter = e.altKey && this.session.tool === "shape"; // the Marquee keeps Option for Subtract
      const x = fromCenter ? s0.x - Math.abs(dx) : Math.min(s0.x, s0.x + dx);
      const y = fromCenter ? s0.y - Math.abs(dy) : Math.min(s0.y, s0.y + dy);
      const w = fromCenter ? Math.abs(dx) * 2 : Math.abs(dx);
      const h = fromCenter ? Math.abs(dy) * 2 : Math.abs(dy);
      if (this.session.tool === "lasso") {
        // Freehand: every move adds a point to the outline (no bounding rectangle).
        const last = this.lassoPoints[this.lassoPoints.length - 1];
        if (!last || Math.hypot(p.x - last[0], p.y - last[1]) >= 0.25) this.lassoPoints.push([p.x, p.y]);
        this.session.lassoPath = this.lassoPoints;
        this.overlay();
        return;
      }
      this.session.cropRect = { x, y, w, h };
      if (this.session.tool === "gradient") {
        this.session.dragLine = { x1: this.marqueeStart.x, y1: this.marqueeStart.y, x2: p.x, y2: p.y };
      }
      this.overlay();
      return;
    }
    if (this.dragMode === "crop" && this.marqueeStart) {
      const s0 = this.marqueeStart;
      let w = Math.abs(p.x - s0.x), h = Math.abs(p.y - s0.y);
      const ratio = this.session.cropRatio;
      if (ratio) { if (w / Math.max(1e-6, h) > ratio) h = w / ratio; else w = h * ratio; } // keep the aspect ratio
      const x = p.x < s0.x ? s0.x - w : s0.x;
      const y = p.y < s0.y ? s0.y - h : s0.y;
      this.session.cropRect = { x, y, w, h };
      this.overlay();
    }
    if (this.dragMode === "crop-handle" && this.transformStart && this.transformHandle) {
      const t = scaleByHandle(this.transformStart, this.transformHandle, p, { proportional: e.shiftKey, fromCenter: e.altKey });
      this.session.cropRect = { x: t.x, y: t.y, w: t.width, h: t.height };
      this.overlay();
    }
    if (this.dragMode === "crop-move" && this.moveStart && this.session.cropRect) {
      const r = this.session.cropRect;
      this.session.cropRect = { ...r, x: r.x + p.x - this.moveStart.x, y: r.y + p.y - this.moveStart.y };
      this.moveStart = p;
      this.overlay();
    }
  }

  /**
   * Store a new selection, combining it with the current one like Photoshop:
   * Shift adds, Alt subtracts, otherwise it replaces.
   */
  /**
   * Combine a new outline with the selection: New replaces, Add unions, Subtract cuts (a
   * subtract with nothing to subtract from is ignored). Every new outline resets the feather.
   */
  private setSelection(path: SelectionPath, mask: HTMLCanvasElement, mode: Selection["mode"]): void {
    const doc = this.doc;
    if (!doc) return;
    if (!this.session.selectionAntialiased && !(path.type === "rect" && !path.ellipse)) thresholdMask(mask);
    const current = doc.selection?.outline ?? doc.selection?.mask;
    if (mode === "replace" || !current) {
      if (mode === "subtract" && !current) return; // nothing to subtract from
      doc.selection = { path, mask, mode: "replace", feather: 0, outline: null };
      return;
    }
    const combined = cloneCanvas(current);
    const ctx = combined.getContext("2d")!;
    ctx.globalCompositeOperation = mode === "subtract" ? "destination-out" : "source-over";
    ctx.drawImage(mask, 0, 0);
    doc.selection = { path, mask: combined, mode, feather: 0, outline: null };
  }

  /** The selection's crisp outline (the coverage itself unless feathered). */
  private selectionOutlineMask(): HTMLCanvasElement | null {
    const sel = this.doc?.selection;
    return sel ? sel.outline ?? sel.mask : null;
  }

  /** A selection that exists but covers nothing ("Empty selection"): edits touch nothing. */
  isSelectionEmpty(): boolean {
    const m = this.selectionOutlineMask();
    return !!m && !maskBounds(m);
  }

  /** Whether a document point lies inside the selection (for moving it). */
  pointInSelection(p: { x: number; y: number }): boolean {
    const doc = this.doc;
    const m = this.selectionOutlineMask();
    if (!doc || !m) return false;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return false;
    return m.getContext("2d")!.getImageData(x, y, 1, 1).data[3] > 127;
  }

  /** Re-apply the feather to a crisp outline (or drop it for feather 0). */
  private featheredSelection(outline: HTMLCanvasElement, feather: number): Selection {
    const path: SelectionPath = this.doc?.selection?.path ?? { type: "rect", x: 0, y: 0, w: 0, h: 0 };
    if (feather <= 0) return { path, mask: outline, mode: "replace", feather: 0, outline: null };
    return { path, mask: gaussianBlur(outline, feather / 2), mode: "replace", feather, outline };
  }

  /** Move the outline by whole pixels; what leaves the canvas comes back intact when moved back. */
  private translatedSelection(originOutline: HTMLCanvasElement, dx: number, dy: number, feather: number): Selection {
    return this.featheredSelection(translateMask(originOutline, dx, dy), feather);
  }

  /** Arrow keys with a selection tool: nudge the outline 1 px (Shift 10), one undo step per press. */
  nudgeSelection(dx: number, dy: number): void {
    const doc = this.doc;
    const outline = this.selectionOutlineMask();
    if (!doc || !outline || this.session.lassoPath) return;
    doc.selection = this.translatedSelection(outline, dx, dy, doc.selection?.feather ?? 0);
    this.commit("Move Selection");
  }

  /** ⌘-arrows: move the selected pixels 1 px (Shift 10). */
  nudgePixels(dx: number, dy: number): void {
    if (!this.beginPixelMove(false, { x: 0, y: 0 })) return;
    this.movePixels({ x: dx, y: dy });
    this.finishPixelMove();
  }

  /** Lift the selected pixels onto a temporary layer so they can be dragged (⌘-drag; ⌘⌥ duplicates). */
  private beginPixelMove(duplicate: boolean, start: { x: number; y: number }): boolean {
    const doc = this.doc;
    const source = this.activeLayer;
    if (!doc || !source?.canvas || source.kind === "group" || source.kind === "adjustment" || this.session.maskSelected || this.pixelMove) return false;
    if (!doc.selection?.mask || this.isSelectionEmpty()) return false;
    const lifted = this.cutout(false);
    if (!lifted) return false;
    const sourceBefore = source.canvas;
    if (!duplicate) this.eraseSelection(source); // punches the hole through the (feathered) coverage
    const floating = createLayer({ name: "Floating Selection", kind: "raster", canvas: lifted.canvas, transform: defaultTransform(lifted.bounds.w, lifted.bounds.h, lifted.bounds.x, lifted.bounds.y) });
    floating.opacity = source.opacity;
    floating.blendMode = source.blendMode;
    this.insertLayerAboveActive(floating);
    this.pixelMove = { sourceId: source.id, floatingId: floating.id, sourceBefore, originMask: doc.selection.outline ?? doc.selection.mask, originOutline: doc.selection.outline ?? null, base: { x: lifted.bounds.x, y: lifted.bounds.y }, start, offset: { x: 0, y: 0 }, duplicate };
    return true;
  }

  private movePixels(offset: { x: number; y: number }): void {
    const doc = this.doc;
    const pm = this.pixelMove;
    if (!doc || !pm) return;
    pm.offset = { x: Math.round(offset.x), y: Math.round(offset.y) };
    const floating = doc.layers.find((l) => l.id === pm.floatingId);
    if (!floating) return;
    floating.transform.x = pm.base.x + pm.offset.x;
    floating.transform.y = pm.base.y + pm.offset.y;
    doc.selection = this.translatedSelection(pm.originMask, pm.offset.x, pm.offset.y, doc.selection?.feather ?? 0);
    this.redraw();
  }

  /** Merge the lifted pixels back into their layer (growing it where they now extend past it). */
  private finishPixelMove(): void {
    const doc = this.doc;
    const pm = this.pixelMove;
    this.pixelMove = null;
    if (!doc || !pm) return;
    const source = doc.layers.find((l) => l.id === pm.sourceId);
    const floating = doc.layers.find((l) => l.id === pm.floatingId);
    doc.layers = doc.layers.filter((l) => l.id !== pm.floatingId);
    this.session.activeLayerId = pm.sourceId;
    this.session.selectedLayerIds = [pm.sourceId];
    if (!source || !floating?.canvas) { this.emit(); return; }
    if (pm.offset.x === 0 && pm.offset.y === 0 && !pm.duplicate) {
      source.canvas = pm.sourceBefore; // nothing moved: exactly as before, no undo step
      doc.selection = this.translatedSelection(pm.originMask, 0, 0, doc.selection?.feather ?? 0);
      this.emit();
      return;
    }
    const c = source.canvas!;
    const t = floating.transform;
    const corners = [{ x: t.x, y: t.y }, { x: t.x + t.width, y: t.y }, { x: t.x, y: t.y + t.height }, { x: t.x + t.width, y: t.y + t.height }]
      .map((q) => docToLayer(source.transform, c.width, c.height, q));
    const lx0 = Math.floor(Math.min(...corners.map((q) => q.x))), ly0 = Math.floor(Math.min(...corners.map((q) => q.y)));
    const lx1 = Math.ceil(Math.max(...corners.map((q) => q.x))), ly1 = Math.ceil(Math.max(...corners.map((q) => q.y)));
    writableLayer(source);
    resizeLayerBitmap(source, Math.max(0, -lx0), Math.max(0, -ly0), Math.max(0, lx1 - c.width), Math.max(0, ly1 - c.height));
    const ctx = source.canvas!.getContext("2d")!;
    enterDocSpace(ctx, source);
    ctx.drawImage(floating.canvas, t.x, t.y, t.width, t.height);
    ctx.restore();
    this.commit(pm.duplicate ? "Duplicate Pixels" : "Move Pixels");
  }

  /** Select › Expand… / Contract…: stroke the outline with a round band and add or cut it. */
  resizeSelection(delta: number): void {
    const doc = this.doc;
    const outline = this.selectionOutlineMask();
    if (!doc || !outline || delta === 0 || Math.abs(delta) > 500 || !maskBounds(outline)) return;
    const seg = selectionOutline(outline);
    const next = cloneCanvas(outline);
    const ctx = next.getContext("2d")!;
    ctx.beginPath();
    for (let i = 0; i < seg.length; i += 4) { ctx.moveTo(seg[i], seg[i + 1]); ctx.lineTo(seg[i + 2], seg[i + 3]); }
    ctx.lineWidth = Math.abs(delta) * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#fff";
    ctx.globalCompositeOperation = delta > 0 ? "source-over" : "destination-out";
    ctx.stroke();
    if (!this.session.selectionAntialiased) thresholdMask(next);
    doc.selection = this.featheredSelection(next, doc.selection?.feather ?? 0);
    this.commit(delta > 0 ? "Expand Selection" : "Contract Selection");
  }

  /** Select › Feather…: soften the edge; repeated feathers stack in quadrature, up to 250 px. */
  featherSelection(amount: number): void {
    const doc = this.doc;
    const outline = this.selectionOutlineMask();
    if (!doc || !outline || amount <= 0 || !maskBounds(outline)) return;
    const current = doc.selection?.feather ?? 0;
    const feather = Math.min(250, Math.sqrt(current * current + amount * amount));
    doc.selection = this.featheredSelection(outline, feather);
    this.commit("Feather Selection");
  }

  /** Select › Layer's Pixels: the active layer's at-least-half-opaque pixels, as placed on the canvas. */
  selectLayerPixels(): void {
    const doc = this.doc;
    const layer = this.activeLayer;
    if (!doc || !layer?.canvas || layer.kind === "group") return;
    const mask = thresholdMask(layerInDocument(doc, layer));
    if (!maskBounds(mask)) return;
    this.setSelection({ type: "rect", x: 0, y: 0, w: doc.width, h: doc.height }, mask, this.session.selectionModeChoice);
    this.commit("Load Layer Selection");
  }

  /** Select › Mask's Black Areas: the hidden part of the active layer's mask. */
  selectMaskBlack(): void {
    const doc = this.doc;
    const layer = this.activeLayer;
    if (!doc || !layer?.mask) return;
    const mask = createCanvas(doc.width, doc.height);
    const ctx = mask.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, doc.width, doc.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(layer.mask.canvas, 0, 0);
    thresholdMask(mask);
    if (!maskBounds(mask)) return;
    this.setSelection({ type: "rect", x: 0, y: 0, w: doc.width, h: doc.height }, mask, this.session.selectionModeChoice);
    this.commit("Load Mask Selection");
  }

  /** ⌘X: copy the selected pixels, then clear them. */
  async cutSelection(): Promise<void> {
    if (!this.doc?.selection?.mask) return;
    if (await this.copyToClipboard(false)) this.clearActive();
  }

  /** Delete: a selection clears its pixels; otherwise the layer (or its mask) goes. */
  deleteKeyPressed(): void {
    if (this.session.lassoPath) { this.removeLastLassoPoint(); return; }
    if (this.doc?.selection) { this.clearActive(); return; }
    const layer = this.activeLayer;
    if (this.session.maskSelected && layer?.mask) { layer.mask = null; this.session.maskSelected = false; this.commit("Delete Mask"); return; }
    this.deleteSelection();
  }

  /** Delete while drawing a polygon: drop the last corner (an empty draft ends). */
  removeLastLassoPoint(): void {
    this.lassoPoints.pop();
    if (!this.lassoPoints.length) { this.cancelLasso(); return; }
    this.session.lassoPath = this.lassoPoints;
    this.overlay();
  }

  pointerUp(_view: HTMLCanvasElement, e: PointerEvent): void {
    const doc = this.doc;
    if (!doc) return;

    if (this.dragMode === "tip") {
      this.dragMode = "none";
      this.tipDrag = null;
      this.emitView();
      return;
    }
    if (this.dragMode === "brush") {
      this.dragMode = "none";
      this.continueBrush(this.brushPointer ?? screenToDoc(_view, doc, this.session, e.clientX, e.clientY));
      this.finishBrush();
      return;
    } else if (this.dragMode === "move") {
      this.commit("Move layer");
    } else if (this.dragMode === "scale" || this.dragMode === "rotate") {
      this.transformStart = null;
      this.transformHandle = null;
      if (this.dragMode === "scale") this.bakeTextScale();
      this.commit(this.dragMode === "scale" ? "Scale layer" : "Rotate layer");
    } else if (this.dragMode === "select-move" && this.selectionMove) {
      const sm = this.selectionMove;
      this.selectionMove = null;
      if (sm.moved) this.commit("Move Selection");
      else if (this.session.tool === "wand") this.magicWand(sm.start, "replace"); // a click inside re-selects from that pixel
      else this.deselect(); // a click inside without a drag deselects
    } else if (this.dragMode === "pixel-move") {
      this.finishPixelMove();
    } else if (this.dragMode === "marquee" && this.marqueeStart) {
      const r = this.session.cropRect;
      if (this.session.tool === "marquee" && (!r || r.w < 1 || r.h < 1)) {
        // A click that encloses nothing: New mode deselects, Add / Subtract do nothing.
        this.session.cropRect = null;
        if (this.downMode === "replace" && doc.selection) this.deselect(); else this.overlay();
      } else if (this.session.tool === "marquee" && r) {
        const mask = createCanvas(doc.width, doc.height);
        const ctx = mask.getContext("2d")!;
        ctx.fillStyle = "#fff";
        if (this.session.marqueeShape === "ellipse") {
          ctx.beginPath();
          ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        this.setSelection({ type: "rect", x: r.x, y: r.y, w: r.w, h: r.h, ellipse: this.session.marqueeShape === "ellipse" }, mask, this.downMode);
        this.session.cropRect = null;
        this.commit(this.session.marqueeShape === "ellipse" ? "Elliptical Marquee" : "Rectangular Marquee");
      } else if (this.session.tool === "lasso") {
        if (this.lassoPoints.length > 2) this.finishLasso(this.downMode);
        else { this.cancelLasso(); if (this.downMode === "replace" && doc.selection) this.deselect(); }
      } else if (this.session.tool === "gradient" && this.session.dragLine) {
        this.applyGradient(this.session.dragLine);
      } else if (this.session.tool === "shape" && r && r.w > 1 && r.h > 1) {
        this.addShapeLayer(r.x, r.y, r.w, r.h);
        this.session.cropRect = null;
      }
    } else if ((this.dragMode === "crop" || this.dragMode === "crop-handle" || this.dragMode === "crop-move") && this.session.cropRect) {
      const r = this.session.cropRect;
      if (r.w < 1 || r.h < 1) this.session.cropRect = null; // a click without a drag: no box
      this.transformStart = null;
      this.transformHandle = null;
    }

    this.dragMode = "none";
    this.marqueeStart = null;
    this.emit();
  }

  /** Close a polygon lasso (double-click, Enter or clicking the first corner). */
  closeLasso(mode: Selection["mode"] = "replace"): void {
    if (this.lassoPoints.length >= 3) this.finishLasso(mode);
    else this.cancelLasso();
  }

  /**
   * Magic Wand: pixels within Tolerance of the clicked colour (every channel, alpha too),
   * read from every visible layer as shown or from the active layer alone. Nothing matched
   * in New mode deselects.
   */
  magicWand(p: { x: number; y: number }, mode: Selection["mode"]): void {
    const doc = this.doc;
    if (!doc) return;
    const s = this.session;
    const sx = Math.floor(p.x), sy = Math.floor(p.y);
    if (sx < 0 || sy < 0 || sx >= doc.width || sy >= doc.height) return;
    const layer = this.activeLayer;
    const src = s.wandSampleAll ? flattenDocument(doc)
      : layer?.canvas && layer.kind !== "group" ? layerInDocument(doc, layer) : createCanvas(doc.width, doc.height);
    const data = imageDataOf(src);
    const mask = s.wandContiguous ? floodSelect(data, sx, sy, s.wandTolerance, s.wandSampleSize) : colorSelect(data, sx, sy, s.wandTolerance, s.wandSampleSize);
    if (!mask) { if (mode === "replace" && doc.selection) this.deselect(); return; }
    this.setSelection({ type: "path", points: [[p.x, p.y]] }, mask, mode);
    this.commit("Magic Wand");
  }

  /** Drop the lasso outline in progress (Esc). */
  cancelLasso(): void {
    this.lassoPoints = [];
    this.session.lassoPath = null;
    this.overlay();
  }

  private finishLasso(mode: Selection["mode"] = "replace"): void {
    const doc = this.doc;
    if (!doc || this.lassoPoints.length < 3) { this.cancelLasso(); return; }
    const mask = createCanvas(doc.width, doc.height);
    const ctx = mask.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(this.lassoPoints[0][0], this.lassoPoints[0][1]);
    for (let i = 1; i < this.lassoPoints.length; i++) ctx.lineTo(this.lassoPoints[i][0], this.lassoPoints[i][1]);
    ctx.closePath();
    ctx.fill();
    const polygon = this.session.lassoMode === "polygon";
    if (!maskBounds(mask)) {
      // An outline with no area: New deselects, Add / Subtract do nothing.
      this.lassoPoints = [];
      this.session.lassoPath = null;
      if (mode === "replace" && doc.selection) this.deselect(); else this.overlay();
      return;
    }
    this.setSelection({ type: "path", points: [...this.lassoPoints] }, mask, mode);
    this.lassoPoints = [];
    this.session.lassoPath = null;
    this.session.cropRect = null;
    this.commit(polygon ? "Polygonal Lasso" : "Lasso");
  }

  /**
   * Gradient tool: like Photoshop, fills a whole layer (or the selection) with a
   * preset gradient (foreground→background, →transparent, black→white; linear or radial)
   * along the drag. Always lands on its own new layer.
   */
  private applyGradient(line: { x1: number; y1: number; x2: number; y2: number }): void {
    const doc = this.doc;
    this.session.dragLine = null;
    this.session.cropRect = null;
    if (!doc) return;
    if (Math.hypot(line.x2 - line.x1, line.y2 - line.y1) < 2) { this.emitView(); return; }
    const layer = this.insertLayerAboveActive(createBlankLayer(doc, `Gradient ${doc.layers.filter((l) => l.name.startsWith("Gradient")).length + 1}`));
    const ctx = layer.canvas!.getContext("2d")!;
    paintGradient(ctx, this.session.gradient, line, this.session.foreground, this.session.background, doc.width, doc.height);
    if (doc.selection?.mask) {
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(doc.selection.mask, 0, 0);
      ctx.globalCompositeOperation = "source-over";
    }
    this.commit("Gradient");
  }

  /** Change the Gradient tool's preset / style / direction; remembered across sessions. */
  setGradient(patch: Partial<GradientSettings>): void {
    this.session.gradient = { ...this.session.gradient, ...patch };
    saveGradientSettings(this.session.gradient);
    this.emitView();
  }

  /** Insert a layer just above the active one (inside its group), select it and return it. */
  private insertLayerAboveActive(layer: Layer): Layer {
    const doc = this.doc!;
    const active = this.activeLayer;
    if (active) {
      doc.layers.splice(doc.layers.indexOf(active) + 1, 0, layer);
      layer.parentId = active.kind === "group" ? active.id : active.parentId;
    } else {
      doc.layers.push(layer);
    }
    this.session.activeLayerId = layer.id;
    this.session.selectedLayerIds = [layer.id];
    return layer;
  }

  /** True while a brush, heal, clone, blur, liquify or smudge stroke is in progress. */
  get painting(): boolean {
    return !!this.stroke || !!this.warp;
  }

  /** True once a right-drag has resized the tip (so the pointer-up must not open the menu). */
  get tipDragMoved(): boolean {
    return !!this.tipDrag?.moved;
  }

  /** Whether the right-drag tip preview should show the hardness ring. */
  get tipHardnessShown(): boolean {
    return !!this.tipDrag?.hardnessShown;
  }

  /** The layer (or its mask) a stroke may paint, following Compositor's `canPaint`. */
  private paintTarget(): { layer: Layer; mask: boolean } | null {
    const doc = this.doc;
    const layer = this.activeLayer;
    if (!doc || !layer || this.session.selectedLayerIds.length > 1) return null;
    if (doc.selection?.mask && !maskBounds(doc.selection.mask)) return null; // an explicitly empty selection paints nothing
    for (let l: Layer | undefined = layer; l; l = l.parentId ? doc.layers.find((x) => x.id === l!.parentId) : undefined) if (!l.visible) return null;
    if (this.session.maskSelected) {
      if (!layer.mask?.enabled) return null;
      if (this.session.tool === "spot-healing" || this.session.tool === "clone-stamp") return null; // they rework image pixels
      if (this.session.tool === "blur" && this.session.smearMode !== "blur") return null;
      return { layer, mask: true };
    }
    if (layer.kind === "group" || layer.kind === "adjustment") return null;
    if (layer.kind === "text" || layer.kind === "shape") {
      // Painting on type or a shape rasterises it, as the Mac app does.
      flattenDocument(doc); // brings the vector bitmap up to date
      layer.kind = "raster";
      layer.text = undefined;
      layer.shape = undefined;
    }
    ensureLayerBitmap(layer);
    return { layer, mask: false };
  }

  /** Option-click with the Clone Stamp: where to copy from. A new source starts a new alignment. */
  setCloneSource(p: { x: number; y: number }): void {
    if (!isFinite(p.x) || !isFinite(p.y)) return;
    this.cloneSource = { ...p };
    this.cloneOffset = null;
  }

  /** Where the Clone Stamp's crosshair sits for a pointer position. */
  cloneSamplePoint(p: { x: number; y: number }): { x: number; y: number } | null {
    if (!this.cloneSource) return null;
    if (!this.cloneOffset || !(this.session.clone.aligned || this.stroke)) return this.cloneSource;
    return { x: p.x + this.cloneOffset.x, y: p.y + this.cloneOffset.y };
  }

  private shiftLineStart(): { x: number; y: number } | null {
    const last = this.lastBrushPoint;
    if (!last || last.layerId !== this.session.activeLayerId || last.mask !== this.session.maskSelected) return null;
    return last.point;
  }

  private beginBrush(p: { x: number; y: number }): void {
    const doc = this.doc;
    if (!doc || this.stroke || this.warp) return;
    const tool = this.session.tool;
    const s = this.session;
    if (tool === "blur" && s.smearMode !== "blur") {
      const target = this.paintTarget();
      if (!target) return;
      if (target.mask) { this.brushError = "Smudge and Liquify work on a layer's pixels, not its mask."; return; }
      this.warp = new WarpStroke(doc, target.layer, this.tip(), s.smearMode);
      this.warp.append(p);
      this.brushPointer = p;
      beginStroke(doc, target.layer.id);
      return;
    }
    if (tool === "clone-stamp" && !this.cloneSource) {
      this.brushError = "Option-click where Clone Stamp should copy from first.";
      return;
    }
    const target = this.paintTarget();
    if (!target) return;
    const { layer, mask } = target;
    const selection = doc.selection?.mask ?? null;
    let mode: StrokeMode;
    const opts: StrokeOptions = { selection };
    if (mask) mode = s.maskPaintWhite ? "mask-reveal" : "mask-hide";
    else if (tool === "brush") mode = s.brushMode === "erase" ? "erase" : "paint";
    else if (tool === "spot-healing") mode = "heal";
    else mode = "clone";
    if (mode === "paint") opts.color = parseHex(s.foreground);
    if (tool === "clone-stamp") {
      if (s.clone.aligned && this.cloneOffset) { /* keep the alignment from the first stroke */ }
      else this.cloneOffset = { x: Math.round(this.cloneSource!.x - p.x), y: Math.round(this.cloneSource!.y - p.y) };
      opts.sample = s.clone.sampleAll ? flattenDocumentCopy(doc) : layerInDocument(doc, layer);
      opts.sampleOffset = { ...this.cloneOffset };
    } else if (tool === "blur") {
      const sigma = Math.min(30, Math.max(1.5, s.brush.size / 10));
      opts.sample = gaussianBlur(mask ? layer.mask!.canvas : layerInDocument(doc, layer), sigma);
      if (mask) mode = "clone"; // blurring a mask copies the softened mask back through the tip
    }
    this.stroke = new BrushStroke(doc, layer, this.tip(), mode, opts);
    this.brushAnchor = p;
    this.brushPointer = p;
    this.stroke.append(p);
    this.lastBrushPoint = { point: p, layerId: layer.id, mask };
    beginStroke(doc, layer.id);
  }

  private tip(): StrokeTip {
    const b = this.session.brush;
    return { diameter: b.size, hardness: b.hardness, opacity: b.opacity };
  }

  /** Smoothing: the brush is dragged only when the pointer pulls its string taut. */
  private smoothed(p: { x: number; y: number }): { x: number; y: number } | null {
    const b = this.session.brush;
    if (this.session.tool !== "brush" || b.smoothing <= 0 || !this.brushAnchor) return p;
    const radius = b.smoothing / Math.max(0.01, this.session.zoom || 1);
    const dx = p.x - this.brushAnchor.x, dy = p.y - this.brushAnchor.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= radius) return null;
    const step = (dist - radius) / dist;
    this.brushAnchor = { x: this.brushAnchor.x + dx * step, y: this.brushAnchor.y + dy * step };
    return this.brushAnchor;
  }

  private continueBrush(p: { x: number; y: number }): void {
    this.brushPointer = p;
    if (this.warp) { this.warp.append(p); return; }
    const stroke = this.stroke;
    if (!stroke) return;
    const q = this.smoothed(p);
    if (!q) return;
    stroke.append(q);
    if (this.lastBrushPoint) this.lastBrushPoint.point = q;
  }

  private finishBrush(): void {
    const doc = this.doc;
    if (!doc) return;
    if (this.warp) {
      const warp = this.warp;
      this.warp = null;
      const commit = warp.finish(doc, doc.selection?.mask ?? null);
      endStroke();
      if (commit && commit.finish()) this.commit(warp.mode === "liquify" ? "Liquify" : "Smudge");
      else this.emit();
      return;
    }
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;
    if (this.brushPointer && this.brushAnchor && (this.brushPointer.x !== this.brushAnchor.x || this.brushPointer.y !== this.brushAnchor.y)) {
      stroke.append(this.brushPointer); // the stroke ends where the hand did, even with smoothing
    }
    if (stroke.mode === "heal") this.healStroke(stroke);
    const changed = stroke.finish();
    endStroke();
    this.brushAnchor = null;
    if (!changed) { this.emit(); return; }
    const mask = stroke.mode === "mask-reveal" || stroke.mode === "mask-hide";
    this.commit(mask ? "Paint Mask" : stroke.mode === "erase" ? "Erase" : stroke.mode === "heal" ? "Spot Healing"
      : this.session.tool === "blur" ? "Blur" : stroke.mode === "clone" ? "Clone Stamp" : "Brush Stroke");
  }

  /** Esc: drop the stroke in progress; the layer is exactly as before. */
  cancelBrush(): void {
    if (this.warp) { this.warp.cancel(); this.warp = null; }
    if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
    this.dragMode = "none";
    this.brushAnchor = null;
    endStroke();
    this.emit();
  }

  /** Replace the healing wash with pixels rebuilt from the surroundings. */
  private healStroke(stroke: BrushStroke): void {
    const doc = this.doc;
    const layer = this.activeLayer;
    const painted = stroke.bounds;
    if (!doc || !layer?.canvas || !painted) return;
    // Room for the patch search, which looks up to about three spot-widths away.
    const reach = Math.ceil((Math.max(painted.w, painted.h) + 32) * 3.2);
    const rx0 = Math.max(0, Math.floor(painted.x - reach)), ry0 = Math.max(0, Math.floor(painted.y - reach));
    const rx1 = Math.min(doc.width, Math.ceil(painted.x + painted.w + reach)), ry1 = Math.min(doc.height, Math.ceil(painted.y + painted.h + reach));
    const region = { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 };
    if (region.w <= 0 || region.h <= 0) return;
    // Heal the layer's original pixels (never the wash), in document space.
    stroke.cancel();
    const original = layerInDocument(doc, layer);
    const img = original.getContext("2d")!.getImageData(region.x, region.y, region.w, region.h);
    const coverage = stroke.coverageBytes(region);
    spotHeal(img.data, coverage, region.w, region.h, stroke.tip.opacity, this.session.healMode, (Math.random() * 0xffffffff) >>> 0);
    // Restore the working bitmap and write the healed pixels through the coverage.
    writableLayer(layer);
    stroke.applyResult(img, region);
  }

  /** X in Photoshop: exchange foreground and background colours. */
  swapColors(): void {
    if (this.painting) return;
    if (this.session.maskSelected) { this.session.maskPaintWhite = !this.session.maskPaintWhite; this.emitView(); return; }
    const { foreground, background } = this.session;
    this.session.foreground = background;
    this.session.background = foreground;
    this.emitView();
  }

  /** D in Photoshop: black foreground over white background. */
  resetColors(): void {
    if (this.painting) return;
    if (this.session.maskSelected) { this.session.maskPaintWhite = false; this.emitView(); return; }
    this.session.foreground = "#000000";
    this.session.background = "#ffffff";
    this.emitView();
  }

  /** `[` / `]` change the brush size, `Shift+[` / `]` the hardness — as in Photoshop. */
  adjustBrush(step: 1 | -1, hardness = false): void {
    if (this.painting) return;
    const b = this.session.brush;
    if (hardness) {
      // Photoshop's 25 % steps: 0.8 goes up to 1 and down to 0.75.
      const quarter = b.hardness * 4;
      const stepped = step > 0 ? Math.floor(quarter + 0.001) + 1 : Math.ceil(quarter - 0.001) - 1;
      b.hardness = Math.min(4, Math.max(0, stepped)) / 4;
    } else {
      const stepped = step > 0 ? Math.max(b.size + 1, Math.round(b.size * 1.2)) : Math.min(b.size - 1, Math.round(b.size / 1.2));
      b.size = Math.min(2000, Math.max(1, stepped));
    }
    this.emitView();
  }

  isTransformable(layer: Layer): boolean {
    return layer.kind === "raster" || layer.kind === "text" || layer.kind === "shape";
  }

  /** Cursor for the pointer hovering (not dragging) at a screen position. */
  cursorAt(view: HTMLCanvasElement, e: PointerEvent): string {
    const doc = this.doc;
    const layer = this.activeLayer;
    if (!doc) return "";
    if (this.session.tool === "crop") {
      const r = this.session.cropRect;
      if (!r || r.w <= 0 || r.h <= 0) return "crosshair";
      const hit = hitTest(cropTransform(r), screenToDoc(view, doc, this.session, e.clientX, e.clientY), this.session.zoom, 7, 0);
      return hit.kind === "outside" ? "crosshair" : cursorFor(hit, 0);
    }
    if (this.session.tool !== "move") return "";
    if (!layer || !this.isTransformable(layer)) return "move";
    const p = screenToDoc(view, doc, this.session, e.clientX, e.clientY);
    const hit = hitTest(layer.transform, p, this.session.zoom);
    return hit.kind === "outside" ? "move" : cursorFor(hit, layer.transform.rotation);
  }

  /** Set transform fields from the Move tool header (live); commit on `change`. */
  setTransform(patch: Partial<Transform>): void {
    const layer = this.activeLayer;
    if (!layer) return;
    Object.assign(layer.transform, patch);
    layer.transform.width = Math.max(1, layer.transform.width);
    layer.transform.height = Math.max(1, layer.transform.height);
    this.redraw();
  }

  /**
   * Scaling type with the handles changes its font size, as Photoshop's Free Transform does, so the
   * Size field stays truthful and the glyphs are re-rendered rather than stretched. A non-uniform
   * stretch keeps its ratio (the bitmap is still rasterized at the displayed size).
   */
  private bakeTextScale(): void {
    const layer = this.activeLayer;
    if (!layer?.text) return;
    const { sx, sy } = textScale(layer);
    const s = Math.abs(sx - sy) < 0.02 ? sx : Math.min(sx, sy);
    if (Math.abs(s - 1) < 1e-3) return;
    const t = layer.text;
    const fontSize = Math.max(1, Math.round(t.fontSize * s));
    const applied = fontSize / t.fontSize;
    t.fontSize = fontSize;
    t.letterSpacing = Math.round(t.letterSpacing * applied * 100) / 100;
    if (layer.id === this.session.activeLayerId) Object.assign(this.session.text, { fontSize: t.fontSize, letterSpacing: t.letterSpacing });
    writableLayer(layer);
    fitTextLayer(layer, { sx: sx / applied, sy: sy / applied });
    layer.transform.x = Math.round(layer.transform.x);
    layer.transform.y = Math.round(layer.transform.y);
  }

  /** Undo scaling and rotation: back to the bitmap's own size, no flips. */
  resetTransform(): void {
    const layer = this.activeLayer;
    if (!layer?.canvas) return;
    const c = layer.transform;
    const cx = c.x + c.width / 2, cy = c.y + c.height / 2;
    const natural = layer.kind === "text" && layer.text ? textNaturalSize(layer) : null;
    const w = natural ? natural.w : layer.canvas.width;
    const h = natural ? natural.h : layer.canvas.height;
    layer.transform = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h, rotation: 0, flipH: false, flipV: false };
    this.commit("Reset transform");
  }

  flipActive(axis: "h" | "v"): void {
    const layer = this.activeLayer;
    if (!layer) return;
    if (axis === "h") layer.transform.flipH = !layer.transform.flipH;
    else layer.transform.flipV = !layer.transform.flipV;
    this.commit(axis === "h" ? "Flip horizontal" : "Flip vertical");
  }

  nudge(dx: number, dy: number): void {
    const doc = this.doc;
    if (!doc) return;
    for (const id of this.session.selectedLayerIds) {
      const l = doc.layers.find((x) => x.id === id);
      if (l) {
        l.transform.x += dx;
        l.transform.y += dy;
      }
    }
    this.commit("Nudge");
  }

  fit(view: HTMLCanvasElement): void {
    const doc = this.doc;
    if (!doc) return;
    this.session.zoom = fitZoom(doc, view);
    this.session.panX = 0;
    this.session.panY = 0;
    this.pendingFit = false;
    this.emitView();
  }

  /** Called by the UI before each draw so new or switched documents are fitted once the canvas has a size. */
  maybeFit(view: HTMLCanvasElement): void {
    if (this.pendingFit && view.clientWidth > 0) {
      this.session.zoom = fitZoom(this.doc ?? createDocument(1, 1), view);
      this.session.panX = 0;
      this.session.panY = 0;
      this.pendingFit = false;
    }
  }
}

function labelForAdjustment(kind: string): string {
  const map: Record<string, string> = {
    hsv: "Hue/Saturation",
    levels: "Levels",
    curves: "Curves",
    exposure: "Exposure",
    "gradient-map": "Gradient Map",
    grain: "Grain",
    "add-noise": "Add Noise",
    "gaussian-blur": "Gaussian Blur",
    "motion-blur": "Motion Blur",
    invert: "Invert",
    "black-white": "Black & White",
    "color-balance": "Color Balance",
  };
  return map[kind] ?? kind;
}

function defaultAdjustment(kind: NonNullable<Layer["adjustmentKind"]>): Layer["adjustment"] {
  switch (kind) {
    case "hsv":
      return { hue: 0, saturation: 0, lightness: 0, colorize: false };
    case "levels":
      return { levels: { black: 0, white: 1, gamma: 1, outBlack: 0, outWhite: 1 } };
    case "curves":
      return { curves: { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] } };
    case "exposure":
      return { exposure: { exposure: 0, offset: 0, gamma: 1 } };
    case "gradient-map":
      return { gradientMap: { stops: [{ t: 0, color: "#000000" }, { t: 1, color: "#ffffff" }], reverse: false } };
    case "grain":
      return { grain: { amount: 0.15, size: 1 } };
    case "add-noise":
      return { noise: { amount: 0.1, monochrome: true } };
    case "gaussian-blur":
      return { blurRadius: 6 };
    case "motion-blur":
      return { motion: { angle: 0, distance: 10 } };
    case "invert":
      return {};
    case "black-white":
      return { blackWhite: { red: 40, yellow: 60, green: 40, cyan: 60, blue: 20, magenta: 80 } };
    case "color-balance":
      return { colorBalance: { shadows: [0, 0, 0], mids: [0, 0, 0], highs: [0, 0, 0] } };
    default:
      return {};
  }
}

export { uid };
