/**
 * Where a project lives on disk, and how to notice when something else changes it.
 *
 * Compositor 1.3 lets any script or AI agent build a project while it is open: the app watches
 * the package and reloads. On Linux a project can be a `.comp` ZIP file (what File › Save
 * writes) or a `.comp` **folder** with `manifest.json` + `images/`, the layout the macOS app and
 * agents write. Each source can read the package's files and produce a cheap fingerprint of
 * its on-disk state; the App polls that fingerprint and reloads when it changes.
 */
import { readZip } from "./zip";

export interface ProjectSource {
  /** Shown in the status bar / title. */
  label: string;
  /** "zip" (a .comp file), "folder" (a package directory), or "url" (a file:// folder from the launcher). */
  kind: "zip" | "folder" | "url";
  /** A string that changes whenever the package changes on disk; null when it cannot be read. */
  fingerprint(): Promise<string | null>;
  /** Read `manifest.json` or `images/<file>`; null when missing. */
  read(path: string): Promise<Uint8Array | null>;
  /** Write the package (folder and zip-file sources); absent for read-only sources. */
  write?(entries: { name: string; data: Uint8Array }[]): Promise<void>;
}

type DirHandle = FileSystemDirectoryHandle & {
  values(): AsyncIterableIterator<FileSystemHandle>;
  removeEntry(name: string): Promise<void>;
};

/** A `.comp` ZIP file reached through the File System Access API. */
export function zipFileSource(handle: FileSystemFileHandle): ProjectSource {
  let cached: { stamp: string; files: Map<string, Uint8Array>; prefix: string } | null = null;
  const load = async () => {
    const file = await handle.getFile();
    const stamp = `${file.lastModified}:${file.size}`;
    if (cached?.stamp !== stamp) {
      const files = await readZip(await file.arrayBuffer());
      const prefix = [...files.keys()].find((k) => k.endsWith("manifest.json"))?.replace(/manifest\.json$/, "") ?? "";
      cached = { stamp, files, prefix };
    }
    return cached;
  };
  return {
    label: handle.name,
    kind: "zip",
    async fingerprint() {
      try { const f = await handle.getFile(); return `${f.lastModified}:${f.size}`; } catch { return null; }
    },
    async read(path) { const c = await load(); return c.files.get(`${c.prefix}${path}`) ?? null; },
    async write(entries) {
      const { writeZip } = await import("./zip");
      const w = await handle.createWritable();
      await w.write(writeZip(entries));
      await w.close();
      cached = null;
    },
  };
}

/** A `.comp` package folder reached through the File System Access API (read and write). */
export function folderSource(dir: FileSystemDirectoryHandle): ProjectSource {
  const d = dir as DirHandle;
  const fileIn = async (path: string): Promise<File | null> => {
    try {
      const parts = path.split("/");
      let cur: FileSystemDirectoryHandle = d;
      for (const p of parts.slice(0, -1)) cur = await cur.getDirectoryHandle(p);
      return await (await cur.getFileHandle(parts[parts.length - 1])).getFile();
    } catch { return null; }
  };
  return {
    label: dir.name,
    kind: "folder",
    async fingerprint() {
      // Manifest contents plus every image's name, size and modification time, like the Mac app.
      const m = await fileIn("manifest.json");
      if (!m) return null;
      const parts = [await m.text()];
      try {
        const images = await d.getDirectoryHandle("images");
        for await (const h of (images as DirHandle).values()) {
          if (h.kind !== "file") continue;
          const f = await (h as FileSystemFileHandle).getFile();
          parts.push(`${h.name}:${f.size}:${f.lastModified}`);
        }
      } catch { /* no images/ yet */ }
      return parts.join("\n");
    },
    async read(path) { const f = await fileIn(path); return f ? new Uint8Array(await f.arrayBuffer()) : null; },
    async write(entries) {
      // Images first, manifest last, so a reader never sees a manifest naming a missing image.
      const images = await d.getDirectoryHandle("images", { create: true });
      const keep = new Set<string>();
      for (const e of entries) {
        if (!e.name.startsWith("images/")) continue;
        const name = e.name.slice("images/".length);
        keep.add(name);
        const w = await (await images.getFileHandle(name, { create: true })).createWritable();
        await w.write(e.data as BlobPart);
        await w.close();
      }
      for await (const h of (images as DirHandle).values()) {
        if (h.kind === "file" && !keep.has(h.name)) await (images as DirHandle).removeEntry(h.name);
      }
      const manifest = entries.find((e) => e.name === "manifest.json")!;
      const w = await (await d.getFileHandle("manifest.json", { create: true })).createWritable();
      await w.write(manifest.data as BlobPart);
      await w.close();
    },
  };
}

/** A package folder given as a URL (the launcher passes `file:///…/Name.comp/`); read-only. */
export function urlFolderSource(base: string): ProjectSource {
  const root = base.endsWith("/") ? base : `${base}/`;
  const get = async (path: string) => {
    const r = await fetch(root + path, { cache: "no-store" });
    return r.ok ? r : null;
  };
  return {
    label: decodeURIComponent(root.split("/").filter(Boolean).pop() ?? "Project.comp"),
    kind: "url",
    async fingerprint() {
      // The manifest is rewritten after every change (see docs/writing-comp-files.md), so its text is the state.
      try { const r = await get("manifest.json"); return r ? await r.text() : null; } catch { return null; }
    },
    async read(path) {
      try { const r = await get(path); return r ? new Uint8Array(await r.arrayBuffer()) : null; } catch { return null; }
    },
  };
}

/** An in-memory package (tests and previews). Mutate `files` and the fingerprint follows. */
export function memorySource(files: Map<string, Uint8Array>, label = "memory.comp"): ProjectSource {
  return {
    label,
    kind: "folder",
    async fingerprint() {
      return [...files.entries()].map(([k, v]) => `${k}:${v.length}:${k === "manifest.json" ? new TextDecoder().decode(v) : ""}`).join("\n");
    },
    async read(path) { return files.get(path) ?? null; },
    async write(entries) { files.clear(); for (const e of entries) files.set(e.name, e.data); },
  };
}
