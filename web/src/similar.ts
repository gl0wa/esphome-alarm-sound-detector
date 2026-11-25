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
  // Candidates are the strongest local peaks, at least ~one template length
  // apart (non-maximum suppression, strongest first): fast repeats such as
  // beeps 1 s apart are all found, while the weaker sub-peaks inside one longer
  // sound (a chime matching itself shifted) are not listed separately.
  const peakWin = Math.round(0.4 * FPS), refr = Math.max(peakWin, Math.round(0.9 * W));
  for (const r of s.recordings) {
    const { scores, firstFrame } = runDetector(r.pcm, q, W, bins, {
      threshold: 2, near_threshold: 1.5, min_repetitions: 255,
      period_s: 3.125, period_tolerance_s: 0.25, refractory_s: 1.5, release_s: 7.25,
    }, s.band);
    // Score index where an example's window ends (= where its match peaks).
    const exIdx = (t0: number, t1: number) => exampleFrameRange(t0, t1, 1e9, W).f0 + W - firstFrame;
    const peaks: number[] = [];
    for (let i = 0; i < scores.length; i++) {
      const v = scores[i];
      if (v < floor) continue;
      let isMax = true;
      for (let k = Math.max(0, i - peakWin); k <= Math.min(scores.length - 1, i + peakWin) && isMax; k++) {
        if (scores[k] > v || (scores[k] === v && k < i)) isMax = false;
      }
      if (isMax) peaks.push(i);
    }
    peaks.sort((a, b) => scores[b] - scores[a]);
    const kept: number[] = [];
    // Examples marked earlier: the seed is never listed; other examples show up
    // as already accepted (once each) so the list reflects every decision.
    const examples = s.examples.filter((e) => e.recId === r.id).map((e) => ({ e, i: exIdx(e.t0, e.t1), used: false }));
    const seedEx = examples.find((x) => x.e.id === seed.id);
    if (seedEx) { kept.push(seedEx.i); seedEx.used = true; }
    for (const i of peaks) {
      if (kept.some((k) => Math.abs(k - i) < refr)) continue;
      kept.push(i);
      const t1 = (firstFrame + i) / FPS, t0 = t1 - W / FPS;
      const ex = examples.find((x) => !x.used && Math.abs(x.i - i) < refr);
      if (ex) ex.used = true;
      s.candidates.push({
        id: uid(), recId: r.id, t0: Math.max(0, t0), t1, score: scores[i],
        status: ex ? "accepted" : "pending", exampleId: ex?.e.id,
      });
    }
  }
  s.candidates.sort((a, b) => b.score - a.score);
}
