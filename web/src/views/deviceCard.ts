// Shared "Device settings" card: name, board preset, advanced pins/keys.
// Used by both the ready-made flow and the recording/install steps.
import { button, field, h, note } from "../helpers";
import {
  DeviceSettings,
  STAMP_S3,
  friendlyNameOf,
  genApiKey,
  genCaptureKey,
  saveDeviceSettings,
} from "../device";

export function renderDeviceCard(parent: HTMLElement, dev: DeviceSettings, onChange: () => void) {
  const box = h("section", "device-card", parent);
  h("h3", "", box, "Device settings");
  note(box, "Defaults fit the reference hardware (wiring guide in the docs). Change them only if yours differs.");

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
  h("span", "", boardWrap, "Microphone board");
  const boardSel = h("select", "", boardWrap) as HTMLSelectElement;
  const o1 = h("option", "", boardSel, "M5Stack Stamp S3 + INMP441") as HTMLOptionElement;
  o1.value = "stamp-s3";
  const o2 = h("option", "", boardSel, "Other ESP32-S3 board") as HTMLOptionElement;
  o2.value = "other";
  boardSel.value = dev.board;
  boardSel.onchange = () => {
    dev.board = boardSel.value === "other" ? "other" : "stamp-s3";
    if (dev.board === "stamp-s3") {
      dev.boardId = STAMP_S3.boardId;
      dev.sck = STAMP_S3.sck;
      dev.ws = STAMP_S3.ws;
      dev.sd = STAMP_S3.sd;
      dev.channel = STAMP_S3.channel;
    }
    saveDeviceSettings(dev);
    onChange();
    renderDeviceCard(parent, dev, onChange);
    parent.removeChild(box);
  };

  if (dev.board === "other") {
    const adv0 = h("div", "grid", box);
    field(adv0, "ESPHome board id", dev.boardId, {
      onChange: (v) => { dev.boardId = v.trim() || STAMP_S3.boardId; saveDeviceSettings(dev); onChange(); },
    });
  }

  const det = h("details", "", box);
  h("summary", "", det, "Advanced (pins, channel, keys)");
  const adv = h("div", "grid", det);
  const dis = dev.board === "stamp-s3";
  const sckI = field(adv, "SCK pin", dev.sck, { onChange: (v) => { dev.sck = v.trim() || dev.sck; saveDeviceSettings(dev); onChange(); } });
  const wsI = field(adv, "WS pin", dev.ws, { onChange: (v) => { dev.ws = v.trim() || dev.ws; saveDeviceSettings(dev); onChange(); } });
  const sdI = field(adv, "SD pin", dev.sd, { onChange: (v) => { dev.sd = v.trim() || dev.sd; saveDeviceSettings(dev); onChange(); } });
  for (const i of [sckI, wsI, sdI]) i.disabled = dis;
  if (dis) note(det, "Stamp S3 preset: SCK GPIO1, WS GPIO7, SD GPIO5, L/R to GND (left channel). Pick “Other ESP32-S3 board” to change pins.");
  const chWrap = h("label", "field", adv);
  h("span", "", chWrap, "INMP441 channel");
  const chSel = h("select", "", chWrap) as HTMLSelectElement;
  for (const [v, t] of [["left", "left (L/R to GND)"], ["right", "right (L/R to 3V3)"]] as const) {
    const o = h("option", "", chSel, t) as HTMLOptionElement;
    o.value = v;
  }
  chSel.value = dev.channel;
  chSel.disabled = dis;
  chSel.onchange = () => { dev.channel = chSel.value === "right" ? "right" : "left"; saveDeviceSettings(dev); onChange(); };

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
  button(btnRow, "Regenerate API key", () => { dev.apiKey = genApiKey(); saveDeviceSettings(dev); onChange(); renderDeviceCard(parent, dev, onChange); parent.removeChild(box); });
  button(btnRow, "Regenerate capture key", () => { dev.captureKey = genCaptureKey(); saveDeviceSettings(dev); onChange(); renderDeviceCard(parent, dev, onChange); parent.removeChild(box); });
  void nameInp;
}
