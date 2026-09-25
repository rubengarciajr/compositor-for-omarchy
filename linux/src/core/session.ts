import type {
  BrushSettings,
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
import { History, snapshot, writableLayer } from "./history";

/** The crop box as an (unrotated) transform, so the Move tool's handle maths applies to it. */
function cropTransform(r: { x: number; y: number; w: number; h: number }): Transform {
  return { x: r.x, y: r.y, width: r.w, height: r.h, rotation: 0, flipH: false, flipV: false };
}

/** Photoshop's selection modifiers: Shift adds to the selection, Alt subtracts from it. */
function selectionMode(e: { shiftKey?: boolean; altKey?: boolean }): Selection["mode"] {
  if (e.shiftKey) return "add";
  if (e.altKey) return "subtract";
  return "replace";
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
  blurSpot,
  healSpot,
  maskBounds,
  stampBrush,
  canvasFromImageData,
} from "./pixels";
import { flattenDocument, flattenDocumentCopy, fitZoom, screenToDoc, ensureLayerBitmap, setEditingLayer, beginStroke, endStroke } from "../render/compositor";
import { toLocal } from "./transform";
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
  private strokePrev: { x: number; y: number } | null = null;
  private cloneSource: { x: number; y: number } | null = null;
  private marqueeStart: { x: number; y: number } | null = null;
  private lassoPoints: [number, number][] = [];
  private dragMode: "none" | "pan" | "move" | "crop" | "crop-handle" | "crop-move" | "marquee" | "brush" | "scale" | "rotate" = "none";
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
      brush: { size: 24, hardness: 0.6, opacity: 1, flow: 1, spacing: 0.25, smoothing: 0.2, erase: false },
      foreground: "#000000",
      background: "#ffffff",
      marqueeShape: "rect",
      lassoMode: "free",
      wandContiguous: true,
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
  /** Where the last paint stroke ended; Shift-click continues from here with a straight line. */
  private lastStrokeEnd: { x: number; y: number } | null = null;
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
  selectLayer(id: string, opts: { toggle?: boolean; range?: boolean } = {}): void {
    const doc = this.doc;
    if (!doc) return;
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
    if (this.session.textEdit && tool !== "type") this.endTextEdit(true);
    this.session.tool = tool;
    if (tool === "crop" && this.doc?.selection?.mask && !this.session.cropRect) {
      // With a selection, the crop box starts at its bounds (Compositor 1.2.5).
      const b = maskBounds(this.doc.selection.mask);
      if (b) this.session.cropRect = { ...b };
    }
    if (tool === "eraser") this.session.brush.erase = true;
    if (tool === "brush") this.session.brush.erase = false;
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

  fillActive(color = this.session.foreground): void {
    const doc = this.doc;
    const layer = this.paintableLayer();
    if (!doc || !layer || !layer.canvas) return;
    ensureLayerBitmap(layer);
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
    this.enterDocSpace(ctx, layer);
    ctx.drawImage(fill, 0, 0);
    ctx.restore();
    this.commit("Fill");
  }

  clearActive(): void {
    const doc = this.doc;
    const layer = this.activeLayer;
    if (!doc || !layer || !layer.canvas) return;
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
    this.enterDocSpace(ctx, layer);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(mask, 0, 0);
    ctx.restore();
  }

  /* ── Selection commands (Photoshop's Select menu) ──────────────────────── */

  hasSelection(): boolean {
    return !!this.doc?.selection?.mask;
  }

  selectAll(): void {
    const doc = this.doc;
    if (!doc) return;
    const mask = createCanvas(doc.width, doc.height);
    const ctx = mask.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, doc.width, doc.height);
    doc.selection = { path: { type: "rect", x: 0, y: 0, w: doc.width, h: doc.height }, mask, mode: "replace" };
    this.commit("Select all");
  }

  deselect(): void {
    const doc = this.doc;
    if (!doc?.selection) return;
    doc.selection = null;
    this.commit("Deselect");
  }

  invertSelection(): void {
    const doc = this.doc;
    if (!doc?.selection?.mask) return;
    const mask = createCanvas(doc.width, doc.height);
    const ctx = mask.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, doc.width, doc.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(doc.selection.mask, 0, 0);
    doc.selection = { path: { type: "rect", x: 0, y: 0, w: doc.width, h: doc.height }, mask, mode: "replace" };
    this.commit("Select inverse");
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
      transform: defaultTransform(1, 1, x, y),
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

    if (tool === "brush" || tool === "eraser" || tool === "blur" || tool === "clone-stamp" || tool === "spot-healing") {
      if (e.altKey && (tool === "brush" || tool === "eraser")) {
        // Alt with a paint tool samples a colour, like Photoshop's temporary Eyedropper.
        this.sampleColor(p, false);
        return;
      }
      this.dragMode = "brush";
      // Shift-click: a straight stroke from where the last one ended.
      this.strokePrev = e.shiftKey && this.lastStrokeEnd ? this.lastStrokeEnd : p;
      this.paintAt(p, e.altKey); // may create the layer to paint on
      const target = this.activeLayer;
      if (target) beginStroke(doc, target.id);
      this.redraw();
      return;
    }
    if (tool === "marquee" || tool === "lasso" || tool === "wand") {
      if (tool === "wand") {
        const src = flattenDocument(doc);
        const sx = Math.min(doc.width - 1, Math.max(0, Math.round(p.x))), sy = Math.min(doc.height - 1, Math.max(0, Math.round(p.y)));
        const mask = this.session.wandContiguous
          ? floodSelect(imageDataOf(src), sx, sy, this.session.wandTolerance)
          : colorSelect(imageDataOf(src), sx, sy, this.session.wandTolerance);
        this.setSelection({ type: "path", points: [[p.x, p.y]] }, mask, selectionMode(e));
        this.commit("Magic wand");
        return;
      }
      if (tool === "lasso" && this.session.lassoMode === "polygon") {
        // Click adds a corner; clicking the first corner (or double-click / Enter) closes.
        const first = this.lassoPoints[0];
        if (first && this.lassoPoints.length >= 3 && Math.hypot(p.x - first[0], p.y - first[1]) * this.session.zoom < 10) {
          this.finishLasso(selectionMode(e));
          return;
        }
        this.lassoPoints.push([p.x, p.y]);
        this.session.lassoPath = this.lassoPoints;
        this.overlay();
        return;
      }
      this.dragMode = "marquee";
      this.marqueeStart = p;
      this.downMode = selectionMode(e); // Shift/Alt at the click choose add/subtract; during the drag they constrain
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
    const p = screenToDoc(view, doc, this.session, e.clientX, e.clientY);
    if (this.dragMode === "pan" && this.moveStart) {
      this.session.panX = e.clientX - this.moveStart.x;
      this.session.panY = e.clientY - this.moveStart.y;
      this.emitView();
      return;
    }
    if (this.dragMode === "brush") {
      this.paintAt(p, e.altKey);
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
    if (this.dragMode === "marquee" && this.marqueeStart) {
      const s0 = this.marqueeStart;
      let dx = p.x - s0.x, dy = p.y - s0.y;
      const constrain = e.shiftKey && (this.session.tool === "marquee" || this.session.tool === "shape");
      if (constrain) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; } // square / circle
      const fromCenter = e.altKey && (this.session.tool === "marquee" || this.session.tool === "shape");
      const x = fromCenter ? s0.x - Math.abs(dx) : Math.min(s0.x, s0.x + dx);
      const y = fromCenter ? s0.y - Math.abs(dy) : Math.min(s0.y, s0.y + dy);
      const w = fromCenter ? Math.abs(dx) * 2 : Math.abs(dx);
      const h = fromCenter ? Math.abs(dy) * 2 : Math.abs(dy);
      if (this.session.tool === "lasso") {
        // Freehand: every move adds a point to the outline (no bounding rectangle).
        const last = this.lassoPoints[this.lassoPoints.length - 1];
        if (!last || Math.hypot(p.x - last[0], p.y - last[1]) * this.session.zoom >= 1.5) this.lassoPoints.push([p.x, p.y]);
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
  private setSelection(path: SelectionPath, mask: HTMLCanvasElement, mode: Selection["mode"]): void {
    const doc = this.doc;
    if (!doc) return;
    const current = doc.selection?.mask;
    if (mode === "replace" || !current) {
      if (mode === "subtract" && !current) return; // nothing to subtract from
      doc.selection = { path, mask, mode: "replace" };
      return;
    }
    const combined = cloneCanvas(current);
    const ctx = combined.getContext("2d")!;
    ctx.globalCompositeOperation = mode === "subtract" ? "destination-out" : "source-over";
    ctx.drawImage(mask, 0, 0);
    doc.selection = { path, mask: combined, mode };
  }

  pointerUp(_view: HTMLCanvasElement, e: PointerEvent): void {
    const doc = this.doc;
    if (!doc) return;

    if (this.dragMode === "brush") {
      this.lastStrokeEnd = this.strokePrev;
      this.strokePrev = null;
      endStroke();
      this.commit("Paint");
    } else if (this.dragMode === "move") {
      this.commit("Move layer");
    } else if (this.dragMode === "scale" || this.dragMode === "rotate") {
      this.transformStart = null;
      this.transformHandle = null;
      if (this.dragMode === "scale") this.bakeTextScale();
      this.commit(this.dragMode === "scale" ? "Scale layer" : "Rotate layer");
    } else if (this.dragMode === "marquee" && this.marqueeStart) {
      const r = this.session.cropRect;
      if (this.session.tool === "marquee" && r && r.w > 1 && r.h > 1) {
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
        this.commit("Marquee selection");
      } else if (this.session.tool === "lasso") {
        if (this.lassoPoints.length > 2) this.finishLasso(selectionMode(e));
        else this.cancelLasso();
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
    this.setSelection({ type: "path", points: [...this.lassoPoints] }, mask, mode);
    this.lassoPoints = [];
    this.session.lassoPath = null;
    this.session.cropRect = null;
    this.commit("Lasso selection");
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

  /**
   * Paint tools need a raster layer. When the active layer is a group, adjustment,
   * text or shape (or there is none), a new blank layer is created for the stroke.
   */
  private paintableLayer(): Layer | null {
    const doc = this.doc;
    if (!doc) return null;
    const active = this.activeLayer;
    if (active?.kind === "raster") return active;
    return this.insertLayerAboveActive(createBlankLayer(doc, `Layer ${doc.layers.filter((l) => l.name.startsWith("Layer")).length + 1}`));
  }

  /**
   * Make `ctx` (a layer bitmap) accept document coordinates: the inverse of the layer's
   * transform (position, size vs. bitmap size, rotation, flips). Without this, painting on a
   * moved, scaled or pasted layer lands away from the pointer.
   */
  private enterDocSpace(ctx: CanvasRenderingContext2D, layer: Layer): void {
    const t = layer.transform;
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const sx = t.width / Math.max(1, cw), sy = t.height / Math.max(1, ch);
    ctx.save();
    ctx.scale(1 / sx, 1 / sy);
    ctx.translate(t.width / 2, t.height / 2);
    ctx.scale(t.flipH ? -1 : 1, t.flipV ? -1 : 1);
    ctx.rotate((-t.rotation * Math.PI) / 180);
    ctx.translate(-(t.x + t.width / 2), -(t.y + t.height / 2));
  }

  private paintAt(p: { x: number; y: number }, altKey: boolean): void {
    const doc = this.doc;
    const layer = this.paintableLayer();
    if (!doc || !layer) return;

    if (this.session.tool === "clone-stamp") {
      if (altKey) {
        this.cloneSource = { ...p };
        return;
      }
      if (!this.cloneSource || !layer.canvas) return;
      ensureLayerBitmap(layer);
      const ctx = writableLayer(layer)!.getContext("2d")!;
      const src = flattenDocument(doc);
      const b = this.session.brush;
      const sx = this.cloneSource.x + (p.x - (this.strokePrev?.x ?? p.x));
      const sy = this.cloneSource.y + (p.y - (this.strokePrev?.y ?? p.y));
      this.enterDocSpace(ctx, layer);
      ctx.globalAlpha = b.opacity;
      ctx.beginPath();
      ctx.arc(p.x, p.y, b.size / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(src, this.strokePrev ? p.x - this.strokePrev.x : 0, this.strokePrev ? p.y - this.strokePrev.y : 0);
      // sample from source point
      ctx.drawImage(src, sx - p.x, sy - p.y);
      ctx.restore();
      this.strokePrev = p;
      return;
    }

    ensureLayerBitmap(layer);
    const ctx = writableLayer(layer)!.getContext("2d")!;
    const b: BrushSettings = this.session.brush;
    const erase = this.session.tool === "eraser" || b.erase;

    if (this.session.tool === "blur" || this.session.tool === "spot-healing") {
      // Retouch tools work in the layer's own pixels around the pointer.
      const steps = this.strokePrev ? Math.max(1, Math.ceil(Math.hypot(p.x - this.strokePrev.x, p.y - this.strokePrev.y) / Math.max(1, b.size * 0.5))) : 1;
      for (let i = 1; i <= steps; i++) {
        const dp = this.strokePrev ? { x: this.strokePrev.x + ((p.x - this.strokePrev.x) * i) / steps, y: this.strokePrev.y + ((p.y - this.strokePrev.y) * i) / steps } : p;
        const q = this.layerPixel(layer, dp);
        if (!q) continue;
        const r = Math.max(1, (b.size / 2) * q.scale);
        if (this.session.tool === "blur") blurSpot(ctx, q.x, q.y, r, b.opacity * b.flow);
        else healSpot(ctx, q.x, q.y, r);
      }
      this.strokePrev = p;
      return;
    }
    this.enterDocSpace(ctx, layer);

    if (this.strokePrev) {
      const dx = p.x - this.strokePrev.x;
      const dy = p.y - this.strokePrev.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(dist / Math.max(1, b.size * b.spacing)));
      for (let i = 1; i <= steps; i++) {
        const x = this.strokePrev.x + (dx * i) / steps;
        const y = this.strokePrev.y + (dy * i) / steps;
        stampBrush(ctx, x, y, b.size, b.hardness, this.session.foreground, b.opacity * b.flow, erase);
      }
    } else {
      stampBrush(ctx, p.x, p.y, b.size, b.hardness, this.session.foreground, b.opacity * b.flow, erase);
    }
    ctx.restore();
    this.strokePrev = p;
  }

  /** X in Photoshop: exchange foreground and background colours. */
  swapColors(): void {
    const { foreground, background } = this.session;
    this.session.foreground = background;
    this.session.background = foreground;
    this.emitView();
  }

  /** D in Photoshop: black foreground over white background. */
  resetColors(): void {
    this.session.foreground = "#000000";
    this.session.background = "#ffffff";
    this.emitView();
  }

  /** `[` / `]` change the brush size, `Shift+[` / `]` the hardness — as in Photoshop. */
  adjustBrush(step: 1 | -1, hardness = false): void {
    const b = this.session.brush;
    if (hardness) {
      b.hardness = Math.min(1, Math.max(0, Math.round((b.hardness + step * 0.25) * 100) / 100));
    } else {
      // Photoshop steps grow with the size: 1 px below 10, then ~10%.
      const delta = b.size < 10 ? 1 : b.size < 100 ? 10 : Math.round(b.size * 0.1);
      b.size = Math.min(2000, Math.max(1, b.size + step * delta));
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
