// Step 3 logic without DOM: template build, band / threshold suggestions,
// example times for the period estimate (unit-tested in tests/pipeline.test.ts).
import { FPS } from "./const";
import { getFeatures, runDetector } from "./dsp";
import { State } from "./store";
import { buildTemplate, exampleFrameRange, nearLevel, suggestBand, suggestThresholds } from "./template";

export const pendingCount = (s: State) => s.candidates.filter((c) => c.status === "pending").length;
export const r2 = (v: number) => Math.round(v * 100) / 100;

export function featsForExamples(s: State, band: { binLo: number; binHi: number } = s.band) {
  const { binLo, binHi } = band;
  const bins = binHi - binLo + 1;
  const W = Math.round(s.duration * FPS);
  const byRec = new Map<string, { data: Float32Array; frames: number; bins: number }>();
  for (const r of s.recordings) byRec.set(r.id, getFeatures(r.pcm, binLo, binHi));
  const feats = s.examples.map((e) => byRec.get(e.recId)!);
  const starts = s.examples.map((e) => {
    const f = byRec.get(e.recId)!;
    return exampleFrameRange(e.t0, e.t1, f.frames, W).f0;
  });
  return { feats, starts, W, bins, byRec };
}

export function doBuild(s: State) {
  const { feats, starts, W } = featsForExamples(s);
  if (feats.some((f) => f.frames < W + 16)) throw new Error("a recording is shorter than the template + alignment margin");
  const { mean, q } = buildTemplate(feats, starts, W);
  s.template = { q, frames: W, bins: feats[0].bins };
  s.tmplMean = mean;
}

export function bandSuggestion(s: State): { loHz: number; hiHz: number; text: string } {
  // Look at the whole audible range (~100–7900 Hz), not only the current band,
  // so a sound outside the current band can be found too.
  const full = { binLo: 3, binHi: 252 };
  const { feats, starts, W, bins } = featsForExamples(s, full);
  const exMean = new Float32Array(bins);
  for (let k = 0; k < feats.length; k++) {
    const w = feats[k].data.subarray(starts[k] * bins, (starts[k] + W) * bins);
    for (let i = 0; i < W * bins; i++) exMean[i % bins] += w[i];
  }
  for (let b = 0; b < bins; b++) exMean[b] /= feats.length * W;
  // background: mean over the seed recording (first example's)
  const f0 = feats[0];
  const bg = new Float32Array(bins);
  for (let i = 0; i < f0.data.length; i++) bg[i % bins] += f0.data[i];
  for (let b = 0; b < bins; b++) bg[b] /= f0.frames;
  return suggestBand(exMean, bg, bins, full.binLo);
}

export function timesPerRecording(s: State): number[][] {
  return s.recordings.map((r) => s.examples.filter((e) => e.recId === r.id).map((e) => (e.t0 + e.t1) / 2));
}

export function thresholdSuggestion(s: State) {
  if (!s.template) throw new Error("build the template first");
  // Score every recording with the candidate template; positives = windows
  // around the accepted examples, negatives = everything else.
  const W = s.template.frames;
  let minPos = Infinity, maxNeg = -Infinity;
  for (const r of s.recordings) {
    const { scores, firstFrame } = runDetector(r.pcm, s.template.q, W, s.template.bins, {
      ...s.params, threshold: 2, near_threshold: 1.5, min_repetitions: 255,
    }, s.band);
    const endT = (t0: number, t1: number) => (exampleFrameRange(t0, t1, 1e9, W).f0 + W) / FPS;
    const expected = s.examples.filter((e) => e.recId === r.id).map((e) => endT(e.t0, e.t1));
    const ignore = s.candidates.filter((c) => c.recId === r.id && c.status === "pending").map((c) => endT(c.t0, c.t1));
    const r2 = suggestThresholds(scores, firstFrame, expected, W, ignore, s.params.refractory_s);
    if (expected.length && r2.minPos < minPos) minPos = r2.minPos;
    if (r2.maxNeg > maxNeg) maxNeg = r2.maxNeg;
  }
  if (!isFinite(minPos)) minPos = 0.55;
  if (!isFinite(maxNeg)) maxNeg = 0.3;
  const threshold = Math.round(((minPos + maxNeg) / 2) * 100) / 100;
  const near = nearLevel(threshold, maxNeg);
  return { threshold, near, margin: minPos - maxNeg, minPos, maxNeg };
}

