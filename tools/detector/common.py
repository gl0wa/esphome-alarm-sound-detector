"""Shared helpers: load recordings + labels (local, gitignored data/)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

import ref


def load_16k(path: Path) -> np.ndarray:
    x, sr = sf.read(path, dtype="float64")
    if x.ndim > 1:
        x = x[:, 0]
    x = x - x.mean()
    if sr != ref.SR:
        from math import gcd
        g = gcd(sr, ref.SR)
        x = resample_poly(x, ref.SR // g, sr // g)
    return x.astype(np.float32)


def load_session(session_dir: Path) -> tuple[np.ndarray, dict]:
    labels = json.loads((session_dir / "labels.json").read_text())
    return load_16k(session_dir / labels["file"]), labels
