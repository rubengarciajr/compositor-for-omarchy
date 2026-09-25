# Compositor for Omarchy

Adobe Photoshop costs too much and tools like GIMP don’t feel familiar enough to stay in flow. That’s why Robbie Tilton built Compositor for the Mac; I ported it over to Omarchy.

A Photoshop-style image editor for **Arch Linux + [Omarchy](https://omarchy.org)**: layers and folders, masks, blend modes, adjustment layers, selections with marching ants, type on the canvas, free transform, and the Photoshop tools and shortcuts you already know. It follows your Omarchy theme live and opens as an app window like Omarchy's other web apps.

![Compositor for Omarchy](linux/screenshot.png)

It is a Linux port of **[Compositor for macOS](https://robbietilton.com/compositor)** by **Robbie Tilton** (Wonder Assembly LLC) and shares its `.comp` project format, so files move between the two. The port lives in [`linux/`](linux/README.md).

## Requirements

**To run**

- Arch Linux with **Omarchy** (recommended, themed automatically), or any Arch-based system. Other distributions can run the release tarball; the launcher only needs bash.
- A **Chromium-based browser** to draw the window: open-source `chromium` is preferred (`omarchy pkg add chromium`), and Chrome, Brave, Edge, Vivaldi, Helium, Thorium or their Flatpaks work as fallbacks. Firefox cannot host the app window.
- Wayland or X11; on Omarchy the window is tiled by Hyprland and launched through uwsm like the built-in web apps.
- About 200 KB of disk for the app, a few MB for its private browser profile, and around 400 MB of memory while it runs (the browser processes).

**To build from source** (not needed to install a release)

- Node.js 20 or newer and npm
- `makepkg` (from `base-devel`) to build the Arch package

## Install

From the AUR (once published):

```bash
omarchy pkg add compositor-for-omarchy
```

From the latest release (no Node needed): download `compositor-for-omarchy-<version>.tar.gz` and `PKGBUILD` from the [releases page](https://github.com/rubengarciajr/compositor-for-omarchy/releases) into one folder, then:

```bash
makepkg -si
```

From source:

```bash
git clone https://github.com/rubengarciajr/compositor-for-omarchy.git
cd compositor-for-omarchy/linux && scripts/install.sh
```

Then launch **Compositor** from the app menu, or `compositor photo.png` from a terminal. `compositor --help` lists the options (`--theme`, `--browser`, `--cache`, `--clean`).

## What you get

- **Layers** — raster layers and folders, opacity, all the Photoshop blend modes, masks, clipping, effects (stroke, shadows, glow, colour overlay), adjustment layers, merge and flatten, inline rename, drag to reorder or into folders, right-click menu.
- **Tools** — Move with free-transform handles, Marquee, Lasso (freehand and polygon), Magic Wand, Crop with handles, Brush / Eraser with Compositor's stroke engine, Spot Healing (Content-Aware, Create Texture, Proximity Match), Clone Stamp, Smear (Liquify, Blur, Smudge), Gradient with Photoshop's presets, Shape, Type on the canvas, Eyedropper, Hand, Zoom — with Photoshop's modifiers (Space pans, Shift-click lines, Alt samples, Shift/Alt constrain, Ctrl-click auto-select, Alt-drag duplicate).
- **Selections** — marching ants, add and subtract with Shift and Alt, Layer via Copy / Cut, layer mask from selection, inverse, deselect, fill and clear.
- **Files** — `.comp` projects shared with the Mac app, images by drag & drop, paste from anywhere, export PNG and JPEG, several documents open at once.
- **Omarchy** — the palette follows your active theme within seconds; Dark and Light are a menu away; the window behaves like Omarchy's other apps.

The full feature list, keyboard reference, developer guide and packaging notes are in [`linux/README.md`](linux/README.md). What differs from the macOS app is in [`docs/omarchy-upgrades.md`](docs/omarchy-upgrades.md); the versioned changelog is [`docs/linux-changelog.md`](docs/linux-changelog.md).

## The macOS original

Compositor was created by [Robbie Tilton](https://github.com/robbietilton/Compositor) as a native Swift and Metal app for macOS ([robbietilton.com/compositor](https://robbietilton.com/compositor)). This repository is about the Linux port; for the Mac app, its features and how to build it, see Robbie's repository.

## License

MIT — see [LICENSE](LICENSE). The original app and the Linux port are both MIT licensed; the original copyright belongs to Wonder Assembly LLC.

## Credits

- **Compositor for macOS**, the original app: [Robbie Tilton](https://github.com/robbietilton/Compositor) (Wonder Assembly LLC), [robbietilton.com/compositor](https://robbietilton.com/compositor). The app icon is his.
- **Linux port:** Ruben Garcia Jr.
- **Omarchy** by DHH and contributors, whose theme palette and desktop conventions the port follows.
- **Screenshot artwork:** the mountain landscape behind the logo is by the author of the r/omarchy post ["I made a theme, check it out"](https://www.reddit.com/r/omarchy/comments/1ojp8ms/i_made_a_theme_check_it_out/); all credit to them.
