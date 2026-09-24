/**
 * Omarchy theme bridge.
 * Reads the active Omarchy `colors.toml` and maps it onto CSS custom properties.
 *
 * Resolution order:
 *  1. `?theme=<builtin>` query or the `compositor.theme` localStorage key (View › Theme menu)
 *  2. `?colors=<url>` — the launcher passes the live Omarchy palette,
 *     `file://~/.local/state/omarchy/current/theme/colors.toml`, and it is re-read every few seconds
 *  3. `./omarchy-theme.json` written by `scripts/sync-omarchy-theme.mjs` (dev server)
 *  4. `./colors.toml` next to the app
 *  5. Bundled Tokyo Night fallback (Omarchy's signature palette)
 */

export interface OmarchyPalette {
  mode: "dark" | "light";
  accent: string;
  selection: string;
  muted: string;
  background: string;
  dark_background: string;
  darker_background: string;
  lighter_background: string;
  foreground: string;
  dark_foreground: string;
  light_foreground: string;
  bright_foreground: string;
  red: string;
  yellow: string;
  orange: string;
  green: string;
  cyan: string;
  blue: string;
  magenta: string;
  brown: string;
  bright_red: string;
  bright_yellow: string;
  bright_green: string;
  bright_cyan: string;
  bright_blue: string;
  bright_magenta: string;
}

export const TOKYO_NIGHT: OmarchyPalette = {
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

export const CATPPUCCIN: OmarchyPalette = {
  mode: "dark",
  accent: "#89b4fa",
  selection: "#45475a",
  muted: "#585b70",
  background: "#1e1e2e",
  dark_background: "#161622",
  darker_background: "#101019",
  lighter_background: "#313244",
  foreground: "#cdd6f4",
  dark_foreground: "#6c7086",
  light_foreground: "#bac2de",
  bright_foreground: "#cdd6f4",
  red: "#f38ba8",
  yellow: "#f9e2af",
  orange: "#f6b6ab",
  green: "#a6e3a1",
  cyan: "#94e2d5",
  blue: "#89b4fa",
  magenta: "#f5c2e7",
  brown: "#7b5b55",
  bright_red: "#f38ba8",
  bright_yellow: "#f9e2af",
  bright_green: "#a6e3a1",
  bright_cyan: "#94e2d5",
  bright_blue: "#89b4fa",
  bright_magenta: "#f5c2e7",
};

export const LIGHT: OmarchyPalette = {
  mode: "light",
  accent: "#1e66f5",
  selection: "#ccd0da",
  muted: "#acb0be",
  background: "#eff1f5",
  dark_background: "#e3e4e8",
  darker_background: "#d7d8dc",
  lighter_background: "#dce0e8",
  foreground: "#4c4f69",
  dark_foreground: "#9ca0b0",
  light_foreground: "#5c5f77",
  bright_foreground: "#4c4f69",
  red: "#d20f39",
  yellow: "#df8e1d",
  orange: "#d84e2b",
  green: "#40a02b",
  cyan: "#179299",
  blue: "#1e66f5",
  magenta: "#ea76cb",
  brown: "#6c2715",
  bright_red: "#d20f39",
  bright_yellow: "#df8e1d",
  bright_green: "#40a02b",
  bright_cyan: "#179299",
  bright_blue: "#1e66f5",
  bright_magenta: "#ea76cb",
};

/** The three choices offered in View › Theme. "omarchy" follows the desktop palette live. */
export type ThemeChoice = "omarchy" | "dark" | "light";
export const THEME_CHOICES: { id: ThemeChoice; label: string }[] = [
  { id: "omarchy", label: "Omarchy" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
];

export const BUILTIN_THEMES: Record<string, { label: string; palette: OmarchyPalette }> = {
  dark: { label: "Dark", palette: TOKYO_NIGHT },
  light: { label: "Light", palette: LIGHT },
  // older names still accepted on the command line
  "tokyo-night": { label: "Dark", palette: TOKYO_NIGHT },
  tokyonight: { label: "Dark", palette: TOKYO_NIGHT },
  catppuccin: { label: "Dark", palette: CATPPUCCIN },
  "catppuccin-latte": { label: "Light", palette: LIGHT },
};

const PREF_KEY = "compositor.theme";

/** The remembered View › Theme choice (default: follow Omarchy). */
export function getThemePreference(): ThemeChoice {
  try {
    const v = (localStorage.getItem(PREF_KEY) ?? "").toLowerCase();
    if (v === "dark" || v === "light" || v === "omarchy") return v;
    if (v === "tokyo-night" || v === "tokyonight" || v === "catppuccin") return "dark"; // legacy values
  } catch { /* storage unavailable */ }
  return "omarchy";
}

export function setThemePreference(choice: ThemeChoice): void {
  try {
    localStorage.setItem(PREF_KEY, choice);
  } catch { /* storage unavailable */ }
}

const KEYS: (keyof OmarchyPalette)[] = [
  "mode", "accent", "selection", "muted",
  "background", "dark_background", "darker_background", "lighter_background",
  "foreground", "dark_foreground", "light_foreground", "bright_foreground",
  "red", "yellow", "orange", "green", "cyan", "blue", "magenta", "brown",
  "bright_red", "bright_yellow", "bright_green", "bright_cyan", "bright_blue", "bright_magenta",
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Minimal TOML subset parser for Omarchy `colors.toml` (`key = "#rrggbb"`). */
export function parseColorsToml(text: string): { palette: OmarchyPalette; found: number } {
  const palette = { ...TOKYO_NIGHT } as OmarchyPalette;
  let found = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const hash = value.indexOf(" #");
    if (hash > 0) value = value.slice(0, hash).trim(); // trailing comment
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "mode" || key === "theme_type") {
      palette.mode = value === "light" ? "light" : "dark";
      found++;
      continue;
    }
    if ((KEYS as string[]).includes(key) && HEX.test(value)) {
      (palette as unknown as Record<string, unknown>)[key] = value.toLowerCase();
      found++;
    }
  }
  return { palette, found };
}

function isPalette(x: unknown): x is OmarchyPalette {
  return !!x && typeof x === "object" && HEX.test(String((x as OmarchyPalette).background ?? ""));
}

export function applyPalette(root: HTMLElement, p: OmarchyPalette): void {
  const s = root.style;
  const set = (name: string, value: string) => s.setProperty(name, value);

  set("--bg", p.background);
  set("--bg-dark", p.dark_background);
  set("--bg-darker", p.darker_background);
  set("--bg-light", p.lighter_background);
  set("--fg", p.foreground);
  set("--fg-dark", p.dark_foreground);
  set("--fg-light", p.light_foreground);
  set("--fg-bright", p.bright_foreground);
  set("--accent", p.accent);
  set("--selection", p.selection);
  set("--muted", p.muted);

  set("--red", p.red);
  set("--yellow", p.yellow);
  set("--orange", p.orange);
  set("--green", p.green);
  set("--cyan", p.cyan);
  set("--blue", p.blue);
  set("--magenta", p.magenta);
  set("--brown", p.brown);
  set("--bright-red", p.bright_red);
  set("--bright-yellow", p.bright_yellow);
  set("--bright-green", p.bright_green);
  set("--bright-cyan", p.bright_cyan);
  set("--bright-blue", p.bright_blue);
  set("--bright-magenta", p.bright_magenta);

  // UI derived tokens — Omarchy-soft chrome
  const light = p.mode === "light";
  set("--panel", light ? p.lighter_background : p.dark_background);
  set("--panel-raised", light ? p.background : p.lighter_background);
  set("--border", p.muted);
  set("--hover", p.selection);
  set("--canvas-chrome", p.darker_background);
  set("--shadow", light ? "rgba(0,0,0,0.12)" : "rgba(0,0,0,0.45)");
  root.dataset.themeMode = p.mode;
}

export interface ThemeSource {
  kind: "builtin" | "colors" | "json";
  /** URL polled for live updates (colors/json kinds). */
  url?: string;
  label: string;
}

export interface LoadedTheme {
  palette: OmarchyPalette;
  source: ThemeSource;
}

async function fetchColors(url: string): Promise<OmarchyPalette | null> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.trimStart().startsWith("<")) return null; // an HTML fallback page, not a palette
  const { palette, found } = parseColorsToml(text);
  return found >= 4 ? palette : null;
}

async function fetchJson(url: string): Promise<OmarchyPalette | null> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trimStart().startsWith("{")) return null;
  const data = JSON.parse(text) as { colors?: unknown };
  return isPalette(data.colors) ? data.colors : null;
}

/** Palette for the given choice: a built-in, or whatever Omarchy source is available. */
export async function loadOmarchyPalette(choice: ThemeChoice = getThemePreference()): Promise<LoadedTheme> {
  const params = new URLSearchParams(location.search);
  const urlTheme = (params.get("theme") ?? "").toLowerCase();
  const builtin = BUILTIN_THEMES[choice] ?? BUILTIN_THEMES[urlTheme];
  if (builtin) {
    return { palette: builtin.palette, source: { kind: "builtin", label: `Built-in · ${builtin.label}` } };
  }

  const colorsUrl = params.get("colors");
  if (colorsUrl) {
    try {
      const palette = await fetchColors(colorsUrl);
      if (palette) return { palette, source: { kind: "colors", url: colorsUrl, label: "Omarchy theme" } };
    } catch {
      /* fall through */
    }
  }

  for (const [url, kind] of [["./omarchy-theme.json", "json"], ["./colors.toml", "colors"]] as const) {
    try {
      const palette = kind === "json" ? await fetchJson(url) : await fetchColors(url);
      if (palette) return { palette, source: { kind, url, label: "Omarchy theme" } };
    } catch {
      /* not synced */
    }
  }

  return { palette: TOKYO_NIGHT, source: { kind: "builtin", label: "Fallback · Tokyo Night" } };
}

/* ── Theme controller: one place that applies a choice and keeps the live watcher ── */
let currentChoice: ThemeChoice = "omarchy";
let stopWatching: () => void = () => {};
let onApplied: (theme: LoadedTheme) => void = () => {};

export function themeChoice(): ThemeChoice {
  return currentChoice;
}

/** Apply a View › Theme choice now, remember it, and follow the desktop only for "omarchy". */
export async function applyThemeChoice(choice: ThemeChoice, remember = true): Promise<LoadedTheme> {
  currentChoice = choice;
  if (remember) setThemePreference(choice);
  stopWatching();
  const theme = await loadOmarchyPalette(choice);
  applyPalette(document.documentElement, theme.palette);
  document.documentElement.dataset.themeSource = theme.source.kind;
  document.documentElement.dataset.themeChoice = choice;
  onApplied(theme);
  if (choice === "omarchy") {
    stopWatching = watchOmarchyTheme(theme, (p) => {
      applyPalette(document.documentElement, p);
      onApplied({ palette: p, source: theme.source });
    });
  } else {
    stopWatching = () => {};
  }
  return theme;
}

/** Boot: apply the remembered choice (or `?theme=` from the launcher) and register the redraw hook. */
export function initTheme(applied: (theme: LoadedTheme) => void): Promise<LoadedTheme> {
  onApplied = applied;
  const params = new URLSearchParams(location.search);
  const urlTheme = (params.get("theme") ?? "").toLowerCase();
  const fromUrl: ThemeChoice | null = urlTheme ? (BUILTIN_THEMES[urlTheme]?.label === "Light" ? "light" : BUILTIN_THEMES[urlTheme] ? "dark" : null) : null;
  return applyThemeChoice(fromUrl ?? getThemePreference(), false);
}

/** Re-read the palette source periodically and call `onChange` only when it actually changed. */
export function watchOmarchyTheme(
  theme: LoadedTheme,
  onChange: (p: OmarchyPalette) => void,
  intervalMs = 3000,
): () => void {
  const { source } = theme;
  if (source.kind === "builtin" || !source.url) return () => {};
  let last = JSON.stringify(theme.palette);
  let alive = true;
  const tick = async () => {
    if (!alive) return;
    try {
      const palette = source.kind === "json" ? await fetchJson(source.url!) : await fetchColors(source.url!);
      if (!palette || !alive) return;
      const next = JSON.stringify(palette);
      if (next !== last) {
        last = next;
        onChange(palette);
      }
    } catch {
      /* ignore transient errors (theme switch mid-write) */
    }
  };
  const id = window.setInterval(tick, intervalMs);
  return () => {
    alive = false;
    clearInterval(id);
  };
}
