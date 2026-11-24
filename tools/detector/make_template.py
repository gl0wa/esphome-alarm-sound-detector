"""Build a detector template from labelled recordings.

Usage: make_template.py --session data/recordings/session1 --name thermomix_tm6 \
          --out components/alarm_sound_detector/templates/thermomix_tm6.json
The output contains only an averaged, quantised spectral template (no audio).
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
    ap.add_argument("--name", required=True)
    ap.add_argument("--duration", type=float, default=1.3, help="template length (s)")
    ap.add_argument("--period", type=float, default=3.125, help="repetition period (s)")
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()

    fps = ref.SR / ref.HOP
    W = int(round(a.duration * fps))
    windows = []
    for sdir in a.session:
        x, lab = load_session(sdir)
        feat = ref.above_floor(ref.frames_db(x))
        masked = set(lab.get("masked_units", []))
        starts = [int(round(u * fps)) for u in lab["units"] if u not in masked]
        base = feat[starts[0]:starts[0] + W]
        for s in starts:  # refine alignment (+-8 frames) against the first unit
            best = max(range(max(0, s - 8), s + 9),
                       key=lambda k: np.corrcoef(base.ravel(), feat[k:k + W].ravel())[0, 1])
            windows.append(feat[best:best + W])
    tmpl = np.mean(windows, axis=0)
    q = ref.quantize_template(tmpl)
    doc = {
        "name": a.name, "format": 1,
        "sample_rate": ref.SR, "n_fft": ref.N_FFT, "hop": ref.HOP,
        "bin_lo": ref.BIN_LO, "bin_hi": ref.BIN_HI,
        "frames": int(q.shape[0]), "bins": int(q.shape[1]),
        "period_s": a.period, "n_examples": len(windows),
        "data_int8_b64": base64.b64encode(q.tobytes()).decode(),
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"wrote {a.out}: {q.shape[0]} frames x {q.shape[1]} bins from {len(windows)} examples")


if __name__ == "__main__":
    main()
