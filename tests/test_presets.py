"""Preset catalog tests (no audio, no hardware).

- Every presets/*.json validates against preset.schema.json (plus the
  cross-field checks in tools/presets/build_index.py).
- presets/index.json is up to date with build_index.py output.
"""
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PRESETS_DIR = REPO / "components" / "alarm_sound_detector" / "presets"
TOOLS_PRESETS = REPO / "tools" / "presets"

sys.path.insert(0, str(TOOLS_PRESETS))
from build_index import (  # noqa: E402
    SCHEMA_PATH,
    INDEX_PATH,
    build_index,
    load_schema,
    validate_preset,
)


def _preset_docs():
    docs = []
    for path in sorted(PRESETS_DIR.glob("*.json")):
        if path.name in ("index.json", "preset.schema.json"):
            continue
        docs.append((path, json.loads(path.read_text())))
    assert docs, "no presets found"
    return docs


def test_every_preset_validates_against_schema():
    schema = load_schema()
    assert json.loads(SCHEMA_PATH.read_text()) == schema
    for path, doc in _preset_docs():
        validate_preset(doc, schema)  # raises on failure


def test_tm6_preset_keeps_legacy_values():
    docs = dict((d["id"], d) for _, d in _preset_docs())
    tm6 = docs["vorwerk_thermomix_tm6_alarm"]
    assert "thermomix_tm6" in tm6["aliases"]
    assert (tm6["bin_lo"], tm6["bin_hi"], tm6["frames"], tm6["bins"]) == (13, 144, 81, 132)
    det = tm6["detection"]
    assert det == {
        "threshold": 0.55, "near_threshold": 0.35, "min_repetitions": 2,
        "period_s": 3.125, "period_tolerance_s": 0.25,
        "refractory_s": 1.5, "release_s": 7.25,
    }
    assert tm6["provenance"]["n_examples"] == 23


def test_index_is_up_to_date():
    expected = json.dumps({"presets": build_index()}, indent=1) + "\n"
    assert INDEX_PATH.is_file(), "presets/index.json missing"
    assert INDEX_PATH.read_text() == expected, (
        "presets/index.json is stale; run tools/presets/build_index.py")


def test_index_check_mode_passes():
    r = subprocess.run(
        [sys.executable, str(TOOLS_PRESETS / "build_index.py"), "--check"],
        capture_output=True, text=True, cwd=REPO)
    assert r.returncode == 0, f"--check failed:\n{r.stdout}\n{r.stderr}"


# ------------------------------------------------- template resolution ---

import pytest  # noqa: E402

REPO_COMPONENTS = REPO / "components" / "alarm_sound_detector"
sys.path.insert(0, str(REPO_COMPONENTS))
import preset_util  # noqa: E402


def test_resolve_id_alias_legacy_and_file():
    by_id = preset_util.resolve_template("vorwerk_thermomix_tm6_alarm", ".")
    by_alias = preset_util.resolve_template("thermomix_tm6", ".")
    assert by_id["data_int8"] == by_alias["data_int8"]
    assert by_id["id"] == "vorwerk_thermomix_tm6_alarm"
    # A path to a v1-format file resolves with identical DSP/detection data.
    by_path = preset_util.resolve_template(
        "tests/fixtures/thermomix_tm6_v1.json", str(REPO))
    assert by_path["frames"] == by_id["frames"] == 81
    assert by_path["data_int8"] == by_id["data_int8"]
    for key in ("threshold", "near_threshold", "min_repetitions", "period_s",
                "period_tolerance_s", "refractory_s", "release_s",
                "bin_lo", "bin_hi"):
        assert by_path[key] == by_id[key], key


def test_resolve_rejects_unknown_and_broken():
    with pytest.raises(preset_util.PresetError, match="Unknown template"):
        preset_util.resolve_template("dishwasher_beep", ".")
    with pytest.raises(preset_util.PresetError, match="not found"):
        preset_util.resolve_template("presets/missing.json", str(REPO))
    bad = REPO / "components" / "alarm_sound_detector" / "presets" / "bad.json"
    bad.write_text('{"format": 2}')
    try:
        with pytest.raises(preset_util.PresetError):
            preset_util.resolve_template(
                "components/alarm_sound_detector/presets/bad.json", str(REPO))
    finally:
        bad.unlink()


def test_v2_validation_rejects_bad_docs():
    import copy
    good = json.loads(
        (PRESETS_DIR / "vorwerk_thermomix_tm6_alarm.json").read_text())
    for mutate in (
        lambda d: d["detection"].update(threshold=0.2, near_threshold=0.4),
        lambda d: d.update(bins=131),
        lambda d: d["detection"].update(period_s=-1.0),
        lambda d: d.update(id="Capital_Letters"),
    ):
        broken = copy.deepcopy(good)
        mutate(broken)
        with pytest.raises(preset_util.PresetError):
            preset_util.validate_v2(broken, "<test>")
