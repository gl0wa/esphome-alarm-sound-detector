// Preset studio: home screen with two modes (ready-made preset / create a preset).
import "./style.css";
import { initWasm } from "./dsp";
import { h, note } from "./helpers";
import { clearSession, freshState, loadSession, peekSession, saveSession, uid } from "./store";
import { sessionStatusElement, setSessionStatus } from "./session";
import { renderUsePreset } from "./views/usePreset";
import { getCreateStep, renderCreate, setCreateStep } from "./views/createPreset";
import { renderHome } from "./views/home";
import { DeviceSettings, loadDeviceSettings, loadMode, saveMode, StudioMode } from "./device";
import { validateCaptureClips } from "./importClips";

const s = freshState();
const dev: DeviceSettings = loadDeviceSettings();
let mode: StudioMode = loadMode();

async function boot() {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  const header = h("header", "", app);
  const titleRow = h("div", "title-row", header);
  const title = h("h1", "home-link", titleRow, "Preset studio") as HTMLElement;
  title.title = "Back to the home screen";
  title.onclick = () => { setMode("home"); };
  const themeBtn = h("button", "theme-toggle", titleRow);
  const isLight = () => document.documentElement.dataset.theme === "light";
  const themeLabel = () => {
    themeBtn.textContent = isLight() ? "☾" : "☀";
    themeBtn.title = isLight() ? "Switch to dark theme" : "Switch to light theme";
    themeBtn.setAttribute("aria-label", themeBtn.title);
  };
  themeLabel();
  h("p", "muted", header, "Teach the alarm detector a new appliance sound. All processing happens on your device — audio never leaves this page.");
  const banner = h("div", "", app);
  const main = h("main", "", app);
  const foot = h("footer", "muted", app,
    "Static site, no tracking, no uploads. The DSP is the firmware code (detector_core.cpp) compiled to WebAssembly.");

  const statusRow = h("div", "status-row", app);
  const status = h("span", "muted", statusRow, "Loading the detector (WebAssembly)…");
  void foot;
  statusRow.appendChild(sessionStatusElement());

  const setMode = (m: StudioMode) => {
    mode = m;
    saveMode(m);
    render();
  };

  const render = () => {
    main.innerHTML = "";
    const wrap = h("section", "", main);
    const refresh = () => render();
    try {
      if (mode === "home") {
        renderHome(wrap, (m) => setMode(m));
      } else if (mode === "use") {
        const back = h("div", "row", wrap);
        const b = h("button", "secondary", back, "← Home");
        b.onclick = () => setMode("home");
        const body = h("div", "", wrap);
        renderUsePreset(body, dev, refresh);
      } else {
        const back = h("div", "row", wrap);
        const b = h("button", "secondary", back, "← Home");
        b.onclick = () => setMode("home");
        const body = h("div", "", wrap);
        renderCreate(body, s, dev, { refresh, rerenderCreate: () => render() });
      }
      autosave.schedule();
    } catch (e) {
      note(wrap, `Something went wrong: ${e}`);
    }
    void getCreateStep;
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
    setupImport(banner, () => {
      setCreateStep(2);
      setMode("create");
    });
    await offerRestore(banner, render);
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
  if (!saved || !saved.recordings) {
    // No session: show the home screen.
    mode = "home";
    saveMode(mode);
    render();
    autosave.enable(true);
    return;
  }
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
      mode = "create";
      saveMode(mode);
      setCreateStep(2);
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
  const onNewWork = () => {
    if (!box.isConnected || !s.recordings.length) return;
    box.remove();
    autosave.enable(true);
    autosave.schedule();
  };
  document.addEventListener("click", () => setTimeout(onNewWork, 0));
  document.addEventListener("change", () => setTimeout(onNewWork, 0));
}

/** Listen for clips posted by the temporary recording firmware page (#import + opener). */
function setupImport(banner: HTMLElement, onImported: () => void) {
  if (!window.location.hash.includes("import") || !window.opener) return;
  const READY = { type: "asd-studio-ready", version: 1 };
  const sendReady = () => {
    try { (window.opener as Window).postMessage(READY, "*"); } catch { /* ignore */ }
  };
  sendReady();
  const timer = window.setInterval(sendReady, 500);
  window.setTimeout(() => window.clearInterval(timer), 15000);

  window.addEventListener("message", (ev) => {
    if (ev.source !== window.opener) return;
    const res = validateCaptureClips(ev.data);
    if (!res.ok) return;
    window.clearInterval(timer);
    const { deviceName, friendlyName, clips } = res.value;
    const box = h("div", "restore-banner", banner);
    h("strong", "", box, `Import ${clips.length} clip(s) from ${friendlyName}?`);
    const row = h("div", "row", box);
    const imp = h("button", "primary", row, "Import");
    const ign = h("button", "", row, "Ignore");
    imp.onclick = () => {
      for (const c of clips) {
        s.recordings.push({ id: uid(), name: `${friendlyName} · ${c.name}`, pcm: new Int16Array(c.pcm.slice(0)) });
      }
      try { (ev.source as Window).postMessage({ type: "asd-capture-received", version: 1, count: clips.length }, "*"); } catch { /* ignore */ }
      box.remove();
      setSessionStatus(`Imported ${clips.length} clip(s) from ${deviceName}.`);
      onImported();
    };
    ign.onclick = () => box.remove();
  });
}
