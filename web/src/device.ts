// Shared device settings for the generated ESPHome YAML (both flows).
// Persisted in localStorage; never uploaded anywhere.

export type BoardPreset = "stamp-s3" | "other";

export interface DeviceSettings {
  deviceName: string;
  board: BoardPreset;
  /** ESPHome board id (editable only for "other"). */
  boardId: string;
  sck: string;
  ws: string;
  sd: string;
  channel: "left" | "right";
  /** API encryption key (32 bytes, base64), inlined in the YAML. */
  apiKey: string;
  /** Capture key guarding the temporary recording page (24 url-safe chars). */
  captureKey: string;
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
  return {
    deviceName: DEFAULT_DEVICE_NAME,
    board: "stamp-s3",
    boardId: STAMP_S3.boardId,
    sck: STAMP_S3.sck,
    ws: STAMP_S3.ws,
    sd: STAMP_S3.sd,
    channel: STAMP_S3.channel,
    apiKey: genApiKey(),
    captureKey: genCaptureKey(),
  };
}

export function loadDeviceSettings(): DeviceSettings {
  const d = defaultDeviceSettings();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return d;
    const j = JSON.parse(raw) as Partial<DeviceSettings>;
    const out: DeviceSettings = {
      deviceName: typeof j.deviceName === "string" && /^[a-z0-9-]+$/.test(j.deviceName) ? j.deviceName : d.deviceName,
      board: j.board === "other" ? "other" : "stamp-s3",
      boardId: typeof j.boardId === "string" && j.boardId ? j.boardId : STAMP_S3.boardId,
      sck: typeof j.sck === "string" && j.sck ? j.sck : STAMP_S3.sck,
      ws: typeof j.ws === "string" && j.ws ? j.ws : STAMP_S3.ws,
      sd: typeof j.sd === "string" && j.sd ? j.sd : STAMP_S3.sd,
      channel: j.channel === "right" ? "right" : "left",
      apiKey: typeof j.apiKey === "string" && j.apiKey ? j.apiKey : d.apiKey,
      captureKey: typeof j.captureKey === "string" && j.captureKey ? j.captureKey : d.captureKey,
    };
    if (out.board === "stamp-s3") {
      out.boardId = STAMP_S3.boardId;
      out.sck = STAMP_S3.sck;
      out.ws = STAMP_S3.ws;
      out.sd = STAMP_S3.sd;
      out.channel = STAMP_S3.channel;
    }
    return out;
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
  L.push("substitutions:");
  L.push(`  name: ${dev.deviceName}`);
  L.push(`  friendly_name: ${yamlStr(friendly)}`);
  L.push("  # INMP441 wiring (see docs/wiring.md)");
  L.push(`  mic_sck_pin: ${dev.sck}   # SCK / BCLK`);
  L.push(`  mic_ws_pin: ${dev.ws}    # WS / LRCLK`);
  L.push(`  mic_sd_pin: ${dev.sd}    # SD / DOUT`);
  L.push("");
  L.push("esphome:");
  L.push("  name: ${name}");
  L.push("  friendly_name: ${friendly_name}");
  L.push("  min_version: 2026.11.0");
  L.push("");
  L.push("esp32:");
  L.push(`  board: ${dev.boardId}`);
  L.push("  variant: esp32s3");
  L.push("  flash_size: 8MB");
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
  L.push(`    channel: ${dev.channel}          # INMP441 L/R pin tied to ${dev.channel === "left" ? "GND" : "3V3"}`);
  L.push("    bits_per_sample: 32bit");
  L.push("    sample_rate: 16000     # the detector requires 16 kHz");
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
