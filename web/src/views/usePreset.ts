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
  note(root, "Pick your appliance below. The generated firmware keeps all sound on the device — " +
    "nothing is ever sent anywhere.");

  const st = (renderUsePreset as { sel?: string[] }).sel ?? [];
  const listBox = h("div", "list", root);
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

  renderDeviceCard(root, dev, () => drawYaml());

  const yamlPre = h("pre", "snippet", yamlBox);
  const row = h("div", "row", yamlBox);
  const msg = h("span", "muted", row, "");

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
    void msg;
  }
  drawYaml();

  h("h3", "", yamlBox, "Install in the ESPHome dashboard");
  const ol = h("ol", "steps-list", yamlBox);
  h("li", "", ol, "New device → paste the YAML above into the ESPHome dashboard.");
  h("li", "", ol, "Add wifi_ssid / wifi_password to ESPHome secrets if they are not there yet.");
  h("li", "", ol, "Install. The first install is over USB; later updates work over Wi-Fi.");
  h("li", "", ol, "Check the new binary sensor in Home Assistant and test with the real appliance sound.");

  button(row, "Copy YAML", async () => {
    try { await navigator.clipboard.writeText(yamlPre.textContent ?? ""); msg.textContent = "Copied."; }
    catch { msg.textContent = "Copy failed; select the text above instead."; }
  }, "primary");
  button(row, "Download YAML", () => download(`${dev.deviceName}.yaml`, yamlPre.textContent ?? ""));
}
