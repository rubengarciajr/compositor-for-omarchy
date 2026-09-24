import "./styles.css";
import { App } from "./core/session";
import { initTheme } from "./theme/omarchy";
import { mountUI, setThemeSourceLabel } from "./ui/shell";

async function boot(): Promise<void> {
  const host = document.getElementById("app");
  if (!host) throw new Error("#app missing");

  const app = new App();
  // Theme: the remembered View › Theme choice (Omarchy / Dark / Light); "Omarchy" follows the desktop live.
  await initTheme((theme) => {
    setThemeSourceLabel(theme.source.label);
    app.emitView();
  });
  mountUI(app, host);
  // Debug handle for the dev console (window.__compositor.newDocument(...), .docs, .session …).
  (window as unknown as { __compositor: App }).__compositor = app;

  // Files passed on the command line (`compositor photo.png`) arrive as ?open=file:///… entries.
  const params = new URLSearchParams(location.search);
  for (const url of params.getAll("open")) {
    try {
      await app.openImageUrl(url);
    } catch (err) {
      console.error(err);
    }
  }

  // Regression checks for `npm test` (scripts/smoke-test.mjs); see src/selftest.ts.
  if (params.has("selftest")) {
    const { runSelfTest } = await import("./selftest");
    const pre = document.createElement("pre");
    pre.id = "selftest";
    document.body.appendChild(pre);
    // Results are written as they arrive so a hang or a throw still shows how far the run got.
    const partial: unknown[] = [];
    const flush = (done: boolean, error?: unknown) => {
      pre.textContent = JSON.stringify(error ? [...partial, { name: "self-test crashed", pass: false, detail: String(error) }] : partial);
      pre.dataset.done = done ? "1" : "";
    };
    try {
      const results = await runSelfTest(app, (r) => { partial.push(r); flush(false); });
      flush(true);
      document.title = results.every((r) => r.pass) ? "SELFTEST PASS" : "SELFTEST FAIL";
    } catch (err) {
      flush(true, err);
      document.title = "SELFTEST FAIL";
    }
  }
}

void boot();
