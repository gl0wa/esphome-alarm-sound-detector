"""Evaluate the streaming reference detector on labelled sessions.

Reports per-episode detection and latency, unit recall, false alarms and
the highest score outside labelled alarm periods.
"""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

import numpy as np

import ref
from common import load_session


def load_template(path: Path) -> np.ndarray:
    d = json.loads(path.read_text())
    return np.frombuffer(base64.b64decode(d["data_int8_b64"]), np.int8).reshape(d["frames"], d["bins"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--template", required=True, type=Path)
    ap.add_argument("--session", action="append", required=True, type=Path)
    ap.add_argument("--threshold", type=float, default=0.55)
    ap.add_argument("--min-repetitions", type=int, default=2)
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    qt = load_template(a.template)
    tot_fa = 0
    for sdir in a.session:
        x, lab = load_session(sdir)
        det = ref.StreamingDetector(qt, threshold=a.threshold, min_repetitions=a.min_repetitions)
        events, max_neg = [], 0.0
        eps = lab["episodes"]
        for i, row in enumerate(ref.frames_db(x)):
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
