// "Use a ready-made preset": pick bundled preset(s), device settings, full YAML.
import { button, download, h, note } from "../helpers";
import { loadBundledIndex } from "../preset";
import { DeviceSettings, YamlPreset, buildDeviceYaml, safeId } from "../device";
import { renderDeviceCard } from "./deviceCard";

const BASE = import.meta.env.BASE_URL;

export function renderUsePreset(
  root: HTMLElement,
  dev: DeviceSettings,
  rerender: () => void,
) {
  root.innerHTML = "";
  h("h2", "", root, "Use a ready-made preset");
  h("p", "instruction", root, "1. Tick your appliance(s) — one device can listen for several. " +
    "2. Check the device settings. 3. Copy the YAML into ESPHome. Sound never leaves the device.");

  const st = (renderUsePreset as { sel?: string[] }).sel ?? [];
  const listBox = h("div", "list", root);
  const cardBox = h("div", "", root);
  const yamlBox = h("div", "", root);

  void loadIndex();
  async function loadIndex() {
    const idx = await loadBundledIndex(BASE);
    (renderUsePreset as { idx?: { id: string; name: string }[] }).idx = idx;
    listBox.innerHTML = "";
    if (!idx.length) {
      note(listBox, "Could not load the preset catalog. Check your connection and reload.");
    }
    const sel: string[] = (renderUsePreset as { sel?: string[] }).sel ?? (idx.slice(0, 1).map((p) => p.id));
    (renderUsePreset as { sel?: string[] }).sel = sel;
    for (const p of idx) {
      const item = h("div", "list-item", listBox);
      const cb = h("input", "", item) as HTMLInputElement;
      cb.type = "checkbox";
      cb.checked = sel.includes(p.id);
      cb.setAttribute("aria-label", `Use ${p.name}`);
      cb.onchange = () => {
        const cur = (renderUsePreset as { sel?: string[] }).sel ?? [];
        (renderUsePreset as { sel?: string[] }).sel = cb.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id);
        drawYaml();
      };
      h("span", "", item, p.name);
      h("span", "muted", item, p.id);
    }
    drawYaml();
  }

  renderDeviceCard(cardBox, dev, () => drawYaml());

  const row = h("div", "row", yamlBox);
  const yamlPre = document.createElement("pre");
  yamlPre.className = "snippet";

  function presets(): YamlPreset[] {
    const sel: string[] = (renderUsePreset as { sel?: string[] }).sel ?? [];
    const idx = ((renderUsePreset as { idx?: { id: string; name: string; model?: string }[] }).idx) ?? [];
    return sel.map((id) => {
      const e = idx.find((x) => x.id === id);
      return { id: safeId(id.replace(/^vorwerk_/, "").replace(/_alarm$/, "")) || safeId(id), ref: id, label: e?.model || e?.name };
    });
  }

  function drawYaml() {
    yamlPre.textContent = buildDeviceYaml(dev, presets(), false);
  }
  drawYaml();

  const ol = h("ol", "steps-list", yamlBox);
  h("li", "", ol, "In the ESPHome dashboard: New device → paste this YAML.");
  h("li", "", ol, "Make sure ESPHome's secrets contain wifi_ssid and wifi_password.");
  h("li", "", ol, "Install (the first install is over USB, later ones over Wi-Fi).");
  h("li", "", ol, "Add the device in Home Assistant and test it with the real appliance sound.");
  const yd = h("details", "", yamlBox);
  h("summary", "", yd, "Show the YAML");
  yd.appendChild(yamlPre);

  button(row, "Copy YAML", async () => {
    try { await navigator.clipboard.writeText(yamlPre.textContent ?? ""); msg.textContent = "Copied."; }
    catch { msg.textContent = "Copy failed; open “Show the YAML” and select the text."; }
  }, "primary");
  button(row, "Download YAML", () => download(`${dev.deviceName}.yaml`, yamlPre.textContent ?? ""));
  const msg = h("span", "muted", row, "");
  msg.setAttribute("role", "status");
}
