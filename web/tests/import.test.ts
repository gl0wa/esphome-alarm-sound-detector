// Validation for capture clips posted by the recording firmware page.
import { describe, expect, it } from "vitest";
import { MAX_BYTES, validateCaptureClips } from "../src/importClips";

function clip(name: string, sampleRate: number, pcm: unknown) {
  return { name, sampleRate, pcm };
}

function msg(clips: unknown[]) {
  return {
    type: "asd-capture-clips",
    version: 1,
    device: { name: "kitchen-sound-detector", friendly_name: "Kitchen Sound Detector" },
    clips,
  };
}

const good = () => msg([
  clip("alarm 1", 16000, new ArrayBuffer(32000)),
  clip("background", 16000, new ArrayBuffer(160000)),
]);

describe("validateCaptureClips", () => {
  it("accepts a well-formed message", () => {
    const r = validateCaptureClips(good());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.deviceName).toBe("kitchen-sound-detector");
      expect(r.value.clips).toHaveLength(2);
    }
  });

  it("ignores other messages", () => {
    expect(validateCaptureClips({ type: "other" }).ok).toBe(false);
    expect(validateCaptureClips(null).ok).toBe(false);
  });

  it("rejects bad shapes", () => {
    expect(validateCaptureClips(msg([])).ok).toBe(false);
    expect(validateCaptureClips(msg([clip("x", 44100, new ArrayBuffer(4))])).ok).toBe(false);
    // odd byte length is not Int16 audio
    expect(validateCaptureClips(msg([clip("x", 16000, new ArrayBuffer(3))])).ok).toBe(false);
    // missing device
    expect(validateCaptureClips({ type: "asd-capture-clips", version: 1, clips: [] }).ok).toBe(false);
  });

  it("rejects oversized clips and too many clips", () => {
    const tooBig = { byteLength: MAX_BYTES + 2, slice: () => null };
    expect(validateCaptureClips(msg([clip("x", 16000, tooBig)])).ok).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => clip(`c${i}`, 16000, new ArrayBuffer(2)));
    expect(validateCaptureClips(msg(many)).ok).toBe(false);
  });
});
