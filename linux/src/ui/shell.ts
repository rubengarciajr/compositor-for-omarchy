import type { BlendMode, DocumentState, Layer, ToolId } from "../core/model";
import { BLEND_GROUPS, BLEND_LABELS, layerTree } from "../core/model";
import type { App } from "../core/session";
import { drawEditor, flattenDocument, screenToDoc } from "../render/compositor";
import { drawAnts } from "../render/ants";
import { APP_NAME, APP_VERSION, ISSUES_URL, ORIGINAL_AUTHOR, ORIGINAL_COMPANY, ORIGINAL_REPO_URL, ORIGINAL_SITE_URL, PROJECT_URL, rendererName } from "../app-info";
const compositorApi = { screenToDoc };
import { boxCorners, handlePositions } from "../core/transform";
import { PAINT_TOOLS, cursorForTool } from "./cursors";
import { icon, iconEl } from "./icons";
import { THEME_CHOICES, applyThemeChoice, themeChoice } from "../theme/omarchy";
import type { IconName } from "./icons";
import { cssFont } from "../core/pixels";
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

const TOOL_META: { id: ToolId; icon: IconName; title: string; key: string }[] = [
  { id: "idle", icon: "pointer", title: "Select (A)", key: "a" },
  { id: "move", icon: "move", title: "Move / Transform (V)", key: "v" },
  { id: "marquee", icon: "marquee", title: "Marquee (M)", key: "m" },
  { id: "lasso", icon: "lasso", title: "Lasso (L)", key: "l" },
  { id: "wand", icon: "wand", title: "Magic Wand (W)", key: "w" },
  { id: "crop", icon: "crop", title: "Crop (C)", key: "c" },
  { id: "brush", icon: "brush", title: "Brush (B)", key: "b" },
  { id: "eraser", icon: "eraser", title: "Eraser (E)", key: "e" },
  { id: "clone-stamp", icon: "stamp", title: "Clone Stamp (S)", key: "s" },
  { id: "blur", icon: "droplet", title: "Blur (R)", key: "r" },
  { id: "spot-healing", icon: "bandage", title: "Spot Healing (J)", key: "j" },
  { id: "gradient", icon: "gradient", title: "Gradient (G)", key: "g" },
  { id: "shape", icon: "shape", title: "Shape (U)", key: "u" },
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
        if (doc?.selection?.mask) drawAnts(ctx, doc.selection.mask, app.session.zoom || 1, performance.now() / 60);
        drawTransformControls(ctx);
        drawBrushPreview(ctx);
        const line = app.session.dragLine;
        if (line && app.session.tool === "gradient") {
          const z = app.session.zoom || 1;
          ctx.save();
          ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7aa2f7";
          ctx.lineWidth = 1.5 / z;
          ctx.beginPath();
          ctx.moveTo(line.x1, line.y1);
          ctx.lineTo(line.x2, line.y2);
          ctx.stroke();
          const g = app.session.gradient;
          const stops = gradientStops(g.preset, app.session.foreground, app.session.background, g.reverse);
          ctx.fillStyle = stops[0].color;
          ctx.beginPath(); ctx.arc(line.x1, line.y1, 5 / z, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = stops[stops.length - 1].color;
          ctx.beginPath(); ctx.arc(line.x2, line.y2, 5 / z, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          if (g.style === "radial") {
            ctx.setLineDash([4 / z, 4 / z]);
            ctx.beginPath(); ctx.arc(line.x1, line.y1, Math.hypot(line.x2 - line.x1, line.y2 - line.y1), 0, Math.PI * 2); ctx.stroke();
          }
          ctx.restore();
          return;
        }
        const lasso = app.session.lassoPath;
        if (lasso && lasso.length >= 1 && app.session.tool === "lasso") {
          const z = app.session.zoom || 1;
          const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7aa2f7";
          ctx.save();
          ctx.lineWidth = 1.5 / z;
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(lasso[0][0], lasso[0][1]);
          for (let i = 1; i < lasso.length; i++) ctx.lineTo(lasso[i][0], lasso[i][1]);
          ctx.strokeStyle = "rgba(0,0,0,0.6)";
          ctx.lineWidth = 3 / z;
          ctx.stroke();
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.5 / z;
          ctx.stroke();
          if (lasso.length >= 2) {
            // closing edge, dashed
            ctx.setLineDash([4 / z, 4 / z]);
            ctx.beginPath();
            ctx.moveTo(lasso[lasso.length - 1][0], lasso[lasso.length - 1][1]);
            ctx.lineTo(lasso[0][0], lasso[0][1]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          if (app.session.lassoMode === "polygon") {
            // corners, and a ring on the first one: click it to close
            for (const [x, y] of lasso) { ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(x, y, 2.5 / z, 0, Math.PI * 2); ctx.fill(); }
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 1 / z;
            ctx.beginPath(); ctx.arc(lasso[0][0], lasso[0][1], 5 / z, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.restore();
          return;
        }
        const cr = app.session.cropRect;
        if (!cr) return;
        ctx.save();
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7aa2f7";
        ctx.lineWidth = 2 / (app.session.zoom || 1);
        ctx.setLineDash([6 / (app.session.zoom || 1), 4 / (app.session.zoom || 1)]);
        ctx.strokeRect(cr.x, cr.y, cr.w, cr.h);
        ctx.setLineDash([]);
        if (app.session.tool === "crop" && cr.w > 0 && cr.h > 0) {
          // handles like the Move tool's: drag to resize the crop box, drag inside to move it
          const s = 8 / (app.session.zoom || 1);
          ctx.fillStyle = "#ffffff";
          for (const h of handlePositions({ x: cr.x, y: cr.y, width: cr.w, height: cr.h, rotation: 0, flipH: false, flipV: false })) {
            ctx.beginPath();
            ctx.rect(h.x - s / 2, h.y - s / 2, s, s);
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        // dim outside
        if (doc) {
          ctx.beginPath();
          ctx.rect(0, 0, doc.width, doc.height);
          ctx.rect(cr.x, cr.y, cr.w, cr.h);
          ctx.fill("evenodd");
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
    if (await resolveUnsaved(doc)) app.closeDocument(doc.id);
  }

  let allowUnload = false;
  /** Quit: settle every unsaved document, then close the window ourselves. */
  async function quitAsk(): Promise<void> {
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
    if (!s.hover || !PAINT_TOOLS.includes(s.tool)) return;
    const z = s.zoom || 1;
    const r = s.brush.size / 2;
    ctx.save();
    ctx.lineWidth = 1 / z;
    ctx.beginPath();
    ctx.arc(s.hover.x, s.hover.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.hover.x, s.hover.y, r + 1 / z, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.stroke();
    if (s.brush.hardness < 1 && r * z > 6) {
      // inner circle marks where the soft edge starts
      ctx.beginPath();
      ctx.arc(s.hover.x, s.hover.y, r * s.brush.hardness, 0, Math.PI * 2);
      ctx.setLineDash([3 / z, 3 / z]);
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (r * z < 4) {
      // tiny brush: crosshair so the pointer stays visible
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.moveTo(s.hover.x - 6 / z, s.hover.y); ctx.lineTo(s.hover.x + 6 / z, s.hover.y);
      ctx.moveTo(s.hover.x, s.hover.y - 6 / z); ctx.lineTo(s.hover.x, s.hover.y + 6 / z);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Photoshop's "Show Transform Controls": box + handles around the active layer with the Move tool. */
  function drawTransformControls(ctx: CanvasRenderingContext2D): void {
    const layer = app.activeLayer;
    if (app.session.tool !== "move" || !layer || !app.isTransformable(layer) || !layer.visible) return;
    const z = app.session.zoom || 1;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7aa2f7";
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
    const s = 8 / z;
    ctx.fillStyle = "#ffffff";
    for (const h of handlePositions(layer.transform)) {
      ctx.beginPath();
      ctx.rect(h.x - s / 2, h.y - s / 2, s, s);
      ctx.fill();
      ctx.stroke();
    }
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
        const top = document.getElementById("type-text") as HTMLInputElement | null;
        if (top) top.value = ta.value;
        syncTextEditor();
      });
      ta.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); app.endTextEdit(false); }
        else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); app.endTextEdit(true); }
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
    const pad = Math.ceil(t.fontSize * 0.25) * z;
    const s = textEditor.style;
    s.left = `${ox + tr.x * z}px`;
    s.top = `${oy + tr.y * z}px`;
    s.width = `${Math.max(tr.width * z, t.fontSize * z)}px`;
    s.height = `${Math.max(tr.height * z, t.fontSize * t.lineHeight * z)}px`;
    s.transform = `rotate(${tr.rotation}deg)`;
    s.padding = `${pad}px`;
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
      { sep: true, label: "" },
      { label: "Save", shortcut: "⌘S", action: () => void app.saveProject(false).catch(reportError) },
      { label: "Save As…", shortcut: "⇧⌘S", action: () => void app.saveProject(true).catch(reportError) },
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
      { label: "Copy", shortcut: "⌘C", action: () => void app.copyToClipboard(false).catch(console.error) },
      { label: "Copy Merged", shortcut: "⇧⌘C", action: () => void app.copyToClipboard(true).catch(console.error) },
      { label: "Paste as Layer", shortcut: "⌘V", action: () => void app.pasteFromClipboard().catch(console.error) },
      { sep: true, label: "" },
      { label: "Fill Foreground", shortcut: "⌥⌫", action: () => app.fillActive() },
      { label: "Clear", shortcut: "⌫", action: () => app.clearActive() },
      { label: "Invert Pixels", shortcut: "⌘I", action: () => app.invertActive() },
      { sep: true, label: "" },
      { label: "Free Transform", shortcut: "⌘T", action: () => app.setTool("move") },
      { label: "Reset Transform", action: () => app.resetTransform() },
      { label: "Flip Layer Horizontal", action: () => app.flipActive("h") },
      { label: "Flip Layer Vertical", action: () => app.flipActive("v") },
    ]);
    const select = menu("Select", [
      { label: "All", shortcut: "⌘A", action: () => app.selectAll() },
      { label: "Deselect", shortcut: "⌘D", action: () => app.deselect() },
      { label: "Inverse", shortcut: "⇧⌘I", action: () => app.invertSelection() },
      { sep: true, label: "" },
      { label: "Layer via Copy", shortcut: "⌘J", action: () => app.layerViaCopy(false) },
      { label: "Layer via Cut", shortcut: "⇧⌘J", action: () => app.layerViaCopy(true) },
      { label: "Layer Mask from Selection", action: () => app.maskFromSelection() },
    ]);
    const layer = menu("Layer", [
      { label: "New Blank Layer", shortcut: "⇧⌘N", action: () => app.addBlankLayer() },
      { label: "Add Image…", action: () => addImageDialog() },
      { label: "Duplicate Layer", shortcut: "⌘J", action: () => app.duplicateLayer() },
      { label: "Group Layers", shortcut: "⌘G", action: () => app.addGroup() },
      { sep: true, label: "" },
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
      { label: "Fit on Screen", shortcut: "⌘0", action: () => app.fit(canvas) },
      { label: "Zoom 100%", shortcut: "⌘1", action: () => { app.session.zoom = 1; app.session.panX = 0; app.session.panY = 0; app.emit(); } },
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
      b.innerHTML = icon(t.icon, 20);
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
    const brushTools = tool === "brush" || tool === "eraser" || tool === "blur" || tool === "clone-stamp" || tool === "spot-healing";
    const title =
      TOOL_META.find((t) => t.id === tool)?.title.split(" (")[0] ?? tool;

    toolHeader.innerHTML = `<div class="title">${title}</div>`;

    const field = (label: string, control: HTMLElement) => {
      const f = document.createElement("div");
      f.className = "field";
      f.innerHTML = `<label>${label}</label>`;
      f.appendChild(control);
      return f;
    };

    const selectionHint = () => {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Shift adds to the selection · Alt subtracts";
      return hint;
    };

    const range = (value: number, min: number, max: number, step: number, on: (v: number) => void) => {
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = String(Math.round(value * 100) / 100);
      input.addEventListener("input", () => {
        const v = Number(input.value);
        val.textContent = String(Math.round(v * 100) / 100);
        on(v);
      });
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.gap = "6px";
      wrap.append(input, val);
      return wrap;
    };

    if (tool === "move") {
      const moveHint = document.createElement("div");
      moveHint.className = "hint";
      moveHint.textContent = "Ctrl-click picks the layer under the pointer · Alt-drag duplicates · Shift constrains · Space pans";
      toolHeader.append(moveHint);
      const layer = app.activeLayer;
      if (layer && app.isTransformable(layer)) {
        const t = layer.transform;
        const num = (value: number, key: "x" | "y" | "width" | "height" | "rotation", step = 1) => {
          const input = document.createElement("input");
          input.type = "number";
          input.step = String(step);
          input.value = String(Math.round(value * 10) / 10);
          input.style.width = "72px";
          input.addEventListener("input", () => {
            const v = Number(input.value);
            if (Number.isFinite(v)) app.setTransform({ [key]: v });
          });
          input.addEventListener("change", () => app.commit("Transform"));
          return input;
        };
        const btn = (label: string, title: string, on: () => void) => {
          const b = document.createElement("button");
          b.textContent = label;
          b.title = title;
          b.addEventListener("click", on);
          return b;
        };
        const iconBtn = (name: IconName, title: string, on: () => void) => {
          const b = btn("", title, on);
          b.className = "icon-btn";
          b.innerHTML = icon(name, 18);
          return b;
        };
        toolHeader.append(
          field("X", num(t.x, "x")),
          field("Y", num(t.y, "y")),
          field("W", num(t.width, "width")),
          field("H", num(t.height, "height")),
          field("Angle", num(t.rotation, "rotation", 0.5)),
          iconBtn("flip-h", "Flip horizontal", () => app.flipActive("h")),
          iconBtn("flip-v", "Flip vertical", () => app.flipActive("v")),
          iconBtn("reset", "Reset transform (size, angle, flips)", () => app.resetTransform()),
        );
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = "Drag handles to scale (Shift: free ratio, Alt: from centre) · drag outside a corner to rotate";
        toolHeader.append(hint);
      }
    } else if (brushTools) {
      if (tool === "brush") {
        // The brush colour is the foreground colour; editing it here keeps the well in sync.
        const color = document.createElement("input");
        color.type = "color";
        color.className = "brush-color";
        color.value = s.foreground;
        color.title = "Brush colour (foreground) · X swaps, D resets";
        color.addEventListener("input", () => {
          s.foreground = color.value;
          const well = toolRail.querySelector<HTMLInputElement>(".swatches .fg");
          if (well) well.value = color.value;
        });
        color.addEventListener("change", () => app.emitView());
        toolHeader.append(field("Color", color));
      }
      toolHeader.append(field("Size", range(s.brush.size, 1, 400, 1, (v) => { s.brush.size = v; })));
      if (tool !== "spot-healing") toolHeader.append(field("Hardness", range(s.brush.hardness, 0, 1, 0.01, (v) => { s.brush.hardness = v; })));
      if (tool !== "spot-healing") toolHeader.append(field(tool === "blur" ? "Strength" : "Opacity", range(s.brush.opacity, 0.05, 1, 0.01, (v) => { s.brush.opacity = v; })));
      if (tool === "brush" || tool === "eraser") toolHeader.append(field("Flow", range(s.brush.flow, 0.05, 1, 0.01, (v) => { s.brush.flow = v; })));
      if (tool === "brush" || tool === "eraser" || tool === "clone-stamp") toolHeader.append(field("Spacing %", range(Math.round(s.brush.spacing * 100), 1, 200, 1, (v) => { s.brush.spacing = v / 100; })));
      const tip = document.createElement("div");
      tip.className = "hint";
      tip.textContent = tool === "clone-stamp" ? "Alt-click sets the source · Shift-click draws a straight line · [ ] size"
        : tool === "spot-healing" ? "Click or paint over a blemish · it fills from the surroundings"
        : tool === "blur" ? "Paint to soften · Shift-click draws a straight line"
        : "Shift-click draws a straight line · Alt samples a colour · [ ] size · Space pans";
      toolHeader.append(tip);
    } else if (tool === "marquee") {
      const sel = document.createElement("select");
      sel.innerHTML = `<option value="rect">Rectangle</option><option value="ellipse">Ellipse</option>`;
      sel.value = s.marqueeShape;
      sel.addEventListener("change", () => { s.marqueeShape = sel.value as "rect" | "ellipse"; app.emit(); });
      toolHeader.append(field("Shape", sel), selectionHint());
    } else if (tool === "lasso") {
      const sel = document.createElement("select");
      sel.innerHTML = `<option value="free">Freehand</option><option value="polygon">Polygonal</option>`;
      sel.value = s.lassoMode;
      sel.addEventListener("change", () => { s.lassoMode = sel.value as "free" | "polygon"; app.cancelLasso(); app.emit(); });
      const how = document.createElement("div");
      how.className = "hint";
      how.textContent = s.lassoMode === "polygon" ? "Click corners · double-click, Enter or the first corner closes · Esc cancels" : "Drag around the area · release to close";
      toolHeader.append(field("Mode", sel), how, selectionHint());
    } else if (tool === "wand") {
      const contiguous = document.createElement("button");
      contiguous.className = "toggle" + (s.wandContiguous ? " active" : "");
      contiguous.textContent = "Contiguous";
      contiguous.title = "Only pixels connected to the click (off: every matching colour in the image)";
      contiguous.addEventListener("click", () => { s.wandContiguous = !s.wandContiguous; app.emitView(); });
      toolHeader.append(field("Tolerance", range(s.wandTolerance, 0, 128, 1, (v) => { s.wandTolerance = v; })), contiguous, selectionHint());
    } else if (tool === "shape") {
      const sel = document.createElement("select");
      sel.innerHTML = `<option value="rect">Rectangle</option><option value="rounded">Rounded</option><option value="ellipse">Ellipse</option><option value="line">Line</option>`;
      sel.value = s.shapeKind;
      sel.addEventListener("change", () => { s.shapeKind = sel.value as typeof s.shapeKind; app.emit(); });
      toolHeader.append(field("Shape", sel));
      const shapeLayer = app.activeLayer?.kind === "shape" ? app.activeLayer : null;
      if (shapeLayer?.shape) {
        // Edit the selected shape live, Photoshop's shape options bar.
        const sh = shapeLayer.shape;
        const colorInput = (value: string, on: (v: string) => void, label: string) => {
          const c = document.createElement("input");
          c.type = "color";
          c.value = value;
          c.addEventListener("input", () => on(c.value));
          c.addEventListener("change", () => app.commit(label));
          return c;
        };
        toolHeader.append(
          field("Fill", colorInput(sh.fill, (v) => app.setShape({ fill: v }), "Shape fill")),
          field("Stroke", colorInput(sh.stroke, (v) => app.setShape({ stroke: v }), "Shape stroke")),
          field("Width", range(sh.strokeWidth, 0, 40, 1, (v) => app.setShape({ strokeWidth: v }))),
        );
        if (sh.kind === "rounded") toolHeader.append(field("Radius", range(sh.radius, 0, 200, 1, (v) => app.setShape({ radius: v }))));
        toolHeader.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((r) => r.addEventListener("change", () => app.commit("Edit shape")));
      }
      const how = document.createElement("div");
      how.className = "hint";
      how.textContent = "Drag to draw · Shift keeps it square / round · Alt draws from the centre";
      toolHeader.append(how);
    } else if (tool === "type") {
      // Values come from the selected text layer when there is one, else the defaults for the next.
      const t = app.activeLayer?.kind === "text" && app.activeLayer.text ? app.activeLayer.text : s.text;
      const commitLater = (label: string) => () => app.commit(label);

      const text = document.createElement("input");
      text.type = "text";
      text.id = "type-text";
      text.value = t.text;
      text.placeholder = "Type, then click the canvas";
      text.style.width = "220px";
      text.addEventListener("input", () => app.setText({ text: text.value }));
      text.addEventListener("change", commitLater("Edit text"));
      text.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "Escape") text.blur();
      });

      const family = document.createElement("select");
      family.className = "font-select";
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
        app.commit("Font");
      });

      const weight = document.createElement("select");
      for (const [w, label] of FONT_WEIGHTS) {
        const o = document.createElement("option");
        o.value = String(w);
        o.textContent = label;
        weight.appendChild(o);
      }
      weight.value = String(FONT_WEIGHTS.some(([w]) => w === t.weight) ? t.weight : 400);
      weight.addEventListener("change", () => { app.setText({ weight: Number(weight.value) }); app.commit("Font weight"); });

      const size = range(t.fontSize, 8, 280, 1, (v) => app.setText({ fontSize: v }));
      size.querySelector("input")!.addEventListener("change", commitLater("Text size"));

      const color = document.createElement("input");
      color.type = "color";
      color.value = t.color;
      color.title = "Text colour";
      color.addEventListener("input", () => app.setText({ color: color.value }));
      color.addEventListener("change", commitLater("Text colour"));

      const align = document.createElement("div");
      align.className = "seg";
      for (const [value, glyph, title] of [["left", "align-left", "Align left"], ["center", "align-center", "Align centre"], ["right", "align-right", "Align right"]] as const) {
        const b = document.createElement("button");
        b.innerHTML = icon(glyph, 16);
        b.title = title;
        b.dataset.align = value;
        b.classList.toggle("active", t.align === value);
        b.addEventListener("click", () => { app.setText({ align: value }); app.commit("Text align"); });
        align.appendChild(b);
      }

      const numField = (value: number, min: number, max: number, step: number, on: (v: number) => void, label: string) => {
        const i = document.createElement("input");
        i.type = "number";
        i.min = String(min); i.max = String(max); i.step = String(step);
        i.value = String(value);
        i.style.width = "62px";
        i.addEventListener("input", () => { const v = Number(i.value); if (Number.isFinite(v)) on(v); });
        i.addEventListener("change", commitLater(label));
        return i;
      };
      const lineH = numField(t.lineHeight, 0.5, 4, 0.05, (v) => app.setText({ lineHeight: v }), "Line height");
      const tracking = numField(t.letterSpacing, -20, 200, 0.5, (v) => app.setText({ letterSpacing: v }), "Letter spacing");

      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = app.session.textEdit
        ? "Editing on canvas · Ctrl+Enter or click away to commit · Esc to cancel"
        : "Click the canvas to type there, or click existing text to edit it";
      toolHeader.append(
        field("Text", text),
        field("Font", family),
        field("Weight", weight),
        field("Size", size),
        field("Colour", color),
        field("Align", align),
        field("Leading", lineH),
        field("Tracking", tracking),
        hint,
      );

    } else if (tool === "crop") {
      const apply = document.createElement("button");
      apply.textContent = "Apply Crop";
      apply.className = "active";
      apply.addEventListener("click", () => app.applyCrop());
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => { app.session.cropRect = null; app.emit(); });
      const how = document.createElement("div");
      how.className = "hint";
      how.textContent = "Drag the area · drag the handles to adjust, inside to move · Enter applies · Esc cancels";
      toolHeader.append(apply, cancel, how);
    } else if (tool === "gradient") {
      toolHeader.append(...gradientHeader());
    } else if (tool === "eyedropper") {
      const info = document.createElement("div");
      info.className = "title";
      info.textContent = `FG ${s.foreground}`;
      toolHeader.append(info);
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

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Drag on the canvas · fills a new layer (or the selection)";
    return [pick, styles, reverse, hint];
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
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = layer.name + (layer.blendMode !== "normal" ? ` · ${BLEND_LABELS[layer.blendMode]}` : "");
    name.title = "Double-click to rename";
    el.append(eye, thumb, name);
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
      b.textContent = `${d.dirty ? "● " : ""}${d.name}`;
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
    if (e.button === 2) return; // context menu
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
  });
  canvas.addEventListener("dblclick", (e) => {
    if (app.session.tool === "lasso" && app.session.lassoPath) { app.closeLasso(e.shiftKey ? "add" : e.altKey ? "subtract" : "replace"); return; }
    if (app.session.tool !== "move" || !app.doc) return;
    const hit = app.textLayerAt(screenToDoc(canvas, app.doc, app.session, e.clientX, e.clientY));
    if (hit) { app.selectLayer(hit.id); app.setTool("type"); app.beginTextEdit(hit.id, false); }
  });
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (app.hasSelection()) showContextMenu(e.clientX, e.clientY, selectionMenuItems());
    else showContextMenu(e.clientX, e.clientY, [
      { label: "Select All", shortcut: "⌘A", action: () => app.selectAll() },
      { label: "Paste as Layer", shortcut: "⌘V", action: () => void app.pasteFromClipboard().catch(reportError) },
      { sep: true, label: "" },
      ...layerMenuItems(),
    ]);
  });

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
      { label: "Copy", shortcut: "⌘C", action: () => void app.copyToClipboard(false).catch(reportError) },
      { label: "Copy Merged", shortcut: "⇧⌘C", action: () => void app.copyToClipboard(true).catch(reportError) },
      { label: "Free Transform", shortcut: "⌘T", action: () => app.setTool("move") },
    ];
  }
  const mods = { shift: false, alt: false, dragging: false };
  function applyCursor(e?: PointerEvent): void {
    const tool = app.session.tool;
    let cursor = cursorForTool({ tool, ...mods, space: app.tempHand });
    if ((tool === "move" || tool === "crop") && e && !mods.dragging) cursor = app.cursorAt(canvas, e) || cursor;
    canvas.style.cursor = cursor;
  }
  canvas.addEventListener("pointermove", (e) => {
    mods.shift = e.shiftKey;
    mods.alt = e.altKey;
    mods.dragging = e.buttons !== 0;
    applyCursor(e);
    if (PAINT_TOOLS.includes(app.session.tool) && app.doc) {
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
    if (e.key === "Shift" || e.key === "Alt") { mods.shift = e.shiftKey; mods.alt = e.altKey; applyCursor(); }
    if (e.key === " " && !inField(e) && !app.session.textEdit) {
      // Space: temporary Hand with any tool (Photoshop). Holding it must not scroll the page.
      e.preventDefault();
      if (!app.tempHand) { app.tempHand = true; applyCursor(); }
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift" || e.key === "Alt") { mods.shift = e.shiftKey; mods.alt = e.altKey; applyCursor(); }
    if (e.key === " " && app.tempHand) { app.tempHand = false; applyCursor(); }
  });
  window.addEventListener("blur", () => { if (app.tempHand) { app.tempHand = false; applyCursor(); } });
  canvas.addEventListener("pointerup", (e) => {
    app.pointerUp(canvas, e);
    mods.dragging = false;
    applyCursor(e);
    // Placing text: hand the keyboard to the text field so typing starts immediately.
    if (app.session.tool === "type" && app.activeLayer?.kind === "text" && !app.session.textEdit) {
      const input = document.getElementById("type-text") as HTMLInputElement | null;
      input?.focus();
      input?.select();
    }
  });
  canvas.addEventListener("pointercancel", (e) => app.pointerUp(canvas, e));
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      app.session.zoom = Math.min(32, Math.max(0.05, app.session.zoom * factor));
    } else {
      app.session.panX -= e.deltaX;
      app.session.panY -= e.deltaY;
    }
    app.emit();
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
    if (mod && key === "t") { e.preventDefault(); app.setTool("move"); return; }
    if (mod && key === "o") { e.preventDefault(); openFileDialog(); return; }
    if (mod && key === "c") { e.preventDefault(); void app.copyToClipboard(e.shiftKey).catch(console.error); return; }
    // Ctrl+V is handled by the paste event below (it carries the clipboard image).
    if (mod && key === "j") { e.preventDefault(); app.layerViaCopy(e.shiftKey); return; }
    if (mod && key === "a") { e.preventDefault(); app.selectAll(); return; }
    if (mod && key === "d") { e.preventDefault(); app.deselect(); return; }
    if (mod && e.shiftKey && key === "i") { e.preventDefault(); app.invertSelection(); return; }
    if (app.session.tool === "crop" && app.session.cropRect && !mod) {
      if (e.key === "Enter") { e.preventDefault(); app.applyCrop(); return; }
      if (e.key === "Escape") { app.session.cropRect = null; app.emit(); return; }
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
    if (e.key === "Backspace" || e.key === "Delete") {
      if (e.altKey) app.fillActive();
      else app.clearActive();
      return;
    }
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft") app.nudge(-d, 0);
      if (e.key === "ArrowRight") app.nudge(d, 0);
      if (e.key === "ArrowUp") app.nudge(0, -d);
      if (e.key === "ArrowDown") app.nudge(0, d);
      return;
    }
    if (!mod && !e.altKey && key === "x") { app.swapColors(); return; }
    if (!mod && !e.altKey && key === "d") { app.resetColors(); return; }
    if (!mod && (e.key === "[" || e.key === "]" || e.key === "{" || e.key === "}")) {
      e.preventDefault();
      app.adjustBrush(e.key === "]" || e.key === "}" ? 1 : -1, e.shiftKey || e.key === "{" || e.key === "}");
      return;
    }
    const hit = TOOL_META.find((x) => x.key === e.key.toLowerCase());
    if (hit && !mod) app.setTool(hit.id);
  };
  window.addEventListener("keydown", onKey);

  const onResize = () => requestDraw();
  window.addEventListener("resize", onResize);

  /* modals */
  /** Links open in a normal browser window of the same profile (the app window stays). */
  function openLink(url: string): void {
    window.open(url, "_blank", "noopener");
  }

  const SHORTCUTS: [string, string][] = [
    ["Undo / Redo", "⌘Z / ⇧⌘Z"], ["New canvas", "⌘N"], ["Open", "⌘O"], ["Save / Save As", "⌘S / ⇧⌘S"],
    ["Export PNG / JPEG", "⇧⌘E / ⌥⇧⌘S"], ["Close document / Quit", "⌘W / ⌘Q"],
    ["New blank layer", "⇧⌘N"], ["Layer via Copy / Cut", "⌘J / ⇧⌘J"], ["Group / Merge down", "⌘G / ⌘E"],
    ["Select All / Deselect / Inverse", "⌘A / ⌘D / ⇧⌘I"], ["Copy / Copy Merged / Paste", "⌘C / ⇧⌘C / ⌘V"],
    ["Invert pixels", "⌘I"], ["Free Transform", "⌘T"], ["Fit on screen / 100 %", "⌘0 / ⌘1"],
    ["Fill with foreground / Clear", "⌥⌫ / ⌫"], ["Nudge (×10 with Shift)", "Arrows"],
    ["Tools", "V M L W C B E S R J G U T I H Z"], ["Swap / reset colours", "X / D"],
    ["Brush size / hardness", "[ ] / ⇧[ ]"], ["Pan with any tool", "Space"],
    ["Add / subtract selection", "Shift / Alt + click"], ["Straight brush line", "Shift + click"],
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
      <div class="about-head">${icon("layers", 40)}<div><div class="about-name">${APP_NAME}</div><div class="about-version">Version ${APP_VERSION} · ${rendererName()}</div></div></div>
      <p>A Photoshop-style image editor with layers, blend modes, masks and adjustment layers, themed live by Omarchy.</p>
      <div class="about-credit">
        <div class="about-credit-title">Original app</div>
        <p><strong>Compositor for macOS</strong> was created by <strong>${ORIGINAL_AUTHOR}</strong> (${ORIGINAL_COMPANY}). This Linux port rebuilds it for Omarchy and keeps its project format.</p>
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


