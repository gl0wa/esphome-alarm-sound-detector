"""Build components/alarm_sound_detector/presets/index.json.

Scans presets/*.json (v2 format), validates each against preset.schema.json
with a small built-in validator (no third-party dependencies, so it also
runs in CI without extra installs), and writes a catalog with one entry
per preset: id, aliases, name, manufacturer, model, sound, band, duration,
mode summary and validation provenance.

Usage:  python3 tools/presets/build_index.py [--check]
  --check: exit 1 if index.json is out of date (used by tests/test_presets.py).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
PRESETS_DIR = REPO / "components" / "alarm_sound_detector" / "presets"
SCHEMA_PATH = PRESETS_DIR / "preset.schema.json"
INDEX_PATH = PRESETS_DIR / "index.json"

sys.path.insert(0, str(REPO / "components" / "alarm_sound_detector"))
import preset_util  # noqa: E402  (single source of truth for validation)

SchemaError = preset_util.PresetError


def validate_preset(doc: dict, schema: dict) -> None:
    """Validate a preset doc (schema param kept for the test API)."""
    preset_util.validate_v2(doc, "<preset>")


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text())


def iter_preset_paths():
    for path in sorted(PRESETS_DIR.glob("*.json")):
        if path.name in ("index.json", "preset.schema.json"):
            continue
        yield path


def catalog_entry(doc: dict) -> dict:
    det = doc["detection"]
    lo_hz = doc["bin_lo"] * doc["sample_rate"] / doc["n_fft"]
    hi_hz = doc["bin_hi"] * doc["sample_rate"] / doc["n_fft"]
    period = det["period_s"]
    if period is None:
        mode = f"single (min_rep {det['min_repetitions']})"
    else:
        mode = (f"periodic {period:g}s +- {det['period_tolerance_s']:g}s, "
                f"min_rep {det['min_repetitions']}")
    return {
        "id": doc["id"],
        "aliases": doc.get("aliases", []),
        "name": doc["name"],
        "manufacturer": doc["manufacturer"],
        "model": doc["model"],
        "sound": doc["sound"],
        "band": f"{lo_hz:g}-{hi_hz:g} Hz (bins {doc['bin_lo']}..{doc['bin_hi']})",
        "duration_s": round(doc["frames"] * doc["hop"] / doc["sample_rate"], 3),
        "mode": mode,
        "validation": doc["provenance"]["validation"],
    }


def build_index() -> list[dict]:
    load_schema()  # fail early if the schema itself is unreadable
    entries, seen_ids, seen_names = [], set(), set()
    for path in iter_preset_paths():
        doc = json.loads(path.read_text())
        try:
            preset_util.validate_v2(doc, path.name)
        except preset_util.PresetError as err:
            raise SystemExit(f"{path.name}: invalid preset: {err}")
        if path.stem != doc["id"]:
            raise SystemExit(f"{path.name}: filename must match preset id {doc['id']!r}")
        for alias in doc.get("aliases", []):
            if alias in seen_names:
                raise SystemExit(f"{path.name}: alias {alias!r} collides with another id/alias")
            seen_names.add(alias)
        if doc["id"] in seen_ids:
            raise SystemExit(f"{path.name}: duplicate preset id {doc['id']!r}")
        seen_ids.add(doc["id"])
        seen_names.add(doc["id"])
        entries.append(catalog_entry(doc))
    return entries


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    entries = build_index()
    doc = {"presets": entries}
    text = json.dumps(doc, indent=1) + "\n"
    if a.check:
        if not INDEX_PATH.is_file() or INDEX_PATH.read_text() != text:
            print(f"{INDEX_PATH} is out of date; run tools/presets/build_index.py")
            sys.exit(1)
        print(f"{INDEX_PATH} is up to date ({len(entries)} preset(s)).")
    else:
        INDEX_PATH.write_text(text)
        print(f"wrote {INDEX_PATH} ({len(entries)} preset(s))")


if __name__ == "__main__":
    main()
