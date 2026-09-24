#!/usr/bin/env node
/**
 * Build-output smoke test: loads dist/index.html?selftest=1 in headless Chromium the way the
 * launcher does (file:// + --allow-file-access-from-files), then polls the page over the
 * DevTools protocol until src/selftest.ts reports it is done.
 *
 *   npm test            (after `npm run build`)
 *   npm run check       (build + test)
 *
 * Skips with exit 0 when no Chromium-based browser is installed (e.g. a clean build box).
 * (Why not --dump-dom: it fires at load, before the async self-test; --virtual-time-budget
 * stalls on image decoding, which the project round trip needs.)
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const index = join(root, "dist", "index.html");
if (!existsSync(index)) {
  console.error("dist/index.html missing — run `npm run build` first.");
  process.exit(1);
}

const candidates = [process.env.COMPOSITOR_BROWSER, "chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "brave"].filter(Boolean);
let browser = null;
for (const c of candidates) {
  try {
    execFileSync("sh", ["-c", `command -v ${c}`], { stdio: "ignore" });
    browser = c;
    break;
  } catch {
    /* next */
  }
}
if (!browser) {
  console.warn("No Chromium-based browser found; skipping smoke test.");
  process.exit(0);
}

const TIMEOUT_MS = 90_000;
const profile = mkdtempSync(join(tmpdir(), "compositor-smoke-"));
const url = `file://${index}?selftest=1&theme=dark`;
const child = spawn(browser, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
  `--user-data-dir=${profile}`, "--allow-file-access-from-files",
  "--remote-debugging-port=0", url,
], { stdio: ["ignore", "ignore", "pipe"] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = () => {
  try { child.kill("SIGKILL"); } catch { /* gone */ }
  rmSync(profile, { recursive: true, force: true });
};

function devtoolsPort() {
  return new Promise((resolvePort, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { child.stderr.off("data", onData); resolvePort(Number(m[1])); }
    };
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`Chromium exited early (code ${code})\n${buf.slice(-800)}`)));
    setTimeout(() => reject(new Error("Chromium did not expose DevTools in time")), 30_000);
  });
}

async function pageSocket(port) {
  for (let i = 0; i < 100; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
    const page = list.find((t) => t.type === "page" && t.url.startsWith("file://"));
    if (page) return page.webSocketDebuggerUrl;
    await sleep(200);
  }
  throw new Error("App page did not appear in DevTools targets");
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  return (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
}

(async () => {
  const port = await devtoolsPort();
  const wsUrl = await pageSocket(port);
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  const send = cdp(ws);
  const expr = `(() => { const p = document.getElementById("selftest"); return p ? JSON.stringify({ done: p.dataset.done === "1", text: p.textContent }) : null; })()`;
  const started = Date.now();
  let state = null;
  while (Date.now() - started < TIMEOUT_MS) {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    const v = r.result?.result?.value;
    if (v) {
      state = JSON.parse(v);
      if (state.done) break;
    }
    await sleep(250);
  }
  ws.close();
  cleanup();
  if (!state) {
    console.error("Self-test did not start (no #selftest element). Did the app boot?");
    process.exit(1);
  }
  const results = JSON.parse(state.text || "[]");
  if (!state.done) console.error(`Self-test did not finish within ${TIMEOUT_MS / 1000}s; results so far:`);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  → ${r.detail}`}`);
    if (!r.pass) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed${state.done ? "" : " (incomplete)"}`);
  process.exit(failed || !state.done ? 1 : 0);
})().catch((err) => {
  cleanup();
  console.error(err.message ?? err);
  process.exit(1);
});
