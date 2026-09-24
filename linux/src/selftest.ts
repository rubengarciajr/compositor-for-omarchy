/**
 * In-page regression checks. Opened with `?selftest=1` the app runs these after boot,
 * writes the results into `<pre id="selftest">` and sets the title to SELFTEST PASS/FAIL.
 * `scripts/smoke-test.mjs` drives this in headless Chromium (`npm test`).
 */
import type { App } from "./core/session";
import { createCanvas, createDocument, createLayer, createRasterLayer, defaultTransform, layerTree } from "./core/model";
import { flattenDocument, isStrokeCached } from "./render/compositor";
import { selectionOutline } from "./render/ants";
import type { History } from "./core/history";
import { applyThemeChoice, getThemePreference, parseColorsToml, themeChoice } from "./theme/omarchy";
import { hitTest, rotateByPointer, scaleByHandle } from "./core/transform";
import { parseProject, serializeProject } from "./io/project";
import { readZip } from "./io/zip";
import { cursorForTool, WAND_ADD_CURSOR, WAND_CURSOR, WAND_SUBTRACT_CURSOR } from "./ui/cursors";
import { writableLayer } from "./core/history";

export interface SelfTestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const px = (c: HTMLCanvasElement, x: number, y: number) => Array.from(c.getContext("2d")!.getImageData(x, y, 1, 1).data);
const near = (a: number[], b: number[], tol = 2) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

export async function runSelfTest(app: App, onResult: (r: SelfTestResult) => void = () => {}): Promise<SelfTestResult[]> {
  const results: SelfTestResult[] = [];
  const check = (name: string, pass: boolean, detail: unknown) => {
    const r = { name, pass, detail: JSON.stringify(detail) };
    results.push(r);
    onResult(r);
  };

  // Layers inside a group render, and group opacity applies.
  {
    const doc = createDocument(64, 64);
    const bg = createRasterLayer("bg", 64, 64, 0, 0, "#000000");
    const red = createRasterLayer("red", 64, 64, 0, 0, "#ff0000");
    const group = createLayer({ name: "G", kind: "group", transform: defaultTransform(64, 64) });
    red.parentId = group.id;
    doc.layers.push(bg, red, group);
    check("group child renders", near(px(flattenDocument(doc), 32, 32), [255, 0, 0, 255]), px(flattenDocument(doc), 32, 32));
    group.opacity = 0.5;
    doc.version++;
    check("group opacity", near(px(flattenDocument(doc), 32, 32), [128, 0, 0, 255], 3), px(flattenDocument(doc), 32, 32));
  }
  // Layer mask is applied in document space for an offset layer.
  {
    const doc = createDocument(64, 64);
    const bg = createRasterLayer("bg", 64, 64, 0, 0, "#000000");
    const blue = createRasterLayer("blue", 32, 32, 16, 16, "#0000ff");
    const m = createCanvas(64, 64);
    const mc = m.getContext("2d")!;
    mc.fillStyle = "#fff";
    mc.fillRect(0, 0, 32, 64);
    blue.mask = { canvas: m, enabled: true, linked: true };
    doc.layers.push(bg, blue);
    const f = flattenDocument(doc);
    check("mask keeps left half", near(px(f, 20, 32), [0, 0, 255, 255]), px(f, 20, 32));
    check("mask hides right half", near(px(f, 44, 32), [0, 0, 0, 255]), px(f, 44, 32));
  }
  // Adjustment layers affect only what is below them.
  {
    const doc = createDocument(8, 8);
    const w = createRasterLayer("w", 8, 8, 0, 0, "#ffffff");
    const inv = createLayer({ name: "inv", kind: "adjustment", adjustmentKind: "invert", adjustment: {}, transform: defaultTransform(8, 8) });
    inv.canvas = null;
    const top = createRasterLayer("top", 4, 8, 0, 0, "#00ff00");
    doc.layers.push(w, inv, top);
    const f = flattenDocument(doc);
    check("adjustment inverts below", near(px(f, 6, 4), [0, 0, 0, 255]), px(f, 6, 4));
    check("adjustment leaves above", near(px(f, 2, 4), [0, 255, 0, 255]), px(f, 2, 4));
  }
  // Effects: outside stroke and drop shadow land where Photoshop puts them.
  {
    const doc = createDocument(64, 64);
    const bg = createRasterLayer("bg", 64, 64, 0, 0, "#ffffff");
    const sq = createRasterLayer("sq", 20, 20, 20, 20, "#ff0000");
    sq.effects.push({ kind: "stroke", enabled: true, color: "#00ff00", opacity: 1, size: 4, distance: 0, angle: 0, spread: 0 });
    sq.effects.push({ kind: "drop-shadow", enabled: true, color: "#000000", opacity: 1, size: 2, distance: 10, angle: 120, spread: 0 });
    doc.layers.push(bg, sq);
    const f = flattenDocument(doc);
    check("stroke outside the layer", near(px(f, 18, 30), [0, 255, 0, 255]), px(f, 18, 30));
    check("drop shadow lower-right", px(f, 30, 46)[0] < 200, px(f, 30, 46));
    check("light side untouched", near(px(f, 14, 14), [255, 255, 255, 255]), px(f, 14, 14));
  }
  // Blend modes: native path and JS path agree on multiply.
  {
    const doc = createDocument(4, 4);
    doc.layers.push(createRasterLayer("a", 4, 4, 0, 0, "#808080"));
    const b = createRasterLayer("b", 4, 4, 0, 0, "#808080");
    b.blendMode = "multiply";
    doc.layers.push(b);
    check("multiply (native)", near(px(flattenDocument(doc), 1, 1), [64, 64, 64, 255], 2), px(flattenDocument(doc), 1, 1));
    b.blendMode = "linear-burn";
    doc.version++;
    check("linear burn (JS path)", near(px(flattenDocument(doc), 1, 1), [1, 1, 1, 255], 2), px(flattenDocument(doc), 1, 1));
  }
  // Text layers size themselves to their content.
  {
    app.newDocument(400, 300, "selftest");
    app.setTool("type");
    app.addTextLayer(10, 10);
    const before = app.activeLayer!.transform.width;
    app.setText({ text: "A much longer line of text than the default" });
    flattenDocument(app.doc!);
    const after = app.activeLayer!.transform.width;
    check("text layer grows with content", after > before, { before, after });
  }
  // Gradient tool creates its own layer and fills it along the drag; brush on a group makes a layer.
  {
    app.newDocument(100, 50, "gradient");
    app.session.foreground = "#ff0000";
    app.session.background = "#0000ff";
    app.setTool("gradient");
    const view = document.getElementById("editor") as HTMLCanvasElement;
    const fakeDown = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, altKey: false, shiftKey: false }) as unknown as PointerEvent;
    // Drive the tool through its pointer API with document coordinates mapped through the view.
    const before = app.doc!.layers.length;
    const rect = view.getBoundingClientRect();
    const z = app.session.zoom;
    const ox = rect.left + rect.width / 2 + app.session.panX - (app.doc!.width * z) / 2;
    const oy = rect.top + rect.height / 2 + app.session.panY - (app.doc!.height * z) / 2;
    app.pointerDown(view, fakeDown(ox + 0 * z, oy + 25 * z));
    app.pointerMove(view, fakeDown(ox + 100 * z, oy + 25 * z));
    app.pointerUp(view, fakeDown(ox + 100 * z, oy + 25 * z));
    const doc = app.doc!;
    const f = flattenDocument(doc);
    const left = px(f, 2, 25), right = px(f, 97, 25);
    check("gradient makes a new layer", doc.layers.length === before + 1 && app.activeLayer?.name.startsWith("Gradient") === true, doc.layers.map((l) => l.name));
    check("gradient spans the layer", left[0] > 200 && left[2] < 60 && right[2] > 200 && right[0] < 60, { left, right });
    // Presets: foreground→transparent fades out, reverse flips, radial spreads from the start point,
    // and the choice is remembered in localStorage.
    const drag = (x1: number, x2: number) => {
      app.pointerDown(view, fakeDown(ox + x1 * z, oy + 25 * z));
      app.pointerMove(view, fakeDown(ox + x2 * z, oy + 25 * z));
      app.pointerUp(view, fakeDown(ox + x2 * z, oy + 25 * z));
      return app.activeLayer!.canvas!.getContext("2d")!;
    };
    const at = (c: CanvasRenderingContext2D, x: number, y: number) => Array.from(c.getImageData(x, y, 1, 1).data);
    app.setGradient({ preset: "fg-transparent", style: "linear", reverse: false });
    let c = drag(0, 100);
    let a = at(c, 2, 25), b = at(c, 97, 25);
    check("gradient preset foreground→transparent", a[0] > 200 && a[3] > 240 && b[3] < 15, { a, b });
    app.setGradient({ preset: "bg-transparent" });
    c = drag(0, 100);
    a = at(c, 2, 25); b = at(c, 97, 25);
    check("gradient preset background→transparent", a[2] > 200 && a[3] > 240 && b[3] < 15, { a, b });
    app.setGradient({ preset: "fg-bg", reverse: true });
    c = drag(0, 100);
    a = at(c, 2, 25); b = at(c, 97, 25);
    check("gradient reverse flips the colours", a[2] > 200 && a[0] < 60 && b[0] > 200 && b[2] < 60, { a, b });
    app.setGradient({ preset: "black-white", style: "radial", reverse: false });
    c = drag(50, 100);
    a = at(c, 50, 25); b = at(c, 3, 25);
    check("gradient radial style spreads from the start point", a[0] < 30 && b[0] > 220, { a, b });
    check("gradient settings are remembered", JSON.parse(localStorage.getItem("compositor.gradient") ?? "{}").style === "radial", localStorage.getItem("compositor.gradient"));
    app.setGradient({ preset: "fg-bg", style: "linear", reverse: false });
    // Brush with a group active paints on a fresh layer instead of the group.
    app.addGroup();
    const groups = doc.layers.filter((l) => l.kind === "group").length;
    app.setTool("brush");
    app.pointerDown(view, fakeDown(ox + 50 * z, oy + 25 * z));
    app.pointerUp(view, fakeDown(ox + 50 * z, oy + 25 * z));
    check("brush on a group creates a layer", app.activeLayer?.kind === "raster" && doc.layers.filter((l) => l.kind === "group").length === groups && doc.layers.every((l) => l.kind !== "group" || l.canvas === null), doc.layers.map((l) => `${l.kind}:${l.name}`));
  }
  // Painting on a moved / scaled / pasted layer lands under the pointer (document → layer space).
  {
    app.newDocument(100, 60, "paintxform");
    const big = createCanvas(400, 400);
    big.getContext("2d")!.fillStyle = "#ffffff";
    big.getContext("2d")!.fillRect(0, 0, 400, 400);
    const blob = await new Promise<Blob | null>((r) => big.toBlob(r, "image/png"));
    await app.pasteImageFile(blob!); // fitted to 60×60 at x=20, bitmap stays 400×400
    const layer = app.activeLayer!;
    app.session.foreground = "#ff0000";
    app.session.brush.size = 8;
    app.session.brush.hardness = 1;
    app.setTool("brush");
    const view = document.getElementById("editor") as HTMLCanvasElement;
    const rect = view.getBoundingClientRect();
    const z = app.session.zoom;
    const ox = rect.left + rect.width / 2 + app.session.panX - (app.doc!.width * z) / 2;
    const oy = rect.top + rect.height / 2 + app.session.panY - (app.doc!.height * z) / 2;
    const ev = (x: number, y: number) => ({ clientX: ox + x * z, clientY: oy + y * z, button: 0, altKey: false, shiftKey: false }) as unknown as PointerEvent;
    app.pointerDown(view, ev(50, 30));
    app.pointerUp(view, ev(50, 30));
    const f = flattenDocument(app.doc!);
    const under = px(f, 50, 30), local = px(layer.canvas!, 200, 200), corner = px(layer.canvas!, 5, 5);
    check("brush lands under the pointer on a transformed layer", layer.transform.x === 20 && under[0] > 200 && under[1] < 60 && local[0] > 200 && local[1] < 60 && corner[1] > 200, { t: layer.transform, under, local, corner });
  }
  // Magic Wand: Shift adds to the selection, Alt subtracts; the cursor carries a +/− badge.
  {
    app.newDocument(60, 20, "wand");
    const bg = writableLayer(app.activeLayer!)!.getContext("2d")!;
    bg.fillStyle = "#ff0000"; bg.fillRect(0, 0, 20, 20);
    bg.fillStyle = "#0000ff"; bg.fillRect(40, 0, 20, 20);
    app.emit();
    app.setTool("wand");
    const view = document.getElementById("editor") as HTMLCanvasElement;
    const rect = view.getBoundingClientRect();
    const z = app.session.zoom;
    const ox = rect.left + rect.width / 2 + app.session.panX - (app.doc!.width * z) / 2;
    const oy = rect.top + rect.height / 2 + app.session.panY - (app.doc!.height * z) / 2;
    const ev = (x: number, y: number, shift = false, alt = false) => ({ clientX: ox + x * z, clientY: oy + y * z, button: 0, altKey: alt, shiftKey: shift }) as unknown as PointerEvent;
    const sel = (x: number) => px(app.doc!.selection!.mask!, x, 10)[3];
    app.pointerDown(view, ev(10, 10)); app.pointerUp(view, ev(10, 10));
    const first = [sel(10), sel(30), sel(50)];
    app.pointerDown(view, ev(50, 10, true)); app.pointerUp(view, ev(50, 10, true));
    const added = [sel(10), sel(30), sel(50)];
    app.pointerDown(view, ev(10, 10, false, true)); app.pointerUp(view, ev(10, 10, false, true));
    const subtracted = [sel(10), sel(30), sel(50)];
    check("wand click replaces the selection", first[0] > 200 && first[1] < 10 && first[2] < 10, first);
    check("shift+wand adds to the selection", added[0] > 200 && added[1] < 10 && added[2] > 200, added);
    check("alt+wand subtracts from the selection", subtracted[0] < 10 && subtracted[2] > 200, subtracted);
    const plain = cursorForTool({ tool: "wand", shift: false, alt: false, dragging: false });
    const plus = cursorForTool({ tool: "wand", shift: true, alt: false, dragging: false });
    const minus = cursorForTool({ tool: "wand", shift: false, alt: true, dragging: false });
    check("wand cursor shows + with Shift and − with Alt", plain === WAND_CURSOR && plus === WAND_ADD_CURSOR && minus === WAND_SUBTRACT_CURSOR && plain !== plus && plus !== minus && plain.startsWith("url("), { plain: plain.slice(0, 40) });
  }
  // Lasso: freehand drag draws a live outline and closes on release; polygon closes on demand;
  // selections extract to new layers (Layer via Copy / Cut), invert, deselect and mask.
  {
    app.newDocument(60, 40, "lasso");
    const bg = writableLayer(app.activeLayer!)!.getContext("2d")!;
    bg.fillStyle = "#ff0000"; bg.fillRect(0, 0, 60, 40);
    app.emit();
    app.setTool("lasso");
    app.session.lassoMode = "free";
    const view = document.getElementById("editor") as HTMLCanvasElement;
    const rect = view.getBoundingClientRect();
    const z = app.session.zoom;
    const ox = rect.left + rect.width / 2 + app.session.panX - (app.doc!.width * z) / 2;
    const oy = rect.top + rect.height / 2 + app.session.panY - (app.doc!.height * z) / 2;
    const ev = (x: number, y: number, shift = false, alt = false) => ({ clientX: ox + x * z, clientY: oy + y * z, button: 0, altKey: alt, shiftKey: shift }) as unknown as PointerEvent;
    const sel = (x: number, y: number) => (app.doc!.selection?.mask ? px(app.doc!.selection.mask, x, y)[3] : -1);
    app.pointerDown(view, ev(10, 5));
    app.pointerMove(view, ev(50, 5));
    app.pointerMove(view, ev(50, 15));
    const live = app.session.lassoPath?.length ?? 0;
    app.pointerMove(view, ev(10, 15));
    app.pointerUp(view, ev(10, 15));
    check("freehand lasso collects the outline while dragging", live >= 3 && app.session.lassoPath === null, { live, after: app.session.lassoPath });
    check("freehand lasso selects the enclosed area on release", sel(30, 10) > 200 && sel(30, 30) < 10, { inside: sel(30, 10), outside: sel(30, 30) });
    app.session.lassoMode = "polygon";
    app.pointerDown(view, ev(10, 25)); app.pointerUp(view, ev(10, 25));
    app.pointerDown(view, ev(50, 25)); app.pointerUp(view, ev(50, 25));
    const stillOpen = app.session.lassoPath?.length === 2 && sel(30, 10) > 200;
    app.pointerDown(view, ev(50, 35)); app.pointerUp(view, ev(50, 35));
    app.closeLasso("add"); // Shift+Enter / Shift+double-click
    check("polygon lasso stays open until closed, Shift adds", stillOpen && sel(40, 30) > 200 && sel(30, 10) > 200 && app.session.lassoPath === null, { stillOpen, tri: sel(40, 30), first: sel(30, 10) });
    // Layer via Copy: the selected pixels become a new layer sized to the selection.
    const layersBefore = app.doc!.layers.length;
    const sourceId = app.activeLayer!.id;
    const source = () => app.doc!.layers.find((l) => l.id === sourceId)!; // records are replaced by undo
    app.layerViaCopy(false);
    const copy = app.activeLayer!;
    check("layer via copy extracts the selection", app.doc!.layers.length === layersBefore + 1 && copy.id !== sourceId && copy.transform.x === 10 && copy.transform.y === 5 && copy.transform.width === 40 && px(copy.canvas!, 20, 5)[0] > 200 && px(copy.canvas!, 20, 5)[3] > 200 && px(copy.canvas!, 0, 25)[3] < 10 && app.doc!.selection === null, { t: copy.transform, n: app.doc!.layers.length });
    check("layer via copy leaves the source intact", px(source().canvas!, 30, 10)[3] > 200, px(source().canvas!, 30, 10));
    app.undo();
    app.selectLayer(sourceId);
    app.layerViaCopy(true);
    check("layer via cut removes the pixels from the source", app.doc!.layers.length === layersBefore + 1 && px(source().canvas!, 30, 10)[3] < 10 && px(source().canvas!, 30, 30)[3] > 200, { cut: px(source().canvas!, 30, 10), kept: px(source().canvas!, 30, 30) });
    app.undo();
    app.selectLayer(sourceId);
    app.invertSelection();
    const inv = [sel(30, 10), sel(5, 38)];
    app.maskFromSelection();
    const m = source().mask;
    check("select inverse and layer mask from selection", inv[0] < 10 && inv[1] > 200 && !!m && px(m!.canvas, 5, 38)[0] > 200 && px(m!.canvas, 30, 10)[0] < 10 && app.doc!.selection === null, { inv, mask: !!m });
    app.selectAll();
    const all = sel(1, 1) > 200 && sel(59, 39) > 200;
    app.deselect();
    check("select all and deselect", all && app.doc!.selection === null, { all });
  }
  // Photoshop tool behaviours: Shift-click lines, Alt sampling, Space pan, Alt eyedropper→background,
  // Alt zoom-out, Shift-constrained marquee, Alt-from-centre shape, non-contiguous wand,
  // real Blur and Spot Healing, Ctrl-click layer pick, Alt-drag duplicate.
  {
    app.newDocument(100, 60, "tools");
    const view = document.getElementById("editor") as HTMLCanvasElement;
    // Each new document refits the view, so map document → screen at event time.
    const ev = (x: number, y: number, m: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {}) => {
      const rect = view.getBoundingClientRect();
      const z = app.session.zoom;
      const ox = rect.left + rect.width / 2 + app.session.panX - (app.doc!.width * z) / 2;
      const oy = rect.top + rect.height / 2 + app.session.panY - (app.doc!.height * z) / 2;
      return { clientX: ox + x * z, clientY: oy + y * z, button: 0, altKey: !!m.alt, shiftKey: !!m.shift, ctrlKey: !!m.ctrl, metaKey: false } as unknown as PointerEvent;
    };
    const click = (x: number, y: number, m?: { shift?: boolean; alt?: boolean; ctrl?: boolean }) => { app.pointerDown(view, ev(x, y, m)); app.pointerUp(view, ev(x, y, m)); };
    // Shift-click straight line
    app.addBlankLayer();
    app.session.foreground = "#ff0000";
    app.session.brush.size = 6; app.session.brush.hardness = 1; app.session.brush.opacity = 1; app.session.brush.flow = 1;
    app.setTool("brush");
    click(10, 30);
    click(90, 30, { shift: true });
    check("shift-click paints a straight line from the last stroke", px(app.activeLayer!.canvas!, 50, 30)[0] > 200 && px(app.activeLayer!.canvas!, 50, 30)[3] > 200, px(app.activeLayer!.canvas!, 50, 30));
    // Alt with the brush samples the merged colour (red line over white)
    app.session.foreground = "#000000";
    click(50, 30, { alt: true });
    check("alt-click with the brush samples a colour", app.session.foreground === "#ff0000", app.session.foreground);
    // Eyedropper: Alt sets the background
    app.setTool("eyedropper");
    click(50, 5, { alt: true });
    check("alt-click eyedropper sets the background", app.session.background === "#ffffff" && app.session.foreground === "#ff0000", { fg: app.session.foreground, bg: app.session.background });
    // Zoom: Alt zooms out
    app.setTool("zoom");
    const z0 = app.session.zoom;
    click(50, 30, { alt: true });
    check("alt-click zooms out", app.session.zoom < z0, { z0, z1: app.session.zoom });
    app.session.zoom = z0;
    // Space: temporary hand pans with any tool
    app.setTool("brush");
    app.tempHand = true;
    const panX0 = app.session.panX;
    app.pointerDown(view, ev(10, 10)); app.pointerMove(view, ev(30, 10)); app.pointerUp(view, ev(30, 10));
    app.tempHand = false;
    check("space pans instead of painting", app.session.panX !== panX0 && px(app.activeLayer!.canvas!, 20, 10)[3] === 0, { dx: app.session.panX - panX0 });
    app.session.panX = panX0;
    // Marquee: Shift during the drag constrains to a square
    app.setTool("marquee");
    app.pointerDown(view, ev(10, 10)); app.pointerMove(view, ev(50, 20, { shift: true })); app.pointerUp(view, ev(50, 20, { shift: true }));
    const sp = app.doc!.selection!.path;
    check("shift while dragging a marquee keeps it square", sp.type === "rect" && Math.round(sp.w) === 40 && Math.round(sp.h) === 40, sp);
    app.deselect();
    // Shape: Alt draws from the centre
    app.setTool("shape");
    app.pointerDown(view, ev(50, 30)); app.pointerMove(view, ev(60, 35, { alt: true })); app.pointerUp(view, ev(60, 35, { alt: true }));
    const st = app.activeLayer!.transform;
    check("alt while dragging a shape draws from the centre", app.activeLayer!.kind === "shape" && Math.round(st.x) === 40 && Math.round(st.y) === 25 && Math.round(st.width) === 20 && Math.round(st.height) === 10, st);
    app.setShape({ fill: "#00ff00", strokeWidth: 0 });
    check("shape options edit the selected shape", px(flattenDocument(app.doc!), 50, 30)[1] > 200 && px(flattenDocument(app.doc!), 50, 30)[0] < 60, px(flattenDocument(app.doc!), 50, 30));
    // Wand: Contiguous off selects every matching colour
    app.newDocument(60, 20, "wand2");
    const g = writableLayer(app.activeLayer!)!.getContext("2d")!;
    g.fillStyle = "#0000ff"; g.fillRect(0, 0, 10, 20); g.fillRect(50, 0, 10, 20);
    app.emit();
    app.setTool("wand");
    app.session.wandContiguous = true;
    click(5, 10);
    const contiguous = px(app.doc!.selection!.mask!, 55, 10)[3];
    app.session.wandContiguous = false;
    click(5, 10);
    const global = px(app.doc!.selection!.mask!, 55, 10)[3];
    app.session.wandContiguous = true;
    check("wand contiguous off selects disconnected matches", contiguous < 10 && global > 200, { contiguous, global });
    app.deselect();
    // Blur softens an edge; Spot Healing removes a mark
    app.newDocument(60, 40, "retouch");
    const rt = writableLayer(app.activeLayer!)!.getContext("2d")!;
    rt.fillStyle = "#000000"; rt.fillRect(0, 0, 30, 40);
    app.emit();
    app.setTool("blur");
    app.session.brush.size = 16; app.session.brush.opacity = 1; app.session.brush.flow = 1;
    click(30, 20);
    const edge = px(app.activeLayer!.canvas!, 29, 20);
    check("blur tool softens an edge", edge[0] > 20 && edge[0] < 235, edge);
    rt.fillStyle = "#ffffff"; rt.fillRect(30, 0, 30, 40);
    rt.fillStyle = "#ff0000"; rt.fillRect(44, 19, 3, 3); // a red mark on white
    app.emit();
    app.setTool("spot-healing");
    app.session.brush.size = 10;
    click(45, 20);
    const healed = px(app.activeLayer!.canvas!, 45, 20);
    check("spot healing fills a mark from its surroundings", healed[0] > 230 && healed[1] > 230 && healed[2] > 230 && healed[3] > 240, healed);
    // Move: Ctrl-click picks the top-most layer under the pointer; Alt-drag duplicates
    app.newDocument(60, 40, "movepick");
    const bgId = app.activeLayer!.id;
    app.addBlankLayer();
    const topId = app.activeLayer!.id;
    const tc = writableLayer(app.activeLayer!)!.getContext("2d")!;
    tc.fillStyle = "#00ff00"; tc.fillRect(0, 0, 20, 40);
    app.emit();
    app.selectLayer(bgId);
    app.setTool("move");
    click(50, 20, { ctrl: true });
    const pickedBg = app.activeLayer!.id;
    click(10, 20, { ctrl: true });
    const pickedTop = app.activeLayer!.id;
    check("ctrl-click with move picks the layer under the pointer", pickedBg === bgId && pickedTop === topId, { pickedBg: pickedBg === bgId, pickedTop: pickedTop === topId });
    const n = app.doc!.layers.length;
    app.pointerDown(view, ev(10, 20, { alt: true })); app.pointerMove(view, ev(30, 20, { alt: true })); app.pointerUp(view, ev(30, 20, { alt: true }));
    check("alt-drag with move duplicates the layer", app.doc!.layers.length === n + 1 && app.activeLayer!.id !== topId && Math.round(app.activeLayer!.transform.x) === 20, { n, now: app.doc!.layers.length, x: app.activeLayer!.transform.x });
  }
  // Trim transparent pixels: added images lose their empty padding but keep their place; the
  // command also works on a rotated, flipped layer.
  {
    app.newDocument(200, 200, "trim");
    const padded = createCanvas(100, 100);
    const pc = padded.getContext("2d")!;
    pc.fillStyle = "#ff00ff"; pc.fillRect(30, 40, 20, 20);
    const blob = await new Promise<Blob | null>((r) => padded.toBlob(r, "image/png"));
    await app.pasteImageFile(blob!);
    const t = app.activeLayer!.transform;
    const f = flattenDocument(app.doc!);
    check("added images are trimmed to their pixels in place", t.width === 20 && t.height === 20 && t.x === 80 && t.y === 90 && app.activeLayer!.canvas!.width === 20 && px(f, 90, 100)[0] > 200 && px(f, 90, 100)[1] < 60, { t, w: app.activeLayer!.canvas!.width });
    // A padded layer that was scaled ×2, flipped and rotated 90°: after trim the pixels stay put.
    app.addBlankLayer();
    const l = app.activeLayer!;
    const lc = writableLayer(l)!.getContext("2d")!;
    lc.fillStyle = "#00ffff"; lc.fillRect(150, 20, 10, 10); // near the top-right of the 200×200 bitmap
    l.transform = { ...l.transform, x: 0, y: 0, width: 400, height: 400, rotation: 90, flipH: true };
    app.emit();
    const before = px(flattenDocument(app.doc!), 100, 100);
    const sample = [[30, 30], [170, 30], [30, 170], [170, 170], [100, 100]].map(([x, y]) => px(flattenDocument(app.doc!), x, y).join());
    app.trimSelected();
    const after = [[30, 30], [170, 30], [30, 170], [170, 170], [100, 100]].map(([x, y]) => px(flattenDocument(app.doc!), x, y).join());
    check("trim keeps a rotated, flipped, scaled layer in place", l.canvas!.width === 10 && Math.round(app.activeLayer!.transform.width) === 20 && sample.join("|") === after.join("|"), { before, sample, after, t: app.activeLayer!.transform });
  }
  // Marching ants outline, crop handles and brush spacing.
  {
    app.newDocument(40, 30, "ants");
    app.setTool("marquee");
    const view = document.getElementById("editor") as HTMLCanvasElement;
    const ev = (x: number, y: number, m: { shift?: boolean; alt?: boolean } = {}) => {
      const rect = view.getBoundingClientRect();
      const z = app.session.zoom;
      const ox = rect.left + rect.width / 2 + app.session.panX - (app.doc!.width * z) / 2;
      const oy = rect.top + rect.height / 2 + app.session.panY - (app.doc!.height * z) / 2;
      return { clientX: ox + x * z, clientY: oy + y * z, button: 0, altKey: !!m.alt, shiftKey: !!m.shift, ctrlKey: false, metaKey: false } as unknown as PointerEvent;
    };
    app.pointerDown(view, ev(10, 10)); app.pointerMove(view, ev(20, 20)); app.pointerUp(view, ev(20, 20));
    const outline = selectionOutline(app.doc!.selection!.mask!);
    check("selection outline for the marching ants", outline.length === 40 * 4, { segments: outline.length / 4 });
    app.deselect();
    // Crop box: handles resize it, dragging inside moves it
    app.setTool("crop");
    app.pointerDown(view, ev(5, 5)); app.pointerMove(view, ev(25, 20)); app.pointerUp(view, ev(25, 20));
    const drawn = { ...app.session.cropRect! };
    app.pointerDown(view, ev(25, 20)); app.pointerMove(view, ev(35, 28)); app.pointerUp(view, ev(35, 28)); // se handle
    const resized = { ...app.session.cropRect! };
    app.pointerDown(view, ev(15, 12)); app.pointerMove(view, ev(17, 13)); app.pointerUp(view, ev(17, 13)); // inside
    const moved = { ...app.session.cropRect! };
    check("crop handles resize the box and dragging inside moves it", Math.round(drawn.w) === 20 && Math.round(resized.w) === 30 && Math.round(resized.h) === 23 && Math.round(moved.x) === 7 && Math.round(moved.y) === 6 && Math.round(moved.w) === 30, { drawn, resized, moved });
    app.session.cropRect = null;
    // Brush spacing: 200 % of a 4 px brush leaves gaps between stamps
    app.addBlankLayer();
    app.setTool("brush");
    app.session.foreground = "#ff0000";
    app.session.brush.size = 4; app.session.brush.hardness = 1; app.session.brush.opacity = 1; app.session.brush.flow = 1; app.session.brush.spacing = 2;
    app.pointerDown(view, ev(5, 15)); app.pointerMove(view, ev(37, 15)); app.pointerUp(view, ev(37, 15));
    const c = app.activeLayer!.canvas!;
    const gap = px(c, 9, 15)[3], stamp = px(c, 13, 15)[3];
    app.session.brush.spacing = 0.25;
    check("brush spacing controls the distance between stamps", gap === 0 && stamp > 200, { gap, stamp });
  }
  // History is copy-on-write: unchanged bitmaps are shared between entries, edits never
  // reach into an entry, and brush strokes composite incrementally around the painted layer.
  {
    app.newDocument(60, 40, "history");
    app.addBlankLayer();
    const hist = (app as unknown as { history: History }).history;
    app.fillActive("#ff0000");
    const { stack, index } = hist.entries();
    const prev = stack[index - 1], cur = stack[index];
    check("history shares unchanged bitmaps", prev.layers[0].canvas === cur.layers[0].canvas && prev.layers[1].canvas !== cur.layers[1].canvas, { shared: prev.layers[0].canvas === cur.layers[0].canvas });
    const alphaAt = (x: number, y: number) => app.activeLayer!.canvas!.getContext("2d")!.getImageData(x, y, 1, 1).data[3];
    app.undo();
    const afterUndo = alphaAt(5, 5);
    app.fillActive("#0000ff"); // new branch: must copy, not draw into the shared bitmap
    app.undo();
    check("history entries are never drawn into", afterUndo === 0 && alphaAt(5, 5) === 0, { afterUndo, again: alphaAt(5, 5) });
    app.redo();
    check("redo restores the branch", app.activeLayer!.canvas!.getContext("2d")!.getImageData(5, 5, 1, 1).data[2] > 200, Array.from(app.activeLayer!.canvas!.getContext("2d")!.getImageData(5, 5, 1, 1).data));

    app.newDocument(60, 40, "stroke");
    app.addBlankLayer();
    app.session.foreground = "#00ff00";
    app.setTool("brush");
    const view = document.getElementById("editor") as HTMLCanvasElement;
    const rect = view.getBoundingClientRect();
    const z = app.session.zoom;
    const ox = rect.left + rect.width / 2 + app.session.panX - (app.doc!.width * z) / 2;
    const oy = rect.top + rect.height / 2 + app.session.panY - (app.doc!.height * z) / 2;
    const ev = (x: number, y: number) => ({ clientX: ox + x * z, clientY: oy + y * z, button: 0, altKey: false, shiftKey: false }) as unknown as PointerEvent;
    app.pointerDown(view, ev(10, 20));
    app.pointerMove(view, ev(40, 20));
    const during = isStrokeCached(app.doc!);
    const mid = px(flattenDocument(app.doc!), 25, 20);
    app.pointerUp(view, ev(40, 20));
    const after = px(flattenDocument(app.doc!), 25, 20);
    check("brush strokes composite incrementally", during && !isStrokeCached(app.doc!) && mid[1] > 200 && mid[0] < 60, { during, mid });
    check("incremental frame matches the full composite", mid.join() === after.join(), { mid, after });
    const painted = app.activeLayer!.id;
    app.addAdjustment("invert"); // an adjustment above the layer depends on its pixels: no shortcut
    app.selectLayer(painted);
    app.pointerDown(view, ev(10, 30));
    const cachedWithAdjustment = isStrokeCached(app.doc!);
    const inv = px(flattenDocument(app.doc!), 25, 20);
    app.pointerUp(view, ev(10, 30));
    check("stroke shortcut yields to adjustment layers above", !cachedWithAdjustment && inv[1] < 60 && inv[0] > 200, { cachedWithAdjustment, inv });
  }
  // Text colour and font family reach the rendered pixels.
  {
    app.newDocument(300, 120, "textstyle");
    app.setTool("type");
    app.addTextLayer(10, 10);
    app.setText({ text: "IIIIIIII", color: "#ff0000", fontFamily: "Liberation Sans", weight: 700, fontSize: 60 });
    const f = flattenDocument(app.doc!);
    const d = f.getContext("2d")!.getImageData(0, 0, f.width, f.height).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) red++;
    check("text colour applied", red > 200, { redPixels: red });
    const l = app.activeLayer!;
    check("text font stored", l.text?.fontFamily === "Liberation Sans" && l.text.weight === 700, l.text);
  }
  // Paste creates a layer with the image's pixels; undo removes it.
  {
    app.newDocument(100, 100, "paste");
    const c = createCanvas(10, 10);
    c.getContext("2d")!.fillStyle = "#ff00ff";
    c.getContext("2d")!.fillRect(0, 0, 10, 10);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    await app.pasteImageFile(blob!);
    const doc = app.doc!;
    check("paste adds a layer", doc.layers.length === 2 && near(px(flattenDocument(doc), 50, 50), [255, 0, 255, 255]), doc.layers.map((l) => l.name));
    app.undo();
    check("undo removes pasted layer", doc.layers.length === 1, doc.layers.length);
    app.redo();
    check("redo restores pasted layer", doc.layers.length === 2, doc.layers.length);
  }
  // Copy respects the selection bounds.
  {
    const doc = app.doc!;
    const mask = createCanvas(doc.width, doc.height);
    mask.getContext("2d")!.fillStyle = "#fff";
    mask.getContext("2d")!.fillRect(10, 20, 30, 40);
    doc.selection = { path: { type: "rect", x: 10, y: 20, w: 30, h: 40 }, mask, mode: "replace" };
    const copied = app.copyPixels(true);
    check("copy merged uses selection bounds", !!copied && copied.width === 30 && copied.height === 40, copied && [copied.width, copied.height]);
    doc.selection = null;
  }
  // Merge down keeps the pixels of both layers.
  {
    app.newDocument(50, 50, "merge");
    const doc = app.doc!;
    doc.layers[0].canvas!.getContext("2d")!.fillStyle = "#0000ff";
    doc.layers[0].canvas!.getContext("2d")!.fillRect(0, 0, 50, 50);
    const top = createRasterLayer("top", 10, 10, 5, 5, "#00ff00");
    doc.layers.push(top);
    app.session.activeLayerId = top.id;
    app.mergeDown();
    const f = flattenDocument(doc);
    check("merge down composites", doc.layers.length === 1 && near(px(f, 8, 8), [0, 255, 0, 255]) && near(px(f, 40, 40), [0, 0, 255, 255]), [doc.layers.length, px(f, 8, 8), px(f, 40, 40)]);
  }
  // Free-transform maths.
  {
    const t = { x: 100, y: 100, width: 200, height: 100, rotation: 0, flipH: false, flipV: false };
    const se = { id: "se" as const, hx: 1 as const, hy: 1 as const };
    // Drag the SE corner proportionally to double the size: NW corner stays put.
    const s1 = scaleByHandle(t, se, { x: 500, y: 300 }, { proportional: true, fromCenter: false });
    check("scale corner keeps anchor", near([s1.x, s1.y, s1.width, s1.height], [100, 100, 400, 200], 0.5), s1);
    // Drag the E edge only changes width.
    const s2 = scaleByHandle(t, { id: "e", hx: 1, hy: 0 }, { x: 400, y: 999 }, { proportional: false, fromCenter: false });
    check("scale edge changes one axis", near([s2.x, s2.y, s2.width, s2.height], [100, 100, 300, 100], 0.5), s2);
    // Alt: from centre.
    const s3 = scaleByHandle(t, se, { x: 400, y: 250 }, { proportional: false, fromCenter: true });
    check("scale from centre", near([s3.x, s3.y, s3.width, s3.height], [0, 50, 400, 200], 0.5), s3);
    // Rotate 90° by dragging from the right of the centre to below it.
    const r = rotateByPointer(t, { x: 300, y: 150 }, { x: 200, y: 250 }, false);
    check("rotate by pointer", Math.abs(r.rotation - 90) < 0.01, r.rotation);
    // Hit testing at zoom 1: handle, inside, rotate band, outside.
    check("hit handle", hitTest(t, { x: 301, y: 201 }, 1).kind === "handle", hitTest(t, { x: 301, y: 201 }, 1));
    check("hit inside", hitTest(t, { x: 200, y: 150 }, 1).kind === "inside", hitTest(t, { x: 200, y: 150 }, 1));
    check("hit rotate band", hitTest(t, { x: 312, y: 212 }, 1).kind === "rotate", hitTest(t, { x: 312, y: 212 }, 1));
    check("hit outside", hitTest(t, { x: 600, y: 600 }, 1).kind === "outside", hitTest(t, { x: 600, y: 600 }, 1));
  }
  // Grouping: folder appears where the top-most selected layer was, contents nest, ungroup restores.
  {
    app.newDocument(20, 20, "groups");
    const doc = app.doc!;
    app.addBlankLayer(); const a = app.activeLayer!;
    app.addBlankLayer(); const b = app.activeLayer!;
    app.addBlankLayer(); const c = app.activeLayer!;
    app.selectLayer(a.id); app.selectLayer(b.id, { toggle: true });
    app.addGroup();
    const g = app.activeLayer!;
    check("group created above members", g.kind === "group" && doc.layers.indexOf(g) === doc.layers.indexOf(b) + 1 && a.parentId === g.id && b.parentId === g.id && c.parentId === null, doc.layers.map((l) => `${l.name}:${l.parentId ? "in" : "top"}`));
    const rows = layerTree(doc).map((r) => `${r.depth}:${r.layer.name}`);
    check("panel tree nests members", rows.join(",") === `0:${c.name},0:${g.name},1:${b.name},1:${a.name},0:Background`, rows);
    app.toggleCollapsed(g);
    check("collapsed folder hides members", layerTree(doc).length === 3, layerTree(doc).map((r) => r.layer.name));
    app.toggleCollapsed(g);
    app.selectLayer(g.id);
    app.duplicateLayer();
    check("duplicate folder copies contents", doc.layers.filter((l) => l.kind === "group").length === 2 && doc.layers.filter((l) => l.parentId === app.activeLayer!.id).length === 2, doc.layers.map((l) => l.name));
    app.deleteSelection();
    app.selectLayer(g.id);
    app.ungroupSelected();
    check("ungroup restores members", !doc.layers.includes(g) && a.parentId === null && b.parentId === null, doc.layers.map((l) => l.name));
  }
  // Project files: .comp round trip keeps structure and pixels; the archive is a Mac-style package.
  {
    app.newDocument(120, 90, "roundtrip");
    const doc = app.doc!;
    const red = createRasterLayer("red", 40, 30, 10, 20, "#ff0000");
    red.transform.rotation = 15; red.opacity = 0.8; red.blendMode = "multiply";
    red.effects.push({ kind: "drop-shadow", enabled: true, color: "#112233", opacity: 0.5, size: 6, distance: 4, angle: 120, spread: 0 });
    const m = createCanvas(120, 90); m.getContext("2d")!.fillStyle = "#fff"; m.getContext("2d")!.fillRect(0, 0, 60, 90);
    red.mask = { canvas: m, enabled: true, linked: true };
    const group = createLayer({ name: "Folder", kind: "group", transform: defaultTransform(120, 90) });
    red.parentId = group.id;
    const txt = createLayer({ name: "Type", kind: "text", canvas: createCanvas(1, 1), transform: defaultTransform(1, 1, 5, 5), text: { text: "Hi", fontFamily: "Liberation Sans", fontSize: 30, color: "#00ff00", align: "center", lineHeight: 1.3, letterSpacing: 2, weight: 700 } });
    const adj = createLayer({ name: "Levels", kind: "adjustment", adjustmentKind: "levels", adjustment: { levels: { black: 0.1, white: 0.9, gamma: 1.2, outBlack: 0, outWhite: 1 } }, transform: defaultTransform(120, 90) }); adj.canvas = null;
    doc.layers.push(red, group, txt, adj);
    app.session.activeLayerId = txt.id;
    doc.version++; // layers were appended directly, invalidate the render cache
    const before = px(flattenDocument(doc), 20, 30);
    const blob = await serializeProject(doc, txt.id);
    const zip = await readZip(await blob.arrayBuffer());
    check("comp archive has manifest and images", zip.has("manifest.json") && [...zip.keys()].some((k) => k.startsWith("images/") && k.endsWith(".png")) && [...zip.keys()].some((k) => k.endsWith(".mask.png")), [...zip.keys()]);
    const manifest = JSON.parse(new TextDecoder().decode(zip.get("manifest.json")!));
    check("manifest is Mac-compatible", manifest.format === "com.compositor.project" && manifest.version === 9 && manifest.layers[2].isGroup === true && manifest.layers[1].parentID === manifest.layers[2].id && manifest.layers[1].blendMode === "Multiply" && manifest.layers[1].maskFile.endsWith(".mask.png") && manifest.layers[3].text.alignment === "Center" && manifest.layers[4].adjustment.kind === "Levels", { keys: Object.keys(manifest), l1: manifest.layers[1] });
    const { doc: back, activeLayerId } = await parseProject(await blob.arrayBuffer(), "x");
    const b1 = back.layers[1];
    check("round trip restores layers", back.layers.length === 5 && b1.kind === "raster" && b1.parentId === back.layers[2].id && b1.transform.rotation === 15 && b1.opacity === 0.8 && b1.blendMode === "multiply" && b1.mask?.enabled === true && b1.effects[0]?.kind === "drop-shadow" && back.layers[3].text?.weight === 700 && back.layers[3].text?.align === "center" && back.layers[4].adjustmentKind === "levels" && (back.layers[4].adjustment?.levels?.gamma ?? 0) === 1.2 && activeLayerId === back.layers[3].id, back.layers.map((l) => `${l.kind}:${l.name}`));
    const after = px(flattenDocument(back), 20, 30);
    check("round trip keeps pixels", near(before, after, 3), { before, after });
  }
  // Pasting never overgrows the canvas.
  {
    app.newDocument(100, 60, "pastefit");
    const big = createCanvas(400, 400);
    big.getContext("2d")!.fillStyle = "#123456";
    big.getContext("2d")!.fillRect(0, 0, 400, 400);
    const blob = await new Promise<Blob | null>((r) => big.toBlob(r, "image/png"));
    await app.pasteImageFile(blob!);
    const t = app.activeLayer!.transform;
    check("paste fits inside the canvas", t.width <= 100 && t.height <= 60 && t.width === 60 && t.height === 60 && t.x === 20 && t.y === 0 && app.activeLayer!.canvas!.width === 400, t);
  }
  // On-canvas text editing: click empty space creates a layer to type into; empty text is discarded.
  {
    app.newDocument(200, 100, "textedit");
    app.setTool("type");
    const view = document.getElementById("editor") as HTMLCanvasElement;
    const rect = view.getBoundingClientRect();
    const z = app.session.zoom;
    const ox = rect.left + rect.width / 2 + app.session.panX - (app.doc!.width * z) / 2;
    const oy = rect.top + rect.height / 2 + app.session.panY - (app.doc!.height * z) / 2;
    const ev = (x: number, y: number) => ({ clientX: ox + x * z, clientY: oy + y * z, button: 0, altKey: false, shiftKey: false }) as unknown as PointerEvent;
    app.pointerDown(view, ev(20, 20)); app.pointerUp(view, ev(20, 20));
    check("type click opens an editor", app.session.textEdit?.created === true && app.activeLayer?.kind === "text" && app.activeLayer.text?.text === "", app.session.textEdit);
    app.setText({ text: "Hello" });
    app.endTextEdit(true);
    const made = app.activeLayer!;
    check("committing keeps the text", app.session.textEdit === null && made.text?.text === "Hello" && made.transform.width > 10, made.text);
    // Clicking the existing text edits it instead of adding another layer.
    const n = app.doc!.layers.length;
    app.pointerDown(view, ev(made.transform.x + 5, made.transform.y + 5)); app.pointerUp(view, ev(made.transform.x + 5, made.transform.y + 5));
    check("clicking text edits in place", app.session.textEdit?.layerId === made.id && app.doc!.layers.length === n, app.session.textEdit);
    app.setText({ text: "" });
    app.endTextEdit(true);
    check("empty text is discarded", app.doc!.layers.length === n - 1, app.doc!.layers.map((l) => l.name));
  }
  // Brush strokes are visible while dragging (each move re-renders).
  {
    app.newDocument(50, 50, "brushlive");
    app.setTool("brush");
    app.session.foreground = "#ff0000";
    app.session.brush.size = 10;
    const view = document.getElementById("editor") as HTMLCanvasElement;
    const rect = view.getBoundingClientRect();
    const z = app.session.zoom;
    const ox = rect.left + rect.width / 2 + app.session.panX - (app.doc!.width * z) / 2;
    const oy = rect.top + rect.height / 2 + app.session.panY - (app.doc!.height * z) / 2;
    const ev = (x: number, y: number) => ({ clientX: ox + x * z, clientY: oy + y * z, button: 0, altKey: false, shiftKey: false, buttons: 1 }) as unknown as PointerEvent;
    const v0 = app.doc!.version;
    app.pointerDown(view, ev(10, 25));
    app.pointerMove(view, ev(40, 25));
    const mid = px(flattenDocument(app.doc!), 25, 25);
    check("stroke renders before pointer-up", app.doc!.version > v0 && mid[0] > 200 && mid[1] < 80, { mid, v0, v1: app.doc!.version });
    app.pointerUp(view, ev(40, 25));
  }
  // Colour well: swap and defaults.
  {
    app.session.foreground = "#123456";
    app.session.background = "#abcdef";
    app.swapColors();
    const swapped = app.session.foreground === "#abcdef" && app.session.background === "#123456";
    app.resetColors();
    check("swap and default colours", swapped && app.session.foreground === "#000000" && app.session.background === "#ffffff", [app.session.foreground, app.session.background]);
  }
  // Double-click rename works with real click pairs (rows are rebuilt between clicks).
  {
    app.newDocument(20, 20, "rename");
    app.addBlankLayer();
    const id = app.activeLayer!.id;
    app.selectLayer(app.doc!.layers[0].id); // select another layer first, so the first click re-renders
    const row = () => document.querySelector<HTMLElement>(`.layer-row[data-id="${id}"] .name`)!;
    row().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    row().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const input = document.querySelector<HTMLInputElement>(".layer-row input.rename");
    check("double-click opens inline rename", !!input && document.activeElement === input, !!input);
    if (input) { input.value = "Renamed"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
    await new Promise((r) => setTimeout(r, 50));
    check("inline rename commits", app.doc!.layers.find((l) => l.id === id)?.name === "Renamed", app.doc!.layers.map((l) => l.name));
  }
  // Tooltips: native titles are replaced by the app's own.
  {
    check("no native title bubbles left", document.querySelectorAll(".app-shell [title]").length === 0 && document.querySelectorAll(".app-shell [data-tip]").length > 10, document.querySelectorAll(".app-shell [data-tip]").length);
  }
  // Cursors and brush keys.
  {
    check("paint tools hide the arrow", cursorForTool({ tool: "brush", shift: false, alt: false, dragging: false }) === "none" && cursorForTool({ tool: "clone-stamp", shift: false, alt: true, dragging: false }) === "crosshair", null);
    check("tool cursors", cursorForTool({ tool: "zoom", shift: true, alt: false, dragging: false }).startsWith("url(") && cursorForTool({ tool: "zoom", shift: true, alt: false, dragging: false }) !== cursorForTool({ tool: "zoom", shift: false, alt: false, dragging: false }) && cursorForTool({ tool: "hand", shift: false, alt: false, dragging: true }) === "grabbing" && cursorForTool({ tool: "type", shift: false, alt: false, dragging: false }) === "text" && cursorForTool({ tool: "eyedropper", shift: false, alt: false, dragging: false }).startsWith("url("), null);
    app.session.brush.size = 24;
    app.adjustBrush(1); app.adjustBrush(1);
    const grown = app.session.brush.size;
    app.adjustBrush(-1);
    check("bracket keys resize the brush", grown === 44 && app.session.brush.size === 34, { grown, now: app.session.brush.size });
  }
  // View › Theme: three choices, applied live and remembered.
  {
    const before = getThemePreference();
    await applyThemeChoice("light");
    const lightOk = document.documentElement.dataset.themeMode === "light" && getThemePreference() === "light" && themeChoice() === "light";
    await applyThemeChoice("dark");
    const darkOk = document.documentElement.dataset.themeMode === "dark" && getThemePreference() === "dark";
    await applyThemeChoice("omarchy");
    const omarchyOk = getThemePreference() === "omarchy" && document.documentElement.dataset.themeChoice === "omarchy";
    check("theme choice applies and is remembered", lightOk && darkOk && omarchyOk, { before, now: getThemePreference() });
    await applyThemeChoice(before);
  }
  // Omarchy colors.toml parsing.
  {
    const { palette, found } = parseColorsToml('mode = "light"\naccent = "#1E66F5"\nbackground = "#eff1f5" # comment\nbogus = "#123456"\nred = "notacolor"\n');
    check("colors.toml parser", palette.mode === "light" && palette.accent === "#1e66f5" && palette.background === "#eff1f5" && found === 3, { found, accent: palette.accent });
  }
  return results;
}
