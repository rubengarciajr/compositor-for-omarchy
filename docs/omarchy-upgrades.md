# Compositor for Omarchy — what's different

The Linux build in [`linux/`](../linux/README.md) is a rebuild of [Robbie Tilton's Compositor for macOS](https://robbietilton.com/compositor) for Arch Linux + [Omarchy](https://omarchy.org). It keeps the Mac app's workflow and Photoshop habits, and adds the things a Hyprland desktop needs. This page is the one-stop list of what you get that the macOS app or a plain web port does not; the dated detail is in [`linux-changelog.md`](linux-changelog.md).

## Feels like Omarchy

- **Live theming from `colors.toml`.** The app reads the active Omarchy palette (`~/.local/state/omarchy/current/theme/colors.toml`) and restyles itself within seconds of `Super + Ctrl + Shift + Space`. Every stock theme works, light and dark, including your own themes in `~/.config/omarchy/themes/`. View › Theme lets you pin Dark or Light instead of following the desktop, and remembers it. `compositor --theme gruvbox` forces one.
- **Native app window.** Runs as a Chromium app window inside the uwsm session like Omarchy's own web apps, with its own browser profile, an app-menu entry (Super + Space → Compositor), an icon, and file associations for images and `.comp` projects. Opaque, un-blurred window rule for smooth painting.
- **Installed the Arch way.** `linux/scripts/install.sh` typechecks, builds, runs the self-test and installs a pacman package. `pacman -R compositor` removes it cleanly.
- **Fonts you actually have.** The Type tool lists Omarchy's fonts (JetBrainsMono / FiraCode / Caskaydia Nerd Fonts, Noto, Adwaita, Liberation, iA Writer…) and can load every installed family on request.
- **Linux shortcuts.** Menus show `Ctrl+…` and the Photoshop keys work (`Ctrl+N`, `Ctrl+T`, `Ctrl+W`, `Ctrl+Q`); closing and quitting go through the app's own Save / Don't Save / Cancel dialog.

## Photoshop-style experience

| Area | What you get |
| --- | --- |
| Layers panel | Folders with nested contents, fold/unfold on double-click, drag into folders, Ctrl-click / Shift-click multi-select, inline rename on double-click, right-click menu (Group, Ungroup, Duplicate, Delete, Merge Down, Show/Hide, Rename, New Layer). The browser's own menu never appears. |
| Free Transform | Handles always shown with the Move tool: corner scale (proportional; Shift free; Alt from centre), edge stretch, rotate outside a corner (Shift snaps 15°), numeric X/Y/W/H/Angle, flips, reset. `Ctrl+Alt+T` jumps to it. |
| Selections | Magic Wand, Marquee and Lasso: `Shift` adds to the selection, `Alt` subtracts; the wand has its own cursor and all three show a `+` / `−` badge while the modifier is held. Freehand lasso draws its outline live; polygon lasso closes on double-click, Enter or the first corner. Right-click a selection for Layer via Copy / Cut, Layer Mask from Selection, Inverse, Deselect, Fill, Clear, Copy; a Select menu carries the same commands (`Ctrl+A`, `Ctrl+D`, `Ctrl+Shift+I`, `Ctrl+J`, `Ctrl+Shift+J`). |
| Cursors | Paint tools show Compositor's ring at the exact brush size (white over black; a dashed core ring while right-dragging with Shift to set hardness); `[` `]` size (20 % steps), `Shift+[` `]` hardness (quarters), right-drag resizes the tip. Wand cursor for Magic Wand (with +/− badges), crosshair for marquee/lasso/crop/gradient/shape, I-beam for Type, pipette for Eyedropper, grab for Hand, zoom-in/out for Zoom, resize/rotate over handles. |
| Type tool | Type directly on the canvas (click to place, click text to edit, Esc / Ctrl+Enter), plus font family, weight, size, colour, alignment, leading, tracking in the header; text layers grow with their content and stay sharp when scaled (a uniform scale becomes the font size, as in Photoshop). |
| Gradient | Preset picker in the header like Photoshop's Basics: Foreground to Background, Foreground to Transparent, Background to Transparent, Black/White; linear or radial; Reverse. Fills a new layer (or the selection) along the drag, with a guide line whose end dots show the actual colours. The choice is remembered. |
| Runtime | Draws in a Chromium app window: open-source Chromium preferred, any Chromium-based browser as fallback, a private profile kept to a few megabytes (`compositor --cache` / `--clean`). The app itself is ~200 KB installed. |
| Selection outline | Marching ants (animated black/white dashes) around every selection, computed once per selection. |
| Crop | Handles to resize the crop box after drawing it (Shift ratio, Alt from centre), drag inside to move, ratio presets (1:1, 4:3, 3:4, 16:9, 9:16), starts at the selection, Enter applies, Esc cancels. |
| Numbers | Drag any number's label in a tool header to change its value (Shift for ×10). |
| Tool modifiers | Space pans with any tool. Shift-click draws straight lines with Brush / Spot Healing / Clone / Smear; Alt samples a colour with Brush / Spot Healing; Alt-click Eyedropper sets the background; Alt-click Zoom zooms out; Shift / Alt while dragging Marquee or Shape constrain / draw from the centre; Ctrl-click Move auto-selects the layer under the pointer, Alt-drag duplicates, Shift constrains; Enter / Esc apply / cancel a crop. Every tool header lists its modifiers. |
| Retouch | Spot Healing (`J`) with Content-Aware / Create Texture / Proximity Match, ported from the Mac app's healer; Smear (`R`) with Liquify / Blur / Smudge and a Strength slider; Clone Stamp with Aligned and This Layer / All Layers; Magic Wand has a Contiguous toggle; shape layers get Fill / Stroke / Width / Radius options. |
| Paint tools | Compositor's stroke engine: opacity caps the whole stroke, soft tips use its falloff and spacing, Smoothing trails the pointer on a string, strokes paint anywhere on the canvas (the layer grows to the paint), masks are painted by clicking their thumbnail (Black · Hide / White · Reveal). Brush header: Paint / Erase, Size, Hardness, Opacity, Smoothing, Color. `1`–`0` set opacity, Esc cancels, Shift locks the axis, Shift-click draws lines. Painting on type or a shape rasterises it; folders take paint on their mask only. Strokes land correctly on moved, scaled, rotated or pasted layers. |
| Clipboard | `Ctrl+V` pastes an image from anywhere as a new layer fitted inside the canvas; `Ctrl+C` / `Ctrl+Shift+C` copy the layer / merged image (limited to the selection) as PNG. Drop an image on a document to add it as a layer. |
| Watch AI design | Open a `.comp` package folder (File › Open Package Folder…, drop it on the canvas, or `compositor demo.comp`) and any script or AI agent that writes files changes the canvas live; Revert / Keep Mine when you have unsaved edits; Save writes back into the folder. See `docs/writing-comp-files.md`. |
| Clipboard | `Ctrl+C` with no selection copies whole layers (text, masks, effects, folders) and `Ctrl+V` pastes them in any open project; with a selection it copies pixels as PNG. |
| Files | `.comp` projects via native Save / Save As / Open dialogs (a `.comp` package folder or ZIP reloads live when another program changes it), SVG rasterised sharp on import, Layer › Add Image… to bring image files in as layers (transparent padding trimmed on import; Layer › Trim Transparent Pixels at any time), `compositor photo.png` from the terminal, several documents open at once. |
| Performance | Copy-on-write history (a step stores only what changed; undo is instant on large documents) and incremental compositing during brush strokes (three draws per frame instead of every layer). |
| Compositing | Groups with opacity and masks, clipping masks, adjustment layers that affect only what is below, effects (stroke, drop shadow, inner shadow, outer glow, colour overlay) on any shape. GPU blend modes where Canvas has them. |

## Project files that travel

A Linux `.comp` is a ZIP of exactly the macOS document package (`manifest.json` + `images/<UUID>.png`, format version 9, see [`project-format.md`](project-format.md)). Unzip it and the Mac app's layout is there; zip a Mac package and Linux opens it. Layers, folders, masks, clipping, transforms, blend modes, effects, text styling, shapes, adjustments and guides are all kept. Linux-only extras (font weight, adjustment parameters, folder state) live under `linux` keys other readers ignore. PSD import/export is the next step.

## Built to stay working

- `npm run check` (or `install.sh`) runs a headless self-test in Chromium against the built app: compositing, masks, adjustments, effects, blend modes, text layout, transform maths, grouping, clipboard, project round trip, theming. A broken build never reaches `/usr/share/compositor`.
- Every change is logged in [`linux-changelog.md`](linux-changelog.md).

## Not there yet (compared with the Mac app)

- No parameter editors for adjustment layers and effects (they are added with defaults).
- One undo stack shared by all open documents.
- Blur tool is an approximation; no Spot Healing / Content-Aware Fill; no PSD, HEIC or TIFF import.
- No rulers, guides dragging or snapping UI yet.
