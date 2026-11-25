// "Find similar": scan every recording with a provisional template built from
// one seed example and list the peaks as candidates (no DOM, unit-tested).
import { FPS } from "./const";
import { getFeatures, runDetector } from "./dsp";
import { State, uid } from "./store";
import { exampleFrameRange, quantizeTemplate } from "./template";

/** Scan all recordings with a provisional template from the seed example. */
export function findSimilar(s: State, seedId: string, floor: number) {
  const seed = s.examples.find((e) => e.id === seedId);
  if (!seed) throw new Error("seed example not found");
  const rec = s.recordings.find((r) => r.id === seed.recId);
  if (!rec) throw new Error("seed recording gone");
  const { binLo, binHi } = s.band;
  const bins = binHi - binLo + 1;
  const W = Math.round(s.duration * FPS);
  const f = getFeatures(rec.pcm, binLo, binHi);
  if (f.frames < W + 16) throw new Error("seed recording too short for the template duration");
  const { f0 } = exampleFrameRange(seed.t0, seed.t1, f.frames, W);
  const win = f.data.slice(f0 * bins, (f0 + W) * bins);
  const q = quantizeTemplate(win);
  s.candidates = [];
  // Minimum spacing between candidates: most of one template length, so fast
  // repeats (e.g. beeps 1 s apart) are all found, but one sound is not listed twice.
  const peakWin = Math.round(0.4 * FPS), refr = Math.max(peakWin, Math.round(0.7 * W));
  for (const r of s.recordings) {
    const { scores, firstFrame } = runDetector(r.pcm, q, W, bins, {
      threshold: 2, near_threshold: 1.5, min_repetitions: 255,
      period_s: 3.125, period_tolerance_s: 0.25, refractory_s: 1.5, release_s: 7.25,
    }, s.band);
    // Peak-pick above the floor (same shape as the firmware candidate logic).
    let best = -1, bestI = -1, lastKept = -1e9;
    const flush = (endI: number) => {
      if (bestI >= 0 && endI - bestI >= peakWin) {
        const frame = firstFrame + bestI; // 1-based end frame of the match
        const t1 = frame / FPS, t0 = t1 - W / FPS;
        const isSeed = r.id === seed.recId && Math.abs(t0 - (f0 / FPS)) < 0.5;
        if (isSeed) lastKept = bestI;
        else if (bestI - lastKept >= refr) {
          lastKept = bestI;
          s.candidates.push({ id: uid(), recId: r.id, t0: Math.max(0, t0), t1, score: best, status: "pending" });
        }
        best = -1; bestI = -1;
      }
    };
    for (let i = 0; i < scores.length; i++) {
      const v = scores[i];
      if (v >= floor && i - lastKept >= refr) {
        if (v > best) { best = v; bestI = i; }
      }
      if (bestI >= 0 && i - bestI >= peakWin) flush(i);
    }
    flush(scores.length);
  }
  s.candidates.sort((a, b) => b.score - a.score);
}
