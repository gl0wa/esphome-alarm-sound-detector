// Preset studio: teach the alarm detector a new appliance sound, in the browser.
import "./style.css";
import { initWasm } from "./dsp";
import { h, note, stepNav } from "./helpers";
import { clearSession, freshState, loadSession, peekSession, saveSession } from "./store";
import { sessionStatusElement, setSessionStatus } from "./session";
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
  const titleRow = h("div", "title-row", header);
  h("h1", "", titleRow, "Preset studio");
  const themeBtn = h("button", "theme-toggle", titleRow);
  const isLight = () => document.documentElement.dataset.theme === "light";
  const themeLabel = () => {
    themeBtn.textContent = isLight() ? "☾" : "☀";
    themeBtn.title = isLight() ? "Switch to dark theme" : "Switch to light theme";
    themeBtn.setAttribute("aria-label", themeBtn.title);
  };
  themeLabel();
  h("p", "muted", header, "Teach the alarm detector a new appliance sound. All processing happens on your device — audio never leaves this page.");
  const nav = h("nav", "tabs", app);
  const statusRow = h("div", "status-row", app);
  const status = h("span", "muted", statusRow, "Loading the detector (WebAssembly)…");
  statusRow.appendChild(sessionStatusElement());
  const banner = h("div", "", app);
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
    const go = (i: number) => { current = i; render(); window.scrollTo({ top: 0, behavior: "smooth" }); };
    try {
      if (current === 0) renderRecordings(wrap, s, { refresh });
      else if (current === 1) renderExamples(wrap, s, refresh);
      else if (current === 2) renderBuild(wrap, s, refresh);
      else if (current === 3) renderEvaluate(wrap, s, refresh);
      else renderExport(wrap, s, refresh);
      const blocked = [
        !s.recordings.length ? "Load a recording first." : !s.examples.length ? "Mark at least one example first." : undefined,
        !s.examples.length ? "Mark or accept at least one example first." : undefined,
        !s.template ? "Build the template first." : undefined,
        undefined,
      ][current];
      autosave.schedule();
      stepNav(wrap, {
        back: current > 0 ? { label: steps[current - 1], go: () => go(current - 1) } : undefined,
        next: current < steps.length - 1 ? { label: `Next: ${steps[current + 1]}`, go: () => go(current + 1), blockedReason: blocked } : undefined,
      });
    } catch (e) {
      note(wrap, `Something went wrong: ${e}`);
    }
  };

  try {
    await initWasm();
    status.textContent = `Detector ready (16 kHz, firmware DSP in WebAssembly).`;
    themeBtn.onclick = () => {
      if (isLight()) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = "light";
      try { localStorage.setItem("theme", isLight() ? "light" : "dark"); } catch { /* noop */ }
      themeLabel();
      render();
    };
    render();
    await offerRestore(banner, render);
    // Changes that don't re-render (typing in forms) also trigger a save.
    document.addEventListener("change", () => autosave.schedule());
  } catch (e) {
    status.textContent = `Could not start the detector: ${e}`;
  }
}

if ((localStorage.getItem("theme") ?? "dark") === "light") {
  document.documentElement.dataset.theme = "light";
}

void boot();


/** Debounced automatic saving to IndexedDB. Paused until the user has answered the
 *  restore prompt, so an empty page never overwrites a saved session by accident. */
const autosave = (() => {
  let timer = 0, enabled = false, pendingFresh = false;
  const run = async () => {
    if (!enabled) return;
    if (pendingFresh && !s.recordings.length) return; // nothing worth saving yet
    try {
      await saveSession(s);
      setSessionStatus(`Saved in this browser ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    } catch (e) {
      setSessionStatus(`Not saved: ${e instanceof Error ? e.message : e} (private browsing or storage full?)`, true);
    }
  };
  return {
    schedule() { clearTimeout(timer); timer = window.setTimeout(run, 800); },
    enable(fresh = false) { enabled = true; pendingFresh = fresh; },
  };
})();

async function offerRestore(banner: HTMLElement, render: () => void) {
  let saved = null;
  try { saved = await peekSession(); } catch { /* IndexedDB unavailable */ }
  if (!saved || !saved.recordings) { autosave.enable(true); return; }
  const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString() : "earlier";
  const box = h("div", "restore-banner", banner);
  h("strong", "", box, "Continue where you left off?");
  h("span", "", box, ` Saved ${when}: ${saved.recordings} recording(s), ${saved.examples} example(s)${saved.hasTemplate ? ", built template" : ""}.`);
  const row = h("div", "row", box);
  const cont = h("button", "primary", row, "Continue session");
  const fresh = h("button", "", row, "Start fresh");
  h("span", "muted", box, "Loading new recordings without choosing also starts fresh and replaces the saved session.");
  cont.onclick = async () => {
    cont.disabled = true;
    try {
      const msg = await loadSession(s);
      box.remove();
      autosave.enable();
      setSessionStatus(msg);
      render();
    } catch (e) {
      cont.disabled = false;
      setSessionStatus(`Could not restore: ${e}`, true);
    }
  };
  fresh.onclick = async () => {
    try { await clearSession(); } catch { /* ignore */ }
    box.remove();
    autosave.enable(true);
    setSessionStatus("Started a new session.");
  };
  // Starting new work without answering = start fresh.
  const onNewWork = () => {
    if (!box.isConnected || !s.recordings.length) return;
    box.remove();
    autosave.enable(true);
    autosave.schedule();
  };
  document.addEventListener("click", () => setTimeout(onNewWork, 0));
  document.addEventListener("change", () => setTimeout(onNewWork, 0));
}
