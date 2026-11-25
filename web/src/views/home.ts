// Home screen: two clearly separated modes + a short privacy explainer.
import { h, note } from "../helpers";

export function renderHome(root: HTMLElement, go: (m: "use" | "create") => void) {
  root.innerHTML = "";
  h("h2", "", root, "What would you like to do?");
  const grid = h("div", "home-grid", root);

  const c1 = h("div", "home-card", grid);
  h("h3", "", c1, "Use a ready-made preset");
  h("p", "muted", c1, "Your appliance is in the catalog. Install the normal firmware; sound never leaves the device.");
  const b1 = h("button", "primary", c1, "Browse presets →");
  b1.onclick = () => go("use");

  const c2 = h("div", "home-card", grid);
  h("h3", "", c2, "Create a preset for your appliance");
  h("p", "muted", c2, "Record your appliance with a temporary recording firmware, teach the detector, then switch back.");
  const b2 = h("button", "primary", c2, "Start recording flow →");
  b2.onclick = () => go("create");

  note(root, "Privacy: only the temporary recording firmware can send sound — only to your own browser, " +
    "only while you press Record. The normal firmware never sends sound anywhere.");
}
