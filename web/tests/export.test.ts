// Exported preset validates against preset.schema.json (ajv) and loads with
// components/alarm_sound_detector/preset_util.py (called as python).
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "../src/const";
import { loadFixtures, tsBuiltTemplate, wasmReady } from "./helpers";
import { buildPresetDoc, buildYamlSnippet, validatePreset } from "../src/preset";

const REPO = join(__dirname, "..", "..");

describe("preset export", () => {
  it("validates against the schema and loads with preset_util.py", async () => {
    await wasmReady();
    const fx = loadFixtures();
    const { q, W } = tsBuiltTemplate(fx);
    const doc = buildPresetDoc({
      id: "test_synth_alarm", name: "Test synth alarm", manufacturer: "TestCo",
      model: "S1", sound: "beep", description: "synthetic fixture", aliases: [],
      testedAgainst: "noise", validation: "synthetic only", notes: "",
    }, { q, frames: W, bins: 132 }, { loHz: 400, hiHz: 4500, binLo: 13, binHi: 144 },
    { ...DEFAULT_PARAMS }, 3);
    const v = validatePreset(doc);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "preset-export-"));
    const p = join(dir, "test_synth_alarm.json");
    writeFileSync(p, JSON.stringify(doc));
    const python = process.env.PYTHON ?? "python3";
    const check = join(dir, "check.py");
    writeFileSync(check, [
      "import json, sys",
      "sys.path.insert(0, 'components/alarm_sound_detector')",
      "import preset_util",
      `doc = json.load(open(${JSON.stringify(p)}))`,
      "doc = preset_util.validate_v2(doc, 'test')",
      "print('preset_util OK:', preset_util.normalize_v2(doc)['id'])",
    ].join("\n"));
    const out = execFileSync(python, [check], { cwd: REPO, encoding: "utf8" });
    expect(out).toContain("preset_util OK: test_synth_alarm");
  });

  it("rejects an invalid doc", () => {
    const bad = { format: 2, id: "Bad Id!" };
    expect(validatePreset(bad).ok).toBe(false);
  });

  it("yaml snippet points at github external_components", () => {
    const y = buildYamlSnippet("my_alarm", "my_alarm.json");
    expect(y).toContain("github://gl0wa/esphome-alarm-sound-detector");
    expect(y).toContain("template: my_alarm.json");
  });
});
