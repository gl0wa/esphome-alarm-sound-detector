// Device settings + YAML generation.
import { describe, expect, it } from "vitest";
import {
  buildDeviceYaml,
  captureLink,
  defaultDeviceSettings,
  friendlyNameOf,
  genApiKey,
  genCaptureKey,
  presetDocToYaml,
  safeId,
} from "../src/device";

describe("device settings", () => {
  it("generates secrets in the right shape", () => {
    const api = genApiKey();
    expect(Buffer.from(api, "base64").length).toBe(32);
    const cap = genCaptureKey();
    expect(cap).toMatch(/^[A-Za-z0-9\-_]{24}$/);
    expect(genCaptureKey()).not.toBe(cap);
  });

  it("derives friendly names and safe ids", () => {
    expect(friendlyNameOf("kitchen-sound-detector")).toBe("Kitchen Sound Detector");
    expect(safeId("Vorwerk TM6 Alarm!")).toBe("vorwerk_tm6_alarm");
  });

  it("normal YAML keeps sound on-device and uses secrets for wifi", () => {
    const dev = { ...defaultDeviceSettings(), apiKey: "QUJD", captureKey: "xyz" };
    const y = buildDeviceYaml(dev, [{ id: "tm6", ref: "vorwerk_thermomix_tm6_alarm" }], false);
    expect(y).toContain("github://gl0wa/esphome-alarm-sound-detector@main");
    expect(y).toContain("components: [alarm_sound_detector]");
    expect(y).not.toContain("capture_server");
    expect(y).toContain("ssid: !secret wifi_ssid");
    expect(y).toContain("password: !secret wifi_password");
    expect(y).toContain('key: "QUJD"');
    expect(y).toContain("- platform: esphome");
    expect(y).toContain("adc_type: external");
    expect(y).toContain("bits_per_sample: 32bit");
    expect(y).toContain("sample_rate: 16000");
    expect(y).toContain("template: vorwerk_thermomix_tm6_alarm");
    expect(y).toContain("platform: alarm_sound_detector");
  });

  it("recording YAML adds capture_server plus the active sensor", () => {
    const dev = { ...defaultDeviceSettings(), captureKey: "testkey1234567890123456" };
    const y = buildDeviceYaml(dev, [], true);
    expect(y).toContain("capture_server:");
    expect(y).toContain("microphone: mic");
    expect(y).toContain("bits_per_sample: 16");
    expect(y).toContain('key: "testkey1234567890123456"');
    expect(y).toContain("platform: capture_server");
    expect(y).toContain('name: "Sound capture active"');
    expect(y).toContain("components: [alarm_sound_detector, capture_server]");
  });

  it("inline templates embed the preset doc mapping", () => {
    const doc = {
      format: 2, id: "x", name: "X", manufacturer: "M", model: "Mo", sound: "beep",
      sample_rate: 16000, n_fft: 512, hop: 256, bin_lo: 13, bin_hi: 144,
      frames: 2, bins: 3, data_int8_b64: "AAAAAA",
      detection: { threshold: 0.5, near_threshold: 0.3, min_repetitions: 2, period_s: 3.1, period_tolerance_s: 0.25, refractory_s: 1.5, release_s: 7.2 },
      provenance: { n_examples: 3, tested_against: ["noise"], validation: "lab" },
    };
    const lines = presetDocToYaml(doc, "    ");
    const text = lines.join("\n");
    expect(text).toContain("format: 2");
    expect(text).toContain("threshold: 0.5");
    const y = buildDeviceYaml(defaultDeviceSettings(), [{ id: "x", ref: null, doc }], false);
    expect(y).not.toContain("capture_server");
    expect(y).toContain("template:");
    expect(y).toContain("data_int8_b64:");
  });

  it("capture links use .local by default and http://ip/ on override", () => {
    expect(captureLink("kitchen-sound-detector", "K")).toBe("http://kitchen-sound-detector.local/#k=K");
    expect(captureLink("kitchen-sound-detector", "K", "192.168.1.42")).toBe("http://192.168.1.42/#k=K");
  });
});
