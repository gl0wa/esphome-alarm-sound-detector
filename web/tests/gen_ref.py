"""Smoke: synth audio + ref.py outputs for WASM parity check."""
import base64, json, sys
import numpy as np
sys.path.insert(0, "tools/detector")
import ref

rng = np.random.default_rng(7)
SR = ref.SR
T = 24.0
x = (0.02 * rng.standard_normal(int(SR * T))).astype(np.float64)

def phrase(t0, freqs=(660.0, 990.0, 1320.0), dur=1.1, amp=0.5):
    n = int(SR * dur)
    t = np.arange(n) / SR
    env = np.exp(-3.0 * t / dur)
    s = sum(np.sin(2 * np.pi * f * t) for f in freqs) / len(freqs)
    x[int(t0 * SR):int(t0 * SR) + n] += amp * env * s

units = [2.0, 2.0 + 3.125, 2.0 + 2 * 3.125, 2.0 + 3 * 3.125, 16.0, 19.125, 22.25]
for u in units:
    phrase(u)
# confuser: different partials, short
for t0 in (14.0, 14.6):
    n = int(SR * 0.3)
    t = np.arange(n) / SR
    x[int(t0 * SR):int(t0 * SR) + n] += 0.4 * np.sin(2 * np.pi * 500 * t)

# int16 path like the device
x16 = np.clip(np.round(x * 32768), -32768, 32767).astype(np.int16)
xf = (x16.astype(np.float64) / 32768.0).astype(np.float32)

W = int(round(1.3 * SR / ref.HOP))
feat = ref.above_floor(ref.frames_db(xf))
fps = SR / ref.HOP
starts = [int(round(u * fps)) for u in units[:3]]
base = feat[starts[0]:starts[0] + W]
wins = []
for s in starts:
    best = max(range(max(0, s - 8), s + 9),
               key=lambda k: np.corrcoef(base.ravel(), feat[k:k + W].ravel())[0, 1])
    wins.append(feat[best:best + W])
tmpl = np.mean(wins, axis=0)
q = ref.quantize_template(tmpl)

det = ref.StreamingDetector(q)
scores = []
events = []
for row in ref.frames_db(xf):
    ev = det.feed_frame_db(row)
    scores.append(det.last_score)
    events += [(e[0], round(e[1] * fps), e[2]) for e in ev]

out = {
    "pcm16_b64": base64.b64encode(x16.tobytes()).decode(),
    "units": units,
    "feat_b64": base64.b64encode(feat.astype(np.float32).tobytes()).decode(),
    "feat_frames": feat.shape[0], "feat_bins": feat.shape[1],
    "tmpl_b64": base64.b64encode(q.tobytes()).decode(),
    "tmpl_frames": q.shape[0], "tmpl_bins": q.shape[1],
    "scores": scores,
    "events": events,
}
open(sys.argv[1], "w").write(json.dumps(out))
print("frames", feat.shape, "scores", len(scores), "events", len(events))
