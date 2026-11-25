"""Reference implementation of the on-device template detector.

This file is the specification for the C++ port: same framing, features,
noise-floor tracking and scoring. Keep both in sync.

Each preset carries its own spectral band (bin_lo..bin_hi) and detection
parameters; see components/alarm_sound_detector/presets/preset.schema.json.
"""

from __future__ import annotations

import numpy as np

SR = 16000
N_FFT = 512          # 32 ms window, 31.25 Hz bins
HOP = 256            # 16 ms hop
F_LO, F_HI = 400.0, 4500.0
BIN_LO = int(np.ceil(F_LO * N_FFT / SR))
BIN_HI = int(np.floor(F_HI * N_FFT / SR))
N_BINS = BIN_HI - BIN_LO + 1
FLOOR_RISE_DB_PER_S = 3.0   # noise floor creeps up this fast; drops instantly
FLOOR_RISE = FLOOR_RISE_DB_PER_S * HOP / SR

# Default detection parameters (also the TM6 preset values).
DEFAULT_THRESHOLD = 0.55
DEFAULT_NEAR_THRESHOLD = 0.35
DEFAULT_PERIOD_S = 3.125
DEFAULT_PERIOD_TOL_S = 0.25
DEFAULT_MIN_REPETITIONS = 2
DEFAULT_REFRACTORY_S = 1.5


def release_default(period_s: float | None) -> float:
    """Alarm-off delay: with TM6 parameters this equals 2*period + 1."""
    if period_s is None:
        raise ValueError("release_s must be explicit when period_s is None")
    return 2 * period_s + 1.0


def frames_db(x: np.ndarray, bin_lo: int = BIN_LO, bin_hi: int = BIN_HI) -> np.ndarray:
    """Log power (dB) of selected bins for each hop. x: float mono at SR."""
    n_bins = bin_hi - bin_lo + 1
    win = np.hanning(N_FFT + 1)[:-1].astype(np.float32)  # periodic Hann
    n = 1 + (len(x) - N_FFT) // HOP
    out = np.empty((n, n_bins), np.float32)
    for i in range(n):
        spec = np.fft.rfft(x[i * HOP:i * HOP + N_FFT] * win)
        p = spec.real[bin_lo:bin_hi + 1] ** 2 + spec.imag[bin_lo:bin_hi + 1] ** 2
        out[i] = 10 * np.log10(p + 1e-10)
    return out


def above_floor(db: np.ndarray, floor0: np.ndarray | None = None) -> np.ndarray:
    """Per-bin dB above a min-tracking noise floor (instant fall, slow rise)."""
    floor = db[0].copy() if floor0 is None else floor0.copy()
    out = np.empty_like(db)
    for i, row in enumerate(db):
        floor = np.minimum(row, floor + FLOOR_RISE)
        out[i] = row - floor
    return out


def ncc_scores(feat: np.ndarray, tmpl: np.ndarray) -> np.ndarray:
    """Normalised cross-correlation of the template against each window ending at frame i."""
    w = tmpl.shape[0]
    t = tmpl - tmpl.mean()
    t /= np.sqrt((t ** 2).sum()) + 1e-9
    s = np.zeros(feat.shape[0], np.float32)
    for i in range(w - 1, feat.shape[0]):
        win = feat[i - w + 1:i + 1]
        d = win - win.mean()
        s[i] = (d * t).sum() / (np.sqrt((d ** 2).sum()) + 1e-9)
    return s


# --- Quantised, streaming form (bit-exact spec for the C++ port) -------------

FEAT_STEP_DB = 0.5          # history stored as uint8 in 0.5 dB steps above floor


def quantize_feat(feat_db: np.ndarray) -> np.ndarray:
    return np.clip(np.floor(feat_db / FEAT_STEP_DB + 0.5), 0, 255).astype(np.uint8)


def quantize_template(tmpl_db: np.ndarray) -> np.ndarray:
    """Zero-mean template scaled into int8. NCC is invariant to template scale."""
    t = tmpl_db - tmpl_db.mean()
    q = np.round(t * (127.0 / np.abs(t).max())).astype(np.int32)
    q -= int(round(q.mean()))  # keep (nearly) zero-mean after rounding
    return np.clip(q, -127, 127).astype(np.int8)


def ncc_quantized(qfeat_win: np.ndarray, qtmpl: np.ndarray) -> float:
    """score = (sum(w*t) - mean(w)*sum(t)) / (sqrt(var_sum(w)) * sqrt(var_sum(t)))."""
    w = qfeat_win.astype(np.int64).ravel()
    t = qtmpl.astype(np.int64).ravel()
    n = w.size
    sw, sww, swt, st, stt = w.sum(), (w * w).sum(), (w * t).sum(), t.sum(), (t * t).sum()
    num = swt - sw * st / n
    den = np.sqrt(max(sww - sw * sw / n, 0.0)) * np.sqrt(max(stt - st * st / n, 0.0))
    return float(num / den) if den > 0 else 0.0


class StreamingDetector:
    """Frame-by-frame detector. feed_frame_db(row) -> list of events.

    Events: ("unit", t, score) for a repetition >= threshold,
            ("near", t, score) for a candidate in [near_threshold, threshold),
            ("alarm_on", t, score), ("alarm_off", t, 0.0).
    t is the time (s) of the *end* of the matched window (i.e. when it is known).

    period_s may be None: any units within release_s of each other chain
    towards min_repetitions with no periodicity check (single-sound mode is
    min_repetitions=1). With the TM6 parameters (period 3.125, release 7.25)
    behaviour is identical to the original fixed 2*period+1 alarm-off rule.
    """

    def __init__(self, qtmpl: np.ndarray, threshold=DEFAULT_THRESHOLD,
                 near_threshold=DEFAULT_NEAR_THRESHOLD,
                 period_s: float | None = DEFAULT_PERIOD_S,
                 period_tol_s: float = DEFAULT_PERIOD_TOL_S,
                 min_repetitions: int = DEFAULT_MIN_REPETITIONS,
                 peak_window_s=0.4, refractory_s: float = DEFAULT_REFRACTORY_S,
                 release_s: float | None = None,
                 bin_lo: int = BIN_LO, bin_hi: int = BIN_HI):
        self.t = qtmpl
        self.W = qtmpl.shape[0]
        self.bin_lo, self.bin_hi = bin_lo, bin_hi
        self.n_bins = bin_hi - bin_lo + 1
        if qtmpl.shape[1] != self.n_bins:
            raise ValueError(
                f"template width {qtmpl.shape[1]} != bin range {bin_lo}..{bin_hi}")
        self.hist = np.zeros_like(qtmpl, dtype=np.uint8)
        self.n = 0                      # frames seen
        self.floor: np.ndarray | None = None
        self.fps = SR / HOP
        self.thr, self.near = threshold, near_threshold
        self.period, self.tol, self.min_rep = period_s, period_tol_s, min_repetitions
        if release_s is None:
            release_s = release_default(period_s)
        self.release = release_s
        self.peak_win = int(round(peak_window_s * self.fps))
        self.refr = int(round(refractory_s * self.fps))
        self.cand_start = -1; self.cand_best = 0.0; self.cand_best_n = 0
        self.last_unit_n = -10**9; self.unit_times: list[float] = []
        self.alarm = False; self.last_score = 0.0

    def feed_frame_db(self, row_db: np.ndarray) -> list:
        if len(row_db) != self.n_bins:
            raise ValueError(
                f"frame width {len(row_db)} != detector band width {self.n_bins}")
        if self.floor is None:
            self.floor = row_db.astype(np.float32).copy()
        self.floor = np.minimum(row_db, self.floor + FLOOR_RISE).astype(np.float32)
        q = quantize_feat(row_db - self.floor)
        self.hist = np.roll(self.hist, -1, axis=0); self.hist[-1] = q
        self.n += 1
        ev = []
        if self.n < self.W:
            return ev
        s = ncc_quantized(self.hist, self.t); self.last_score = s
        now = self.n / self.fps
        # Candidate peak picking: open on crossing near_threshold, close once the score
        # has not improved for peak_win frames (so the true peak is always captured).
        if self.cand_start < 0:
            if s >= self.near and self.n - self.last_unit_n >= self.refr:
                self.cand_start, self.cand_best, self.cand_best_n = self.n, s, self.n
        else:
            if s > self.cand_best:
                self.cand_best, self.cand_best_n = s, self.n
            if self.n - self.cand_best_n >= self.peak_win:
                tb = self.cand_best_n / self.fps
                if self.cand_best >= self.thr:
                    ev.append(("unit", tb, self.cand_best))
                    self.last_unit_n = self.cand_best_n
                    self._on_unit(tb, self.cand_best, ev)
                else:
                    ev.append(("near", tb, self.cand_best))
                self.cand_start = -1
        if self.alarm and now - self.unit_times[-1] > self.release:
            self.alarm = False; self.unit_times = []
            ev.append(("alarm_off", now, 0.0))
        return ev

    def _on_unit(self, t: float, score: float, ev: list) -> None:
        if self.period is None:
            # No periodicity check: chain any units within release_s of the chain.
            self.unit_times = [u for u in self.unit_times if t - u <= self.release]
            self.unit_times.append(t)
        else:
            # Keep the chain of units that are spaced by ~k*period (k=1,2 allows one miss).
            if self.unit_times:
                dt = t - self.unit_times[-1]
                k = round(dt / self.period)
                if not (k in (1, 2) and abs(dt - k * self.period) <= self.tol * k):
                    self.unit_times = [] if not self.alarm else self.unit_times
                    if self.alarm:
                        return  # stray unit during an alarm: ignore, keep the chain
            self.unit_times.append(t)
        if not self.alarm and len(self.unit_times) >= self.min_rep:
            self.alarm = True
            ev.append(("alarm_on", t, score))
