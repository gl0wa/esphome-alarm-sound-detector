// Shared device settings for the generated ESPHome YAML (both flows).
// Persisted in localStorage; never uploaded anywhere.

/**
 * Hardware presets. Any ESP32 / ESP32-S3 with a microphone ESPHome supports should
 * work; "stamp-s3" and "cores3" are verified on real hardware.
 *  - i2s:    I2S MEMS microphone (INMP441, ICS-43434, SPH0645, MSM261…): SCK/WS/SD pins
 *  - pdm:    PDM microphone (SPM1423, MP34DT05, built-in mics of many boards): CLK + DATA
 *  - es7210: boards with an ES7210 audio ADC (M5Stack CoreS3 / CoreS3 SE, ESP32-S3-BOX-3)
 */
export type BoardPreset = "stamp-s3" | "i2s" | "pdm" | "cores3" | "xiao-s3-sense" | "atom-echo";
export type MicKind = "i2s" | "pdm" | "es7210";
export type Chip = "esp32s3" | "esp32";

export interface HardwarePreset {
  id: BoardPreset;
  label: string;
  mic: MicKind;
  chip: Chip;
  boardId: string;
  flash?: string;       // omitted = ESPHome default (4MB, fits every board)
  sck: string; ws: string; sd: string; // pdm: ws = CLK, sd = DATA; es7210: fixed pins
  channel: "left" | "right";
  editable: boolean;    // pins / board id editable in the UI
  tested: boolean;      // verified end to end on real hardware
  note: string;
}

export const HARDWARE: HardwarePreset[] = [
  { id: "stamp-s3", label: "M5Stack Stamp S3 + INMP441 (reference, tested)", mic: "i2s", chip: "esp32s3",
    boardId: "esp32-s3-devkitc-1", flash: "8MB", sck: "GPIO1", ws: "GPIO7", sd: "GPIO5", channel: "left",
    editable: false, tested: true, note: "Wiring: SCK→GPIO1, WS→GPIO7, SD→GPIO5, L/R→GND, VDD→3V3." },
  { id: "i2s", label: "Any ESP32 / ESP32-S3 + I2S microphone (INMP441, ICS-43434, SPH0645…)", mic: "i2s", chip: "esp32s3",
    boardId: "esp32-s3-devkitc-1", sck: "GPIO1", ws: "GPIO7", sd: "GPIO5", channel: "left",
    editable: true, tested: false, note: "Set your board, chip and the three pins. L/R pin to GND = left channel, to 3V3 = right." },
  { id: "pdm", label: "Any ESP32 / ESP32-S3 + PDM microphone (SPM1423, MP34DT05…)", mic: "pdm", chip: "esp32s3",
    boardId: "esp32-s3-devkitc-1", sck: "", ws: "GPIO42", sd: "GPIO41", channel: "left",
    editable: true, tested: false, note: "PDM microphones have two signal pins: CLK and DATA." },
  { id: "cores3", label: "M5Stack CoreS3 / CoreS3 SE (built-in microphones, tested)", mic: "es7210", chip: "esp32s3",
    boardId: "m5stack-cores3", flash: "16MB", sck: "GPIO34", ws: "GPIO33", sd: "GPIO14", channel: "left",
    editable: false, tested: true, note: "Built-in ES7210 microphone ADC; nothing to wire. Verified on a CoreS3 SE with a test sound." },
  { id: "xiao-s3-sense", label: "Seeed XIAO ESP32S3 Sense (built-in microphone)", mic: "pdm", chip: "esp32s3",
    boardId: "seeed_xiao_esp32s3", flash: "8MB", sck: "", ws: "GPIO42", sd: "GPIO41", channel: "left",
    editable: false, tested: false, note: "Built-in PDM microphone on the Sense expansion board." },
  { id: "atom-echo", label: "M5Stack Atom Echo (built-in microphone, ESP32)", mic: "pdm", chip: "esp32",
    boardId: "m5stack-atom", flash: "4MB", sck: "", ws: "GPIO33", sd: "GPIO23", channel: "right",
    editable: false, tested: false, note: "Built-in SPM1423 PDM microphone." },
];
export const hardwareOf = (id: string): HardwarePreset => HARDWARE.find((h) => h.id === id) ?? HARDWARE[0];

export interface DeviceSettings {
  deviceName: string;
  board: BoardPreset;
  /** ESPHome board id (editable for the generic presets). */
  boardId: string;
  chip: Chip;
  sck: string;
  ws: string;
  sd: string;
  channel: "left" | "right";
  /** API encryption key (32 bytes, base64), inlined in the YAML. */
  apiKey: string;
  /** Capture key guarding the temporary recording page (24 url-safe chars). */
  captureKey: string;
}

/** Apply a hardware preset's defaults to the settings (keeps name and keys). */
export function applyHardware(d: DeviceSettings, id: BoardPreset): DeviceSettings {
  const hw = hardwareOf(id);
  return { ...d, board: hw.id, boardId: hw.boardId, chip: hw.chip, sck: hw.sck, ws: hw.ws, sd: hw.sd, channel: hw.channel };
}

export const STAMP_S3 = {
  boardId: "esp32-s3-devkitc-1",
  sck: "GPIO1",
  ws: "GPIO7",
  sd: "GPIO5",
  channel: "left" as const,
};

export const DEFAULT_DEVICE_NAME = "kitchen-sound-detector";

const LS_KEY = "asd-studio-device-v1";
export const MODE_KEY = "asd-studio-mode-v1";
export type StudioMode = "home" | "use" | "create";

function randBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

const URLSAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function genApiKey(): string {
  return b64(randBytes(32));
}

export function genCaptureKey(): string {
  const b = randBytes(24);
  let s = "";
  for (let i = 0; i < b.length; i++) s += URLSAFE[b[i] & 63];
  return s;
}

/** "kitchen-sound-detector" -> "Kitchen Sound Detector". */
export function friendlyNameOf(deviceName: string): string {
  const words = deviceName.split(/[-_]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length ? words.join(" ") : "Sound Detector";
}

/** ESPHome-safe id: lowercase, non [a-z0-9_] -> _. */
export function safeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "preset";
}

export function defaultDeviceSettings(): DeviceSettings {
  return applyHardware({
    deviceName: DEFAULT_DEVICE_NAME, board: "stamp-s3", boardId: "", chip: "esp32s3",
    sck: "", ws: "", sd: "", channel: "left",
    apiKey: genApiKey(),
    captureKey: genCaptureKey(),
  }, "stamp-s3");
}

/** Normalise stored/loaded settings (older versions had board "other" = generic I2S). */
export function normalizeDevice(j: Partial<Omit<DeviceSettings, "board">> & { board?: string }, d = defaultDeviceSettings()): DeviceSettings {
  const board = (j.board === "other" ? "i2s" : HARDWARE.some((h) => h.id === j.board) ? j.board : "stamp-s3") as BoardPreset;
  const hw = hardwareOf(board);
  const str = (v: unknown, fb: string) => (typeof v === "string" && v ? v : fb);
  const out: DeviceSettings = {
    deviceName: typeof j.deviceName === "string" && /^[a-z0-9-]+$/.test(j.deviceName) ? j.deviceName : d.deviceName,
    board,
    boardId: str(j.boardId, hw.boardId),
    chip: j.chip === "esp32" ? "esp32" : j.chip === "esp32s3" ? "esp32s3" : hw.chip,
    sck: str(j.sck, hw.sck), ws: str(j.ws, hw.ws), sd: str(j.sd, hw.sd),
    channel: j.channel === "right" ? "right" : j.channel === "left" ? "left" : hw.channel,
    apiKey: str(j.apiKey, d.apiKey),
    captureKey: str(j.captureKey, d.captureKey),
  };
  return hw.editable ? out : applyHardware(out, board);
}

export function loadDeviceSettings(): DeviceSettings {
  const d = defaultDeviceSettings();
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? normalizeDevice(JSON.parse(raw), d) : d;
  } catch {
    return d;
  }
}

export function saveDeviceSettings(s: DeviceSettings): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* private browsing etc. */
  }
}

export function loadMode(): StudioMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === "use" || m === "create" || m === "home") return m;
  } catch { /* ignore */ }
  return "home";
}

export function saveMode(m: StudioMode): void {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch { /* ignore */ }
}

/** http://<name>.local/#k=<key>, or http://<ip>/#k=<key> when an IP override is given. */
export function captureLink(deviceName: string, captureKey: string, ip = ""): string {
  const host = ip.trim() ? ip.trim() : `${deviceName}.local`;
  return `http://${host}/#k=${captureKey}`;
}

export interface YamlPreset {
  /** Detector id (already safe). */
  id: string;
  /** Bundled preset id for `template: <id>`, or null for an inline template. */
  ref: string | null;
  /** Full preset doc for inline templates (format v2 keys). */
  doc?: Record<string, unknown>;
  /** Short appliance label for entity names, e.g. "Thermomix TM6". */
  label?: string;
}

const labelOf = (p: YamlPreset) =>
  (p.label || p.id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())).replace(/"/g, "'");

function yamlStr(s: string): string {
  // Quote when the value could confuse YAML (": ", "#", leading special chars…).
  if (s === "" || /[:#{}[\],&*!|>'"%@`-]|^\s|\s$|:\s/.test(s) || /^(true|false|null|yes|no|on|off|[0-9])/i.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function yamlVal(v: unknown, indent: string): string[] {
  if (v === null) return ["null"];
  if (typeof v === "number" || typeof v === "boolean") return [String(v)];
  if (typeof v === "string") return [yamlStr(v)];
  if (Array.isArray(v)) {
    if (!v.length) return ["[]"];
    const lines: string[] = [];
    for (const item of v) {
      if (item !== null && typeof item === "object") {
        const sub = yamlVal(item, indent + "  ");
        lines.push(`${indent}- ${sub[0].replace(/^\s*/, "")}`);
        for (const l of sub.slice(1)) lines.push(`${indent}  ${l.replace(new RegExp(`^${indent}  `), "")}`);
      } else {
        lines.push(`${indent}- ${yamlVal(item, indent)[0]}`);
      }
    }
    return lines;
  }
  const lines: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val !== null && typeof val === "object" && !Array.isArray(val) && Object.keys(val).length) {
      lines.push(`${indent}${k}:`);
      for (const l of yamlVal(val, indent + "  ")) lines.push(l);
    } else if (Array.isArray(val) && val.length && val.some((x) => x !== null && typeof x === "object")) {
      lines.push(`${indent}${k}:`);
      for (const l of yamlVal(val, indent + "  ")) lines.push(l);
    } else if (Array.isArray(val) && val.length) {
      lines.push(`${indent}${k}: [${val.map((x) => yamlVal(x, "")[0]).join(", ")}]`);
    } else {
      lines.push(`${indent}${k}: ${yamlVal(val, indent)[0]}`);
    }
  }
  return lines;
}

function detectorBlock(p: YamlPreset, micIndent: string): string[] {
  const lines = [
    `${micIndent}- id: ${p.id}`,
    `${micIndent}  microphone:`,
    `${micIndent}    microphone: mic`,
    `${micIndent}    bits_per_sample: 16`,
  ];
  if (p.ref) {
    lines.push(`${micIndent}  template: ${p.ref}`);
  } else if (p.doc) {
    lines.push(`${micIndent}  template:`);
    for (const l of yamlVal(p.doc, micIndent + "    ")) lines.push(l);
  }
  return lines;
}

/** Full device YAML. `recording=true` adds capture_server (temporary firmware). */
export function buildDeviceYaml(dev: DeviceSettings, presets: YamlPreset[], recording: boolean): string {
  const friendly = friendlyNameOf(dev.deviceName);
  const L: string[] = [];
  const hw = hardwareOf(dev.board);
  L.push("substitutions:");
  L.push(`  name: ${dev.deviceName}`);
  L.push(`  friendly_name: ${yamlStr(friendly)}`);
  if (hw.mic === "i2s") {
    L.push(`  # ${hw.label} — see docs/wiring.md`);
    L.push(`  mic_sck_pin: ${dev.sck}   # SCK / BCLK`);
    L.push(`  mic_ws_pin: ${dev.ws}    # WS / LRCLK`);
    L.push(`  mic_sd_pin: ${dev.sd}    # SD / DOUT`);
  } else if (hw.mic === "pdm") {
    L.push(`  # ${hw.label} — see docs/wiring.md`);
    L.push(`  mic_clk_pin: ${dev.ws}   # PDM CLK`);
    L.push(`  mic_data_pin: ${dev.sd}  # PDM DATA`);
  } else {
    L.push(`  # ${hw.label}`);
  }
  L.push("");
  L.push("esphome:");
  L.push("  name: ${name}");
  L.push("  friendly_name: ${friendly_name}");
  L.push("  min_version: 2026.11.0");
  L.push("");
  L.push("esp32:");
  L.push(`  board: ${dev.boardId}`);
  L.push(`  variant: ${dev.chip}`);
  if (hw.flash) L.push(`  flash_size: ${hw.flash}`);
  L.push("  framework:");
  L.push("    type: esp-idf    # required by the I2S microphone / detector");
  L.push("");
  L.push("external_components:");
  L.push("  - source: github://gl0wa/esphome-alarm-sound-detector@main");
  L.push(`    components: [alarm_sound_detector${recording ? ", capture_server" : ""}]`);
  L.push("");
  L.push("logger:");
  L.push("  level: INFO");
  L.push("");
  L.push("api:");
  L.push("  encryption:");
  L.push(`    key: "${dev.apiKey}"`);
  L.push("");
  L.push("ota:");
  L.push("  - platform: esphome");
  L.push("    encryption: {}   # reuses the API encryption key");
  L.push("");
  L.push("wifi:");
  L.push("  ssid: !secret wifi_ssid");
  L.push("  password: !secret wifi_password");
  L.push("  power_save_mode: none   # mains powered; avoids audio processing hiccups");
  L.push("");
  L.push("# Microphone: any ESPHome microphone at 16 kHz works —");
  L.push("# https://esphome.io/components/microphone/i2s_audio/");
  if (hw.mic === "i2s") {
    L.push("i2s_audio:");
    L.push("  - id: i2s_mic_bus");
    L.push("    i2s_lrclk_pin: ${mic_ws_pin}");
    L.push("    i2s_bclk_pin: ${mic_sck_pin}");
    L.push("");
    L.push("microphone:");
    L.push("  - platform: i2s_audio");
    L.push("    id: mic");
    L.push("    i2s_audio_id: i2s_mic_bus");
    L.push("    i2s_din_pin: ${mic_sd_pin}");
    L.push("    adc_type: external");
    L.push("    pdm: false");
    L.push(`    channel: ${dev.channel}          # L/R pin tied to ${dev.channel === "left" ? "GND" : "3V3"}`);
    L.push("    bits_per_sample: 32bit");
    L.push("    sample_rate: 16000     # the detector requires 16 kHz");
  } else if (hw.mic === "pdm") {
    L.push("i2s_audio:");
    L.push("  - id: i2s_mic_bus");
    L.push("    i2s_lrclk_pin: ${mic_clk_pin}   # PDM clock");
    L.push("");
    L.push("microphone:");
    L.push("  - platform: i2s_audio");
    L.push("    id: mic");
    L.push("    i2s_audio_id: i2s_mic_bus");
    L.push("    i2s_din_pin: ${mic_data_pin}");
    L.push("    adc_type: external");
    L.push("    pdm: true");
    L.push(`    channel: ${dev.channel}`);
    L.push("    bits_per_sample: 16bit");
    L.push("    sample_rate: 16000     # the detector requires 16 kHz");
    L.push("    correct_dc_offset: true");
  } else {
    L.push("i2c:");
    L.push("  - id: bsp_bus           # internal bus (ES7210 microphone ADC)");
    L.push("    sda: GPIO12");
    L.push("    scl: GPIO11");
    L.push("");
    L.push("i2s_audio:");
    L.push("  - id: i2s_mic_bus");
    L.push(`    i2s_lrclk_pin: ${dev.ws}`);
    L.push(`    i2s_bclk_pin: ${dev.sck}`);
    L.push("    i2s_mclk_pin:");
    L.push("      number: GPIO0");
    L.push("      ignore_strapping_warning: true");
    L.push("");
    L.push("audio_adc:");
    L.push("  - platform: es7210");
    L.push("    id: es7210_adc");
    L.push("    i2c_id: bsp_bus");
    L.push("    bits_per_sample: 16bit");
    L.push("    sample_rate: 16000");
    L.push("    mic_gain: 30");
    L.push("");
    L.push("microphone:");
    L.push("  - platform: i2s_audio");
    L.push("    id: mic");
    L.push("    i2s_audio_id: i2s_mic_bus");
    L.push(`    i2s_din_pin: ${dev.sd}`);
    L.push("    adc_type: external");
    L.push("    bits_per_sample: 16bit");
    L.push("    sample_rate: 16000     # the detector requires 16 kHz");
  }
  L.push("");
  if (recording) {
    L.push("# TEMPORARY recording firmware: the only firmware that sends sound,");
    L.push("# and only to your browser while you press Record. Switch back afterwards.");
    L.push("capture_server:");
    L.push("  microphone:");
    L.push("    microphone: mic");
    L.push("    bits_per_sample: 16");
    L.push(`  key: "${dev.captureKey}"`);
    L.push("");
  }
  if (presets.length) {
    L.push("alarm_sound_detector:");
    for (const p of presets) L.push(...detectorBlock(p, "  "));
    L.push("");
  }
  if (presets.length || recording) {
    L.push("binary_sensor:");
    for (const p of presets) {
      L.push("  - platform: alarm_sound_detector");
      L.push(`    alarm_sound_detector_id: ${p.id}`);
      L.push(`    name: "${labelOf(p)} alarm"`);
    }
    if (recording) {
      L.push("  - platform: capture_server");
      L.push('    name: "Sound capture active"');
    }
    L.push("");
  }
  L.push("sensor:");
  for (const p of presets) {
    L.push("  - platform: alarm_sound_detector");
    L.push(`    alarm_sound_detector_id: ${p.id}`);
    L.push(`    name: "${labelOf(p)} match score"`);
    L.push("    entity_category: diagnostic");
  }
  L.push("  - platform: wifi_signal");
  L.push('    name: "Wi-Fi signal"');
  L.push("    update_interval: 60s");
  L.push("    entity_category: diagnostic");
  L.push("");
  return L.join("\n");
}

/** Serialize a built v2 preset doc to YAML mapping lines (inline template support). */
export function presetDocToYaml(doc: Record<string, unknown>, indent: string): string[] {
  return yamlVal(doc, indent);
}

/** How the user records: with the device (temporary recording firmware) or with
 *  a phone/laptop/audio files (the device steps are hidden). */
export type CreateRoute = "device" | "file";
const ROUTE_KEY = "asd-studio-route-v1";
export function getRoute(): CreateRoute {
  try { return localStorage.getItem(ROUTE_KEY) === "file" ? "file" : "device"; } catch { return "device"; }
}
export function setRoute(r: CreateRoute) {
  try { localStorage.setItem(ROUTE_KEY, r); } catch { /* ignore */ }
}
