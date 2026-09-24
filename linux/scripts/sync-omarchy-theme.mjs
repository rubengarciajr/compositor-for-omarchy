#!/usr/bin/env node
/**
 * Sync an Omarchy theme (colors.toml) into the Compositor web app for development.
 *
 * The packaged app does not need this: `scripts/compositor` points the page at the
 * live palette directly. The Vite dev server, however, can only serve files under
 * the project, so this copies the palette into public/ where `./omarchy-theme.json`
 * and `./colors.toml` resolve.
 *
 * Omarchy keeps the active theme at:
 *   ~/.local/state/omarchy/current/theme/colors.toml   (name in …/current/theme.name)
 * Themes live at ~/.config/omarchy/themes/<name>/ and /usr/share/omarchy/themes/<name>/.
 *
 * Usage:
 *   node scripts/sync-omarchy-theme.mjs                 # active theme → public/
 *   node scripts/sync-omarchy-theme.mjs --theme gruvbox # a specific theme
 *   node scripts/sync-omarchy-theme.mjs --watch         # keep public/ in sync while switching themes
 *   node scripts/sync-omarchy-theme.mjs --out DIR
 */

import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const publicDir = join(root, "public");

const home = homedir();
const stateHome = process.env.XDG_STATE_HOME || join(home, ".local/state");
const omarchyPath = process.env.OMARCHY_PATH || "/usr/share/omarchy";
const currentDir = join(stateHome, "omarchy/current");
const currentColors = join(currentDir, "theme/colors.toml");

function parseArgs(argv) {
  const args = { theme: null, watch: false, out: publicDir };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--theme") args.theme = argv[++i];
    else if (a.startsWith("--theme=")) args.theme = a.slice(8);
    else if (a === "--watch") args.watch = true;
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: sync-omarchy-theme.mjs [--theme NAME] [--watch] [--out DIR]");
      process.exit(0);
    }
  }
  return args;
}

const DEFAULTS = {
  mode: "dark",
  accent: "#7aa2f7",
  selection: "#292e42",
  muted: "#414868",
  background: "#1a1b26",
  dark_background: "#13141c",
  darker_background: "#0e0e14",
  lighter_background: "#24283b",
  foreground: "#a9b1d6",
  dark_foreground: "#565f89",
  light_foreground: "#b4bee6",
  bright_foreground: "#c0caf5",
  red: "#f7768e",
  yellow: "#e0af68",
  orange: "#eb927b",
  green: "#9ece6a",
  cyan: "#449dab",
  blue: "#7aa2f7",
  magenta: "#ad8ee6",
  brown: "#75493d",
  bright_red: "#ff7a93",
  bright_yellow: "#ff9e64",
  bright_green: "#b9f27c",
  bright_cyan: "#0db9d7",
  bright_blue: "#7da6ff",
  bright_magenta: "#bb9af7",
};

export function parseColorsToml(text) {
  const palette = { ...DEFAULTS };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.indexOf(" #");
    if (hash > 0) value = value.slice(0, hash).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === "mode" || key === "theme_type") palette.mode = value === "light" ? "light" : "dark";
    else if (key in palette && /^#[0-9a-f]{6}$/i.test(value)) palette[key] = value.toLowerCase();
  }
  return palette;
}

function currentThemeName() {
  try {
    return readFileSync(join(currentDir, "theme.name"), "utf8").trim();
  } catch {
    return null;
  }
}

function resolveTheme(themeName) {
  if (themeName) {
    const slug = themeName.toLowerCase().replace(/\s+/g, "-");
    for (const dir of [join(home, ".config/omarchy/themes", slug), join(omarchyPath, "themes", slug)]) {
      const p = join(dir, "colors.toml");
      if (existsSync(p)) return { path: p, name: slug };
    }
    return null;
  }
  if (existsSync(currentColors)) return { path: currentColors, name: currentThemeName() ?? "current" };
  const fallback = join(omarchyPath, "themes/tokyo-night/colors.toml");
  if (existsSync(fallback)) return { path: fallback, name: "tokyo-night" };
  return null;
}

function syncOnce(themeName, outDir) {
  const theme = resolveTheme(themeName);
  mkdirSync(outDir, { recursive: true });
  if (!theme) {
    console.error(
      themeName
        ? `Theme "${themeName}" not found in ~/.config/omarchy/themes or ${omarchyPath}/themes.`
        : "No Omarchy colors.toml found — the app will use its built-in Tokyo Night fallback.",
    );
    return null;
  }
  const text = readFileSync(theme.path, "utf8");
  const colors = parseColorsToml(text);
  const payload = { source: "omarchy", theme: theme.name, path: theme.path, syncedAt: new Date().toISOString(), colors };
  writeFileSync(join(outDir, "omarchy-theme.json"), JSON.stringify(payload, null, 2));
  writeFileSync(join(outDir, "colors.toml"), text);
  console.log(`Synced Omarchy theme "${theme.name}" from ${theme.path}`);
  console.log(`  accent=${colors.accent} bg=${colors.background} mode=${colors.mode}`);
  return theme;
}

const args = parseArgs(process.argv.slice(2));
syncOnce(args.theme, args.out);

if (args.watch) {
  // omarchy-theme-set rebuilds current/theme atomically, so watch the parent directory.
  const dir = args.theme ? dirname(resolveTheme(args.theme)?.path ?? currentColors) : currentDir;
  if (!existsSync(dir)) {
    console.error(`Cannot watch ${dir}: it does not exist.`);
    process.exit(1);
  }
  console.log(`Watching ${dir} for theme changes…`);
  let timer = null;
  watch(dir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => syncOnce(args.theme, args.out), 250);
  });
}
