"""Shared preset loading/validation for alarm_sound_detector (stdlib only).

Used by the ESPHome codegen (``__init__.py``) and by
``tools/presets/build_index.py`` so both enforce the same rules. Must stay
free of ESPHome imports: the tools side runs outside ESPHome.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

COMPONENT_DIR = Path(__file__).resolve().parent
PRESETS_DIR = COMPONENT_DIR / "presets"
SCHEMA_PATH = PRESETS_DIR / "preset.schema.json"
INDEX_PATH = PRESETS_DIR / "index.json"

# DSP geometry every preset must match (the portable core is fixed at
# 16 kHz / 512-point FFT / 256-sample hop).
CORE_SR = 16000
CORE_N_FFT = 512
CORE_HOP = 256

# Detection defaults for v1 templates (which carry no detection block):
# the TM6 values the component shipped with.
V1_DEFAULT_THRESHOLD = 0.55
V1_DEFAULT_NEAR_THRESHOLD = 0.35
V1_DEFAULT_MIN_REPETITIONS = 2
V1_DEFAULT_PERIOD_TOL_S = 0.25
V1_DEFAULT_REFRACTORY_S = 1.5


class PresetError(ValueError):
    """Raised when a preset reference cannot be resolved or is invalid."""


def _fail(msg: str) -> PresetError:
    return PresetError(msg)


def validate_v2(doc: dict, source: str) -> dict:
    """Validate a v2 preset doc; returns it unchanged. Raises PresetError."""
    import re

    def err(msg: str) -> PresetError:
        return PresetError(f"Invalid preset {source}: {msg}")

    try:
        schema = json.loads(SCHEMA_PATH.read_text())
    except OSError as exc:
        raise PresetError(f"Cannot read preset schema: {exc}") from exc

    # Structural check against preset.schema.json (small built-in subset:
    # const/type/required/properties/additionalProperties/minimum/maximum/
    # exclusiveMinimum/minLength/pattern/anyOf/items).
    _validate_against_schema(doc, schema, "$", err)

    if not 1 <= doc["bin_lo"] <= doc["bin_hi"] <= 255:
        raise err("bin_lo/bin_hi must satisfy 1 <= lo <= hi <= 255")
    if doc["bins"] != doc["bin_hi"] - doc["bin_lo"] + 1:
        raise err("bins must equal bin_hi - bin_lo + 1")
    det = doc["detection"]
    if not det["near_threshold"] < det["threshold"]:
        raise err("detection.near_threshold must be < detection.threshold")
    try:
        raw = base64.b64decode(doc["data_int8_b64"])
    except (ValueError, TypeError) as exc:
        raise err(f"data_int8_b64 is not valid base64: {exc}")
    if len(raw) != doc["frames"] * doc["bins"]:
        raise err(f"data has {len(raw)} bytes, expected frames*bins "
                  f"({doc['frames']}*{doc['bins']})")
    doc = dict(doc)
    doc["data_int8"] = [b if b < 128 else b - 256 for b in raw]
    return doc


def _validate_against_schema(value, schema: dict, where: str, err) -> None:
    if "anyOf" in schema:
        for sub in schema["anyOf"]:
            try:
                _validate_against_schema(value, sub, where, err)
                return
            except PresetError:
                continue
        raise err(f"{where}: does not match any allowed type")
    if "const" in schema and value != schema["const"]:
        raise err(f"{where}: expected {schema['const']!r}")
    if "type" in schema:
        want = schema["type"]
        ok = {
            "object": isinstance(value, dict),
            "array": isinstance(value, list),
            "string": isinstance(value, str),
            "integer": isinstance(value, int) and not isinstance(value, bool),
            "number": isinstance(value, (int, float)) and not isinstance(value, bool),
            "null": value is None,
        }.get(want, False)
        if not ok:
            raise err(f"{where}: expected {want}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            raise err(f"{where}: must not be empty")
        if "pattern" in schema:
            import re as _re
            if not _re.search(schema["pattern"], value):
                raise err(f"{where}: must be snake_case")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        for key in ("minimum", "maximum", "exclusiveMinimum"):
            if key in schema:
                bound = schema[key]
                bad = (value < bound if key == "minimum"
                       else value > bound if key == "maximum"
                       else value <= bound)
                if bad:
                    raise err(f"{where}: violates {key} {bound}")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                raise err(f"{where}: missing key {key!r}")
        props = schema.get("properties", {})
        for key, sub in value.items():
            if key in props:
                _validate_against_schema(sub, props[key], f"{where}.{key}", err)
            elif schema.get("additionalProperties") is False:
                raise err(f"{where}: unexpected key {key!r}")
    if isinstance(value, list) and "items" in schema:
        for i, sub in enumerate(value):
            _validate_against_schema(sub, schema["items"], f"{where}[{i}]", err)


def normalize_v1(doc: dict, source: str) -> dict:
    """Normalize a v1 template doc to the internal preset representation."""
    for key in ("format", "sample_rate", "n_fft", "hop", "bin_lo", "bin_hi",
                "frames", "bins", "period_s", "data_int8_b64"):
        if key not in doc:
            raise PresetError(f"Invalid v1 template {source}: missing key {key!r}")
    checks = [
        (doc["format"] == 1, "unsupported format (expected 1)"),
        (doc["sample_rate"] == CORE_SR, f"sample_rate must be {CORE_SR}"),
        (doc["n_fft"] == CORE_N_FFT, f"n_fft must be {CORE_N_FFT}"),
        (doc["hop"] == CORE_HOP, f"hop must be {CORE_HOP}"),
        (doc.get("bin_lo", 13) == 13, "bin_lo must be 13"),
        (doc.get("bin_hi", 144) == 144, "bin_hi must be 144"),
        (doc["frames"] > 0 and doc["bins"] == 144 - 13 + 1,
         "frames/bins mismatch the core geometry"),
        (doc["period_s"] > 0, "period_s must be positive"),
    ]
    for ok, msg in checks:
        if not ok:
            raise PresetError(f"Invalid v1 template {source}: {msg}")
    try:
        raw = base64.b64decode(doc["data_int8_b64"])
    except (ValueError, TypeError) as exc:
        raise PresetError(f"Invalid v1 template {source}: bad data: {exc}") from exc
    if len(raw) != doc["frames"] * doc["bins"]:
        raise PresetError(
            f"Invalid v1 template {source}: data has {len(raw)} bytes, "
            f"expected {doc['frames'] * doc['bins']}")
    period = float(doc["period_s"])
    return {
        "id": doc.get("name", source),
        "name": doc.get("name", source),
        "sample_rate": doc["sample_rate"],
        "n_fft": doc["n_fft"],
        "hop": doc["hop"],
        "bin_lo": doc["bin_lo"],
        "bin_hi": doc["bin_hi"],
        "frames": doc["frames"],
        "bins": doc["bins"],
        "data_int8": [b if b < 128 else b - 256 for b in raw],
        "threshold": V1_DEFAULT_THRESHOLD,
        "near_threshold": V1_DEFAULT_NEAR_THRESHOLD,
        "min_repetitions": V1_DEFAULT_MIN_REPETITIONS,
        "period_s": period,
        "period_tolerance_s": V1_DEFAULT_PERIOD_TOL_S,
        "refractory_s": V1_DEFAULT_REFRACTORY_S,
        "release_s": 2 * period + 1,
    }


def normalize_v2(doc: dict) -> dict:
    """Flatten a validated v2 preset doc to the internal representation."""
    det = doc["detection"]
    return {
        "id": doc["id"],
        "name": doc["name"],
        "sample_rate": doc["sample_rate"],
        "n_fft": doc["n_fft"],
        "hop": doc["hop"],
        "bin_lo": doc["bin_lo"],
        "bin_hi": doc["bin_hi"],
        "frames": doc["frames"],
        "bins": doc["bins"],
        "data_int8": doc["data_int8"],
        "threshold": float(det["threshold"]),
        "near_threshold": float(det["near_threshold"]),
        "min_repetitions": int(det["min_repetitions"]),
        "period_s": None if det["period_s"] is None else float(det["period_s"]),
        "period_tolerance_s": float(det["period_tolerance_s"]),
        "refractory_s": float(det["refractory_s"]),
        "release_s": float(det["release_s"]),
    }


def _iter_v2_presets() -> dict:
    """Map every preset id and alias -> preset file path."""
    mapping: dict[str, Path] = {}
    if not PRESETS_DIR.is_dir():
        return mapping
    for path in sorted(PRESETS_DIR.glob("*.json")):
        if path.name in ("index.json", "preset.schema.json"):
            continue
        try:
            doc = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        pid = doc.get("id", path.stem)
        mapping.setdefault(pid, path)
        mapping.setdefault(path.stem, path)
        for alias in doc.get("aliases", []) or []:
            mapping.setdefault(alias, path)
    return mapping


def resolve_template(ref: str, config_dir: str | Path) -> dict:
    """Resolve a ``template:`` value to the normalized internal preset.

    Accepts a v2 preset id, a preset alias, a legacy v1 builtin name, or a
    path to a JSON file (v1 or v2) relative to the YAML file. Raises
    PresetError with a human-readable message on any failure.
    """
    ref = str(ref)
    p = Path(ref)
    if len(p.parts) == 1 and p.suffix == "":
        # Bare name: bundled preset id or alias.
        mapping = _iter_v2_presets()
        if ref in mapping:
            return _load_file(mapping[ref])
        known = sorted(mapping)
        hint = f" (known: {', '.join(known)})" if known else ""
        raise PresetError(f"Unknown template {ref!r}{hint}. Use a preset id, "
                          f"an alias, or a path to a JSON file.")
    base = Path(config_dir) if config_dir else Path.cwd()
    candidate = p if p.is_absolute() else (base / p)
    if not candidate.is_file():
        raise PresetError(f"Template file not found: {candidate} "
                          f"(resolved relative to the YAML file)")
    return _load_file(candidate)


def _load_file(path: Path) -> dict:
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise PresetError(f"Cannot read template {path}: {exc}") from exc
    if not isinstance(doc, dict) or "format" not in doc:
        raise PresetError(f"Invalid template {path}: missing key 'format'")
    if doc["format"] == 2:
        return normalize_v2(validate_v2(doc, str(path)))
    if doc["format"] == 1:
        return normalize_v1(doc, str(path))
    raise PresetError(f"Invalid template {path}: unsupported format {doc['format']!r} "
                      f"(expected 1 or 2)")
