// Shared "Device settings" card: name, board preset, advanced pins/keys.
// Used by both the ready-made flow and the recording/install steps.
import { button, field, h, note } from "../helpers";
import {
  BoardPreset,
  DeviceSettings,
  HARDWARE,
  applyHardware,
  hardwareOf,
  friendlyNameOf,
  genApiKey,
  genCaptureKey,
  saveDeviceSettings,
} from "../device";

export function renderDeviceCard(parent: HTMLElement, dev: DeviceSettings, onChange: () => void) {
  const box = h("section", "device-card", parent);
  h("h3", "", box, "Device settings");
  note(box, "Works with most ESP32 / ESP32-S3 boards and microphones ESPHome supports. Pick yours; the defaults fit the reference hardware.");

  const g = h("div", "grid", box);
  const nameInp = field(g, "device name", dev.deviceName, {
    title: "Lowercase letters, numbers and dashes; used for the ESPHome device name.",
    onChange: (v) => {
      dev.deviceName = v.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "kitchen-sound-detector";
      nameInp.value = dev.deviceName;
      friendly.textContent = friendlyNameOf(dev.deviceName);
      saveDeviceSettings(dev);
      onChange();
    },
  });
  const friendly = h("p", "note", box, "");
  friendly.textContent = `Friendly name: ${friendlyNameOf(dev.deviceName)}`;

  const boardWrap = h("label", "field", g);
  h("span", "", boardWrap, "Board and microphone");
  const boardSel = h("select", "", boardWrap) as HTMLSelectElement;
  for (const hwp of HARDWARE) {
    const o = h("option", "", boardSel, hwp.label) as HTMLOptionElement;
    o.value = hwp.id;
  }
  boardSel.value = dev.board;
  const rerender = () => { saveDeviceSettings(dev); onChange(); renderDeviceCard(parent, dev, onChange); parent.removeChild(box); };
  boardSel.onchange = () => {
    Object.assign(dev, applyHardware(dev, boardSel.value as BoardPreset));
    rerender();
  };
  const hw = hardwareOf(dev.board);
  const hwNote = h("p", "note", box, `${hw.note} `);
  if (!hw.tested) h("span", "", hwNote, "Not yet verified on this hardware by the project — please report how it works.");
  const wl = h("a", "", hwNote, " Wiring and microphones →") as HTMLAnchorElement;
  wl.href = "https://github.com/gl0wa/esphome-alarm-sound-detector/blob/main/docs/wiring.md";
  wl.target = "_blank"; wl.rel = "noopener";

  const save = () => { saveDeviceSettings(dev); onChange(); };
  if (hw.editable) {
    const adv0 = h("div", "grid", box);
    field(adv0, "ESPHome board id", dev.boardId, { onChange: (v) => { dev.boardId = v.trim() || hw.boardId; save(); } });
    const chipWrap = h("label", "field", adv0);
    h("span", "", chipWrap, "Chip");
    const chipSel = h("select", "", chipWrap) as HTMLSelectElement;
    for (const [v, t] of [["esp32s3", "ESP32-S3"], ["esp32", "ESP32"]] as const) {
      const o = h("option", "", chipSel, t) as HTMLOptionElement; o.value = v;
    }
    chipSel.value = dev.chip;
    chipSel.onchange = () => { dev.chip = chipSel.value === "esp32" ? "esp32" : "esp32s3"; save(); };
    if (hw.mic === "i2s") {
      field(adv0, "SCK / BCLK pin", dev.sck, { onChange: (v) => { dev.sck = v.trim() || dev.sck; save(); } });
      field(adv0, "WS / LRCLK pin", dev.ws, { onChange: (v) => { dev.ws = v.trim() || dev.ws; save(); } });
      field(adv0, "SD / DOUT pin", dev.sd, { onChange: (v) => { dev.sd = v.trim() || dev.sd; save(); } });
    } else {
      field(adv0, "CLK pin", dev.ws, { onChange: (v) => { dev.ws = v.trim() || dev.ws; save(); } });
      field(adv0, "DATA pin", dev.sd, { onChange: (v) => { dev.sd = v.trim() || dev.sd; save(); } });
    }
    const chWrap = h("label", "field", adv0);
    h("span", "", chWrap, "Channel");
    const chSel = h("select", "", chWrap) as HTMLSelectElement;
    const chOpts = hw.mic === "i2s"
      ? [["left", "left (L/R pin to GND)"], ["right", "right (L/R pin to 3V3)"]]
      : [["left", "left"], ["right", "right"]];
    for (const [v, t] of chOpts) { const o = h("option", "", chSel, t) as HTMLOptionElement; o.value = v; }
    chSel.value = dev.channel;
    chSel.onchange = () => { dev.channel = chSel.value === "right" ? "right" : "left"; save(); };
  }

  const det = h("details", "", box);
  h("summary", "", det, "Advanced (keys)");
  const keyRow = h("div", "grid", det);
  const apiI = field(keyRow, "API encryption key (in YAML)", dev.apiKey, {
    onChange: (v) => { dev.apiKey = v.trim() || dev.apiKey; saveDeviceSettings(dev); onChange(); },
  });
  apiI.readOnly = true;
  const capI = field(keyRow, "Capture key (recording page)", dev.captureKey, {
    onChange: (v) => { dev.captureKey = v.trim() || dev.captureKey; saveDeviceSettings(dev); onChange(); },
  });
  capI.readOnly = true;
  const btnRow = h("div", "row", det);
  button(btnRow, "Regenerate API key", () => { dev.apiKey = genApiKey(); rerender(); });
  button(btnRow, "Regenerate capture key", () => { dev.captureKey = genCaptureKey(); rerender(); });
  void nameInp;
}
