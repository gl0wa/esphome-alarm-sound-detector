"""tools/presets/validate.py catches broken or inconsistent presets."""
import base64
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "tools" / "presets"))
import validate  # noqa: E402

TM6 = REPO / "components/alarm_sound_detector/presets/vorwerk_thermomix_tm6_alarm.json"


def run(tmp_path, capsys, mutate, name=None):
    doc = json.loads(TM6.read_text())
    mutate(doc)
    p = tmp_path / f"{name or doc['id']}.json"
    p.write_text(json.dumps(doc))
    rc = validate.main([str(p)])
    return rc, capsys.readouterr().out


def test_bundled_presets_pass(capsys):
    assert validate.main([]) == 0, capsys.readouterr().out


def test_good_copy_passes(tmp_path, capsys):
    rc, out = run(tmp_path, capsys, lambda d: None)
    assert rc == 0, out


@pytest.mark.parametrize("mutate, expect", [
    (lambda d: d.pop("model"), "'model' is a required property"),
    (lambda d: d.update(id="Bad-Id"), "does not match"),
    (lambda d: d.update(extra_field=1), "Additional properties"),
    (lambda d: d["detection"].update(threshold=1.5), "threshold"),
    (lambda d: d["detection"].update(near_threshold=0.7), "near_threshold must be <"),
    (lambda d: d.update(bins=10), "bins must equal"),
    (lambda d: d.update(data_int8_b64=base64.b64encode(b"\x01" * 100).decode()), "expected frames*bins"),
    (lambda d: d["detection"].update(release_s=2.0), "release_s (2.0) must be longer than period_s"),
    (lambda d: d["detection"].update(refractory_s=4.0), "refractory_s (4.0) must be shorter"),
    (lambda d: d["detection"].update(period_tolerance_s=2.0), "less than half the period"),
    (lambda d: d.update(data_int8_b64=base64.b64encode(bytes(d["frames"] * d["bins"])).decode()), "wrongly quantised"),
])
def test_broken_presets_fail(tmp_path, capsys, mutate, expect):
    rc, out = run(tmp_path, capsys, mutate, name="vorwerk_thermomix_tm6_alarm")
    assert rc == 1 and expect in out, out


def test_file_name_must_match_id(tmp_path, capsys):
    rc, out = run(tmp_path, capsys, lambda d: None, name="something_else")
    assert rc == 1 and "rename to vorwerk_thermomix_tm6_alarm.json" in out


def test_duplicate_names_across_presets(tmp_path, capsys):
    a = json.loads(TM6.read_text())
    b = dict(a, id="other_preset", aliases=["thermomix_tm6"])  # alias clashes with a's alias
    (tmp_path / "vorwerk_thermomix_tm6_alarm.json").write_text(json.dumps(a))
    (tmp_path / "other_preset.json").write_text(json.dumps(b))
    rc = validate.main([str(tmp_path / "vorwerk_thermomix_tm6_alarm.json"), str(tmp_path / "other_preset.json")])
    out = capsys.readouterr().out
    assert rc == 1 and "'thermomix_tm6' is already used" in out


def test_warnings_do_not_fail(tmp_path, capsys):
    rc, out = run(tmp_path, capsys, lambda d: d["provenance"].update(n_examples=1, tested_against=[]))
    assert rc == 0 and out.count("WARNING") == 2, out


def test_github_annotations(tmp_path, capsys, monkeypatch):
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    rc, out = run(tmp_path, capsys, lambda d: d["detection"].update(release_s=2.0), name="vorwerk_thermomix_tm6_alarm")
    assert rc == 1 and "::error file=" in out
