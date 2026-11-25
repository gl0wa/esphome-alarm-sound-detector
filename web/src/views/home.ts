// Home screen: a visual map of the three routes (ready-made preset; create a
// preset recorded with the device; create one from phone/laptop audio) with as
// little text as possible.
import { h } from "../helpers";
import { loadBundledIndex } from "../preset";

// Simple 24×24 line icons (stroke = currentColor).
const ICONS: Record<string, string> = {
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16"/>',
  flash: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/><path d="M12.5 8.5L10 12.5h4l-2.5 3.5"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3M14 21h1"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 15v-2M12 17v-6M15 15v-2"/>',
  mark: '<path d="M3 12h2l2-5 3 10 3-12 3 9 2-2h3"/>',
  build: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  test: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/><circle cx="12" cy="12" r="2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2"/>',
  agent: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12v1M15 12v1M9.5 16h5"/><path d="M2 12v3M22 12v3"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
};

function icon(parent: HTMLElement, name: string, cls = "ic"): HTMLElement {
  const span = h("span", cls, parent);
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

export function renderHome(root: HTMLElement, go: (m: "use" | "create", step?: number) => void) {
  root.innerHTML = "";

  // How it works, in one line of pictures.
  const how = h("div", "how", root);
  for (const [ic, label] of [["wave", "Appliance plays its alarm"], ["chip", "ESP32 + mic recognises it"], ["home", "Alarm sensor turns on in Home Assistant"]] as const) {
    const d = h("div", "how-item", how);
    icon(d, ic, "ic big");
    h("span", "", d, label);
  }

  h("h2", "home-q", root, "How do you want to set it up?");
  const routes = h("div", "routes", root);

  // --- A: ready-made preset ---
  const a = h("section", "route route-a", routes);
  h("div", "route-tag", a, "Appliance in the catalog");
  const ah = h("div", "way-head", a);
  icon(ah, "list", "ic big");
  h("h3", "", ah, "Use a ready-made preset");
  const cat = h("p", "catalog", a);
  h("span", "muted", cat, "Catalog: ");
  const catList = h("span", "", cat, "…");
  void loadBundledIndex(import.meta.env.BASE_URL).then((idx) => {
    catList.textContent = idx.length ? idx.map((p) => p.name).join(" · ") : "could not load the list";
  }).catch(() => { catList.textContent = "could not load the list"; });
  h("p", "route-sub", a, "Pick it, copy the generated YAML into ESPHome, install.");
  privacy(a, "Sound never leaves the device.");
  button(a, "Browse presets", () => go("use"));

  // --- B: create a preset (two ways to record) ---
  const b = h("section", "route route-b", routes);
  h("div", "route-tag", b, "Not in the catalog");
  const bh = h("div", "way-head", b);
  icon(bh, "mark", "ic big");
  h("h3", "", bh, "Create your own preset");
  h("p", "route-sub", b, "Record the alarm, mark it, and the studio builds and tests the detector. Record with:");
  const ways = h("div", "ways", b);
  const way = (ic: string, title: string, pill: string, text: string, label: string, onClick: () => void, tip?: string) => {
    const w = h("div", "way", ways);
    const t = h("div", "way-head", w);
    icon(t, ic, "ic");
    h("strong", "", t, title);
    const p = h("span", "pill", t, pill);
    if (tip) p.title = tip;
    h("p", "way-text", w, text);
    button(w, label, onClick);
  };
  way("chip", "The ESP32's microphone", "most accurate",
    "Install a temporary recording firmware, scan a QR code, record from your phone. Sound goes only to your browser, only while recording.",
    "Record with the device", () => go("create", 0),
    "The same microphone, in the same spot, that will listen later.");
  way("phone", "Phone or laptop mic, or a file", "quickest",
    "Record in this page with your phone or laptop microphone, or load an audio file. No extra firmware; audio stays in this browser.",
    "Record or load audio", () => go("create", 2));

  // --- C: hand it to an AI agent (covers every path above) ---
  const c = h("section", "route route-c", routes);
  h("div", "route-tag", c, "Any appliance");
  const ch = h("div", "way-head", c);
  icon(ch, "agent", "ic big");
  h("h3", "", ch, "Let your AI agent do it");
  h("p", "route-sub", c, "Claude Code, Codex, Gemini CLI, Cursor, Copilot and similar agents can do all of this and tell you " +
    "when to plug in the device or play the alarm. Paste this prompt into your agent:");
  const guide = "https://gl0wa.github.io/esphome-alarm-sound-detector/agent-guide.md";
  let appliance = "";
  const promptOf = () => `Set up an ESPHome alarm sound detector for my ${appliance || "appliance"} ` +
    `and connect it to Home Assistant. Follow ${guide} — use its asd tool, keep my audio recordings on this computer, ` +
    "and ask me before flashing anything or whenever you need me to do something physical.";
  const row = h("div", "row", c);
  const copyBtn = h("button", "primary", row, "Copy prompt") as HTMLButtonElement;
  const msg = h("span", "muted", row, "");
  msg.setAttribute("role", "status");
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(promptOf()); msg.textContent = "Copied — paste it into your agent."; }
    catch { msg.textContent = "Copy failed; open “Show the prompt” and select the text."; }
  };
  const det = h("details", "", c);
  h("summary", "", det, "Show / personalise the prompt");
  const fieldRow = h("label", "field agent-field", det);
  h("span", "", fieldRow, "Your appliance (optional)");
  const appl = h("input", "", fieldRow) as HTMLInputElement;
  appl.placeholder = "e.g. Tefal rice cooker RK8121";
  const pre = h("pre", "snippet agent-prompt", det, promptOf());
  appl.oninput = () => { appliance = appl.value.trim(); pre.textContent = promptOf(); };
  const links = h("p", "agent-links", c);
  const a1 = h("a", "", links, "Agent guide") as HTMLAnchorElement;
  a1.href = "https://github.com/gl0wa/esphome-alarm-sound-detector/blob/main/docs/agent_guide.md"; a1.target = "_blank"; a1.rel = "noopener";
  h("span", "muted", links, " · ");
  const a2 = h("a", "", links, "asd command-line tool") as HTMLAnchorElement;
  a2.href = "cli/asd.mjs"; a2.setAttribute("download", "asd.mjs");
  privacy(c, "The agent works on your computer and keeps recordings local.");
}

function privacy(parent: HTMLElement, text: string) {
  const p = h("p", "privacy", parent);
  icon(p, "lock", "ic small");
  h("span", "", p, text);
}

function button(parent: HTMLElement, label: string, onClick: () => void) {
  const btn = h("button", "primary", parent, `${label} →`) as HTMLButtonElement;
  btn.onclick = onClick;
  return btn;
}
