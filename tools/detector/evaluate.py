"""Evaluate the streaming reference detector on labelled sessions.

Reports per-episode detection and latency, unit recall, false alarms and
the highest score outside labelled alarm periods.

Detection parameters default to the preset's own (v1 templates use the
legacy component defaults); pass CLI flags to override them.
"""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

import numpy as np

import ref
from common import load_session


def load_preset(path: Path) -> tuple[np.ndarray, dict]:
    """Returns (quantised template, detection-params dict). Handles v1/v2."""
    d = json.loads(path.read_text())
    fmt = d.get("format", 1)
    q = np.frombuffer(base64.b64decode(d["data_int8_b64"]), np.int8).reshape(
        d["frames"], d["bins"])
    if fmt == 2:
        det = dict(d["detection"])
        params = {
            "threshold": det["threshold"],
            "near_threshold": det["near_threshold"],
            "min_repetitions": det["min_repetitions"],
            "period_s": det["period_s"],
            "period_tol_s": det["period_tolerance_s"],
            "refractory_s": det["refractory_s"],
            "release_s": det["release_s"],
        }
        band = {"bin_lo": d["bin_lo"], "bin_hi": d["bin_hi"]}
    elif fmt == 1:
        params = {
            "threshold": 0.55,
            "near_threshold": 0.35,
            "min_repetitions": 2,
            "period_s": float(d["period_s"]),
            "period_tol_s": 0.25,
            "refractory_s": 1.5,
            "release_s": 2 * float(d["period_s"]) + 1,
        }
        band = {"bin_lo": d["bin_lo"], "bin_hi": d["bin_hi"]}
    else:
        raise SystemExit(f"{path}: unsupported format {fmt!r}")
    return q, params, band


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", required=True, type=Path)
    ap.add_argument("--session", action="append", required=True, type=Path)
    ap.add_argument("--threshold", type=float, default=None)
    ap.add_argument("--near-threshold", type=float, default=None)
    ap.add_argument("--min-repetitions", type=int, default=None)
    ap.add_argument("--period", type=float, default=None)
    ap.add_argument("--period-tolerance", type=float, default=None)
    ap.add_argument("--refractory", type=float, default=None)
    ap.add_argument("--release", type=float, default=None)
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    qt, preset_params, band = load_preset(a.template)
    params = dict(preset_params)
    for key, val in (("threshold", a.threshold),
                     ("near_threshold", a.near_threshold),
                     ("min_repetitions", a.min_repetitions),
                     ("period_s", a.period),
                     ("period_tol_s", a.period_tolerance),
                     ("refractory_s", a.refractory),
                     ("release_s", a.release)):
        if val is not None:
            params[key] = val
    print(f"preset {a.template.name}: " +
          ", ".join(f"{k}={v}" for k, v in params.items()))
    tot_fa = 0
    for sdir in a.session:
        x, lab = load_session(sdir)
        det = ref.StreamingDetector(qt, bin_lo=band["bin_lo"],
                                    bin_hi=band["bin_hi"], **params)
        events, max_neg = [], 0.0
        eps = lab["episodes"]
        for i, row in enumerate(ref.frames_db(x, band["bin_lo"], band["bin_hi"])):
            ev = det.feed_frame_db(row)
            events += ev
            t = (i + 1) * ref.HOP / ref.SR
            in_alarm = any(e["start"] <= t - 1.3 and t - 1.3 <= e["end"] + 1.0 for e in eps)
            if not in_alarm:
                max_neg = max(max_neg, det.last_score)
        if a.verbose:
            for e in events:
                print(f"  {e[0]:10s} {e[1]:8.2f}s {e[2]:.3f}")
        ons = [e for e in events if e[0] == "alarm_on"]
        units = [e for e in events if e[0] == "unit"]
        print(f"{sdir}:")
        for ep in eps:
            hit = [e for e in ons if ep["start"] <= e[1] <= ep["end"] + 3]
            print(f"  episode {ep['start']:.1f}-{ep['end']:.1f}s: "
                  + (f"detected, latency {hit[0][1] - ep['start']:.1f}s" if hit else "MISSED"))
        fa = [e for e in ons if not any(ep["start"] <= e[1] <= ep["end"] + 3 for ep in eps)]
        tot_fa += len(fa)
        gt = [u for u in lab["units"] if u not in set(lab.get("masked_units", []))]
        found = sum(any(abs(u2[1] - 1.3 - u) < 0.6 for u2 in units) for u in gt)
        print(f"  clean units found {found}/{len(gt)}; false alarms {len(fa)}; "
              f"max score outside alarms {max_neg:.3f}")
    print(f"TOTAL false alarms: {tot_fa}")


if __name__ == "__main__":
    main()
