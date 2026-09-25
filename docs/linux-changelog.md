# Compositor for Omarchy — changelog

What changed in the Linux port (`linux/`), newest first. Before shipping an update run
`npm run check` in `linux/` (typecheck, build and the headless self-test) — it fails if any
rendering, clipboard, history or theming check regresses.

## 1.2.0 — 2026-09-25

Brings the Linux port up to the features Compositor for macOS shipped between 1.2.5 and 1.3.1.

### Added
- **Watch AI design** (Compositor 1.3): any script or AI agent that can write files can build or change a project while it is open, and the canvas reloads as the package changes, usually within half a second. Open a `.comp` **package folder** (`manifest.json` + `images/`, the layout agents and the Mac app write) with File › Open Package Folder…, by dropping the folder on the canvas, or with `compositor ~/Desktop/demo.comp`; a `.comp` ZIP file opened through the file dialog is watched too. A reload keeps zoom, scroll, selection and the selected layer; with unsaved edits the app asks to Revert or Keep Mine. Save writes back into the folder (images first, manifest last); Save As Package Folder… turns any document into one. Watched documents show ⟳ in the status bar. How to write packages: [`docs/writing-comp-files.md`](writing-comp-files.md).
- **Copy and paste whole layers** (Compositor 1.2.5): `Ctrl+C` with no selection copies the selected layers themselves, and `Ctrl+V` in this or another open project pastes them above the active layer with editable text, masks, effects and folders intact; other apps still receive the PNG. `Ctrl+J`, paste and Alt-drag duplicate every selected layer, stacked together above the topmost, and `Ctrl+J` duplicates folders with their contents.
- **Crop ratios** (Compositor 1.2.5): Free, 1:1, 4:3, 3:4, 16:9 and 9:16 in the Crop header, and with a selection the crop box starts at its bounds.
- **Drag a number's label to change its value** (Compositor 1.2.11): brush size, hardness, opacity, flow, spacing, transform X/Y/W/H/angle, text size, leading, tracking and the rest; Shift drags ten times faster.
- **SVG import** (Compositor 1.2.10): an SVG added, pasted or dropped is rasterised sharp at a size that fits the canvas.
- **Inner Glow** layer effect (format parity with the Mac app's `innerGlow`): rendered, saved and loaded.
- **Quit or close while typing** (Compositor 1.3.1): the text is committed and the usual save prompt follows.

## 1.1.1 — 2026-09-23

### Changed
- **The app menu entry is named "Compositor"** and uses the original Compositor app icon at 48–512 px (pre-rendered in `packaging/icons`, so packaging needs no SVG tooling); the page favicon matches.
- **About shows the original app icon** (Robbie Tilton's Compositor icon from robbietilton.com/compositor) instead of a drawn placeholder.

### Added
- **Trim Transparent Pixels** (Layer menu and the layer right-click menu): crops a raster layer's bitmap to its visible pixels without moving them, so the transform box hugs the artwork instead of a PNG's empty padding. Works on scaled, flipped and rotated layers. Images added with Add Image, paste or drop are trimmed automatically on import.

### Fixed
- **Layer panel buttons disappeared** (New Layer, Add Image, Group, Mask, Effect, Adjustment, Delete) once the layer list grew taller than the panel: the list now scrolls and the button row stays put.

## 1.1.0 — 2026-09-23

### Added
- **Named and versioned for release:** the app is now *Compositor for Omarchy* (package `compositor-for-omarchy`, which replaces the earlier `compositor` package; the command is still `compositor`). Version 1.1.0 shows in Help › About with the renderer in use. A **Help** menu adds Keyboard Shortcuts, Report a Bug (opens the issue tracker), the GitHub page, a link to the original app and About, which credits Robbie Tilton (Wonder Assembly LLC) as the creator of Compositor for macOS with links to robbietilton.com/compositor and the GitHub repository. `scripts/release.sh` builds a prebuilt release tarball (no Node needed to install) and the matching AUR `PKGBUILD` with the sha256 filled in.
- **Gradient presets** (Photoshop "Basics"): the Gradient header shows a preview strip that opens a preset picker with Foreground to Background, Foreground to Transparent, Background to Transparent and Black/White tiles (drawn over a checkerboard so transparency is visible, name shown on hover). Linear / Radial style buttons and a Reverse toggle sit next to it. Presets resolve against the current foreground/background at paint time; the guide line's end dots show the actual start/end colours and radial drags show the radius. The last preset, style and direction are remembered (`compositor.gradient` in localStorage). Self-test covers each preset, reverse, radial and persistence.

- **Layer › Add Image…** (also in the layer panel footer and the right-click menu): pick one or more image files and each becomes a new layer fitted inside the canvas, exactly like pasting. With no document open it opens the image as a new document.

- **Renderer choice and a lean profile:** the launcher now prefers open-source Chromium (no Google services) and falls back to any Chromium-based browser it finds, including Flatpaks; with none installed it prints and notifies the install command. The private profile starts with extensions, component and ML-model downloads, Safe Browsing databases, sync, translation, crash upload and background fetches off and a 64 MB disk cache, and leftover browser junk is pruned at every launch (a Chrome profile had grown to 158 MB of Google services the app never uses). New commands: `compositor --browser`, `compositor --cache`, `compositor --clean`; `COMPOSITOR_PROFILE` picks another profile directory.
- **Marching ants:** selections are outlined with the animated black/white dashes instead of a tint. The outline is computed once per selection (edges between selected and unselected pixels) and redrawn ten times a second from the cached composite, so it costs nothing while you work. This also removed a full-size tint canvas that was allocated on every frame.
- **Crop handles:** after drawing a crop box, drag its corner and edge handles to adjust it (Shift keeps the ratio, Alt from the centre) or drag inside to move it; the cursor changes over handles. Enter applies, Esc cancels.
- **Brush spacing:** a Spacing % slider (Brush, Eraser, Clone Stamp) sets the distance between stamps as a fraction of the size, Photoshop's default 25 %.
- **Tools reviewed against Photoshop** and upgraded:
  - **Space** is a temporary Hand with any tool (grab cursor, no page scroll).
  - **Brush / Eraser / Clone / Blur:** Shift-click draws a straight line from where the last stroke ended; Alt with Brush or Eraser samples a colour (pipette cursor); Clone Stamp keeps Alt for the source.
  - **Spot Healing** is back on the rail (`J`): click or paint over a mark and it is filled from the surrounding pixels with a feathered edge (a light content-aware patch). **Blur** now really blurs the pixels under the brush (Strength slider) instead of stamping grey.
  - **Eyedropper:** Alt-click sets the background colour.
  - **Zoom:** Alt-click zooms out as well as Shift-click.
  - **Marquee:** hold Shift *while dragging* for a square / circle, Alt to draw from the centre; Shift or Alt *before* the click still add / subtract.
  - **Shape:** Shift keeps it square / round, Alt draws from the centre; selecting a shape layer shows Fill, Stroke, Width (and Radius for rounded) in the header and edits it live.
  - **Magic Wand:** a **Contiguous** toggle; off selects every matching colour in the image.
  - **Move:** Ctrl-click selects the top-most layer with pixels under the pointer (auto-select), Alt-drag moves a copy, Shift constrains the drag to one axis; dragging repaints only the canvas.
  - **Crop:** Enter applies, Esc cancels.
  - Every tool header shows a short hint of its modifiers.
- **Right-click a selection** for Photoshop's selection commands: Layer via Copy (`Ctrl+J`), Layer via Cut (`Ctrl+Shift+J`), Layer Mask from Selection, Select Inverse (`Ctrl+Shift+I`), Deselect (`Ctrl+D`), Fill with Foreground / Background, Clear, Copy, Copy Merged, Free Transform. The same commands live in a new **Select** menu (All `Ctrl+A`, Deselect, Inverse, Layer via Copy / Cut, Layer Mask from Selection). Right-clicking the canvas without a selection offers Select All and Paste on top of the layer menu. Layer via Copy without a selection duplicates the layer, as in Photoshop.
- **Add to / subtract from a selection** like Photoshop: with Magic Wand, Marquee or Lasso, hold `Shift` to add to the current selection and `Alt` to subtract from it. The Magic Wand now has its own wand cursor with a `+` badge while Shift is held and a `−` badge for Alt; Marquee and Lasso show the same badges on their crosshair. The tool headers say so.
- **Brush colour in the tool header:** the Brush header starts with a colour swatch (the foreground colour) so you can change it without going down to the colour well; the well follows it, and `X` / `D` still swap and reset.

### Fixed
- **Freehand lasso** showed only a dashed rectangle while dragging and re-rendered the whole interface on every mouse move; it now draws the outline live (with the closing edge dashed) and closes on release. **Polygon lasso** used to close itself on the third click; corners now stay open until you double-click, press Enter, or click the first corner (ringed), and Esc cancels. Marquee and gradient drags also repaint only the canvas overlay now.
- **Fill and Clear** on a moved, scaled or rotated layer landed in the wrong place; they now go through the layer's transform like the brush.
- **Hardness 100 % painted nothing:** a fully hard brush or eraser produced no stroke (a zero-width radial gradient); it now fills a solid disc.
- **Brush painted away from the cursor** on any layer that had been moved, scaled, rotated, flipped or pasted (a fitted image, for example): strokes were stamped in bitmap pixels as if the layer sat at the canvas origin at 1:1. Brush, Eraser, Blur, Clone Stamp and Spot Healing now paint through the inverse of the layer's transform, so the stroke lands exactly under the circle at the right size, and Clone Stamp samples correctly. Self-test paints on a fitted paste and checks the pixel under the pointer.

### Performance
Measured on a 3000×2000 document with 9 layers in Chromium (GPU canvases, timed with a readback):

| Operation | Before | After |
| --- | --- | --- |
| Brush stroke frame | 12 ms | 3.5 ms |
| Commit (one history step) | 24.5 ms | 1.5 ms |
| Undo | 36.5 ms | 1.8 ms |

- **Copy-on-write history.** A history step used to copy every layer bitmap (and undo copied them all back), so memory grew with layers × steps and big documents hitched on every stroke. Entries now share bitmaps with the live document; a bitmap that history holds is frozen and copied only when a tool is about to draw into it (`writableLayer` in `src/core/history.ts`). Memory and time are proportional to what changed. Every in-place drawing path (brush, eraser, clone, blur, fill, clear, text and shape re-rasterising) goes through it, and the self-test proves entries are never drawn into.
- **Incremental stroke compositing.** While a brush stroke is in progress the layers below and above the painted layer are composited once and reused, so each frame is three `drawImage` calls instead of a full re-composite (`beginStroke`/`endStroke` in `src/render/compositor.ts`). It is used only when nothing above the layer depends on its pixels (no clipping layer on it, no adjustment layer or non-Normal blend mode above it); otherwise it silently falls back to the full composite. Any structural change ends the shortcut.

### Changed
- The colour well is more compact (18 px swatches in a 32 px box) and its swap control is Photoshop's curved arrow wrapping the top-right corner, heads pointing at the foreground and background swatches.

## 1.0.0 — 2026-09-22

### Added
- **Type on the canvas:** with the Type tool, click an empty spot and type right there; click existing text to edit it in place (or double-click it with the Move tool). The editor sits exactly over the layer with its font, size, colour, alignment and rotation; Ctrl+Enter or clicking away commits, Esc cancels, empty text layers are discarded. The header text field stays in sync.
- **Photoshop-style cursors:** paint tools (Brush, Eraser, Blur, Clone Stamp, Spot Healing) hide the arrow and show a circle the exact size of the brush, with a dashed inner ring for soft edges and a crosshair when the brush is tiny; `[` / `]` change the size, `Shift+[` / `]` the hardness. Selections, Crop, Gradient and Shape use a crosshair; Type an I-beam; Eyedropper a pipette; Hand grab/grabbing; Zoom zoom-in (Shift: zoom-out); Clone Stamp a crosshair while Alt picks the source; Move shows resize and rotate cursors over the handles.
- **Project files (.comp):** File › Save (`Ctrl+S`), Save As… (`Ctrl+Shift+S`) and Open… (`Ctrl+O`, also `.comp` on the command line, in the file manager, or dropped onto the canvas) keep every layer editable: folders, masks, clipping, opacity and blend modes, transforms, effects, text (font, weight, colour, alignment, leading, tracking), shapes, adjustment layers and guides. A `.comp` is a ZIP of the macOS app's document package (`manifest.json` + `images/<UUID>.png`, format version 9, see `docs/project-format.md`), so it unzips into a Mac package; Linux-only details live under `linux` keys the Mac app ignores. Export JPEG moved to `Ctrl+Alt+Shift+S`. The package registers `application/x-compositor-project`.
- **Layers panel:** double-click a layer name (or right-click › Rename…) to edit it right in the row.
- **Paste** never overgrows the canvas: larger images are fitted inside it, keeping their full resolution for scaling back up later.
- **Layers panel:** right-click any layer (or the canvas) for the app's own menu — Group Layers first, then Ungroup, Duplicate, Delete, Merge Down, Show/Hide, Rename, New Blank Layer. The browser's context menu no longer appears. Folders show their contents nested underneath and fold/unfold on double-click (or the ▸ disclosure). Ctrl-click toggles layers in and out of the selection, Shift-click selects a range. Drag a layer onto a folder to put it inside; deleting or duplicating a folder takes its contents along.
- **Gradient tool:** every gradient lands on its own new layer, fills the whole layer (or the selection) from the foreground to the background colour along the drag, and shows a guide line while dragging. Brush, Eraser, Clone, Blur and Fill create a new layer automatically when the active layer cannot be painted (group, adjustment, text, shape).
- **Type tool styling:** font family (curated Omarchy fonts, or every installed font via "System fonts…"), weight, size, colour, alignment, leading and tracking in the tool header, editing the selected text layer live. Default font is Noto Sans (installed on Omarchy).
- **Free Transform:** with the Move tool the selected layer shows a box with eight handles. Drag a corner to scale (proportional by default, Shift for free ratio, Alt from the centre), an edge to stretch, or just outside a corner to rotate (Shift snaps to 15°). The tool header shows X / Y / W / H / Angle fields, Flip H / V and Reset. `Ctrl+Alt+T` (Edit › Free Transform) switches to the Move tool, because Chromium reserves `Ctrl+T` for a new tab.
- **Clipboard:** paste an image from anywhere (screenshot, browser, file manager, another editor) with `Ctrl+V` or Edit › Paste as Layer; it lands as a new layer centred on the canvas. `Ctrl+C` copies the active layer, `Ctrl+Shift+C` copies the merged image, both limited to the selection when there is one, as PNG on the system clipboard.
- Drop an image onto an open document to add it as a layer (dropping with no document still opens it).
- Open files from the command line or the app menu's file association: `compositor photo.png`.
- Several documents open at once, switchable in the status bar; Close Document (`Ctrl+Alt+W`).
- Clipping masks, group masks, and adjustment layers that affect only what is below them.
- Layer effects: outside stroke on any shape, inner shadow, outer glow; Photoshop light-angle convention.
- Text layers grow to fit their content; the text field takes focus as soon as you place text.
- Live Omarchy theming without a sync step: the launcher points the app at `~/.local/state/omarchy/current/theme/colors.toml` and it re-reads it every 3 seconds; `--theme <name>` forces any installed theme; light themes switch the chrome to light.
- `npm run check` / `npm test`: headless self-test (`src/selftest.ts`, `scripts/smoke-test.mjs`) driven over the DevTools protocol, with results reported progressively so a hang shows where it stopped.
- `.gitignore` for the Linux tree.

### Fixed
- Zoom tool: the pointer disappeared while holding Shift because the cursor theme has no `zoom-out` cursor; both magnifier cursors (+ / −) are now drawn by the app.
- Brush, Eraser, Blur and Clone strokes appeared only after releasing the mouse; they now render while you drag.
- Launcher opened a blank window: Chromium blocks module scripts, stylesheets and `fetch()` on `file://` pages. The app now runs in its own browser profile with `--allow-file-access-from-files`.
- Theme sync looked in `~/.config/omarchy/current/`, which does not exist on Omarchy 4 (the theme lives in `~/.local/state/omarchy/current/`), and silently fell back to Tokyo Night.
- Layers inside a group did not render at all.
- Every frame blended each layer per pixel in JavaScript (160 ms for the default canvas, 1.6 s for a 12 MP photo). Canvas-native blend modes are used where they exist and the flattened image is cached; pan and zoom no longer re-composite.
- Typing in the Type tool, dragging sliders and using the colour picker lost focus or collapsed because every input rebuilt the toolbar or rail.
- Inner shadow painted the whole layer black; stroke outlined the bounding box instead of the shape.
- Layer masks were applied in layer space (wrong for moved or resized layers).
- Menus advertised shortcuts that were unbound or that Chromium reserves (`Ctrl+N`, `Ctrl+Shift+N`, `Ctrl+W`); shortcut labels now render as `Ctrl+…` on Linux.
- View › Theme entries wrote a setting nobody read.
- New documents opened at 100% instead of fitting the window.
- `.desktop` `StartupWMClass` never matched (Chromium derives the Wayland app id from the URL); `--theme` was forwarded to Chromium as junk arguments; the launcher's `uwsm-app ping` raised a desktop notification on every launch.
- PKGBUILD installed `dist/` with the checkout's private file modes, so the packaged app was unreadable.
- Unsaved work: the window asks before closing (`Ctrl+W` is Chromium's).

### Changed
- **Tooltips** are drawn by the app (small, themed, thin border) instead of the browser's native bubbles, which rendered with a broken border on first hover.
- **Closing:** Ctrl+W closes the document and Ctrl+Q (File › Quit Compositor) closes the app, each through the app's own "Save changes to … before closing?" dialog with Save / Don't Save / Cancel. Chromium's "Leave app?" prompt only appears when the window manager closes the window with unsaved work. Because app windows deliver all shortcuts, the Photoshop keys are back: Ctrl+N new canvas, Ctrl+Shift+N new layer, Ctrl+T free transform (the Alt variants still work).
- **View › Theme** offers exactly three choices — Omarchy (follow the desktop palette live, the default), Dark, Light — applied instantly and remembered across launches. `compositor --theme dark|light` still forces one for a session.
- **Colour well** like Photoshop and the Mac app: rounded foreground swatch over the background swatch with light borders, a swap arrow (`X`) and a default-colours button (`D`, black over white). Defaults are now black over white.
- **Icons:** the tool rail, layer panel, folders and header buttons use one stroke-based SVG icon set (Lucide-style, `currentColor`) instead of mixed Unicode glyphs and an emoji; tools show their shortcut letter on hover. New app icon (layered squares in the Omarchy accent family) with PNG sizes for menus that ignore SVG.
- The "Omarchy theme" badge at the top right is gone; the palette source is still readable from `<html data-theme-source-label>`.
- Larger tool rail (64 px, 22 px icons) and colour swatches.
- Keyboard: New canvas `Ctrl+Alt+N`, New layer `Ctrl+Alt+L`, Export PNG `Ctrl+Shift+E`, Export JPEG `Ctrl+Shift+S`, Open `Ctrl+O`, Group `Ctrl+G`, Invert `Ctrl+I`.
- Merge Down goes through the real compositor (masks, effects, flips, blend modes honoured).
- Exporting clears the unsaved flag.

### Known limitations
- No parameter editor yet for adjustment layers and effects (added with defaults).
- One undo stack shared by all documents; each step stores full layer copies.
- Blur tool is an approximation; Clone Stamp samples the flattened image.
- Import limited to what Chromium decodes (no HEIC, TIFF, PSD).
