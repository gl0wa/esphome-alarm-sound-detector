"""Host equivalence + event-logic tests for the detector core.

Builds the C++ CLI (tests/detector/detector_cli.cpp + the portable core),
generates SYNTHETIC audio (never anything from data/), builds a template with
the reference functions in tools/detector/ref.py, and asserts:

- per-frame NCC scores match within 0.01,
- identical event sequences (types; times within 1 frame; scores within 0.01),
- event-logic semantics: missed repetition (k=2), stray units, alarm_off
  timing, min_repetitions=1 — both ref-vs-C++ on audio and deterministic
  scripted-score unit tests of ref.StreamingDetector.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

TOOLS = Path(__file__).resolve().parent.parent.parent / "tools" / "detector"
CORE_DIR = Path(__file__).resolve().parent.parent.parent / "components" / "alarm_sound_detector"
sys.path.insert(0, str(TOOLS))
import ref  # noqa: E402  (reference implementation = the spec)

SR = ref.SR
FPS = SR / ref.HOP
FRAME_S = ref.HOP / SR  # 0.016 s
W = 81  # template length used by the synthetic tests (1.296 s)


# ---------------------------------------------------------------- synthesis ---

def chime(dur=1.5, seed_notes=((0.0, 660.0), (0.15, 880.0), (0.30, 990.0), (0.45, 1320.0))):
    """Marimba-like arpeggio: decaying notes with harmonics."""
    t = np.arange(int(dur * SR)) / SR
    y = np.zeros_like(t)
    for onset, f in seed_notes:
        m = t >= onset
        env = np.exp(-(t - onset) * 4.0) * m
        y += env * (np.sin(2 * np.pi * f * (t - onset))
                    + 0.4 * np.sin(2 * np.pi * 2 * f * (t - onset))
                    + 0.2 * np.sin(2 * np.pi * 3 * f * (t - onset)))
    return (0.25 * y / np.abs(y).max()).astype(np.float32)


def add_at(x, y, t0):
    i = int(round(t0 * SR))
    x[i:i + len(y)] += y[:max(0, len(x) - i)]


def make_audio(unit_times, total_s, distractors=True, seed=7):
    rng = np.random.default_rng(seed)
    x = rng.normal(0, 0.004, int(total_s * SR)).astype(np.float32)
    unit = chime()
    for u in unit_times:
        add_at(x, unit, u)
    if distractors:
        # Distractor: pure 950 Hz beeps (never part of the template).
        tb = np.arange(int(0.5 * SR)) / SR
        beep = (0.08 * np.sin(2 * np.pi * 950 * tb)).astype(np.float32)
        for t0 in (17.0, 22.0, 40.0):
            if t0 < total_s - 1:
                add_at(x, beep, t0)
        # Clatter-like broadband impulses.
        for _ in range(int(total_s * 0.7)):
            t0 = rng.uniform(0, total_s - 0.05)
            burst = (rng.normal(0, 0.05, int(0.02 * SR)) * np.hanning(int(0.02 * SR) + 1)[:-1]
                     ).astype(np.float32)
            add_at(x, burst, t0)
    # Exact frame-multiple length: N_FFT + HOP*(NF-1).
    nf = 1 + (len(x) - ref.N_FFT) // ref.HOP
    return x[:ref.N_FFT + ref.HOP * (nf - 1)]


def build_template(x, unit_times, w=W):
    feat = ref.above_floor(ref.frames_db(x))
    wins = []
    for u in unit_times:
        s = int(round(u * FPS))
        wins.append(feat[s:s + w])
    return ref.quantize_template(np.mean(wins, axis=0))


# ------------------------------------------------------------------ runners ---

@pytest.fixture(scope="session")
def cli(tmp_path_factory):
    out = tmp_path_factory.mktemp("bin") / "detector_cli"
    src = Path(__file__).parent / "detector_cli.cpp"
    cmd = ["c++", "-std=c++17", "-O2", "-Wall", "-Wextra", str(src),
           str(CORE_DIR / "detector_core.cpp"), "-I", str(CORE_DIR), "-o", str(out)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    assert r.returncode == 0, f"CLI build failed:\n{r.stdout}\n{r.stderr}"
    return out


def run_ref(x, qtmpl, **kw):
    det = ref.StreamingDetector(qtmpl, **kw)
    scores, events = {}, []
    for i, row in enumerate(ref.frames_db(x)):
        ev = det.feed_frame_db(row)
        n = i + 1
        if n >= qtmpl.shape[0]:
            scores[n] = det.last_score
        events += ev
    return scores, events


def run_cli(cli, tmp_path, x, qtmpl, **kw):
    audio = tmp_path / "a.f32"
    tmpl = tmp_path / "t.i8"
    audio.write_bytes(np.ascontiguousarray(x, dtype=np.float32).tobytes())
    tmpl.write_bytes(np.ascontiguousarray(qtmpl).tobytes())
    args = [str(cli), str(audio), str(tmpl), str(qtmpl.shape[0]), str(qtmpl.shape[1]),
            str(kw.get("threshold", 0.55)), str(kw.get("near_threshold", 0.35)),
            str(kw.get("period_s", 3.125)), str(kw.get("period_tol_s", 0.25)),
            str(kw.get("min_repetitions", 2))]
    r = subprocess.run(args, capture_output=True, text=True)
    assert r.returncode == 0, f"CLI failed:\n{r.stdout}\n{r.stderr}"
    scores, events = {}, []
    for line in r.stdout.splitlines():
        p = line.split()
        if p[0] == "SCORE":
            scores[int(p[1])] = float(p[2])
        else:
            events.append((p[1], float(p[2]), float(p[3])))
    return scores, events


def assert_equivalent(rs, re_, cs, ce):
    assert set(rs) == set(cs), "scored frame sets differ"
    worst = max(abs(rs[n] - cs[n]) for n in rs)
    assert worst < 0.01, f"score mismatch: worst {worst}"
    assert [e[0] for e in re_] == [e[0] for e in ce], f"event types differ: {re_} vs {ce}"
    for (t1, s1, v1), (t2, s2, v2) in zip(re_, ce):
        assert abs(s1 - s2) <= FRAME_S + 1e-9, f"time mismatch {s1} vs {s2}"
        assert abs(v1 - v2) < 0.01, f"event score mismatch {v1} vs {v2}"


# --------------------------------------------------------------- scenarios ---

PERIOD = 3.125
EP1 = [2.0 + k * PERIOD for k in range(5)]          # 2.0 .. 14.5
EP2 = [27.0 + k * PERIOD for k in range(3)]         # 27.0 .. 33.25
TOTAL_A = 45.0


def scenario_a():
    x = make_audio(EP1 + EP2, TOTAL_A)
    return x, build_template(x, EP1[:3])


def test_scores_and_events_match(cli, tmp_path):
    x, q = scenario_a()
    kw = dict(threshold=0.55)
    rs, re_ = run_ref(x, q, **kw)
    cs, ce = run_cli(cli, tmp_path, x, q, **kw)
    assert_equivalent(rs, re_, cs, ce)
    # Semantic checks on the reference: two episodes -> on/off pairs.
    ons = [e for e in re_ if e[0] == "alarm_on"]
    offs = [e for e in re_ if e[0] == "alarm_off"]
    units = [e for e in re_ if e[0] == "unit"]
    assert len(ons) == 2, re_
    assert len(offs) == 2, re_
    assert len(units) == 8, re_
    assert all(e[2] >= 0.55 for e in units)
    # No false alarm before the first episode can possibly trigger.
    assert ons[0][1] > EP1[1]


def test_missing_repetition_k2_survives(cli, tmp_path):
    units = [2.0, 2.0 + PERIOD, 2.0 + 3 * PERIOD, 2.0 + 4 * PERIOD]  # skip k=2 gap
    x = make_audio(units, 30.0, distractors=False)
    q = build_template(x, units[:2])
    kw = dict(threshold=0.55)
    rs, re_ = run_ref(x, q, **kw)
    cs, ce = run_cli(cli, tmp_path, x, q, **kw)
    assert_equivalent(rs, re_, cs, ce)
    assert [e[0] for e in re_].count("alarm_on") == 1, re_
    assert [e[0] for e in re_].count("alarm_off") == 1, re_


def test_stray_unit_ignored(cli, tmp_path):
    units = [2.0, 5.125, 8.25, 14.25]
    stray = 11.0  # 2.75 s after unit3, 3.25 s before unit4: off-grid but refractory-clear
    x = make_audio(sorted(units + [stray]), 34.0, distractors=False)
    q = build_template(x, units[:2])
    kw = dict(threshold=0.55)
    rs, re_ = run_ref(x, q, **kw)
    cs, ce = run_cli(cli, tmp_path, x, q, **kw)
    assert_equivalent(rs, re_, cs, ce)
    kinds = [e[0] for e in re_]
    assert kinds.count("alarm_on") == 1 and kinds.count("alarm_off") == 1, re_
    assert kinds.count("unit") == 5, re_  # 4 chained + 1 stray


def test_stray_resets_idle_chain(cli, tmp_path):
    # Single unit, then an off-grid stray (k rounds to 2 but outside tol*k),
    # then a unit on the stray's grid -> alarm fires on the second pair.
    units = [2.0, 7.0, 10.125]
    x = make_audio(units, 30.0, distractors=False)
    q = build_template(x, [units[0], units[2]])
    kw = dict(threshold=0.55)
    rs, re_ = run_ref(x, q, **kw)
    cs, ce = run_cli(cli, tmp_path, x, q, **kw)
    assert_equivalent(rs, re_, cs, ce)
    ons = [e for e in re_ if e[0] == "alarm_on"]
    assert len(ons) == 1 and ons[0][1] > units[2], re_


def test_alarm_off_timing(cli, tmp_path):
    units = [2.0, 5.125, 8.25]
    x = make_audio(units, 30.0, distractors=False)
    q = build_template(x, units[:2])
    kw = dict(threshold=0.55)
    rs, re_ = run_ref(x, q, **kw)
    cs, ce = run_cli(cli, tmp_path, x, q, **kw)
    assert_equivalent(rs, re_, cs, ce)
    off = [e for e in re_ if e[0] == "alarm_off"]
    last_unit = max(e[1] for e in re_ if e[0] == "unit")
    assert len(off) == 1
    # off fires on the first frame with now - last_unit > 2*period + 1.
    assert 2 * PERIOD + 1 < off[0][1] - last_unit <= 2 * PERIOD + 1 + 2 * FRAME_S + 1e-9


def test_min_repetitions_1(cli, tmp_path):
    units = [2.0, 12.0]  # isolated: each alone must raise the alarm
    x = make_audio(units, 30.0, distractors=False)
    q = build_template(x, units[:1])
    kw = dict(threshold=0.55, min_repetitions=1)
    rs, re_ = run_ref(x, q, **kw)
    cs, ce = run_cli(cli, tmp_path, x, q, **kw)
    assert_equivalent(rs, re_, cs, ce)
    kinds = [e[0] for e in re_]
    assert kinds.count("alarm_on") == 2 and kinds.count("alarm_off") == 2, re_
    # alarm_on is simultaneous with its unit.
    for i, e in enumerate(re_):
        if e[0] == "alarm_on":
            assert re_[i - 1][0] == "unit" and abs(re_[i - 1][1] - e[1]) < 1e-9


# ------------------------------------------------- deterministic logic tests ---

def drive_scripted(scored, **kw):
    """Drive ref.StreamingDetector with a scripted per-frame score sequence.

    `scored` holds the score for every frame from the first scored frame
    (frame W) on; earlier warm-up frames never reach ncc_quantized, so the
    fake pops one score per actual scoring call to stay aligned.
    """
    Wframes = 8
    params = dict(threshold=0.55, near_threshold=0.35, period_s=1.6,
                  period_tol_s=0.25, min_repetitions=2)
    params.update(kw)
    det = ref.StreamingDetector(np.zeros((Wframes, 4), dtype=np.int8), **params)
    evs = []
    calls = {"n": 0}

    def fake_ncc(w, t):
        i = calls["n"]
        calls["n"] += 1
        return scored[i] if i < len(scored) else 0.0

    import unittest.mock as mock
    with mock.patch.object(ref, "ncc_quantized", fake_ncc):
        for _ in range((Wframes - 1) + len(scored)):
            evs += det.feed_frame_db(np.zeros(4, dtype=np.float32))
    return evs


def unit_then_gap(best_to_best):
    """A score bump resolving to one unit, with the next bump's best exactly
    best_to_best frames later (bump best is 4 frames into its pattern)."""
    assert best_to_best >= 29
    return [0.5, 0.5, 0.5, 0.95] + [0.1] * (best_to_best - 4)


def single_unit_tail():
    return [0.5, 0.5, 0.5, 0.95] + [0.1] * 30


def test_logic_k2_keeps_chain_but_k3_breaks_it():
    for btb, expect_alarm in ((200, True), (300, False)):  # k=2 vs k=3 @ period 1.6 s
        evs = drive_scripted(unit_then_gap(btb) + single_unit_tail() + [0.0] * 40)
        kinds = [e[0] for e in evs]
        assert kinds.count("unit") == 2, (btb, evs)
        assert (kinds.count("alarm_on") == 1) == expect_alarm, (btb, evs)


def test_logic_refractory_blocks_second_candidate():
    evs = drive_scripted(unit_then_gap(50) + single_unit_tail() + [0.0] * 40)
    assert [e[0] for e in evs].count("unit") == 1, evs


def test_logic_min_rep_1_fires_immediately():
    evs = drive_scripted(single_unit_tail() + [0.0] * 40, min_repetitions=1)
    kinds = [e[0] for e in evs]
    assert kinds == ["unit", "alarm_on"], evs
    assert evs[0][1] == evs[1][1]


def test_logic_alarm_off_exact_frame():
    evs = drive_scripted(unit_then_gap(200) + single_unit_tail() + [0.0] * 400)
    off = [e for e in evs if e[0] == "alarm_off"]
    units = [e for e in evs if e[0] == "unit"]
    assert len(off) == 1 and [e[0] for e in evs].count("alarm_on") == 1
    # First frame with now - last_unit > 2*1.6 + 1 = 4.2 s = 262.5 frames.
    last_n = round(units[-1][1] * FPS)
    assert last_n == 8 - 1 + 4 + 200, evs  # warm-up + bump offset + gap
    assert off[0][1] == (last_n + 263) / FPS


def test_logic_stray_during_alarm_keeps_chain():
    # Alarm on two k=1 units, then a stray (dt=2.4 s: k=2 but outside tol*2),
    # then silence: alarm_off stays relative to the last chained unit.
    evs = drive_scripted(unit_then_gap(100) + unit_then_gap(150) + single_unit_tail()
                         + [0.0] * 400)
    kinds = [e[0] for e in evs]
    assert kinds == ["unit", "unit", "alarm_on", "unit", "alarm_off"], evs
    chained = [e for e in evs if e[0] == "unit"][1][1]
    assert evs[-1][1] - chained == 263 / FPS
