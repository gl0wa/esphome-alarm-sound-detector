// Home screen: a visual map of the three routes (ready-made preset; create a
// preset recorded with the device; create one from phone/laptop audio) with as
// little text as possible.
import { h } from "../helpers";

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
};

function icon(parent: HTMLElement, name: string, cls = "ic"): HTMLElement {
  const span = h("span", cls, parent);
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

type Step = [icon: string, label: string];

function flow(parent: HTMLElement, steps: Step[], alt = false) {
  const ol = h("ol", alt ? "flow alt" : "flow", parent);
  for (const [ic, label] of steps) {
    const li = h("li", "", ol);
    icon(li, ic);
    h("span", "", li, label);
  }
}

export function renderHome(root: HTMLElement, go: (m: "use" | "create", step?: number) => void) {
  root.innerHTML = "";

  // How it works, in one line of pictures.
  const how = h("div", "how", root);
  for (const [ic, label] of [["wave", "Appliance alarm"], ["chip", "ESP32 + mic recognises it"], ["home", "Home Assistant notifies you"]] as const) {
    const d = h("div", "how-item", how);
    icon(d, ic, "ic big");
    h("span", "", d, label);
  }

  h("h2", "home-q", root, "Is your appliance in the catalog?");
  const routes = h("div", "routes", root);

  // --- A: ready-made preset ---
  const a = h("div", "route route-a", routes);
  h("div", "route-tag", a, "Yes");
  h("h3", "", a, "Use a ready-made preset");
  flow(a, [["list", "Pick appliance"], ["code", "Copy YAML"], ["flash", "Install"], ["bell", "Done"]]);
  privacy(a, "Sound never leaves the device.");
  button(a, "Browse presets", () => go("use"));

  // --- B: create a preset (two ways to record) ---
  const b = h("div", "route route-b", routes);
  h("div", "route-tag", b, "No");
  h("h3", "", b, "Create your own preset");
  h("p", "route-sub", b, "First record the alarm — choose how:");
  const ways = h("div", "ways", b);

  const b1 = h("div", "way", ways);
  const t1 = h("div", "way-head", b1);
  icon(t1, "chip", "ic big");
  h("strong", "", t1, "With the device");
  const acc = h("span", "pill", t1, "most accurate");
  acc.title = "Recorded by the same microphone, in the same spot, that will listen later.";
  flow(b1, [["flash", "Install recording firmware"], ["qr", "Scan QR, record on phone"]]);
  privacy(b1, "Temporary firmware: sound goes only to your browser, only while recording.");
  button(b1, "Record with the device", () => go("create", 0));

  const b2 = h("div", "way", ways);
  const t2 = h("div", "way-head", b2);
  icon(t2, "phone", "ic big");
  h("strong", "", t2, "With a phone or laptop");
  h("span", "pill", t2, "quickest");
  flow(b2, [["laptop", "Record in this page"], ["file", "Load an audio file"]], true);
  privacy(b2, "No extra firmware. Audio stays in this browser.");
  button(b2, "Record or load audio", () => go("create", 2));

  h("div", "merge", b, "then, in both cases");
  flow(b, [["mark", "Mark the alarm"], ["build", "Build"], ["test", "Test"], ["code", "Copy YAML"], ["flash", "Install"], ["bell", "Done"]]);
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
