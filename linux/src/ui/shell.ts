import type { BlendMode, DocumentState, Layer, ToolId } from "../core/model";
import { BLEND_GROUPS, BLEND_LABELS, layerTree } from "../core/model";
import type { App } from "../core/session";
import { drawEditor, flattenDocument, screenToDoc } from "../render/compositor";
import { drawAnts } from "../render/ants";
import { APP_NAME, APP_VERSION, ISSUES_URL, ORIGINAL_AUTHOR, ORIGINAL_COMPANY, ORIGINAL_REPO_URL, ORIGINAL_SITE_URL, PROJECT_URL, rendererName } from "../app-info";
const compositorApi = { screenToDoc };
import { boxCorners, handlePositions, rotationHandle } from "../core/transform";
import { PAINT_TOOLS, cursorForTool, MOVE_CURSOR, DUPLICATE_CURSOR, ROTATE_CURSOR } from "./cursors";
import { icon, iconEl } from "./icons";
import { THEME_CHOICES, applyThemeChoice, themeChoice } from "../theme/omarchy";
import type { IconName } from "./icons";
import { cssFont, textPad, textScale } from "../core/pixels";
import { GRADIENT_PRESETS, gradientCss, gradientStops } from "../core/gradient";
import type { GradientStyle } from "../core/gradient";

/**
 * Shortcut labels are written Mac-style ("⇧⌘E") and rendered per platform.
 * Chromium *app* windows deliver every shortcut to the page (unlike tabs), so the
 * Photoshop keys Ctrl+N / Ctrl+Shift+N / Ctrl+T / Ctrl+W / Ctrl+Q are handled here.
 */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
function keyLabel(mac: string): string {
  if (IS_MAC) return mac;
  const mods = [mac.includes("⌘") && "Ctrl", mac.includes("⌥") && "Alt", mac.includes("⇧") && "Shift"].filter(Boolean);
  const key = mac.replace(/[⌘⌥⇧]/g, "").replace(/⌫/g, "Backspace");
  return [...mods, key].join("+");
}

/** The tool rail in Compositor's order; the "no tool" state (A) has no button. */
const TOOL_META: { id: ToolId; icon: IconName; title: string; key: string }[] = [
  { id: "move", icon: "move", title: "Move / Transform (V)", key: "v" },
  { id: "marquee", icon: "marquee", title: "Marquee (M)", key: "m" },
  { id: "lasso", icon: "lasso", title: "Lasso (L)", key: "l" },
  { id: "wand", icon: "wand", title: "Magic Wand (W)", key: "w" },
  { id: "crop", icon: "crop", title: "Crop (C)", key: "c" },
  { id: "brush", icon: "brush", title: "Brush (B) · Eraser (E)", key: "b" },
  { id: "spot-healing", icon: "bandage", title: "Spot Healing Brush (J)", key: "j" },
  { id: "clone-stamp", icon: "stamp", title: "Clone Stamp (S) · Alt-click sets the source", key: "s" },
  { id: "blur", icon: "droplet", title: "Smear (R)", key: "r" },
  { id: "gradient", icon: "gradient", title: "Gradient (G)", key: "g" },
  { id: "shape", icon: "shape", title: "Shape (U) · Shift-U switches the shape", key: "u" },
  { id: "type", icon: "type", title: "Type (T)", key: "t" },
  { id: "eyedropper", icon: "pipette", title: "Eyedropper (I)", key: "i" },
  { id: "hand", icon: "hand", title: "Hand (H)", key: "h" },
  { id: "zoom", icon: "zoom", title: "Zoom (Z)", key: "z" },
];

export interface UIRoot {
  destroy(): void;
  refresh(): void;
}

/** Families offered before the user loads the system list (all ship with Omarchy or are common). */
const CURATED_FONTS = [
  "Noto Sans", "Noto Serif", "Adwaita Sans", "Adwaita Mono", "Liberation Sans", "Liberation Serif",
  "Liberation Mono", "Nimbus Sans", "Nimbus Roman", "JetBrainsMono Nerd Font", "FiraCode Nerd Font",
  "CaskaydiaMono Nerd Font", "iA Writer Quattro S", "Inter", "DejaVu Sans", "DejaVu Serif",
];
const FONT_WEIGHTS: [number, string][] = [[300, "Light"], [400, "Regular"], [500, "Medium"], [600, "Semibold"], [700, "Bold"], [800, "Extra Bold"]];
let localFamilies: string[] | null = null;

/** Installed font families via the Local Font Access API (Chromium; asks once). */
async function loadLocalFonts(): Promise<string[]> {
  if (localFamilies) return localFamilies;
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!q) throw new Error("This browser cannot list system fonts");
  const fonts = await q.call(window);
  localFamilies = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  return localFamilies;
}

/** The active palette source is kept on <html data-theme-source-label> for debugging; there is no UI badge. */
export function setThemeSourceLabel(source: string): void {
  document.documentElement.dataset.themeSourceLabel = source;
}

export function mountUI(app: App, host: HTMLElement): UIRoot {
  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "app-shell";
  host.appendChild(root);

  root.innerHTML = `
    <div class="menu-bar" id="menu-bar"></div>
    <div class="tool-header" id="tool-header"></div>
    <div class="workspace">
      <div class="tool-rail" id="tool-rail"></div>
      <div class="canvas-wrap" id="canvas-wrap">
        <canvas class="editor" id="editor"></canvas>
      </div>
      <aside class="layers-panel" id="layers-panel"></aside>
    </div>
    <div class="status-bar" id="status-bar"></div>
  `;

  const menuBar = root.querySelector<HTMLElement>("#menu-bar")!;
  const toolHeader = root.querySelector<HTMLElement>("#tool-header")!;
  const toolRail = root.querySelector<HTMLElement>("#tool-rail")!;
  const canvasWrap = root.querySelector<HTMLElement>("#canvas-wrap")!;
  const canvas = root.querySelector<HTMLCanvasElement>("#editor")!;
  const layersPanel = root.querySelector<HTMLElement>("#layers-panel")!;
  const statusBar = root.querySelector<HTMLElement>("#status-bar")!;

  let openMenu: string | null = null;
  let raf = 0;

  const requestDraw = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      app.maybeFit(canvas);
      syncTextEditor();
      const doc = app.doc;
      drawEditor(canvas, doc, app.session, (ctx) => {
        if (doc?.selection?.mask) drawAnts(ctx, doc.selection.outline ?? doc.selection.mask, app.session.zoom || 1, performance.now() / 120);
        drawTransformControls(ctx);
        drawBrushPreview(ctx);
        const ge = app.gradientEdit;
        if (ge && app.gradientHasLine() && app.session.tool !== "crop") {
          const z = app.session.zoom || 1;
          const g = app.session.gradient;
          const stops = gradientStops(g.preset, app.session.foreground, app.session.background, g.reverse);
          ctx.save();
          if (g.style === "radial") {
            ctx.setLineDash([4 / z, 4 / z]);
            ctx.beginPath(); ctx.arc(ge.start.x, ge.start.y, Math.hypot(ge.end.x - ge.start.x, ge.end.y - ge.start.y), 0, Math.PI * 2);
            ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.lineWidth = 2 / z; ctx.stroke();
            ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 1 / z; ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.beginPath(); ctx.moveTo(ge.start.x, ge.start.y); ctx.lineTo(ge.end.x, ge.end.y);
          ctx.strokeStyle = "rgba(0,0,0,0.7)"; ctx.lineWidth = 3 / z; ctx.stroke();
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 1 / z; ctx.stroke();
          for (const [pt, color] of [[ge.start, stops[0].color], [ge.end, stops[stops.length - 1].color]] as const) {
            ctx.beginPath(); ctx.arc(pt.x, pt.y, 6 / z, 0, Math.PI * 2);
            ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#000"; ctx.lineWidth = 1 / z; ctx.stroke();
            ctx.beginPath(); ctx.arc(pt.x, pt.y, 3.5 / z, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255,255,255,0.75)"; ctx.fill(); ctx.fillStyle = color; ctx.fill();
          }
          ctx.restore();
        }
        const draft = app.session.shapeDraft;
        if (draft && app.session.tool === "shape") {
          const z = app.session.zoom || 1;
          ctx.save();
          ctx.fillStyle = app.session.foreground;
          ctx.strokeStyle = app.session.foreground;
          ctx.beginPath();
          if (draft.kind === "line" && draft.line) {
            ctx.lineCap = "round";
            ctx.lineWidth = Math.max(1 / z, app.session.shapeLineWidth);
            ctx.moveTo(draft.line.x0, draft.line.y0); ctx.lineTo(draft.line.x1, draft.line.y1); ctx.stroke();
          } else if (draft.kind === "ellipse") { ctx.ellipse(draft.x + draft.w / 2, draft.y + draft.h / 2, draft.w / 2, draft.h / 2, 0, 0, Math.PI * 2); ctx.fill(); }
          else { const r = Math.min(app.session.shapeCornerRadius, draft.w / 2, draft.h / 2); if (r > 0) ctx.roundRect(draft.x, draft.y, draft.w, draft.h, r); else ctx.rect(draft.x, draft.y, draft.w, draft.h); ctx.fill(); }
          ctx.restore();
          return;
        }
        const ring = app.session.sampleRing;
        if (ring && app.session.showsSampleRing) {
          const z = app.session.zoom || 1;
          ctx.save();
          ctx.beginPath(); ctx.arc(ring.x, ring.y, 43 / z, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(255,255,255,0.45)"; ctx.lineWidth = 24 / z; ctx.stroke();
          ctx.lineWidth = 16 / z;
          ctx.beginPath(); ctx.arc(ring.x, ring.y, 43 / z, Math.PI, 0); ctx.strokeStyle = ring.sampled; ctx.stroke(); // top: the new colour
          ctx.beginPath(); ctx.arc(ring.x, ring.y, 43 / z, 0, Math.PI); ctx.strokeStyle = ring.original; ctx.stroke(); // bottom: the colour before
          ctx.restore();
        }
        if (app.session.tool === "type" && app.session.cropRect) {
          const z = app.session.zoom || 1;
          const r = app.session.cropRect;
          ctx.save();
          ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7aa2f7";
          ctx.lineWidth = 1 / z;
          ctx.strokeRect(r.x, r.y, r.w, r.h);
          ctx.restore();
          return;
        }
        const lasso = app.session.lassoPath;
        if (lasso && lasso.length >= 1 && app.session.tool === "lasso") {
          const z = app.session.zoom || 1;
          ctx.save();
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(lasso[0][0], lasso[0][1]);
          for (let i = 1; i < lasso.length; i++) ctx.lineTo(lasso[i][0], lasso[i][1]);
          if (app.session.lassoMode === "polygon" && app.session.hover) ctx.lineTo(app.session.hover.x, app.session.hover.y); // rubber band
          ctx.strokeStyle = "rgba(0,0,0,0.8)";
          ctx.lineWidth = 2 / z;
          ctx.stroke();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1 / z;
          ctx.stroke();
          if (app.session.lassoMode === "polygon") {
            // the first corner gets a handle: click it to close
            const h = 8 / z;
            ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1 / z;
            ctx.beginPath(); ctx.rect(lasso[0][0] - h / 2, lasso[0][1] - h / 2, h, h); ctx.fill(); ctx.stroke();
          }
          ctx.restore();
          return;
        }
        if (app.session.tool === "marquee" && app.session.cropRect) {
          const z = app.session.zoom || 1;
          const r = app.session.cropRect;
          ctx.save();
          ctx.beginPath();
          if (app.session.marqueeShape === "ellipse") ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
          else ctx.rect(r.x, r.y, r.w, r.h);
          ctx.strokeStyle = "rgba(0,0,0,0.8)"; ctx.lineWidth = 2 / z; ctx.stroke();
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 1 / z; ctx.stroke();
          ctx.restore();
          return;
        }
        const cr = app.visibleCropRect();
        if (!cr || !doc) return;
        const z = app.session.zoom || 1;
        ctx.save();
        // Compositor's crop overlay: darkened outside, a white frame, rule-of-thirds, 8 × 8 handles.
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.beginPath();
        ctx.rect(Math.min(0, cr.x) - 1e5, Math.min(0, cr.y) - 1e5, 2e5 + doc.width, 2e5 + doc.height);
        ctx.rect(cr.x, cr.y, cr.w, cr.h);
        ctx.fill("evenodd");
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1 / z;
        ctx.strokeRect(cr.x, cr.y, cr.w, cr.h);
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.beginPath();
        for (const f of [1 / 3, 2 / 3]) {
          ctx.moveTo(cr.x + cr.w * f, cr.y); ctx.lineTo(cr.x + cr.w * f, cr.y + cr.h);
          ctx.moveTo(cr.x, cr.y + cr.h * f); ctx.lineTo(cr.x + cr.w, cr.y + cr.h * f);
        }
        ctx.stroke();
        const s = 8 / z;
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#000";
        for (const h of handlePositions({ x: cr.x, y: cr.y, width: cr.w, height: cr.h, rotation: 0, flipH: false, flipV: false })) {
          ctx.beginPath();
          ctx.rect(h.x - s / 2, h.y - s / 2, s, s);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      });
    });
  };

  /* ── App tooltips (replace the browser's native title bubbles) ─────────── */
  const tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  document.body.appendChild(tooltip);
  let tipTimer = 0;
  let tipTarget: HTMLElement | null = null;
  function hideTip(): void {
    clearTimeout(tipTimer);
    tipTarget = null;
    tooltip.classList.remove("show");
  }
  function showTip(el: HTMLElement): void {
    const text = el.dataset.tip;
    if (!text) return;
    tooltip.textContent = text;
    tooltip.classList.add("show");
    const r = el.getBoundingClientRect();
    const t = tooltip.getBoundingClientRect();
    let x: number, y: number;
    if (el.closest(".tool-rail")) {
      x = r.right + 8;
      y = r.top + r.height / 2 - t.height / 2;
    } else {
      x = r.left + r.width / 2 - t.width / 2;
      y = r.bottom + 6;
      if (y + t.height > innerHeight - 4) y = r.top - t.height - 6;
    }
    x = Math.max(4, Math.min(x, innerWidth - t.width - 4));
    y = Math.max(4, Math.min(y, innerHeight - t.height - 4));
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }
  document.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]") ?? null;
    if (el === tipTarget) return;
    hideTip();
    if (!el) return;
    tipTarget = el;
    tipTimer = window.setTimeout(() => { if (tipTarget === el) showTip(el); }, 450);
  });
  document.addEventListener("mouseout", (e) => {
    const to = (e.relatedTarget as HTMLElement | null)?.closest?.("[data-tip]") ?? null;
    if (tipTarget && to !== tipTarget) hideTip();
  });
  for (const ev of ["pointerdown", "keydown", "wheel", "scroll"]) document.addEventListener(ev, hideTip, true);
  /** Native title bubbles cannot be styled: move every title inside the app onto data-tip. */
  function adoptTitles(scope: ParentNode): void {
    for (const el of scope.querySelectorAll<HTMLElement>("[title]")) {
      el.dataset.tip = el.title;
      el.removeAttribute("title");
    }
  }

  /* ── Branded dialogs (Save / Don't Save / Cancel) and closing ──────────── */
  type DialogButton<T> = { label: string; value: T; primary?: boolean; danger?: boolean };
  function dialog<T>(title: string, message: string, buttons: DialogButton<T>[], cancelValue: T): Promise<T> {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      const box = document.createElement("div");
      box.className = "modal dialog";
      box.innerHTML = `<h3>${title}</h3><p class="message">${message}</p>`;
      const actions = document.createElement("div");
      actions.className = "actions";
      let primary: HTMLButtonElement | null = null;
      const finish = (v: T) => { document.removeEventListener("keydown", onKey, true); backdrop.remove(); resolve(v); };
      const onKey = (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); finish(cancelValue); }
        if (e.key === "Enter" && primary) { e.preventDefault(); primary.click(); }
      };
      for (const b of buttons) {
        const el = document.createElement("button");
        el.textContent = b.label;
        if (b.primary) { el.className = "primary"; primary = el; }
        if (b.danger) el.className = "danger";
        el.addEventListener("click", () => finish(b.value));
        actions.appendChild(el);
      }
      box.appendChild(actions);
      backdrop.appendChild(box);
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(backdrop);
      (primary ?? actions.querySelector("button"))?.focus();
    });
  }

  /** Ask what to do with an unsaved document. Resolves true when it is fine to close it. */
  async function resolveUnsaved(doc: DocumentState): Promise<boolean> {
    if (!doc.dirty) return true;
    const choice = await dialog<"save" | "discard" | "cancel">(
      "Save changes?",
      `Save changes to “${doc.name}” before closing?`,
      [
        { label: "Don't Save", value: "discard", danger: true },
        { label: "Cancel", value: "cancel" },
        { label: "Save", value: "save", primary: true },
      ],
      "cancel",
    );
    if (choice === "cancel") return false;
    if (choice === "discard") return true;
    app.switchDocument(doc.id);
    try {
      return await app.saveProject(false); // false when the save dialog was cancelled
    } catch (err) {
      reportError(err);
      return false;
    }
  }

  async function closeDocumentAsk(): Promise<void> {
    const doc = app.doc;
    if (!doc) return;
    if (app.session.textEdit) app.endTextEdit(true); // text being typed is committed first (Compositor 1.3.1)
    if (await resolveUnsaved(doc)) app.closeDocument(doc.id);
  }

  let allowUnload = false;
  /** Quit: settle every unsaved document, then close the window ourselves. */
  async function quitAsk(): Promise<void> {
    if (app.session.textEdit) app.endTextEdit(true);
    for (const doc of [...app.docs]) {
      if (!(await resolveUnsaved(doc))) return;
      doc.dirty = false;
    }
    allowUnload = true;
    console.info("Compositor: quit requested, closing window (history length %d)", history.length);
    window.close();
    // A window the script may not close keeps running; surface that instead of failing silently.
    setTimeout(() => {
      allowUnload = false;
      console.warn("Compositor: window.close() was refused");
      reportError("The window could not be closed from here — use the window manager's close (Super+W).");
    }, 800);
  }
  // Chromium's own "Leave app?" prompt only remains for closes we cannot intercept (window manager).
  window.addEventListener("beforeunload", (e) => {
    if (!allowUnload && app.docs.some((d) => d.dirty)) e.preventDefault();
  });

  /* ── App context menu (replaces Chromium's) ─────────────────────────────── */
  type MenuItem = { label: string; shortcut?: string; action?: () => void; sep?: boolean; disabled?: boolean };
  let contextMenuEl: HTMLElement | null = null;
  function closeContextMenu(): void {
    contextMenuEl?.remove();
    contextMenuEl = null;
  }
  function showContextMenu(x: number, y: number, items: MenuItem[]): void {
    closeContextMenu();
    const el = document.createElement("div");
    el.className = "menu-dropdown context-menu";
    for (const item of items) {
      if (item.sep) {
        const s = document.createElement("div");
        s.className = "sep";
        el.appendChild(s);
        continue;
      }
      const b = document.createElement("button");
      b.innerHTML = `<span>${item.label}</span>${item.shortcut ? `<span class="shortcut">${keyLabel(item.shortcut)}</span>` : ""}`;
      b.disabled = !!item.disabled;
      b.addEventListener("click", () => { closeContextMenu(); item.action?.(); });
      el.appendChild(b);
    }
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    el.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    contextMenuEl = el;
  }
  document.addEventListener("pointerdown", (e) => {
    if (contextMenuEl && !contextMenuEl.contains(e.target as Node)) closeContextMenu();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeContextMenu(); });
  // The browser's own menu never belongs in the editor, except inside text fields.
  document.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    e.preventDefault();
  });

  function layerMenuItems(): MenuItem[] {
    const doc = app.doc;
    const sel = app.session.selectedLayerIds;
    const selected = doc?.layers.filter((l) => sel.includes(l.id)) ?? [];
    const hasGroup = selected.some((l) => l.kind === "group");
    const many = selected.length > 1;
    return [
      { label: many ? `Group ${selected.length} Layers` : "Group Layer", shortcut: "⌘G", action: () => app.addGroup(), disabled: !selected.length },
      { label: "Ungroup Layers", action: () => app.ungroupSelected(), disabled: !hasGroup },
      { sep: true, label: "" },
      { label: many ? "Duplicate Layers" : "Duplicate Layer", shortcut: "⌘J", action: () => app.duplicateLayer(), disabled: !selected.length },
      { label: many ? "Delete Layers" : "Delete Layer", action: () => app.deleteSelection(), disabled: !selected.length },
      { sep: true, label: "" },
      { label: "Trim Transparent Pixels", action: () => app.trimSelected(), disabled: !selected.some((l) => l.kind === "raster") },
      { label: "Merge Down", shortcut: "⌘E", action: () => app.mergeDown(), disabled: many || !selected.length },
      { label: selected.every((l) => l.visible) ? "Hide" : "Show", action: () => app.toggleVisibility(), disabled: !selected.length },
      { label: "Rename…", action: () => renameRow(app.session.activeLayerId), disabled: many || !selected.length },
      { sep: true, label: "" },
      { label: "New Blank Layer", shortcut: "⇧⌘N", action: () => app.addBlankLayer() },
      { label: "Add Image…", action: () => addImageDialog() },
    ];
  }

  /** Brush size preview: a circle of the brush diameter at the pointer, readable on any background. */
  function drawBrushPreview(ctx: CanvasRenderingContext2D): void {
    const s = app.session;
    if (!s.hover || !PAINT_TOOLS.includes(s.tool) || app.tempHand) return;
    if (mods.alt && (s.tool === "brush" || s.tool === "spot-healing")) return; // Option = eyedropper
    const z = s.zoom || 1;
    const r = Math.max(0.5 / z, s.brush.size / 2); // never smaller than a pixel on screen
    const ring = (x: number, y: number, radius: number, dashed = false) => {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      if (dashed) ctx.setLineDash([4 / z, 3 / z]);
      ctx.lineWidth = 2.5 / z; ctx.strokeStyle = "#fff"; ctx.stroke();
      ctx.lineWidth = 1 / z; ctx.strokeStyle = "#000"; ctx.stroke();
      ctx.setLineDash([]);
    };
    ctx.save();
    ring(s.hover.x, s.hover.y, r);
    if (app.tipHardnessShown) ring(s.hover.x, s.hover.y, r * s.brush.hardness, true); // the full-strength core while Shift-right-dragging
    if (s.tool === "clone-stamp" && !mods.alt) {
      const src = app.cloneSamplePoint(s.hover);
      if (src) {
        const reach = 7 / z;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(src.x - reach, src.y); ctx.lineTo(src.x + reach, src.y);
        ctx.moveTo(src.x, src.y - reach); ctx.lineTo(src.x, src.y + reach);
        ctx.lineWidth = 3 / z; ctx.strokeStyle = "#fff"; ctx.stroke();
        ctx.lineWidth = 1 / z; ctx.strokeStyle = "#000"; ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Photoshop's "Show Transform Controls": box + handles around the active layer with the Move tool. */
  function drawTransformControls(ctx: CanvasRenderingContext2D): void {
    const layer = app.activeLayer;
    const z = app.session.zoom || 1;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7aa2f7";
    if (app.session.tool === "move" && app.session.snapLines.length && app.doc) {
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1 / z;
      for (const l of app.session.snapLines) {
        ctx.beginPath();
        if (l.axis === "x") { ctx.moveTo(l.pos, 0); ctx.lineTo(l.pos, app.doc.height); }
        else { ctx.moveTo(0, l.pos); ctx.lineTo(app.doc.width, l.pos); }
        ctx.stroke();
      }
      ctx.restore();
    }
    const controls = app.session.showTransformControls || !!app.transformEdit?.persistent;
    if (app.session.tool !== "move" || !layer || !app.isTransformable(layer) || !layer.visible || !controls) return;
    ctx.save();
    ctx.lineWidth = 1 / z;
    ctx.strokeStyle = accent;
    // outline other selected layers faintly
    for (const id of app.session.selectedLayerIds) {
      const other = app.doc?.layers.find((l) => l.id === id);
      if (!other || other === layer || !app.isTransformable(other)) continue;
      const c = boxCorners(other.transform);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      c.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const corners = boxCorners(layer.transform);
    ctx.beginPath();
    corners.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
    ctx.closePath();
    ctx.stroke();
    // Compositor's handles: 7×7 white squares with an accent stroke, and a round rotation knob on a stem.
    const handles = handlePositions(layer.transform);
    const top = handles.find((h) => h.id === "n")!;
    const knob = rotationHandle(layer.transform, z);
    ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(knob.x, knob.y); ctx.stroke();
    const s = 7 / z;
    ctx.fillStyle = "#ffffff";
    for (const h of handles) {
      ctx.beginPath();
      ctx.rect(h.x - s / 2, h.y - s / 2, s, s);
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(knob.x, knob.y, 4 / z, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  /* ── On-canvas text editor: a textarea laid exactly over the text layer ── */
  let textEditor: HTMLTextAreaElement | null = null;

  function syncTextEditor(): void {
    const edit = app.session.textEdit;
    const doc = app.doc;
    const layer = edit && doc ? doc.layers.find((l) => l.id === edit.layerId) : null;
    if (!edit || !doc || !layer?.text) {
      if (textEditor) { textEditor.remove(); textEditor = null; }
      return;
    }
    if (!textEditor) {
      const ta = document.createElement("textarea");
      ta.className = "text-editor";
      ta.spellcheck = false;
      ta.addEventListener("input", () => {
        app.setText({ text: ta.value });
        syncTextEditor();
      });
      ta.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); app.endTextEdit(false); }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); app.endTextEdit(true); }
        else if (e.altKey && e.key.startsWith("Arrow")) {
          // Option-arrows: tracking (left / right) and leading (up / down), by 10 with Shift.
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const t = app.activeLayer?.text;
          if (!t) return;
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") app.setText({ letterSpacing: t.letterSpacing + (e.key === "ArrowRight" ? step : -step) });
          else { const px = t.lineHeight * t.fontSize + (e.key === "ArrowDown" ? step : -step); app.setText({ lineHeight: Math.max(1, px) / t.fontSize }); }
          syncTextEditor();
        }
      });
      ta.addEventListener("pointerdown", (e) => e.stopPropagation());
      canvasWrap.appendChild(ta);
      textEditor = ta;
      ta.value = layer.text.text;
      requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
    }
    const t = layer.text, tr = layer.transform, z = app.session.zoom || 1;
    const rect = canvas.getBoundingClientRect();
    const ox = rect.width / 2 + app.session.panX - (doc.width * z) / 2;
    const oy = rect.height / 2 + app.session.panY - (doc.height * z) / 2;
    const pad = textPad(t) * z;
    // CSS centres glyphs in their line box; the canvas draws them from the em top. Shift by the half-leading.
    const halfLead = ((t.lineHeight - 1) * t.fontSize * z) / 2;
    const s = textEditor.style;
    s.left = `${ox + tr.x * z}px`;
    s.top = `${oy + tr.y * z}px`;
    const { sx, sy } = textScale(layer); // type stretched by the handles keeps its ratio while editing
    s.whiteSpace = t.boxWidth ? "pre-wrap" : "pre";
    s.wordBreak = t.boxWidth ? "break-word" : "normal";
    s.width = `${Math.max(tr.width / sx * z, t.fontSize * z)}px`;
    s.height = `${Math.max(tr.height / sy * z, t.fontSize * z) + Math.max(0, halfLead)}px`;
    s.transformOrigin = "0 0";
    s.transform = `translate(${(tr.width * z) / 2}px, ${(tr.height * z) / 2}px) rotate(${tr.rotation}deg) translate(${(-tr.width * z) / 2}px, ${(-tr.height * z) / 2}px) scale(${sx}, ${sy})`;
    s.padding = `${Math.max(0, pad - halfLead)}px ${pad}px ${pad}px`;
    s.font = cssFont({ weight: t.weight, fontSize: t.fontSize * z, fontFamily: t.fontFamily });
    s.lineHeight = `${t.fontSize * t.lineHeight * z}px`;
    s.letterSpacing = `${t.letterSpacing * z}px`;
    s.color = t.color;
    s.textAlign = t.align;
    if (textEditor.value !== t.text && document.activeElement !== textEditor) textEditor.value = t.text;
  }

  app.onChange = () => {
    render();
    requestDraw();
  };
  app.onDraw = requestDraw;
  // Marching ants: while a selection exists, advance the dashes ten times a second.
  setInterval(() => { if (app.hasSelection() && !document.hidden) requestDraw(); }, 100);


  function menu(label: string, items: { label: string; shortcut?: string; action?: () => void; sep?: boolean }[]): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "menu-item";
    wrap.dataset.menu = label;
    const btn = document.createElement("button");
    btn.textContent = label;
    const drop = document.createElement("div");
    drop.className = "menu-dropdown";
    for (const item of items) {
      if (item.sep) {
        const s = document.createElement("div");
        s.className = "sep";
        drop.appendChild(s);
        continue;
      }
      const b = document.createElement("button");
      b.innerHTML = `<span>${item.label}</span>${item.shortcut ? `<span class="shortcut">${keyLabel(item.shortcut)}</span>` : ""}`;
      b.addEventListener("click", () => {
        item.action?.();
        openMenu = null;
        render();
      });
      drop.appendChild(b);
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMenu = openMenu === label ? null : label;
      render();
    });
    wrap.append(btn, drop);
    return wrap;
  }

  function renderMenus(): void {
    menuBar.innerHTML = "";
    const brand = document.createElement("div");
    brand.className = "brand";
    brand.innerHTML = `Compositor<span> · Omarchy</span>`;
    menuBar.appendChild(brand);

    const file = menu("File", [
      { label: "New…", shortcut: "⌘N", action: () => showNewCanvas() },
      { label: "Open…", shortcut: "⌘O", action: () => openFileDialog() },
      { label: "Open Package Folder…", action: () => openFolderDialog() },
      { sep: true, label: "" },
      { label: "Save", shortcut: "⌘S", action: () => void app.saveProject(false).catch(reportError) },
      { label: "Save As…", shortcut: "⇧⌘S", action: () => void app.saveProject(true).catch(reportError) },
      { label: "Save As Package Folder…", action: () => void app.saveProjectToFolder().catch(reportError) },
      { sep: true, label: "" },
      { label: "Export PNG", shortcut: "⇧⌘E", action: () => exportPng() },
      { label: "Export JPEG…", shortcut: "⌥⇧⌘S", action: () => showExportJpeg() },
      { sep: true, label: "" },
      { label: "Close Document", shortcut: "⌘W", action: () => void closeDocumentAsk() },
      { label: "Quit Compositor", shortcut: "⌘Q", action: () => void quitAsk() },
    ]);
    const edit = menu("Edit", [
      { label: "Undo", shortcut: "⌘Z", action: () => app.undo() },
      { label: "Redo", shortcut: "⇧⌘Z", action: () => app.redo() },
      { sep: true, label: "" },
      { label: "Cut", shortcut: "⌘X", action: () => void app.cutSelection().catch(console.error) },
      { label: "Copy", shortcut: "⌘C", action: () => void app.copyToClipboard(false).catch(console.error) },
      { label: "Copy Merged", shortcut: "⇧⌘C", action: () => void app.copyToClipboard(true).catch(console.error) },
      { label: "Paste as Layer", shortcut: "⌘V", action: () => void app.pasteFromClipboard().catch(console.error) },
      { sep: true, label: "" },
      { label: "Fill with Foreground Color", shortcut: "⌥⌫", action: () => app.fillActive() },
      { label: "Fill with Background Color", shortcut: "⌘⌫", action: () => app.fillActive(app.session.background) },
      { label: "Clear Selection Pixels", shortcut: "⌫", action: () => app.clearActive() },
      { label: "Invert Pixels", shortcut: "⌘I", action: () => app.invertActive() },
      { sep: true, label: "" },
      { label: "Transform Layer / Selection", shortcut: "⌘T", action: () => app.transformCommand() },
      { label: "Show Transform Controls", shortcut: "⌘H", action: () => app.toggleTransformControls() },
      { label: "Reset Transform", action: () => app.resetTransform() },
      { label: "Flip Layer Horizontal", action: () => app.flipActive("h") },
      { label: "Flip Layer Vertical", action: () => app.flipActive("v") },
    ]);
    const select = menu("Select", [
      { label: "All", shortcut: "⌘A", action: () => app.selectAll() },
      { label: "Deselect", shortcut: "⌘D", action: () => app.deselect() },
      { label: "Inverse", shortcut: "⇧⌘I", action: () => app.invertSelection() },
      { label: "Layer's Pixels", action: () => app.selectLayerPixels() },
      { label: "Mask's Black Areas", action: () => app.selectMaskBlack() },
      { sep: true, label: "" },
      { label: "Expand…", action: () => promptSelectionAmount("Expand") },
      { label: "Contract…", action: () => promptSelectionAmount("Contract") },
      { label: "Feather…", action: () => promptSelectionAmount("Feather") },
      { sep: true, label: "" },
      { label: "Layer via Copy", shortcut: "⌘J", action: () => app.layerViaCopy(false) },
      { label: "Layer via Cut", shortcut: "⇧⌘J", action: () => app.layerViaCopy(true) },
      { label: "Layer Mask from Selection", action: () => app.maskFromSelection() },
    ]);
    const layer = menu("Layer", [
      { label: "New Blank Layer", shortcut: "⇧⌘N", action: () => app.addBlankLayer() },
      { label: "Add Image…", action: () => addImageDialog() },
      { label: "Duplicate Layer", shortcut: "⌘J", action: () => app.duplicateLayer() },
      { label: "Move Layer Up", shortcut: "⌘]", action: () => app.moveLayerOrder(1) },
      { label: "Move Layer Down", shortcut: "⌘[", action: () => app.moveLayerOrder(-1) },
      { label: "Group Layers", shortcut: "⌘G", action: () => app.addGroup() },
      { sep: true, label: "" },
      { label: "Trim Transparent Pixels", action: () => app.trimSelected() },
      { label: "Merge Down", shortcut: "⌘E", action: () => app.mergeDown() },
      { label: "Flatten Image", action: () => app.flattenImage() },
      { sep: true, label: "" },
      { label: "Delete Layer", action: () => app.deleteSelection() },
      { sep: true, label: "" },
      { label: "Adjustment · Hue/Saturation", action: () => app.addAdjustment("hsv") },
      { label: "Adjustment · Levels", action: () => app.addAdjustment("levels") },
      { label: "Adjustment · Curves", action: () => app.addAdjustment("curves") },
      { label: "Adjustment · Exposure", action: () => app.addAdjustment("exposure") },
      { label: "Adjustment · Invert", action: () => app.addAdjustment("invert") },
    ]);
    const image = menu("Image", [
      { label: "Canvas Size…", action: () => showCanvasSize() },
      { label: "Image Size…", action: () => showImageSize() },
      { sep: true, label: "" },
      { label: "Flip Canvas Horizontal", action: () => flipCanvas("h") },
      { label: "Flip Canvas Vertical", action: () => flipCanvas("v") },
    ]);
    const filter = menu("Filter", [
      { label: "Gaussian Blur…", action: () => showBlur() },
      { label: "Add Noise", action: () => app.applyAdjustmentToActive("noise", { amount: 0.12 }) },
      { label: "Invert", action: () => app.invertActive() },
    ]);
    const viewMenu = menu("View", [
      { label: "Toggle Pixel Grid", action: () => { app.session.showPixelGrid = !app.session.showPixelGrid; app.emit(); } },
      { label: "Fit Canvas", shortcut: "⌘0", action: () => app.fit(canvas) },
      { label: "Actual Pixels", shortcut: "⌘1", action: () => { app.session.zoom = 1; app.session.panX = 0; app.session.panY = 0; app.emit(); } },
      { label: "Zoom In", shortcut: "⌘=", action: () => app.zoomKeyboard(canvas, 1) },
      { label: "Zoom Out", shortcut: "⌘-", action: () => app.zoomKeyboard(canvas, -1) },
      { sep: true, label: "" },
      ...THEME_CHOICES.map((c) => ({
        label: `${themeChoice() === c.id ? "●" : "○"}  Theme: ${c.label}`,
        action: () => void applyThemeChoice(c.id).then(() => render()).catch(console.error),
      })),
    ]);

    const help = menu("Help", [
      { label: "Keyboard Shortcuts…", action: () => showShortcuts() },
      { sep: true, label: "" },
      { label: "Report a Bug…", action: () => openLink(ISSUES_URL) },
      { label: `${APP_NAME} on GitHub`, action: () => openLink(PROJECT_URL) },
      { sep: true, label: "" },
      { label: `Compositor by ${ORIGINAL_AUTHOR} (original app)`, action: () => openLink(ORIGINAL_SITE_URL) },
      { sep: true, label: "" },
      { label: `About ${APP_NAME}`, action: () => showAbout() },
    ]);
    menuBar.append(file, edit, select, layer, image, filter, viewMenu, help);
    const spacer = document.createElement("div");
    spacer.className = "menu-spacer";
    menuBar.appendChild(spacer);

    for (const el of menuBar.querySelectorAll(".menu-item")) {
      el.classList.toggle("open", el.getAttribute("data-menu") === openMenu);
    }
  }

  function renderToolRail(): void {
    toolRail.innerHTML = "";
    for (const t of TOOL_META) {
      const b = document.createElement("button");
      b.title = t.title;
      const variant: IconName = t.id === "brush" && app.session.brushMode === "erase" ? "eraser"
        : t.id === "marquee" && app.session.marqueeShape === "ellipse" ? "marquee-ellipse"
        : t.id === "lasso" && app.session.lassoMode === "polygon" ? "lasso-polygon" : t.icon;
      b.innerHTML = icon(variant, 20);
      b.dataset.key = t.key.toUpperCase();
      b.classList.toggle("active", app.session.tool === t.id);
      b.addEventListener("click", () => app.setTool(t.id));
      toolRail.appendChild(b);
    }
    // Photoshop's colour well: foreground over background, swap (X) top right, defaults (D) bottom left.
    const sw = document.createElement("div");
    sw.className = "swatches";
    sw.innerHTML = `
      <input class="bg" type="color" value="${app.session.background}" title="Background colour" />
      <input class="fg" type="color" value="${app.session.foreground}" title="Foreground colour" />
      <button class="swap" title="Swap foreground and background (X)">${icon("swap", 11)}</button>
      <button class="defaults" title="Default colours: black over white (D)">${icon("default-colors", 11)}</button>
    `;
    const fg = sw.querySelector<HTMLInputElement>(".fg")!;
    const bg = sw.querySelector<HTMLInputElement>(".bg")!;
    sw.querySelector(".swap")!.addEventListener("click", () => app.swapColors());
    sw.querySelector(".defaults")!.addEventListener("click", () => app.resetColors());
    // `input` fires continuously while the picker is open: only store the value (rebuilding the
    // rail here would destroy the picker). Refresh the UI once the picker closes (`change`).
    fg.addEventListener("input", () => { app.session.foreground = fg.value; });
    bg.addEventListener("input", () => { app.session.background = bg.value; });
    fg.addEventListener("change", () => app.emitView());
    bg.addEventListener("change", () => app.emitView());
    toolRail.appendChild(sw);
  }

  function renderToolHeader(): void {
    const s = app.session;
    const tool = s.tool;
    const brushTools = app.isBrushTool(tool);
    const title = tool === "idle" ? "Select a tool"
      : tool === "brush" ? (s.brushMode === "erase" ? "Eraser" : "Brush")
      : tool === "blur" ? "Smear"
      : tool === "spot-healing" ? "Spot Healing"
      : tool === "hand" ? "Pan"
      : TOOL_META.find((t) => t.id === tool)?.title.split(" (")[0] ?? tool;

    toolHeader.innerHTML = `<div class="title">${title}</div>`;

    /** Segmented control (Compositor's `.segmented` pickers). */
    const segmented = <T extends string>(options: { value: T; label: string }[], value: T, on: (v: T) => void, help?: string) => {
      const seg = document.createElement("div");
      seg.className = "seg";
      if (help) seg.title = help;
      for (const o of options) {
        const b = document.createElement("button");
        b.textContent = o.label;
        b.classList.toggle("active", value === o.value);
        b.addEventListener("click", () => on(o.value));
        seg.appendChild(b);
      }
      return seg;
    };
    /** A number field with optional unit, clamped on input; Up/Down step it (Shift ×10). */
    const numberField = (value: number, min: number, max: number, step: number, on: (v: number) => void, opts: { unit?: string; width?: number; help?: string; digits?: number } = {}) => {
      const wrap = document.createElement("div");
      wrap.className = "num";
      const i = document.createElement("input");
      i.type = "number";
      i.min = String(min); i.max = String(max); i.step = String(step);
      i.value = String(Math.round(value * 10 ** (opts.digits ?? 0)) / 10 ** (opts.digits ?? 0));
      i.style.width = `${opts.width ?? 56}px`;
      if (opts.help) i.title = opts.help;
      const apply = () => { const v = Number(i.value); if (Number.isFinite(v)) on(Math.min(max, Math.max(min, v))); };
      i.addEventListener("input", apply);
      i.addEventListener("keydown", (e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const v = (Number(i.value) || 0) + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
          i.value = String(Math.min(max, Math.max(min, Math.round(v * 1000) / 1000)));
          apply();
        }
        if (e.key === "Enter" || e.key === "Escape") i.blur();
      });
      wrap.append(i);
      if (opts.unit) { const u = document.createElement("span"); u.className = "unit"; u.textContent = opts.unit; wrap.append(u); }
      return wrap;
    };
    /** Slider plus percent field, as the brush and gradient headers pair them. */
    const percentControl = (value: number, min: number, on: (v: number) => void, help?: string) => {
      const wrap = document.createElement("div");
      wrap.style.display = "flex"; wrap.style.alignItems = "center"; wrap.style.gap = "6px";
      const slider = document.createElement("input");
      slider.type = "range"; slider.min = String(min); slider.max = "1"; slider.step = "0.01"; slider.value = String(value);
      slider.style.width = "100px";
      const pct = numberField(value * 100, min * 100, 100, 1, (v) => { slider.value = String(v / 100); on(v / 100); }, { unit: "%", width: 54, help });
      slider.addEventListener("input", () => { const v = Number(slider.value); pct.querySelector("input")!.value = String(Math.round(v * 100)); on(v); });
      wrap.append(slider, pct);
      return wrap;
    };

    const field = (label: string, control: HTMLElement) => {
      const f = document.createElement("div");
      f.className = "field";
      f.innerHTML = `<label>${label}</label>`;
      f.appendChild(control);
      makeScrubby(f.querySelector("label")!, control);
      return f;
    };


    if (tool === "move") {
      const layer = app.activeLayer;
      const editing = !!app.transformEdit?.persistent;
      const can = !!layer && app.isTransformable(layer);
      const toggle = (label: string, on: boolean, help: string, flip: () => void) => {
        const b = document.createElement("button");
        b.className = "toggle" + (on ? " active" : "");
        b.textContent = label;
        b.title = help;
        b.addEventListener("click", flip);
        return b;
      };
      toolHeader.append(
        toggle("Auto Select", s.transformAutoSelect, "Select layers by clicking the canvas. When off, hold Ctrl to select a layer.", () => app.setAutoSelect(!s.transformAutoSelect)),
        toggle("Show Controls", s.showTransformControls, "Show the transform box and handles (Ctrl+H). When hidden, drag anywhere to move the layer.", () => app.toggleTransformControls()),
      );
      if (layer) {
        const t = layer.transform;
        const fmt = (v: number) => (Number.isInteger(v) ? v : Math.round(v * 100) / 100);
        const tf = (value: number, min: number, max: number, on: (v: number) => void, width = 85, unit?: string) => numberField(fmt(value), min, max, 1, on, { width, unit, digits: 2 });
        const link = document.createElement("button");
        link.className = "icon-btn toggle" + (s.locksTransformRatio ? " active" : "");
        link.innerHTML = icon("link", 16);
        link.title = "Lock aspect ratio";
        link.addEventListener("click", () => { s.locksTransformRatio = !s.locksTransformRatio; app.emitView(); });
        const sampling = document.createElement("select");
        sampling.innerHTML = `<option value="nearest">Nearest</option><option value="smooth">Smooth</option><option value="high">High quality</option>`;
        sampling.value = t.sampling ?? "high";
        sampling.addEventListener("change", () => app.setTransform({ sampling: sampling.value as "nearest" | "smooth" | "high" }));
        const btn = (label: string, on: () => void, title?: string) => { const b = document.createElement("button"); b.textContent = label; if (title) b.title = title; b.addEventListener("click", on); return b; };
        const block = document.createElement("div");
        block.className = "transform-fields";
        block.append(
          field("X", tf(t.x, -30000, 30000, (v) => app.setTransform({ x: v }))),
          field("Y", tf(t.y, -30000, 30000, (v) => app.setTransform({ y: v }))),
          field("W", tf(t.width, 1, 30000, (v) => app.resizeTransform(v, undefined))),
          field("H", tf(t.height, 1, 30000, (v) => app.resizeTransform(undefined, v))),
          link,
          field("Scale", tf(app.transformScalePercent(layer), 0.1, 30000, (v) => app.setTransformScale(v), 110, "%")),
          field("°", tf(t.rotation, -360, 360, (v) => app.setTransform({ rotation: v }), 75)),
          field("Sampling", sampling),
          btn("Flip H", () => app.flipActive("h")),
          btn("Flip V", () => app.flipActive("v")),
        );
        if (!can && !editing) block.classList.add("disabled");
        toolHeader.append(block);
      }
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.disabled = !app.transformEdit;
      cancel.addEventListener("click", () => app.cancelTransform());
      const apply = document.createElement("button");
      apply.textContent = "Apply";
      apply.className = "active";
      apply.disabled = !app.transformEdit;
      apply.addEventListener("click", () => app.commitTransform());
      toolHeader.append(cancel, apply);
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Drag to move · Handles to resize · Circle to rotate · 1–0 layer opacity · Space to pan";
      toolHeader.append(hint);
    } else if (brushTools) {
      const b = s.brush;
      const maskTarget = s.maskSelected && !!app.activeLayer?.mask;
      if (tool === "brush") toolHeader.append(segmented([{ value: "paint", label: "Paint" }, { value: "erase", label: "Erase" }] as const, s.brushMode, (v) => app.setBrushMode(v), "Paint with the foreground color (B), or erase pixels away (E)"));
      if (tool === "blur") toolHeader.append(segmented([{ value: "liquify", label: "Liquify" }, { value: "blur", label: "Blur" }, { value: "smudge", label: "Smudge" }] as const, s.smearMode, (v) => { s.smearMode = v; app.emitView(); }, "Liquify pushes pixels · Blur softens · Smudge drags color along"));
      if (tool === "spot-healing") toolHeader.append(segmented([{ value: "content-aware", label: "Content-Aware" }, { value: "create-texture", label: "Create Texture" }, { value: "proximity-match", label: "Proximity Match" }] as const, s.healMode, (v) => { s.healMode = v; app.emitView(); }));
      if (tool === "clone-stamp") {
        const aligned = document.createElement("button");
        aligned.className = "toggle" + (s.clone.aligned ? " active" : "");
        aligned.textContent = "Aligned";
        aligned.title = "Keep the source moving with the brush between strokes; off starts every stroke at the source point";
        aligned.addEventListener("click", () => { s.clone.aligned = !s.clone.aligned; app.emitView(); });
        toolHeader.append(aligned);
        toolHeader.append(field("Sample", segmented([{ value: "layer", label: "This Layer" }, { value: "all", label: "All Layers" }] as const, s.clone.sampleAll ? "all" : "layer", (v) => { s.clone.sampleAll = v === "all"; app.emitView(); }, "Copy from the active layer only, or from every visible layer as shown")));
      }
      toolHeader.append(field("Size", numberField(b.size, 1, 2000, 1, (v) => { b.size = v; requestDraw(); }, { unit: "px", width: 56 })));
      toolHeader.append(field("Hardness", percentControl(b.hardness, 0, (v) => { b.hardness = v; requestDraw(); })));
      toolHeader.append(field(tool === "blur" ? "Strength" : "Opacity", percentControl(b.opacity, 0.01, (v) => { b.opacity = v; }, "Press 1–9 for 10–90%, 0 for 100%")));
      if (tool === "brush") toolHeader.append(field("Smoothing", (() => {
        const wrap = document.createElement("div");
        wrap.style.display = "flex"; wrap.style.alignItems = "center"; wrap.style.gap = "6px";
        const slider = document.createElement("input");
        slider.type = "range"; slider.min = "0"; slider.max = "100"; slider.step = "1"; slider.value = String(b.smoothing); slider.style.width = "100px";
        const f = numberField(b.smoothing, 0, 100, 1, (v) => { slider.value = String(v); b.smoothing = v; }, { width: 54, help: "The brush trails the pointer on a string this long, so a shaky hand still draws a smooth line" });
        slider.addEventListener("input", () => { b.smoothing = Number(slider.value); f.querySelector("input")!.value = slider.value; });
        wrap.append(slider, f);
        return wrap;
      })()));
      if (maskTarget) {
        const pick = document.createElement("select");
        pick.innerHTML = `<option value="black">Black · Hide</option><option value="white">White · Reveal</option>`;
        pick.value = s.maskPaintWhite ? "white" : "black";
        pick.addEventListener("change", () => { s.maskPaintWhite = pick.value === "white"; app.emitView(); });
        toolHeader.append(field("Paint", pick));
      } else if (tool === "brush" || tool === "spot-healing") {
        // The brush colour is the foreground colour; editing it here keeps the well in sync.
        const color = document.createElement("input");
        color.type = "color";
        color.className = "brush-color";
        color.value = s.foreground;
        color.title = "Foreground color";
        color.addEventListener("input", () => {
          s.foreground = color.value;
          const well = toolRail.querySelector<HTMLInputElement>(".swatches .fg");
          if (well) well.value = color.value;
        });
        color.addEventListener("change", () => app.emitView());
        toolHeader.append(field("Color", color));
      }
      const tip = document.createElement("div");
      tip.className = "hint";
      tip.textContent = tool === "clone-stamp" && !app.cloneSource ? "Alt-click to set the source"
        : maskTarget ? "Mask"
        : tool === "clone-stamp" ? "Alt-click to set the source · Drag to clone · [ ] size · Shift-[ ] hardness · 1–0 opacity · Space to pan"
        : tool === "spot-healing" ? "Drag over blemishes to heal · [ ] size · Shift-[ ] hardness · Escape cancel · Space to pan"
        : tool === "blur" ? `Drag to ${s.smearMode === "liquify" ? "push pixels" : s.smearMode === "blur" ? "soften" : "smudge"} · [ ] size · Shift-[ ] hardness · 1–0 strength · Space to pan`
        : `Drag to ${s.brushMode === "erase" ? "erase" : "paint"} · [ ] size · Shift-[ ] hardness · 1–0 opacity · Escape cancel · Space to pan`;
      toolHeader.append(tip);
    } else if (tool === "marquee" || tool === "lasso" || tool === "wand") {
      const sel = app.doc?.selection ?? null;
      if (tool === "marquee") toolHeader.append(field("Shape", segmented([{ value: "rect", label: "Rectangle" }, { value: "ellipse", label: "Ellipse" }] as const, s.marqueeShape, (v) => { s.marqueeShape = v; app.cancelLasso(); app.emitView(); }, "Press Tab to switch between Rectangle and Ellipse")));
      if (tool === "lasso") toolHeader.append(field("Lasso", segmented([{ value: "free", label: "Freehand" }, { value: "polygon", label: "Polygonal" }] as const, s.lassoMode, (v) => { s.lassoMode = v; app.cancelLasso(); app.emitView(); }, "Press Tab to switch between Freehand and Polygonal")));
      toolHeader.append(field("Mode", segmented([{ value: "replace", label: "New" }, { value: "add", label: "Add" }, { value: "subtract", label: "Subtract" }] as const, app.displayedSelectionMode() as "replace" | "add" | "subtract", (v) => { s.selectionModeChoice = v; app.emitView(); }, "Hold Shift to add or Option to subtract for one outline")));
      if (tool === "wand") {
        toolHeader.append(field("Tolerance", numberField(s.wandTolerance, 0, 255, 1, (v) => { s.wandTolerance = Math.round(v); }, { width: 50, help: "How far each color channel (0–255) can differ from the clicked color and still be selected" })));
        const size = document.createElement("select");
        size.innerHTML = `<option value="0">Point Sample</option><option value="1">3 by 3 Average</option><option value="2">5 by 5 Average</option>`;
        size.value = String(s.wandSampleSize);
        size.title = "Match the clicked pixel, or the average of the pixels around it";
        size.addEventListener("change", () => { s.wandSampleSize = Number(size.value) as 0 | 1 | 2; });
        toolHeader.append(field("Sample Size", size));
        toolHeader.append(field("Sample", segmented([{ value: "layer", label: "This Layer" }, { value: "all", label: "All Layers" }] as const, s.wandSampleAll ? "all" : "layer", (v) => { s.wandSampleAll = v === "all"; app.emitView(); }, "Read colors from the active layer only, or from every visible layer as shown")));
        const contiguous = document.createElement("button");
        contiguous.className = "toggle" + (s.wandContiguous ? " active" : "");
        contiguous.textContent = "Contiguous";
        contiguous.title = "Select only similar pixels connected to the one you click; off selects them everywhere";
        contiguous.addEventListener("click", () => { s.wandContiguous = !s.wandContiguous; app.emitView(); });
        toolHeader.append(contiguous);
      }
      if (tool !== "marquee" || s.marqueeShape === "ellipse") {
        // Rectangles snap to whole pixels, so smoothing does not apply (as in Photoshop); ellipses curve.
        const aa = document.createElement("button");
        aa.className = "toggle" + (s.selectionAntialiased ? " active" : "");
        aa.textContent = "Anti-alias";
        aa.title = "Smooth selection edges; turn off for hard pixel edges";
        aa.addEventListener("click", () => { s.selectionAntialiased = !s.selectionAntialiased; app.emitView(); });
        toolHeader.append(aa);
      }
      const divider = document.createElement("div");
      divider.className = "divider";
      toolHeader.append(divider);
      const canModify = app.hasSelection() && !app.isSelectionEmpty() && !s.lassoPath;
      const amount = (label: string, value: number, max: number, help: string, onAmount: (v: number) => void, run: () => void) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.title = help;
        b.disabled = !canModify;
        b.addEventListener("click", run);
        const f = numberField(value, 1, max, 1, onAmount, { unit: "px", width: 44 });
        f.querySelector("input")!.disabled = !canModify;
        const wrap = document.createElement("div");
        wrap.className = "field";
        wrap.append(b, f);
        return wrap;
      };
      toolHeader.append(
        amount("Expand", s.selectionExpandAmount, 500, "Expand the selection by this many pixels", (v) => { s.selectionExpandAmount = v; }, () => app.resizeSelection(s.selectionExpandAmount)),
        amount("Contract", s.selectionContractAmount, 500, "Contract the selection by this many pixels", (v) => { s.selectionContractAmount = v; }, () => app.resizeSelection(-s.selectionContractAmount)),
        amount("Feather", s.selectionFeatherAmount, 250, "Fade the edge of the selection by this many pixels", (v) => { s.selectionFeatherAmount = v; }, () => app.featherSelection(s.selectionFeatherAmount)),
      );
      if (sel && app.isSelectionEmpty()) { const empty = document.createElement("div"); empty.className = "hint"; empty.textContent = "Empty selection"; toolHeader.append(empty); }
      if (sel) { const d = document.createElement("button"); d.textContent = "Deselect"; d.addEventListener("click", () => app.deselect()); toolHeader.append(d); }
      const how = document.createElement("div");
      how.className = "hint";
      how.textContent = tool === "marquee"
        ? (s.marqueeShape === "ellipse" ? "Drag an ellipse · Shift add · Option subtract · Shift again mid-drag circle · Drag inside to move · Delete clears · ⌘D deselect"
          : "Drag a rectangle · Shift add · Option subtract · Shift again mid-drag square · Drag inside to move · ⌘-drag moves pixels · Delete clears · ⌘D deselect")
        : tool === "lasso"
          ? (s.lassoMode === "polygon" ? "Click corners · Click start, double-click or Enter to close · Delete removes corner · Escape cancel"
            : "Drag to select · Drag inside to move · Shift add · Option subtract · Delete clears · ⌥⌫/⌘⌫ fill · ⌘D deselect")
          : "Click to select similar colors · Shift add · Option subtract · Drag inside to move · ⌘-drag moves pixels · Delete clears · ⌘D deselect";
      toolHeader.append(how);
    } else if (tool === "shape") {
      const shapeLayer = app.activeLayer?.kind === "shape" ? app.activeLayer : null;
      const kindNow = s.shapeKind === "rounded" ? "rect" : s.shapeKind;
      toolHeader.append(segmented([{ value: "rect", label: "Rectangle" }, { value: "ellipse", label: "Ellipse" }, { value: "line", label: "Line" }] as const, kindNow, (v) => { s.shapeKind = v; app.cancelShape(); app.emitView(); }, "Shift-U (or Tab) steps through Rectangle, Ellipse and Line"));
      const sliderField = (label: string, value: number, sliderMax: number, min: number, max: number, help: string, on: (v: number) => void) => {
        const wrap = document.createElement("div");
        wrap.style.display = "flex"; wrap.style.alignItems = "center"; wrap.style.gap = "6px";
        const slider = document.createElement("input");
        slider.type = "range"; slider.min = String(min); slider.max = String(sliderMax); slider.step = "1"; slider.value = String(Math.min(sliderMax, value)); slider.style.width = "100px";
        const f = numberField(value, min, max, 1, (v) => { slider.value = String(Math.min(sliderMax, v)); on(Math.round(v)); }, { unit: "px", width: 56, help });
        slider.addEventListener("input", () => { f.querySelector("input")!.value = slider.value; on(Number(slider.value)); });
        slider.addEventListener("change", () => { if (shapeLayer) app.commit("Edit shape"); });
        f.querySelector("input")!.addEventListener("change", () => { if (shapeLayer) app.commit("Edit shape"); });
        wrap.append(slider, f);
        return field(label, wrap);
      };
      if (kindNow === "line") toolHeader.append(sliderField("Width", shapeLayer?.shape?.kind === "line" ? shapeLayer.shape.strokeWidth : s.shapeLineWidth, 100, 1, 5000, "Line thickness in pixels", (v) => { s.shapeLineWidth = v; if (shapeLayer?.shape?.kind === "line") app.setShape({ strokeWidth: v }); }));
      if (kindNow === "rect") toolHeader.append(sliderField("Radius", shapeLayer?.shape && shapeLayer.shape.kind !== "line" && shapeLayer.shape.kind !== "ellipse" ? shapeLayer.shape.radius : s.shapeCornerRadius, 200, 0, 5000, "Round the rectangle's corners by this many pixels; 0 keeps them square", (v) => { s.shapeCornerRadius = v; if (shapeLayer?.shape && (shapeLayer.shape.kind === "rect" || shapeLayer.shape.kind === "rounded")) app.setShape({ radius: v, kind: v > 0 ? "rounded" : "rect" }); }));
      const fill = document.createElement("input");
      fill.type = "color";
      fill.className = "brush-color";
      fill.value = shapeLayer?.shape ? (shapeLayer.shape.kind === "line" ? shapeLayer.shape.stroke : shapeLayer.shape.fill) : s.foreground;
      fill.title = "Shapes fill with the foreground color; click to change it";
      fill.addEventListener("input", () => {
        s.foreground = fill.value;
        const well = toolRail.querySelector<HTMLInputElement>(".swatches .fg");
        if (well) well.value = fill.value;
        if (shapeLayer?.shape) app.setShape(shapeLayer.shape.kind === "line" ? { stroke: fill.value } : { fill: fill.value });
      });
      fill.addEventListener("change", () => { if (shapeLayer) app.commit("Shape fill"); else app.emitView(); });
      toolHeader.append(field("Fill", fill));
      const how = document.createElement("div");
      how.className = "hint";
      how.textContent = `Drag to draw a shape on a new layer · Shift ${kindNow === "line" ? "45°" : kindNow === "rect" ? "square" : "circle"} · Option from center · Shift-U or Tab for the next shape · Escape cancel · Space to pan`;
      toolHeader.append(how);
    } else if (tool === "type") {
      // Values come from the selected text layer when there is one, else the defaults for the next.
      const t = app.activeLayer?.kind === "text" && app.activeLayer.text ? app.activeLayer.text : s.text;
      const editing = !!app.session.textEdit;
      const live = app.activeLayer?.kind === "text";
      const commitLater = (label: string) => () => { if (live && !editing) app.commit(label); };
      const family = document.createElement("select");
      family.className = "font-select";
      family.title = "Font face";
      const fillFamilies = (list: string[]) => {
        family.innerHTML = "";
        const all = [...new Set([t.fontFamily, ...list])];
        for (const f of all) {
          const o = document.createElement("option");
          o.value = f;
          o.textContent = f;
          o.style.fontFamily = `"${f}"`;
          family.appendChild(o);
        }
        if (!localFamilies) {
          const o = document.createElement("option");
          o.value = "__system__";
          o.textContent = "System fonts…";
          family.appendChild(o);
        }
        family.value = t.fontFamily;
      };
      fillFamilies(localFamilies ?? CURATED_FONTS);
      family.addEventListener("change", () => {
        if (family.value === "__system__") {
          loadLocalFonts()
            .then((list) => { fillFamilies(list); family.focus(); })
            .catch((err) => { console.error(err); family.value = t.fontFamily; });
          return;
        }
        app.setText({ fontFamily: family.value });
        commitLater("Edit Text")();
      });
      const weight = document.createElement("select");
      for (const [w, label] of FONT_WEIGHTS) {
        const o = document.createElement("option");
        o.value = String(w);
        o.textContent = label;
        weight.appendChild(o);
      }
      weight.value = String(FONT_WEIGHTS.some(([w]) => w === t.weight) ? t.weight : 400);
      weight.addEventListener("change", () => { app.setText({ weight: Number(weight.value) }); commitLater("Edit Text")(); });
      const size = numberField(t.fontSize, 1, 2000, 1, (v) => app.setText({ fontSize: v }), { unit: "px", width: 56 });
      size.querySelector("input")!.addEventListener("change", commitLater("Edit Text"));
      const color = document.createElement("input");
      color.type = "color";
      color.className = "brush-color";
      color.value = t.color;
      color.title = "Text color";
      color.addEventListener("input", () => app.setText({ color: color.value }));
      color.addEventListener("change", commitLater("Edit Text"));
      const align = document.createElement("div");
      align.className = "seg";
      for (const [value, glyph, title] of [["left", "align-left", "Align left"], ["center", "align-center", "Align center"], ["right", "align-right", "Align right"]] as const) {
        const b = document.createElement("button");
        b.innerHTML = icon(glyph, 16);
        b.title = title;
        b.dataset.align = value;
        b.classList.toggle("active", t.align === value);
        b.addEventListener("click", () => { app.setText({ align: value }); commitLater("Edit Text")(); });
        align.appendChild(b);
      }
      const tracking = numberField(t.letterSpacing, -100, 1000, 1, (v) => app.setText({ letterSpacing: v }), { width: 50 });
      tracking.querySelector("input")!.addEventListener("change", commitLater("Edit Text"));
      // Leading is baseline to baseline in pixels; empty or 0 is Auto (120 % of the size).
      const leadingPx = Math.abs(t.lineHeight - 1.2) < 1e-6 ? 0 : Math.round(t.lineHeight * t.fontSize);
      const leading = numberField(leadingPx, 0, 5000, 1, (v) => app.setText({ lineHeight: v > 0 ? v / t.fontSize : 1.2 }), { width: 56, help: "Line height, baseline to baseline. Empty or 0 is Auto: 120% of the font size." });
      const leadInput = leading.querySelector("input")!;
      leadInput.placeholder = "Auto";
      if (leadingPx === 0) leadInput.value = "";
      leadInput.addEventListener("change", commitLater("Edit Text"));
      toolHeader.append(field("Font", family), field("Weight", weight), field("Size", size), field("Color", color), align, field("Tracking", tracking), field("Leading", leading));
      if (editing) {
        const cancel = document.createElement("button"); cancel.textContent = "Cancel"; cancel.addEventListener("click", () => app.endTextEdit(false));
        const done = document.createElement("button"); done.textContent = "Done"; done.className = "active"; done.addEventListener("click", () => app.endTextEdit(true));
        toolHeader.append(cancel, done);
      } else {
        const edit = document.createElement("button"); edit.textContent = "Edit Text"; edit.disabled = !live;
        edit.addEventListener("click", () => { const l = app.activeLayer; if (l?.kind === "text") app.beginTextEdit(l.id, false); });
        toolHeader.append(edit);
      }
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Drag a text box · Click text to edit · ⌘Return finish · Escape cancel";
      toolHeader.append(hint);
    } else if (tool === "crop") {
      const ratio = document.createElement("select");
      ratio.innerHTML = ["Free", "Original", "1:1", "4:3", "3:4", "16:9", "9:16"].map((l) => `<option value="${l}">${l}</option>`).join("");
      ratio.value = s.cropRatioChoice;
      ratio.addEventListener("change", () => app.changeCropRatio(ratio.value as typeof s.cropRatioChoice));
      toolHeader.append(field("Ratio", ratio));
      if (s.cropRect) {
        const size = document.createElement("div");
        size.className = "hint";
        size.style.fontVariantNumeric = "tabular-nums";
        size.textContent = `${Math.round(s.cropRect.w)} × ${Math.round(s.cropRect.h)} px`;
        toolHeader.append(size);
      }
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.disabled = !s.cropRect;
      cancel.addEventListener("click", () => app.cancelCrop());
      const apply = document.createElement("button");
      apply.textContent = "Apply Crop";
      apply.className = "active";
      apply.disabled = !s.cropRect;
      apply.addEventListener("click", () => app.applyCrop());
      const how = document.createElement("div");
      how.className = "hint";
      how.textContent = "Drag to crop · Enter apply · Escape cancel · Space to pan";
      toolHeader.append(cancel, apply, how);
    } else if (tool === "gradient") {
      toolHeader.append(...gradientHeader());
    } else if (tool === "eyedropper") {
      const ring = document.createElement("button");
      ring.className = "toggle" + (s.showsSampleRing ? " active" : "");
      ring.textContent = "Sample Ring";
      ring.addEventListener("click", () => { s.showsSampleRing = !s.showsSampleRing; app.emitView(); });
      toolHeader.append(ring);
    } else if (tool === "zoom") {
      const pct = numberField(Math.round(s.zoom * 10000) / 100, 0.1, 3200, 1, () => {}, { unit: "%", width: 72, help: "Zoom percentage (0.1–3200%). Press Return to apply.", digits: 2 });
      const input = pct.querySelector("input")!;
      input.removeEventListener("input", () => {});
      const applyZoom = () => { const v = Number(input.value); if (Number.isFinite(v) && v > 0) app.zoomTo(canvas, v / 100); };
      input.addEventListener("change", applyZoom);
      input.addEventListener("blur", applyZoom);
      toolHeader.append(pct);
      const how = document.createElement("div");
      how.className = "hint";
      how.textContent = "Click to zoom in · Option-click to zoom out · Drag right or left to zoom smoothly · Space to pan";
      toolHeader.append(how);
    } else if (tool === "hand") {
      const how = document.createElement("div");
      how.className = "hint";
      how.textContent = "Drag to pan · Ctrl or Alt + wheel zooms";
      toolHeader.append(how);
    } else if (tool === "idle") {
      const how = document.createElement("div");
      how.className = "hint";
      how.textContent = "No tool selected · Press a tool's key to pick one · Space to pan";
      toolHeader.append(how);
    }

    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    toolHeader.appendChild(spacer);
  }

  /* ── Gradient tool header: preset picker (Photoshop "Basics"), style and reverse ────── */
  function gradientHeader(): HTMLElement[] {
    const s = app.session;
    const g = s.gradient;
    const preset = GRADIENT_PRESETS.find((p) => p.id === g.preset) ?? GRADIENT_PRESETS[0];
    const stops = gradientStops(g.preset, s.foreground, s.background, g.reverse);

    // Preview strip + chevron opens the preset popover, like Photoshop's gradient picker.
    const pick = document.createElement("button");
    pick.className = "gradient-pick";
    pick.title = `${preset.name} · click to choose a preset`;
    pick.innerHTML = `<span class="gradient-strip"><span></span></span>${icon("chevron-down", 14)}`;
    (pick.querySelector(".gradient-strip span") as HTMLElement).style.background = gradientCss(stops);
    pick.addEventListener("click", (e) => {
      e.stopPropagation();
      if (contextMenuEl?.classList.contains("gradient-popover")) { closeContextMenu(); return; }
      openGradientPopover(pick);
    });

    const styles = document.createElement("div");
    styles.className = "seg gradient-styles";
    for (const st of ["linear", "radial"] as GradientStyle[]) {
      const b = document.createElement("button");
      b.className = `gstyle ${st}${g.style === st ? " active" : ""}`;
      b.title = st === "linear" ? "Linear gradient" : "Radial gradient";
      b.innerHTML = `<span class="gstyle-thumb"></span>`;
      b.addEventListener("click", () => app.setGradient({ style: st }));
      styles.append(b);
    }

    const reverse = document.createElement("button");
    reverse.className = `gradient-reverse${g.reverse ? " active" : ""}`;
    reverse.title = "Reverse the gradient direction";
    reverse.innerHTML = `${icon("swap", 14)}<span>Reverse</span>`;
    reverse.addEventListener("click", () => app.setGradient({ reverse: !g.reverse }));
    styles.title = "Linear runs along the line; Radial spreads out from the start point";

    // Opacity slider + percent field, as Compositor pairs them.
    const opacity = document.createElement("div");
    opacity.className = "field";
    opacity.innerHTML = "<label>Opacity</label>";
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "0.01"; slider.max = "1"; slider.step = "0.01"; slider.value = String(g.opacity); slider.style.width = "100px";
    const pctIn = document.createElement("input");
    pctIn.type = "number"; pctIn.min = "1"; pctIn.max = "100"; pctIn.step = "1"; pctIn.value = String(Math.round(g.opacity * 100)); pctIn.style.width = "54px";
    pctIn.title = "Press 1–9 for 10–90%, 0 for 100%";
    slider.addEventListener("input", () => { pctIn.value = String(Math.round(Number(slider.value) * 100)); app.setGradient({ opacity: Number(slider.value) }); });
    pctIn.addEventListener("input", () => { const v = Math.min(100, Math.max(1, Number(pctIn.value) || 100)); slider.value = String(v / 100); app.setGradient({ opacity: v / 100 }); });
    const unit = document.createElement("span"); unit.className = "unit"; unit.textContent = "%";
    opacity.append(slider, pctIn, unit);
    makeScrubby(opacity.querySelector("label")!, pctIn);

    const out: HTMLElement[] = [pick, styles, reverse, opacity];
    if (s.maskSelected && app.activeLayer?.mask) { const m = document.createElement("div"); m.className = "hint"; m.textContent = "Mask"; out.push(m); }
    if (app.gradientEdit) {
      const cancel = document.createElement("button"); cancel.textContent = "Cancel"; cancel.addEventListener("click", () => app.cancelGradient());
      const apply = document.createElement("button"); apply.textContent = "Apply"; apply.className = "active"; apply.addEventListener("click", () => app.commitGradient());
      out.push(cancel, apply);
    }
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Drag to draw · Drag ends to adjust · Shift 45° · 1–0 opacity · Enter apply · Escape cancel";
    out.push(hint);
    return out;
  }

  function openGradientPopover(anchor: HTMLElement): void {
    closeContextMenu();
    const s = app.session;
    const el = document.createElement("div");
    el.className = "menu-dropdown context-menu gradient-popover";
    const group = document.createElement("div");
    group.className = "gradient-group";
    group.innerHTML = `<div class="gradient-group-head">${icon("folder-open", 16)}<span>Basics</span></div>`;
    const tiles = document.createElement("div");
    tiles.className = "gradient-tiles";
    for (const p of GRADIENT_PRESETS) {
      const t = document.createElement("button");
      t.className = `gradient-tile${p.id === s.gradient.preset ? " active" : ""}`;
      t.dataset.preset = p.id;
      t.title = p.name;
      t.innerHTML = `<span></span>`;
      (t.firstElementChild as HTMLElement).style.background = gradientCss(gradientStops(p.id, s.foreground, s.background, s.gradient.reverse), "linear", 135);
      t.addEventListener("click", () => { closeContextMenu(); app.setGradient({ preset: p.id }); });
      tiles.append(t);
    }
    group.append(tiles);
    const name = document.createElement("div");
    name.className = "gradient-name";
    name.textContent = GRADIENT_PRESETS.find((p) => p.id === s.gradient.preset)?.name ?? "";
    tiles.addEventListener("pointerover", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".gradient-tile");
      if (b) name.textContent = GRADIENT_PRESETS.find((p) => p.id === b.dataset.preset)?.name ?? "";
    });
    el.append(group, name);
    adoptTitles(el);
    document.body.appendChild(el);
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.min(a.left, innerWidth - r.width - 8)}px`;
    el.style.top = `${Math.min(a.bottom + 4, innerHeight - r.height - 8)}px`;
    contextMenuEl = el;
  }

  function renderLayers(): void {
    const doc = app.doc;
    if (doc) flattenDocument(doc); // brings text/shape bitmaps up to date so thumbnails are current (cached per version)
    layersPanel.innerHTML = `
      <div class="head"><span>Layers</span><span class="count" id="layer-count">${doc?.layers.length ?? 0}</span></div>
      <div class="appearance" id="appearance"></div>
      <div class="layer-list" id="layer-list"></div>
      <div class="layer-footer">
        <button data-act="add" title="New blank layer">${icon("plus", 18)}</button>
        <button data-act="image" title="Add image from a file as a new layer">${icon("image", 18)}</button>
        <button data-act="group" title="Group selected layers">${icon("folder", 18)}</button>
        <button data-act="mask" title="Add layer mask">${icon("mask", 18)}</button>
        <button data-act="fx" title="Add layer effect (drop shadow)">${icon("sparkles", 18)}</button>
        <button data-act="adj" title="Add adjustment layer (Hue/Saturation)">${icon("sliders", 18)}</button>
        <button data-act="del" title="Delete selected layers">${icon("trash", 18)}</button>
      </div>
    `;
    const appearance = layersPanel.querySelector<HTMLElement>("#appearance")!;
    const list = layersPanel.querySelector<HTMLElement>("#layer-list")!;
    const active = app.activeLayer;

    if (active) {
      const blend = document.createElement("select");
      for (const group of BLEND_GROUPS) {
        const og = document.createElement("optgroup");
        og.label = group.label;
        for (const m of group.modes) {
          const o = document.createElement("option");
          o.value = m;
          o.textContent = BLEND_LABELS[m];
          og.appendChild(o);
        }
        blend.appendChild(og);
      }
      blend.value = active.blendMode;
      blend.addEventListener("change", () => {
        active.blendMode = blend.value as BlendMode;
        app.commit("Blend mode");
      });

      const opacity = document.createElement("input");
      opacity.type = "range";
      opacity.min = "0";
      opacity.max = "1";
      opacity.step = "0.01";
      opacity.value = String(active.opacity);
      opacity.addEventListener("input", () => {
        active.opacity = Number(opacity.value);
        app.redraw();
      });
      opacity.addEventListener("change", () => app.commit("Opacity"));

      const name = document.createElement("input");
      name.type = "text";
      name.id = "layer-name";
      name.value = active.name;
      name.addEventListener("change", () => {
        active.name = name.value;
        app.commit("Rename layer");
      });

      const vis = document.createElement("button");
      vis.className = "icon-btn";
      vis.innerHTML = icon(active.visible ? "eye" : "eye-off", 18);
      vis.title = "Toggle visibility";
      vis.addEventListener("click", () => {
        active.visible = !active.visible;
        app.commit("Toggle visibility");
      });

      appearance.append(
        row("Blend", blend),
        row("Opacity", opacity),
        row("Name", name),
        row("Visible", vis),
      );
    }

    if (!doc?.layers.length) {
      list.innerHTML = `<div style="padding:24px;text-align:center;color:var(--fg-dark)">No layers yet</div>`;
    } else {
      for (const row of layerTree(doc)) {
        list.appendChild(layerRow(row.layer, doc, row.depth));
      }
      list.addEventListener("contextmenu", (e) => {
        if ((e.target as HTMLElement).closest(".layer-row")) return; // rows handle their own
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, layerMenuItems());
      });
    }

    layersPanel.querySelectorAll<HTMLButtonElement>(".layer-footer button").forEach((b) => {
      b.addEventListener("click", () => {
        const act = b.dataset.act;
        if (act === "add") app.addBlankLayer();
        if (act === "image") addImageDialog();
        if (act === "group") app.addGroup();
        if (act === "del") app.deleteSelection();
        if (act === "mask") {
          const l = app.activeLayer;
          if (l && !l.mask) {
            const c = document.createElement("canvas");
            c.width = doc?.width ?? 1;
            c.height = doc?.height ?? 1;
            const ctx = c.getContext("2d")!;
            ctx.fillStyle = "#fff";
            ctx.fillRect(0, 0, c.width, c.height);
            l.mask = { canvas: c, enabled: true, linked: true };
            app.commit("Add mask");
          }
        }
        if (act === "fx") app.addEffect("drop-shadow");
        if (act === "adj") app.addAdjustment("hsv");
      });
    });
  }

  function row(label: string, control: HTMLElement): HTMLElement {
    const r = document.createElement("div");
    r.className = "row";
    r.innerHTML = `<label>${label}</label>`;
    r.appendChild(control);
    return r;
  }

  let lastRowClick = { id: "", at: 0 };
  const renamers = new Map<string, () => void>();
  function renameRow(id: string | null): void {
    if (id) renamers.get(id)?.();
  }
  function layerRow(layer: Layer, doc: DocumentState, depth = 0): HTMLElement {
    const el = document.createElement("div");
    const isGroup = layer.kind === "group";
    el.className = "layer-row" + (app.session.selectedLayerIds.includes(layer.id) ? " active" : "") + (isGroup ? " group" : "");
    el.style.marginLeft = `${depth * 16}px`;
    el.dataset.id = layer.id;
    const eye = document.createElement("button");
    eye.className = "eye" + (layer.visible ? "" : " off");
    eye.innerHTML = icon(layer.visible ? "eye" : "eye-off", 16);
    eye.title = layer.visible ? "Hide layer" : "Show layer";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      app.commit("Toggle visibility");
    });
    const thumb = document.createElement("div");
    thumb.className = "thumb" + (isGroup ? " folder" : "");
    if (isGroup) {
      const count = doc.layers.filter((l) => l.parentId === layer.id).length;
      thumb.innerHTML = `<span class="disclosure">${icon(layer.collapsed ? "chevron-right" : "chevron-down", 14)}</span><span class="folder-icon">${icon(layer.collapsed ? "folder" : "folder-open", 18)}</span>`;
      thumb.title = `${count} item${count === 1 ? "" : "s"} · double-click to ${layer.collapsed ? "open" : "close"}`;
      thumb.querySelector(".disclosure")!.addEventListener("click", (e) => { e.stopPropagation(); app.toggleCollapsed(layer); });
    } else if (layer.canvas) {
      const t = document.createElement("canvas");
      t.width = 40;
      t.height = 28;
      t.getContext("2d")!.drawImage(layer.canvas, 0, 0, 40, 28);
      thumb.appendChild(t);
    } else if (layer.kind === "adjustment") {
      thumb.className = "thumb adjustment";
      thumb.appendChild(iconEl("sliders", 18));
    }
    const isActive = layer.id === app.session.activeLayerId;
    thumb.classList.toggle("target", isActive && !app.session.maskSelected && !!layer.mask);
    let maskThumb: HTMLElement | null = null;
    if (layer.mask) {
      maskThumb = document.createElement("div");
      maskThumb.className = "thumb mask" + (isActive && app.session.maskSelected ? " target" : "") + (layer.mask.enabled ? "" : " off");
      const t = document.createElement("canvas");
      t.width = 40; t.height = 28;
      const mctx = t.getContext("2d")!;
      mctx.fillStyle = "#000"; mctx.fillRect(0, 0, 40, 28);
      mctx.drawImage(layer.mask.canvas, 0, 0, 40, 28); // alpha coverage: opaque = reveal
      maskThumb.appendChild(t);
      maskThumb.title = "Layer mask · click to paint it (black hides, white reveals)";
      maskThumb.addEventListener("click", (e) => { e.stopPropagation(); app.selectLayer(layer.id, { mask: true }); });
    }
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = layer.name + (layer.blendMode !== "normal" ? ` · ${BLEND_LABELS[layer.blendMode]}` : "");
    name.title = "Double-click to rename";
    const thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    thumbs.append(thumb);
    if (maskThumb) thumbs.append(maskThumb);
    el.append(eye, thumbs, name);
    el.addEventListener("click", (e) => {
      // Rows are rebuilt on selection changes, so the browser cannot pair two clicks into a dblclick;
      // detect the double-click here from two plain clicks on the same layer.
      const now = performance.now();
      const isDouble = lastRowClick.id === layer.id && now - lastRowClick.at < 400 && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      lastRowClick = { id: layer.id, at: now };
      if (isDouble) {
        lastRowClick = { id: "", at: 0 };
        const onName = (e.target as HTMLElement).closest(".name");
        if (isGroup && !onName) app.toggleCollapsed(layer);
        else renameInline();
        return;
      }
      app.selectLayer(layer.id, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
    });
    /** Edit the name right in the row (Enter/blur commits, Escape cancels). */
    const renameInline = () => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = layer.name;
      input.className = "rename";
      name.replaceChildren(input);
      let done = false;
      const finish = (commit: boolean) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (commit && v && v !== layer.name) { layer.name = v; app.commit("Rename layer"); }
        else app.emitView();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("dblclick", (e) => e.stopPropagation());
      input.focus();
      input.select();
    };
    renamers.set(layer.id, renameInline);
    el.addEventListener("dblclick", (e) => e.preventDefault()); // handled by the click pairing above
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (!app.session.selectedLayerIds.includes(layer.id)) app.selectLayer(layer.id);
      showContextMenu(e.clientX, e.clientY, layerMenuItems());
    });
    el.draggable = true;
    el.addEventListener("dragstart", (e) => e.dataTransfer?.setData("text/layer", layer.id));
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("drop-target"); });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop-target");
      const id = e.dataTransfer?.getData("text/layer");
      if (!id || id === layer.id) return;
      // Dropping onto a folder puts the layer inside it; onto anything else places it above that row.
      app.moveLayer(id, layer.id, isGroup && !layer.collapsed);
    });
    return el;
  }

  function renderStatus(): void {
    const doc = app.doc;
    const s = app.session;
    const layer = app.activeLayer;
    statusBar.innerHTML = "";
    const tabs = document.createElement("div");
    tabs.className = "doc-tabs";
    if (!app.docs.length) tabs.textContent = "No document";
    for (const d of app.docs) {
      const b = document.createElement("button");
      b.className = "doc-tab" + (d.id === app.activeDocId ? " active" : "");
      b.textContent = `${d.dirty ? "● " : ""}${d.name}${d.source ? " ⟳" : ""}`;
      if (d.source) b.title = `Watching ${d.source.label}: reloads when it changes on disk`;
      b.title = `${d.fileName ?? "Not saved yet"} · ${d.width}×${d.height}`;
      b.addEventListener("click", () => app.switchDocument(d.id));
      tabs.appendChild(b);
    }
    statusBar.appendChild(tabs);
    const info = document.createElement("div");
    info.className = "doc-info";
    info.innerHTML = `
      <span>${doc ? `${doc.width}×${doc.height}` : ""}</span>
      <span id="zoom-readout">${Math.round(s.zoom * 100)}%</span>
      <span>${layer ? layer.name : "—"}</span>
      <span>${doc?.dirty ? "Unsaved" : "Saved"}</span>
    `;
    statusBar.appendChild(info);
  }

  function render(): void {
    syncTextEditor();
    renderMenus();
    renderToolRail();
    renderToolHeader();
    renderLayers();
    renderStatus();
    canvasWrap.className = "canvas-wrap tool-" + app.session.tool;
    applyCursor();
    adoptTitles(root);
  }

  /* canvas events */
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 2 && !app.isBrushTool()) return; // context menu
    if (e.button === 2) { canvas.setPointerCapture(e.pointerId); app.pointerDown(canvas, e); return; } // right-drag sizes the tip
    if (app.session.textEdit) {
      // Clicking the canvas outside the editor commits; a click on another text layer starts editing it.
      app.endTextEdit(true);
      if (app.session.tool === "type" && app.doc) {
        const p = screenToDoc(canvas, app.doc, app.session, e.clientX, e.clientY);
        const hit = app.textLayerAt(p);
        if (hit) { app.selectLayer(hit.id); app.beginTextEdit(hit.id, false); }
      }
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    app.pointerDown(canvas, e);
    if (app.brushError) { reportError(app.brushError); app.brushError = null; }
  });
  canvas.addEventListener("dblclick", (e) => {
    if (app.session.tool === "lasso" && app.session.lassoPath) { app.closeLasso(e.shiftKey ? "add" : e.altKey ? "subtract" : "replace"); return; }
    if (app.session.tool !== "move" || !app.doc) return;
    const hit = app.textLayerAt(screenToDoc(canvas, app.doc, app.session, e.clientX, e.clientY));
    if (hit) { app.selectLayer(hit.id); app.setTool("type"); app.beginTextEdit(hit.id, false); }
  });
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (app.isBrushTool()) return; // shown on pointer-up unless the right-drag resized the tip
    canvasMenu(e.clientX, e.clientY);
  });
  function canvasMenu(x: number, y: number): void {
    const e = { clientX: x, clientY: y };
    if (app.hasSelection()) showContextMenu(e.clientX, e.clientY, selectionMenuItems());
    else showContextMenu(e.clientX, e.clientY, [
      { label: "Select All", shortcut: "⌘A", action: () => app.selectAll() },
      { label: "Paste as Layer", shortcut: "⌘V", action: () => void app.pasteFromClipboard().catch(reportError) },
      { sep: true, label: "" },
      ...layerMenuItems(),
    ]);
  }

  /** Right-click inside a selection: what Photoshop offers, starting with the extraction commands. */
  function selectionMenuItems(): MenuItem[] {
    const l = app.activeLayer;
    const pixels = !!l && l.kind !== "group" && l.kind !== "adjustment";
    return [
      { label: "Layer via Copy", shortcut: "⌘J", action: () => app.layerViaCopy(false), disabled: !pixels },
      { label: "Layer via Cut", shortcut: "⇧⌘J", action: () => app.layerViaCopy(true), disabled: !pixels },
      { label: "Layer Mask from Selection", action: () => app.maskFromSelection(), disabled: !l },
      { sep: true, label: "" },
      { label: "Select Inverse", shortcut: "⇧⌘I", action: () => app.invertSelection() },
      { label: "Deselect", shortcut: "⌘D", action: () => app.deselect() },
      { sep: true, label: "" },
      { label: "Fill with Foreground", shortcut: "⌥⌫", action: () => app.fillActive(), disabled: !pixels },
      { label: "Fill with Background", shortcut: "⌘⌫", action: () => app.fillActive(app.session.background), disabled: !pixels },
      { label: "Clear", shortcut: "⌫", action: () => app.clearActive(), disabled: !pixels },
      { sep: true, label: "" },
      { label: "Cut", shortcut: "⌘X", action: () => void app.cutSelection().catch(reportError) },
      { label: "Copy", shortcut: "⌘C", action: () => void app.copyToClipboard(false).catch(reportError) },
      { label: "Copy Merged", shortcut: "⇧⌘C", action: () => void app.copyToClipboard(true).catch(reportError) },
      { label: "Transform Selection", shortcut: "⌘T", action: () => app.transformCommand() },
    ];
  }
  const mods = { shift: false, alt: false, dragging: false };
  const selectionToolActive = () => app.session.tool === "marquee" || app.session.tool === "lasso" || app.session.tool === "wand";
  /** Highlight the Mode the held keys imply without rebuilding the header. */
  function syncModePicker(): void {
    const mode = app.displayedSelectionMode();
    const seg = [...toolHeader.querySelectorAll<HTMLElement>(".field")].find((f) => f.querySelector("label")?.textContent === "Mode")?.querySelector(".seg");
    if (!seg) return;
    const labels = { replace: "New", add: "Add", subtract: "Subtract" } as const;
    for (const b of seg.querySelectorAll("button")) b.classList.toggle("active", b.textContent === labels[mode as keyof typeof labels]);
  }
  function applyCursor(e?: PointerEvent): void {
    const tool = app.session.tool;
    let cursor = cursorForTool({ tool, ...mods, space: app.tempHand });
    if ((tool === "move" || tool === "crop") && e && !mods.dragging) cursor = app.cursorAt(canvas, e) || cursor;
    if (cursor === "move") cursor = MOVE_CURSOR;
    else if (cursor === "duplicate") cursor = DUPLICATE_CURSOR;
    else if (cursor === "rotate") cursor = ROTATE_CURSOR;
    canvas.style.cursor = cursor;
  }
  canvas.addEventListener("pointermove", (e) => {
    mods.shift = e.shiftKey;
    mods.alt = e.altKey;
    mods.dragging = e.buttons !== 0;
    applyCursor(e);
    if ((PAINT_TOOLS.includes(app.session.tool) || (app.session.tool === "lasso" && app.session.lassoPath)) && app.doc) {
      const { screenToDoc } = compositorApi;
      app.session.hover = screenToDoc(canvas, app.doc, app.session, e.clientX, e.clientY);
      if (e.buttons === 0) requestDraw();
    }
    app.pointerMove(canvas, e);
  });
  canvas.addEventListener("pointerleave", () => {
    if (app.session.hover) { app.session.hover = null; requestDraw(); }
  });
  const inField = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  };
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift" || e.key === "Alt") { mods.shift = e.shiftKey; mods.alt = e.altKey; applyCursor(); app.modifiersChanged(canvas, e); if (selectionToolActive()) syncModePicker(); }
    if (e.key === " " && !inField(e) && !app.session.textEdit) {
      // Space: temporary Hand with any tool (Photoshop). Holding it must not scroll the page.
      e.preventDefault();
      if (!app.tempHand) { app.tempHand = true; applyCursor(); }
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift" || e.key === "Alt") { mods.shift = e.shiftKey; mods.alt = e.altKey; applyCursor(); app.modifiersChanged(canvas, e); if (selectionToolActive()) syncModePicker(); }
    if (e.key === " " && app.tempHand) { app.tempHand = false; applyCursor(); }
  });
  window.addEventListener("blur", () => { if (app.tempHand) { app.tempHand = false; applyCursor(); } });
  canvas.addEventListener("pointerup", (e) => {
    const tipMoved = app.tipDragMoved;
    app.pointerUp(canvas, e);
    if (e.button === 2 && app.isBrushTool()) { if (!tipMoved) canvasMenu(e.clientX, e.clientY); return; }
    mods.dragging = false;
    applyCursor(e);
  });
  canvas.addEventListener("pointercancel", (e) => app.pointerUp(canvas, e));
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (app.painting) return; // a stroke keeps the view still
    if (e.ctrlKey || e.metaKey || e.altKey) {
      // Ctrl / Alt + wheel zooms about the pointer, as Compositor's Command / Option scroll does.
      const dy = e.deltaMode === 1 ? e.deltaY * 12 : e.deltaY;
      app.zoomTo(canvas, app.session.zoom * Math.exp(-dy * 0.015), e);
    } else {
      const k = e.deltaMode === 1 ? 12 : 1;
      app.session.panX -= e.deltaX * k;
      app.session.panY -= e.deltaY * k;
      app.emitView();
    }
  }, { passive: false });

  /* menus close on outside click */
  document.addEventListener("click", () => {
    if (openMenu) {
      openMenu = null;
      render();
    }
  });

  /* keyboard */
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const mod = e.metaKey || e.ctrlKey;
    // Closing and quitting must work from anywhere, even inside a text field.
    if (mod && !e.altKey && (e.key === "w" || e.key === "W")) { e.preventDefault(); void closeDocumentAsk(); return; }
    if (mod && !e.altKey && (e.key === "q" || e.key === "Q")) { e.preventDefault(); void quitAsk(); return; }
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? app.redo() : app.undo();
      return;
    }
    const key = e.key.toLowerCase();
    // Chromium app windows do not reserve shortcuts, so the Photoshop keys work; the Alt variants remain as aliases.
    if (mod && key === "n") { e.preventDefault(); if (e.shiftKey) app.addBlankLayer(); else showNewCanvas(); return; }
    if (mod && e.altKey && key === "l") { e.preventDefault(); app.addBlankLayer(); return; }
    if (mod && key === "w") { e.preventDefault(); void closeDocumentAsk(); return; }
    if (mod && key === "q") { e.preventDefault(); void quitAsk(); return; }
    if (mod && key === "t") { e.preventDefault(); app.transformCommand(); return; }
    if (mod && key === "h") { e.preventDefault(); app.toggleTransformControls(); return; }
    if (mod && (e.key === "]" || e.key === "[")) { e.preventDefault(); app.moveLayerOrder(e.key === "]" ? 1 : -1); return; }
    if (app.transformEdit && !mod && app.session.tool === "move") {
      if (e.key === "Enter") { e.preventDefault(); app.commitTransform(); return; }
      if (e.key === "Escape") { app.cancelTransform(); return; }
    }
    if (mod && key === "o") { e.preventDefault(); openFileDialog(); return; }
    if (mod && key === "c") { e.preventDefault(); void app.copyToClipboard(e.shiftKey).catch(console.error); return; }
    // Ctrl+V is handled by the paste event below (it carries the clipboard image).
    if (mod && key === "j") { e.preventDefault(); app.layerViaCopy(e.shiftKey); return; }
    if (mod && key === "a") { e.preventDefault(); app.selectAll(); return; }
    if (mod && key === "d") { e.preventDefault(); app.deselect(); return; }
    if (mod && e.shiftKey && key === "i") { e.preventDefault(); app.invertSelection(); return; }
    if (e.key === "Escape" && app.painting) { app.cancelBrush(); return; }
    if (app.gradientEdit && !mod) {
      if (e.key === "Escape") { app.cancelGradient(); return; }
      if (e.key === "Enter") { e.preventDefault(); app.commitGradient(); return; }
    }
    if (e.key === "Escape" && app.session.shapeDraft) { app.cancelShape(); return; }
    if (app.painting) return; // a stroke keeps the keyboard until it ends
    if (app.session.tool === "crop" && app.session.cropRect && !mod) {
      if (e.key === "Enter") { e.preventDefault(); app.applyCrop(); return; }
      if (e.key === "Escape") { app.cancelCrop(); return; }
    }
    if (app.session.lassoPath && !mod) {
      if (e.key === "Escape") { app.cancelLasso(); return; }
      if (e.key === "Enter") { app.closeLasso(e.shiftKey ? "add" : e.altKey ? "subtract" : "replace"); return; }
    }
    if (mod && key === "g") { e.preventDefault(); app.addGroup(); return; }
    if (mod && key === "i") { e.preventDefault(); app.invertActive(); return; }
    if (mod && key === "e") {
      e.preventDefault();
      if (e.shiftKey) exportPng();
      else app.mergeDown();
      return;
    }
    if (mod && key === "s") {
      e.preventDefault();
      if (e.altKey && e.shiftKey) showExportJpeg();
      else void app.saveProject(e.shiftKey).catch(reportError);
      return;
    }
    if (mod && e.key === "0") {
      e.preventDefault();
      app.fit(canvas);
      return;
    }
    if (mod && e.key === "1") {
      e.preventDefault();
      app.session.zoom = 1;
      app.session.panX = 0;
      app.session.panY = 0;
      app.emit();
      return;
    }
    if (mod && !e.altKey && (e.key === "=" || e.key === "+")) { e.preventDefault(); app.zoomKeyboard(canvas, 1); return; }
    if (mod && !e.altKey && !e.shiftKey && e.key === "-") { e.preventDefault(); app.zoomKeyboard(canvas, -1); return; }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      if (e.altKey) app.fillActive();
      else if (mod) app.fillActive(app.session.background);
      else app.deleteKeyPressed();
      return;
    }
    if (mod && key === "x") { e.preventDefault(); void app.cutSelection().catch(reportError); return; }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0;
      const dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
      if (mod && app.hasSelection()) app.nudgePixels(dx, dy); // ⌘-arrows move the selected pixels with any tool
      else if (selectionToolActive() && app.hasSelection()) app.nudgeSelection(dx, dy);
      else app.nudge(dx, dy);
      return;
    }
    if (!mod && !e.altKey && key === "x") { app.swapColors(); return; }
    if (!mod && !e.altKey && key === "d") { app.resetColors(); return; }
    if (!mod && app.isBrushTool() && (e.key === "[" || e.key === "]" || e.key === "{" || e.key === "}")) {
      e.preventDefault();
      app.adjustBrush(e.key === "]" || e.key === "}" ? 1 : -1, e.shiftKey || e.key === "{" || e.key === "}");
      return;
    }
    if (!mod && !e.altKey && /^[0-9]$/.test(e.key)) { app.typeOpacityDigit(Number(e.key)); return; }
    if (e.key === "Tab" && !mod && !e.altKey && !e.shiftKey && !app.session.textEdit) { e.preventDefault(); app.cycleToolMode(); return; }
    if (mod || e.altKey) return;
    if (key === "a") { app.setTool("idle"); return; }
    if (key === "b") { app.setBrushMode("paint"); return; }
    if (key === "e") { app.setBrushMode("erase"); return; }
    if (key === "u" && e.shiftKey && app.session.tool === "shape") { app.cycleToolMode(); return; }
    const hit = TOOL_META.find((x) => x.key === key);
    if (hit) app.setTool(hit.id);
  };
  window.addEventListener("keydown", onKey);

  const onResize = () => requestDraw();
  window.addEventListener("resize", onResize);

  /* modals */
  /**
   * Drag a number's label to change its value, as in Photoshop (Compositor 1.2.11): works for
   * any field whose control is (or contains) a range or number input. Shift drags ten times faster.
   */
  function makeScrubby(label: HTMLElement, control: HTMLElement): void {
    const input = (control instanceof HTMLInputElement ? control : control.querySelector("input")) as HTMLInputElement | null;
    if (!input || (input.type !== "range" && input.type !== "number")) return;
    label.classList.add("scrub");
    label.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const step = Number(input.step) > 0 ? Number(input.step) : 1;
      const start = Number(input.value) || 0;
      const x0 = e.clientX;
      const fine = step < 1 ? step : Math.max(step, 1);
      const move = (ev: PointerEvent) => {
        const px = ev.clientX - x0;
        let v = start + px * fine * (ev.shiftKey ? 10 : 1) * (step < 1 ? 4 : 1);
        if (input.min !== "") v = Math.max(Number(input.min), v);
        if (input.max !== "") v = Math.min(Number(input.max), v);
        v = Math.round(v / step) * step;
        input.value = String(Math.round(v * 1000) / 1000);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  /** Links open in a normal browser window of the same profile (the app window stays). */
  function openLink(url: string): void {
    window.open(url, "_blank", "noopener");
  }

  const SHORTCUTS: [string, string][] = [
    ["Undo / Redo", "⌘Z / ⇧⌘Z"], ["New canvas", "⌘N"], ["Open", "⌘O"], ["Save / Save As", "⌘S / ⇧⌘S"],
    ["Export PNG / JPEG", "⇧⌘E / ⌥⇧⌘S"], ["Close document / Quit", "⌘W / ⌘Q"],
    ["New blank layer", "⇧⌘N"], ["Duplicate / Layer via Copy / Cut", "⌘J / ⇧⌘J"], ["Group / Merge down", "⌘G / ⌘E"],
    ["Move layer up / down", "⌘] / ⌘["], ["Layer opacity (two digits for exact)", "1–0"],
    ["Select All / Deselect / Inverse", "⌘A / ⌘D / ⇧⌘I"], ["Cut / Copy / Copy Merged / Paste", "⌘X / ⌘C / ⇧⌘C / ⌘V"],
    ["Invert pixels", "⌘I"], ["Transform Layer / Selection", "⌘T"], ["Show transform controls", "⌘H"],
    ["Fit / Actual pixels / Zoom in / out", "⌘0 / ⌘1 / ⌘= / ⌘-"],
    ["Fill with foreground / background", "⌥⌫ / ⌘⌫"], ["Delete selection pixels / layer / lasso corner", "⌫"],
    ["Nudge layer or selection (×10 with Shift)", "Arrows"], ["Move selected pixels", "⌘ + Arrows"],
    ["Apply / Cancel the current operation", "⏎ / ⎋"], ["Cycle the tool's mode", "Tab"], ["No tool", "A"],
    ["Tools", "V M L W C B E J S R G U T I H Z"], ["Swap / reset colours", "X / D"],
    ["Brush size / hardness", "[ ] / ⇧[ ]"], ["Resize the tip / hardness", "Right-drag / ⇧ right-drag"], ["Pan with any tool", "Space"],
    ["Add / subtract selection", "Shift / Alt + click"], ["Straight brush line / axis lock", "Shift + click / drag"],
    ["Text tracking / leading while typing", "⌥← → / ⌥↑ ↓"],
  ];

  function showShortcuts(): void {
    const body = document.createElement("div");
    body.className = "shortcuts";
    body.innerHTML = SHORTCUTS.map(([what, keys]) => `<div class="row"><span>${what}</span><kbd>${keyLabel(keys)}</kbd></div>`).join("");
    modal("Keyboard shortcuts", body, () => {});
  }

  function showAbout(): void {
    const body = document.createElement("div");
    body.className = "about";
    body.innerHTML = `
      <div class="about-head"><img class="about-icon" src="./about-icon.png" width="48" height="48" alt="Compositor icon"><div><div class="about-name">${APP_NAME}</div><div class="about-version">Version ${APP_VERSION} · ${rendererName()}</div></div></div>
      <p>A Photoshop-style image editor with layers, blend modes, masks and adjustment layers, themed live by Omarchy.</p>
      <div class="about-credit">
        <div class="about-credit-title">Original app</div>
        <p><strong>Compositor for macOS</strong> was created by <strong>${ORIGINAL_AUTHOR}</strong> (${ORIGINAL_COMPANY}); the icon above is the original app's. This Linux port rebuilds it for Omarchy and keeps its project format.</p>
        <p><a href="${ORIGINAL_SITE_URL}" target="_blank" rel="noopener">${ORIGINAL_SITE_URL.replace("https://", "")}</a><br><a href="${ORIGINAL_REPO_URL}" target="_blank" rel="noopener">${ORIGINAL_REPO_URL.replace("https://", "")}</a></p>
      </div>
      <p class="about-small">Both the original and this port are MIT licensed.${PROJECT_URL !== ORIGINAL_REPO_URL ? ` Port: <a href="${PROJECT_URL}" target="_blank" rel="noopener">${PROJECT_URL.replace("https://", "")}</a>` : ""}</p>`;
    modal(`About ${APP_NAME}`, body, () => {});
  }

  function modal(title: string, body: HTMLElement, onOk: () => void): void {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const box = document.createElement("div");
    box.className = "modal";
    box.innerHTML = `<h3>${title}</h3>`;
    const fields = document.createElement("div");
    fields.className = "fields";
    fields.appendChild(body);
    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => backdrop.remove());
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = "OK";
    ok.addEventListener("click", () => {
      onOk();
      backdrop.remove();
    });
    actions.append(cancel, ok);
    box.append(fields, actions);
    backdrop.appendChild(box);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    backdrop.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); backdrop.remove(); }
      if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "TEXTAREA") { e.preventDefault(); ok.click(); }
    });
    document.body.appendChild(backdrop);
    const first = body.querySelector<HTMLInputElement>("input");
    if (first) { first.focus(); first.select(); } else ok.focus();
  }

  function fieldRow(label: string, input: HTMLElement): HTMLElement {
    const r = document.createElement("div");
    r.className = "row";
    r.innerHTML = `<label>${label}</label>`;
    r.appendChild(input);
    return r;
  }

  function numInput(value: number): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "number";
    i.value = String(value);
    return i;
  }

  function showNewCanvas(): void {
    const w = numInput(1280);
    const h = numInput(800);
    const n = document.createElement("input");
    n.type = "text";
    n.value = "Untitled";
    const body = document.createElement("div");
    body.append(fieldRow("Width", w), fieldRow("Height", h), fieldRow("Name", n));
    modal("New Canvas", body, () => {
      app.newDocument(Number(w.value) || 1280, Number(h.value) || 800, n.value || "Untitled");
    });
  }

  function showCanvasSize(): void {
    const doc = app.doc;
    if (!doc) return;
    const w = numInput(doc.width);
    const h = numInput(doc.height);
    const body = document.createElement("div");
    body.append(fieldRow("Width", w), fieldRow("Height", h));
    modal("Canvas Size", body, () => {
      doc.width = Math.max(1, Number(w.value) || doc.width);
      doc.height = Math.max(1, Number(h.value) || doc.height);
      app.commit("Canvas size");
    });
  }

  function showImageSize(): void {
    const doc = app.doc;
    if (!doc) return;
    const w = numInput(doc.width);
    const h = numInput(doc.height);
    const body = document.createElement("div");
    body.append(fieldRow("Width", w), fieldRow("Height", h));
    modal("Image Size", body, () => {
      const nw = Math.max(1, Number(w.value) || doc.width);
      const nh = Math.max(1, Number(h.value) || doc.height);
      for (const layer of doc.layers) {
        if (!layer.canvas) continue;
        const c = document.createElement("canvas");
        c.width = nw;
        c.height = nh;
        c.getContext("2d")!.drawImage(layer.canvas, 0, 0, nw, nh);
        layer.canvas = c;
        layer.transform.width = nw;
        layer.transform.height = nh;
      }
      doc.width = nw;
      doc.height = nh;
      app.commit("Image size");
    });
  }

  /** Select › Expand… / Contract… / Feather…: a whole number of pixels, remembered in the header. */
  function promptSelectionAmount(op: "Expand" | "Contract" | "Feather"): void {
    const s = app.session;
    const max = op === "Feather" ? 250 : 500;
    const current = op === "Expand" ? s.selectionExpandAmount : op === "Contract" ? s.selectionContractAmount : s.selectionFeatherAmount;
    const r = numInput(current);
    r.min = "1"; r.max = String(max); r.step = "1";
    const body = document.createElement("div");
    body.append(fieldRow("Amount", r));
    const note = document.createElement("div");
    note.className = "hint";
    note.textContent = `Enter a whole number from 1 to ${max} px.`;
    body.append(note);
    modal(`${op} Selection`, body, () => {
      const v = Math.round(Number(r.value));
      if (!Number.isInteger(v) || v < 1 || v > max) { reportError(`Enter a whole number from 1 to ${max} px.`); return; }
      if (op === "Expand") { s.selectionExpandAmount = v; app.resizeSelection(v); }
      else if (op === "Contract") { s.selectionContractAmount = v; app.resizeSelection(-v); }
      else { s.selectionFeatherAmount = v; app.featherSelection(v); }
    });
  }

  function showBlur(): void {
    const r = numInput(6);
    const body = document.createElement("div");
    body.append(fieldRow("Radius", r));
    modal("Gaussian Blur", body, () => {
      app.applyAdjustmentToActive("gaussian-blur", { radius: Number(r.value) || 6 });
    });
  }

  function showExportJpeg(): void {
    const q = numInput(92);
    const body = document.createElement("div");
    body.append(fieldRow("Quality", q));
    modal("Export JPEG", body, () => exportJpeg((Number(q.value) || 92) / 100));
  }

  function exportPng(): void {
    const doc = app.doc;
    if (!doc) return;
    const flat = flattenDocument(doc);
    flat.toBlob((b) => {
      if (!b) return;
      downloadBlob(b, `${doc.name || "compositor"}.png`);
      doc.dirty = false;
      app.emitView();
    }, "image/png");
  }

  function exportJpeg(quality: number): void {
    const doc = app.doc;
    if (!doc) return;
    const flat = flattenDocument(doc);
    // JPEG has no alpha — composite on white
    const out = document.createElement("canvas");
    out.width = flat.width;
    out.height = flat.height;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(flat, 0, 0);
    out.toBlob((b) => {
      if (!b) return;
      downloadBlob(b, `${doc.name || "compositor"}.jpg`);
      doc.dirty = false;
      app.emitView();
    }, "image/jpeg", quality);
  }

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function reportError(err: unknown): void {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  /** Open .comp projects or images. The native picker keeps a handle so Save writes back in place. */
  function openFileDialog(): void {
    const picker = (window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
    if (picker) {
      picker.call(window, {
        multiple: true,
        types: [
          { description: "Compositor project or image", accept: { "application/x-compositor-project": [".comp"], "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".svg"] } },
        ],
      }).then(async (handles) => {
        for (const h of handles) await app.openFile(await h.getFile(), h);
      }).catch((err) => { if ((err as DOMException).name !== "AbortError") reportError(err); });
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.comp";
    input.multiple = true;
    input.addEventListener("change", () => {
      for (const f of Array.from(input.files ?? [])) app.openFile(f).catch(reportError);
    });
    input.click();
  }

  /** File › Open Package Folder…: a `.comp` folder (manifest.json + images/), watched for outside changes. */
  function openFolderDialog(): void {
    const picker = (window as unknown as { showDirectoryPicker?: (o: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!picker) { reportError(new Error("This browser cannot open folders; open a .comp file instead.")); return; }
    picker.call(window, { mode: "readwrite", id: "compositor-package" })
      .then((dir) => app.openFolder(dir))
      .catch((err) => { if ((err as DOMException).name !== "AbortError") reportError(err); });
  }

  // A watched package changed on disk while there are unsaved edits: revert or keep, never silently.
  app.onExternalChange = (doc) => dialog<"revert" | "keep">(
    "Project changed on disk",
    `“${doc.name}” was changed by another program. Revert to the version on disk, or keep your unsaved edits?`,
    [
      { label: "Keep Mine", value: "keep" },
      { label: "Revert", value: "revert", primary: true },
    ],
    "keep",
  );

  /** Layer › Add Image…: pick image files and add each as a new layer fitted inside the canvas. */
  function addImageDialog(): void {
    const place = (f: File) => app.pasteImageFile(f, f.name.replace(/\.[^.]+$/, "") || "Image", "Add image");
    const picker = (window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
    if (picker) {
      picker.call(window, {
        multiple: true,
        types: [{ description: "Image", accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".svg"] } }],
      }).then(async (handles) => {
        for (const h of handles) await place(await h.getFile());
      }).catch((err) => { if ((err as DOMException).name !== "AbortError") reportError(err); });
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.addEventListener("change", () => {
      for (const f of Array.from(input.files ?? [])) place(f).catch(reportError);
    });
    input.click();
  }

  function flipCanvas(axis: "h" | "v"): void {
    const doc = app.doc;
    if (!doc) return;
    for (const layer of doc.layers) {
      if (!layer.canvas) continue;
      const c = document.createElement("canvas");
      c.width = layer.canvas.width;
      c.height = layer.canvas.height;
      const ctx = c.getContext("2d")!;
      ctx.translate(axis === "h" ? c.width : 0, axis === "v" ? c.height : 0);
      ctx.scale(axis === "h" ? -1 : 1, axis === "v" ? -1 : 1);
      ctx.drawImage(layer.canvas, 0, 0);
      layer.canvas = c;
    }
    app.commit("Flip canvas");
  }

  // drag & drop: an image dropped on an open document becomes a new layer; with no document it opens one
  canvasWrap.addEventListener("dragover", (e) => e.preventDefault());
  canvasWrap.addEventListener("drop", (e) => {
    e.preventDefault();
    const item = e.dataTransfer?.items?.[0] as (DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }) | undefined;
    if (item?.getAsFileSystemHandle && e.dataTransfer?.files?.[0]?.type === "" && !e.dataTransfer.files[0].name.toLowerCase().endsWith(".comp")) {
      // A dropped folder (a .comp package written by a script or agent).
      void item.getAsFileSystemHandle().then((h) => { if (h?.kind === "directory") return app.openFolder(h as FileSystemDirectoryHandle); }).catch(reportError);
      return;
    }
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (f.name.toLowerCase().endsWith(".comp")) { app.openFile(f).catch(reportError); return; }
    if (!f.type.startsWith("image/")) return;
    const name = f.name.replace(/\.[^.]+$/, "") || "Image";
    (app.doc ? app.pasteImageFile(f, name) : app.openImageFile(f)).catch(reportError);
  });

  // paste an image from the system clipboard (screenshots, browsers, file managers, other editors)
  const onPaste = (e: ClipboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    for (const item of Array.from(e.clipboardData?.items ?? [])) {
      if (item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (!f) continue;
        e.preventDefault();
        if (app.isLayerClipboardImage(f)) { app.pasteLayers(); return; }
        app.pasteImageFile(f).catch(console.error);
        return;
      }
    }
  };
  document.addEventListener("paste", onPaste);

  render();
  // Fit after layout so the canvas floats on chrome instead of overflowing.
  const bootFit = () => {
    if (canvas.clientWidth > 0) {
      app.fit(canvas);
    } else {
      requestAnimationFrame(bootFit);
    }
    requestDraw();
  };
  requestAnimationFrame(bootFit);
  window.addEventListener("resize", () => {
    // Keep fit on first real layout; later resizes only redraw.
    requestDraw();
  }, { once: true });

  return {
    destroy() {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("paste", onPaste);
    },
    refresh() {
      render();
      requestDraw();
    },
  };
}


