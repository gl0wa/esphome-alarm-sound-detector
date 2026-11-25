// Preset studio: teach the alarm detector a new appliance sound, in the browser.
import "./style.css";
import { initWasm } from "./dsp";
import { h, note } from "./helpers";
import { freshState } from "./store";
import { renderBuild } from "./views/build";
import { renderEvaluate } from "./views/evaluate";
import { renderExamples } from "./views/examples";
import { renderExport } from "./views/exportView";
import { renderRecordings } from "./views/recordings";

const s = freshState();

const steps = ["Recordings", "Examples", "Build", "Evaluate", "Export"] as const;
let current = 0;

async function boot() {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  const header = h("header", "", app);
  h("h1", "", header, "Preset studio");
  h("p", "muted", header, "Teach the alarm detector a new appliance sound. All processing happens on your device — audio never leaves this page.");
  const nav = h("nav", "tabs", app);
  const status = h("p", "muted", app, "Loading the detector (WebAssembly)…");
  const main = h("main", "", app);
  const foot = h("footer", "muted", app,
    "Static site, no tracking, no uploads. The DSP is the firmware code (detector_core.cpp) compiled to WebAssembly.");

  const render = () => {
    nav.innerHTML = "";
    steps.forEach((name, i) => {
      const b = h("button", i === current ? "tab active" : "tab", nav, `${i + 1} · ${name}`);
      b.onclick = () => { current = i; render(); };
    });
    main.innerHTML = "";
    const wrap = h("section", "", main);
    const refresh = () => render();
    try {
      if (current === 0) renderRecordings(wrap, s, { refresh });
      else if (current === 1) renderExamples(wrap, s, refresh);
      else if (current === 2) renderBuild(wrap, s, refresh);
      else if (current === 3) renderEvaluate(wrap, s, refresh);
      else renderExport(wrap, s, refresh);
    } catch (e) {
      note(wrap, `Something went wrong: ${e}`);
    }
  };

  try {
    await initWasm();
    status.textContent = `Detector ready (16 kHz, firmware DSP in WebAssembly).`;
    const themeBtn = h("button", "theme", header, document.documentElement.dataset.theme === "light" ? "☾ dark" : "☀ light");
    themeBtn.onclick = () => {
      const d = document.documentElement.dataset.theme === "light" ? "" : "light";
      if (d) document.documentElement.dataset.theme = d;
      else delete document.documentElement.dataset.theme;
      try { localStorage.setItem("theme", d || "dark"); } catch { /* noop */ }
      themeBtn.textContent = d === "light" ? "☾ dark" : "☀ light";
      render();
    };
    render();
  } catch (e) {
    status.textContent = `Could not start the detector: ${e}`;
  }
}

if ((localStorage.getItem("theme") ?? "dark") === "light") {
  document.documentElement.dataset.theme = "light";
}

void boot();
