"""capture_server codegen validation + inline presets (host-side, no hardware).

- Key rules are unit-tested against the component's own validator.
- Port clash, inline presets and the recording example go through
  `esphome config` in a scratch dir with a local external_components
  source and dummy secrets (never touches firmware/secrets.yaml).
- page.html is checked for the offline/self-contained contract.
"""
import base64
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent
COMPONENTS = REPO / "components"

sys.path.insert(0, str(COMPONENTS))
import capture_server  # noqa: E402
from alarm_sound_detector import preset_util  # noqa: E402

ESPHOME_BIN = os.environ.get(
    "ESPHOME_BIN", str(Path(sys.executable).parent / "esphome"))
TM6 = REPO / "components" / "alarm_sound_detector" / "presets" / "vorwerk_thermomix_tm6_alarm.json"
TM6_EXAMPLE = REPO / "examples" / "stamp-s3-inmp441-thermomix-tm6.yaml"
REC_EXAMPLE = REPO / "examples" / "stamp-s3-inmp441-recording.yaml"


# ------------------------------------------------- key rules ---

@pytest.mark.parametrize("key", [
    "abcdefghijklmnop",
    "A1-________xyz09",
    "x" * 64,
    "CAPTURE-key_01-02",
])
def test_valid_keys_pass(key):
    assert capture_server.validate_key(key) == key


@pytest.mark.parametrize("key", [
    "short",
    "",
    "has space in key 123",
    "bad!char#01234567",
    "dollar$ign01234567",
])
def test_invalid_keys_fail(key):
    import esphome.config_validation as cv

    with pytest.raises(cv.Invalid):
        capture_server.validate_key(key)


# ------------------------------------------------- page.html ---

def test_page_is_self_contained_and_small():
    page = REPO / "components" / "capture_server" / "page.html"
    raw = page.read_bytes()
    assert len(raw) < 40 * 1024, f"page.html is {len(raw)} bytes (> 40 KiB)"
    text = raw.decode("utf-8")
    # No external requests at all: no src=/href= resources, no URLs.
    # (a.href= below is only blob: download links, not network.)
    assert "src=\"" not in text and "src='" not in text
    assert "href=\"" not in text and "href='" not in text
    assert "http://" not in text and "https://" not in text
    assert "@import" not in text and "url(" not in text
    # Contract hooks the studio side relies on.
    for needle in ("#k=", "sessionStorage", "/api/info", "/api/stream",
                   "asd-studio-ready", "asd-capture-clips",
                   "asd-capture-received", "sampleRate:16000",
                   "Authorization", "indexedDB"):
        assert needle in text, needle


# ------------------------------------------------- inline presets ---

def test_inline_preset_validates_like_file():
    doc = json.loads(TM6.read_text())
    preset = preset_util.normalize_v2(
        preset_util.validate_v2(dict(doc), "inline template:"))
    by_id = preset_util.resolve_template("vorwerk_thermomix_tm6_alarm", ".")
    assert preset == by_id


def test_inline_preset_rejects_bad_docs():
    import copy

    doc = json.loads(TM6.read_text())
    broken = copy.deepcopy(doc)
    broken["detection"]["near_threshold"] = 0.7
    with pytest.raises(preset_util.PresetError):
        preset_util.validate_v2(broken, "inline template:")
    broken = copy.deepcopy(doc)
    broken["bins"] = 10
    with pytest.raises(preset_util.PresetError):
        preset_util.validate_v2(broken, "inline template:")


# ------------------------------------------------- esphome config checks ---

def _write_scratch(tmp_path: Path, base_example: Path, mutate=None) -> Path:
    text = base_example.read_text()
    text = text.replace(
        "- source: github://gl0wa/esphome-alarm-sound-detector@main",
        f"- source: {{ type: local, path: {REPO / 'components'} }}",
    )
    if mutate is not None:
        text = mutate(text)
    target = tmp_path / base_example.name
    target.write_text(text)
    (tmp_path / "secrets.yaml").write_text(
        "wifi_ssid: \"ci\"\n"
        "wifi_password: \"ci-password\"\n"
        f"api_encryption_key: \"{base64.b64encode(b'0' * 32).decode()}\"\n"
        "capture_key: \"test-capture-key-01\"\n"
    )
    return target


def _esphome_config(target: Path):
    return subprocess.run(
        [ESPHOME_BIN, "config", str(target)],
        capture_output=True, text=True, cwd=target.parent, timeout=300,
    )


def _inline_template_mutate(doc_mutate=None):
    def mutate(text: str) -> str:
        doc = json.loads(TM6.read_text())
        if doc_mutate is not None:
            doc_mutate(doc)
        dumped = yaml.safe_dump(doc, default_flow_style=False, sort_keys=False)
        indented = "\n".join(
            ("      " + line) if line.strip() else line
            for line in dumped.splitlines()
        )
        new, n = re.subn(r"^    template:.*$", "    template:\n" + indented,
                         text, count=1, flags=re.M)
        assert n == 1, "template: line not found"
        return new

    return mutate


def test_recording_example_validates(tmp_path):
    target = _write_scratch(tmp_path, REC_EXAMPLE)
    r = _esphome_config(target)
    assert r.returncode == 0, f"esphome config failed:\n{r.stdout}\n{r.stderr}"


def test_port_conflict_with_web_server_fails(tmp_path):
    def mutate(text):
        return text + "\nweb_server:\n  port: 80\n"

    target = _write_scratch(tmp_path, REC_EXAMPLE, mutate)
    r = _esphome_config(target)
    assert r.returncode != 0, f"expected a port-clash failure:\n{r.stdout}"
    assert "clash" in (r.stdout + r.stderr), r.stdout


def test_web_server_on_other_port_passes(tmp_path):
    def mutate(text):
        return text + "\nweb_server:\n  port: 8080\n"

    target = _write_scratch(tmp_path, REC_EXAMPLE, mutate)
    r = _esphome_config(target)
    assert r.returncode == 0, f"esphome config failed:\n{r.stdout}\n{r.stderr}"


def test_inline_preset_config_passes(tmp_path):
    target = _write_scratch(tmp_path, TM6_EXAMPLE, _inline_template_mutate())
    r = _esphome_config(target)
    assert r.returncode == 0, f"esphome config failed:\n{r.stdout}\n{r.stderr}"


def test_inline_preset_config_rejects_broken(tmp_path):
    def break_threshold(doc):
        doc["detection"]["near_threshold"] = 0.7

    target = _write_scratch(tmp_path, TM6_EXAMPLE, _inline_template_mutate(break_threshold))
    r = _esphome_config(target)
    assert r.returncode != 0, f"expected an inline-preset failure:\n{r.stdout}"
    assert "near_threshold" in (r.stdout + r.stderr), r.stdout
