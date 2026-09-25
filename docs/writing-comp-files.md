# Writing Compositor projects (for AI agents and scripts)

A Compositor project (`.comp`) is a `manifest.json` plus PNG layer images. Anything that can write files can build or edit one, and **Compositor for Omarchy updates the open canvas as the files change**, the same way Compositor 1.3 does on the Mac. No plugin or API is involved.

## Try it on Omarchy

1. Make a package folder and open it, keeping it open:

   ```bash
   mkdir -p ~/Desktop/demo.comp/images
   compositor ~/Desktop/demo.comp
   ```

   (Or File › **Open Package Folder…** in the app, or drop the folder onto the canvas. A folder with no `manifest.json` yet shows nothing until the first write.)

2. Ask an AI agent that can edit files on your machine (Claude Code, Codex and the like):

   > Read docs/writing-comp-files.md in github.com/rubengarciajr/compositor-for-omarchy, then design a moody night scene in ~/Desktop/demo.comp. Work in steps, one or two layers at a time.

3. Watch the canvas. Each time the agent writes the project, Compositor reloads it, usually within half a second.

What you get are ordinary layers: select them, change their opacity or blend mode, paint, add masks, save.

## Two shapes of `.comp`

- A **package folder** `Name.comp/` with `manifest.json` and `images/`. This is what agents and the macOS app write, and what File › Open Package Folder… and `compositor Name.comp` open. Save writes back into the folder.
- A **ZIP file** `Name.comp` with the same contents. This is what File › Save writes by default; it also reloads when another program replaces the file. Unzip one and you have a package folder; zip a folder and the Mac app opens it.

## The package

```
Example.comp/
├── manifest.json
└── images/
    ├── 6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.png        a layer's pixels
    └── 6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.mask.png   its mask (optional)
```

A minimal manifest with one full-canvas image layer:

```json
{
  "format": "com.compositor.project",
  "version": 9,
  "colorSpace": "sRGB",
  "documentID": "0C5E7A91-3B2D-4F6A-8E1C-9D0B7A6F5E4D",
  "width": 1920,
  "height": 1080,
  "resolution": 72,
  "activeLayerID": "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F",
  "layers": [
    {
      "id": "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F",
      "name": "Background",
      "imageFile": "6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.png",
      "isVisible": true,
      "isGroup": false,
      "opacity": 1,
      "blendMode": "Normal",
      "transform": {
        "origin": [0, 0],
        "size": [1920, 1080],
        "rotation": 0,
        "flipX": false,
        "flipY": false,
        "sampling": "High quality"
      }
    }
  ]
}
```

- `layers` runs **bottom to top**: the last layer draws on top.
- Keep `documentID` as it is when editing an existing project.
- `transform` places the layer in document pixels: `origin` is its top-left corner, `size` its width and height, `rotation` is in degrees, clockwise. The image is stretched to `size`, so a layer can be smaller than the canvas (a cut-out placed with `origin`) or scaled.
- `sampling` is `"High quality"`, `"Smooth"` or `"Nearest"`.
- `opacity` runs from 0 to 1.
- Folders: `"isGroup": true` on the folder, and `"parentID": "<folder id>"` on each layer inside it.

## Rules that matter

Break one of these and Compositor keeps the canvas as it was and ignores the write until the next change (the browser console says why):

- **Image files are named after their layer.** A layer with `"id": "6F1D…"` uses `"imageFile": "6F1D….png"`, and a mask `"maskFile": "6F1D….mask.png"`, with the ID in uppercase as written in the manifest. One ID per layer, unique in the project.
- **Images are 8-bit PNGs** in `images/`. Layer images are RGBA; masks are grayscale (white shows the layer, black hides it).
- **Blend modes are spelled exactly** as Compositor names them: `Normal`, `Darken`, `Multiply`, `Color Burn`, `Linear Burn`, `Lighten`, `Screen`, `Color Dodge`, `Linear Dodge (Add)`, `Overlay`, `Soft Light`, `Hard Light`, `Vivid Light`, `Linear Light`, `Pin Light`, `Hard Mix`, `Difference`, `Exclusion`, `Subtract`, `Divide`, `Hue`, `Saturation`, `Color`, `Luminosity`.
- **Every layer the manifest names has its image in place**, and the manifest is valid JSON.

## Writing safely while the project is open

Compositor reads the project as soon as it changes, so never leave it half written:

1. Write any new or changed PNGs into `images/` first.
2. Then write the manifest to a temporary file inside the package (for example `.manifest.json.tmp`) and rename it over `manifest.json`. A rename is atomic: Compositor sees either the old manifest or the new one, never part of one.

To change an existing layer, keep its `id` and overwrite its PNG, then rewrite the manifest. The layer updates in place, in the same spot in the stack.

Remove images you no longer reference once the manifest no longer lists them.

**Always rewrite the manifest after changing an image.** A folder opened from the launcher (`compositor Name.comp`) is watched through the manifest's contents; a folder opened with Open Package Folder… (or dropped on the canvas) is also watched through each image's name, size and modification time, like the Mac app. Adding a `"savedAt"` timestamp under a `"linux"` key, or touching any value, is enough to make the manifest differ.

## What the open app does

- It checks the package about every 0.4 s and reloads when it differs. Several writes in quick succession arrive as one update, so pause briefly between steps if a viewer should see each one.
- A reload keeps the zoom, scroll, selection and the selected layer (when it still exists) but clears undo, as reopening a file does.
- If the person has unsaved changes of their own, Compositor asks them to **Revert** to your version or **Keep Mine**, and never replaces their work silently.
- A write that fails to load is ignored until the next change, so a mistake you then fix will still show up.
- The status bar shows ⟳ after the name of a watched document.

## Masks

Add a mask to any layer with `"maskFile": "<id>.mask.png"` and `"maskEnabled": true`. The mask covers the layer's own pixels, so it has the same pixel size as the layer's image. Soft grays give soft edges.

## Adjustment layers

An adjustment layer has an `adjustment` object and no `imageFile`, and it affects everything below it. `kind` is one of `Hue/Saturation`, `Levels`, `Curves`, `Exposure`, `Gradient Map`, `Grain`, `Invert`, `Black & White`, `Color Balance`, `Gaussian Blur`, `Motion Blur`, `Add Noise`. For Hue/Saturation set `hue`, `saturation` and `lightness` on the adjustment itself; the Linux app also reads its own settings from a `linux` object inside `adjustment` (add one in the app, save, and copy it from the manifest for the exact shape). The macOS reference for every kind is [robbietilton/Compositor/docs/writing-comp-files.md](https://github.com/robbietilton/Compositor/blob/main/docs/writing-comp-files.md).

## Text and shapes

Text layers carry a `text` object (`content`, `fontName`, `fontSize`, `red`/`green`/`blue` 0–1, `alignment` `Left`/`Center`/`Right`, `tracking`, `leading`) and are re-rendered by the app, so they stay editable. Shape layers carry a `shape` object (`kind` `Rectangle`/`Ellipse`/`Line`, colour, `cornerRadius`, `lineWidth`). Both still need an `imageFile` for readers that do not render them.

## More

- Folders, layer effects and everything else the format holds: [project-format.md](project-format.md).
- The Linux app keeps its extras (document name, font weight, folder state) under `linux` keys that other readers ignore.
