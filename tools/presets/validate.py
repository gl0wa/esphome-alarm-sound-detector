"""Validate preset files (CI and contributors).

Checks, per preset:
  1. full JSON Schema validation against presets/preset.schema.json (jsonschema);
  2. the component's own loader checks (preset_util.validate_v2: band, bins,
     thresholds, template size) — exactly what ESPHome runs at compile time;
  3. catalog consistency: file name == id, ids and aliases unique across presets;
  4. plausibility of the template and detection timing.

Usage: python tools/presets/validate.py [preset.json ...]   (default: all bundled)
Exit code 1 if any error. Warnings never fail. On GitHub Actions, findings are
also emitted as annotations so they show up on the pull request.
"""
from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
COMPONENT = REPO / "components" / "alarm_sound_detector"
PRESETS_DIR = COMPONENT / "presets"
sys.path.insert(0, str(COMPONENT))
import preset_util  # noqa: E402

NON_PRESETS = {"index.json", "preset.schema.json"}
MAX_TEMPLATE_BYTES = 40 * 1024   # history buffer in RAM is the same size; ESP32 without PSRAM
MAX_FRAMES = 625                 # 10 s at 62.5 frames/s


def preset_files() -> list[Path]:
    return sorted(p for p in PRESETS_DIR.glob("*.json") if p.name not in NON_PRESETS)


class Report:
    def __init__(self) -> None:
        self.errors = 0
        self.warnings = 0
        self.gha = os.environ.get("GITHUB_ACTIONS") == "true"

    def _emit(self, kind: str, path: Path, msg: str) -> None:
        rel = path.relative_to(REPO) if path.is_relative_to(REPO) else path
        print(f"{kind.upper()}: {rel}: {msg}")
        if self.gha:
            print(f"::{kind} file={rel},title=Preset check::{msg}")

    def error(self, path: Path, msg: str) -> None:
        self.errors += 1
        self._emit("error", path, msg)

    def warn(self, path: Path, msg: str) -> None:
        self.warnings += 1
        self._emit("warning", path, msg)


def check_file(path: Path, rep: Report, schema_validator) -> dict | None:
    try:
        doc = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        rep.error(path, f"not valid JSON: {exc}")
        return None
    if not isinstance(doc, dict):
        rep.error(path, "top level must be a JSON object")
        return None

    schema_errors = sorted(schema_validator.iter_errors(doc), key=lambda e: list(e.absolute_path))
    for e in schema_errors:
        where = "/".join(str(p) for p in e.absolute_path) or "(top level)"
        rep.error(path, f"schema: {where}: {e.message}")
    if schema_errors:
        return None

    try:
        loaded = preset_util.validate_v2(doc, path.name)
    except preset_util.PresetError as exc:
        rep.error(path, str(exc))
        return None

    if path.stem != doc["id"]:
        rep.error(path, f"file name must match the preset id: rename to {doc['id']}.json")

    # Template plausibility (quantize_template scales to +-127 around zero mean).
    data = loaded["data_int8"]
    n = len(data)
    peak = max(abs(v) for v in data)
    mean = sum(data) / n
    if peak < 100:
        rep.error(path, f"template looks wrongly quantised (max |value| {peak}, expected ~127)")
    if abs(mean) > 2:
        rep.error(path, f"template is not zero-mean (mean {mean:.2f}); rebuild it with the studio or make_template.py")
    if len(set(data)) < 8:
        rep.error(path, "template is (almost) constant; it cannot match anything")
    if n > MAX_TEMPLATE_BYTES:
        rep.error(path, f"template is {n} bytes (> {MAX_TEMPLATE_BYTES}); shorten the sound length or narrow the band")
    if doc["frames"] > MAX_FRAMES:
        rep.error(path, f"sound length {doc['frames'] / 62.5:.1f} s is longer than 10 s")
    elif doc["frames"] < 8:
        rep.warn(path, f"sound length {doc['frames'] / 62.5:.2f} s is very short; matches may be unreliable")

    det = doc["detection"]
    per = det.get("period_s")
    if per is not None:
        if det["release_s"] <= per:
            rep.error(path, f"release_s ({det['release_s']}) must be longer than period_s ({per}), "
                            "otherwise the alarm switches off between repetitions")
        if det["refractory_s"] >= per:
            rep.error(path, f"refractory_s ({det['refractory_s']}) must be shorter than period_s ({per})")
        if det["period_tolerance_s"] >= per / 2:
            rep.error(path, f"period_tolerance_s ({det['period_tolerance_s']}) must be less than half the period")
        if doc["frames"] / 62.5 > per:
            rep.warn(path, "the sound length is longer than the repetition period")
    elif det["min_repetitions"] > 1 and det["release_s"] < 1:
        rep.warn(path, "single-sound preset needs several repetitions within a very short release_s")
    if not 0.3 <= det["threshold"] <= 0.95:
        rep.warn(path, f"unusual threshold {det['threshold']} (typical 0.45–0.8)")

    prov = doc["provenance"]
    if prov.get("n_examples", 0) < 3:
        rep.warn(path, f"built from only {prov.get('n_examples', 0)} example(s); 3+ from different occurrences is better")
    if not prov.get("tested_against"):
        rep.warn(path, "provenance.tested_against is empty; list the confusing sounds it was checked against")
    return doc


def main(argv: list[str]) -> int:
    try:
        from jsonschema import Draft7Validator
    except ImportError:
        print("ERROR: pip install jsonschema (see tools/requirements.txt)")
        return 2
    schema = json.loads(preset_util.SCHEMA_PATH.read_text())
    Draft7Validator.check_schema(schema)
    validator = Draft7Validator(schema)

    files = [Path(a).resolve() for a in argv] or preset_files()
    rep = Report()
    names: dict[str, Path] = {}
    for path in files:
        doc = check_file(path, rep, validator)
        if not doc:
            continue
        for name in [doc["id"], *doc.get("aliases", [])]:
            if name in names and names[name] != path:
                rep.error(path, f"name {name!r} is already used by {names[name].name}")
            names.setdefault(name, path)
    print(f"{len(files)} preset(s) checked: {rep.errors} error(s), {rep.warnings} warning(s)")
    return 1 if rep.errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
