"""Build a detector preset from labelled recordings.

Usage: make_template.py --session data/recordings/session1 --id vorwerk_thermomix_tm6_alarm ...
The output is a v2 preset JSON (see components/alarm_sound_detector/presets/
preset.schema.json): an averaged, quantised spectral template plus the DSP
band and detection parameters — no audio. Spectral band defaults to
400-4500 Hz; pass --band-hz LO HI and/or --duration to cover another sound.
Pass --no-period for a non-repeating (single-sound) preset.

(... --name is kept as a deprecated alias of --id.)
"""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

import numpy as np

import ref
from common import load_session


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", action="append", required=True, type=Path)
    ap.add_argument("--id", default=None,
                    help="snake_case preset id, e.g. vorwerk_thermomix_tm6_alarm")
    ap.add_argument("--name", default=None, help="deprecated alias of --id")
    ap.add_argument("--alias", action="append", default=[],
                    help="extra alias for the preset (repeatable)")
    ap.add_argument("--manufacturer", default="")
    ap.add_argument("--model", default="")
    ap.add_argument("--sound", default="")
    ap.add_argument("--description", default="")
    ap.add_argument("--band-hz", nargs=2, type=float, default=(400.0, 4500.0),
                    metavar=("LO", "HI"))
    ap.add_argument("--duration", type=float, default=1.3, help="template length (s)")
    ap.add_argument("--period", type=float, default=3.125,
                    help="repetition period (s)")
    ap.add_argument("--no-period", action="store_true",
                    help="non-repeating sound: period_s is null, chaining by release_s")
    ap.add_argument("--threshold", type=float, default=0.55)
    ap.add_argument("--near-threshold", type=float, default=0.35)
    ap.add_argument("--min-repetitions", type=int, default=2)
    ap.add_argument("--period-tolerance", type=float, default=0.25)
    ap.add_argument("--refractory", type=float, default=1.5)
    ap.add_argument("--release", type=float, default=None,
                    help="alarm-off delay (s); defaults to 2*period+1 for periodic presets")
    ap.add_argument("--tested-against", default="",
                    help="comma-separated list of confuser sounds checked")
    ap.add_argument("--validation", default="")
    ap.add_argument("--notes", default="")
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()

    preset_id = a.id or a.name
    if not preset_id:
        raise SystemExit("pass --id <snake_case preset id>")
    if a.no_period and a.release is None:
        raise SystemExit("--no-period requires an explicit --release (s)")

    lo_hz, hi_hz = a.band_hz
    bin_lo = int(np.ceil(lo_hz * ref.N_FFT / ref.SR))
    bin_hi = int(np.floor(hi_hz * ref.N_FFT / ref.SR))
    if not 1 <= bin_lo <= bin_hi <= ref.N_FFT // 2:
        raise SystemExit(f"band {lo_hz}-{hi_hz} Hz maps to bins {bin_lo}..{bin_hi}, "
                         f"out of the 1..{ref.N_FFT // 2} range")

    fps = ref.SR / ref.HOP
    W = int(round(a.duration * fps))
    windows = []
    for sdir in a.session:
        x, lab = load_session(sdir)
        feat = ref.above_floor(ref.frames_db(x, bin_lo, bin_hi))
        masked = set(lab.get("masked_units", []))
        starts = [int(round(u * fps)) for u in lab["units"] if u not in masked]
        base = feat[starts[0]:starts[0] + W]
        for s in starts:  # refine alignment (+-8 frames) against the first unit
            best = max(range(max(0, s - 8), s + 9),
                       key=lambda k: np.corrcoef(base.ravel(), feat[k:k + W].ravel())[0, 1])
            windows.append(feat[best:best + W])
    tmpl = np.mean(windows, axis=0)
    q = ref.quantize_template(tmpl)
    period_s = None if a.no_period else a.period
    release_s = a.release if a.release is not None else 2 * a.period + 1
    doc = {
        "format": 2,
        "id": preset_id,
        "aliases": a.alias,
        "name": f"{a.manufacturer} {a.model} {a.sound}".strip() or preset_id,
        "manufacturer": a.manufacturer,
        "model": a.model,
        "sound": a.sound,
        "description": a.description,
        "sample_rate": ref.SR, "n_fft": ref.N_FFT, "hop": ref.HOP,
        "bin_lo": bin_lo, "bin_hi": bin_hi,
        "frames": int(q.shape[0]), "bins": int(q.shape[1]),
        "data_int8_b64": base64.b64encode(q.tobytes()).decode(),
        "detection": {
            "threshold": a.threshold,
            "near_threshold": a.near_threshold,
            "min_repetitions": a.min_repetitions,
            "period_s": period_s,
            "period_tolerance_s": a.period_tolerance,
            "refractory_s": a.refractory,
            "release_s": release_s,
        },
        "provenance": {
            "n_examples": len(windows),
            "tested_against": [s.strip() for s in a.tested_against.split(",") if s.strip()],
            "validation": a.validation,
            "notes": a.notes,
        },
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"wrote {a.out}: {q.shape[0]} frames x {q.shape[1]} bins "
          f"(bins {bin_lo}..{bin_hi}) from {len(windows)} examples")


if __name__ == "__main__":
    main()
