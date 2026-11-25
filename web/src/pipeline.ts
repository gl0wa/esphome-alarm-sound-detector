// Step 3 logic without DOM: template build, band / threshold suggestions,
// example times for the period estimate (unit-tested in tests/pipeline.test.ts).
import { FPS, SR as SR_HZ } from "./const";
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


/**
 * Measure how long the sound inside a marked region lasts: the loudest moment
 * in the region, extended while the sound stays well above the background
 * (gaps up to 0.12 s bridged), plus a small margin. Returns null when nothing
 * stands out.
 */
export function measureSoundLength(pcm: Int16Array, t0: number, t1: number): number | null {
  const lead = 3; // s of audio before the region so the noise floor settles
  const s0 = Math.max(0, Math.floor((t0 - lead) * SR_HZ));
  const s1 = Math.min(pcm.length, Math.ceil((t1 + 1) * SR_HZ));
  const f = getFeatures(pcm.subarray(s0, s1), 3, 252);
  if (!f.frames) return null;
  // Feature frame k covers audio ending at (k * HOP + N_FFT) samples into the slice.
  const tOf = (k: number) => (s0 + k * 256 + 256) / SR_HZ; // frame centre
  const level = new Float32Array(f.frames);
  const top = new Float32Array(5);
  for (let k = 0; k < f.frames; k++) {
    top.fill(0);
    for (let b = 0; b < f.bins; b++) {
      const v = f.data[k * f.bins + b];
      if (v > top[4]) { top[4] = v; top.sort((x, y) => y - x); }
    }
    level[k] = (top[0] + top[1] + top[2] + top[3] + top[4]) / 5;
  }
  // Smooth over ~0.1 s so note changes and short dips inside one sound don't split it.
  const raw = level.slice();
  for (let k = 0; k < f.frames; k++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, k - 3); j <= Math.min(f.frames - 1, k + 3); j++) { sum += raw[j]; n++; }
    level[k] = sum / n;
  }
  const inRegion = (k: number) => tOf(k) >= t0 - 0.3 && tOf(k) <= t1 + 0.3;
  let peak = -1;
  for (let k = 0; k < f.frames; k++) if (tOf(k) >= t0 && tOf(k) <= t1 && (peak < 0 || level[k] > level[peak])) peak = k;
  // Background level: a quiet moment of the lead-in before the region (20th
  // percentile, so an earlier sound in the lead-in doesn't raise it).
  const lead0: number[] = [];
  for (let k = 0; k < f.frames && tOf(k) < t0 - 0.3; k++) lead0.push(level[k]);
  lead0.sort((a, b) => a - b);
  const base = lead0.length ? lead0[Math.floor(lead0.length / 5)] : 0;
  if (peak < 0 || level[peak] - base < 10) return null;
  // Halfway from background to the peak: covers the sound and its main decay,
  // while the gap between two beeps falls below it.
  const thr = base + (level[peak] - base) / 2;
  const maxGap = Math.round(0.12 * FPS);
  const walk = (dir: 1 | -1) => {
    let last = peak, gap = 0;
    for (let k = peak + dir; k >= 0 && k < f.frames && inRegion(k); k += dir) {
      if (level[k] >= thr) { last = k; gap = 0; } else if (++gap > maxGap) break;
    }
    return last;
  };
  const len = (walk(1) - walk(-1) + 1) / FPS + 0.06;
  return Math.max(0.2, Math.min(5, Math.round(len * 20) / 20));
}

/** Sound length measured from an example, capped below the repetition period. */
export function soundLengthFor(s: State, ex: { recId: string; t0: number; t1: number }): number | null {
  const rec = s.recordings.find((r) => r.id === ex.recId);
  if (!rec) return null;
  let len = measureSoundLength(rec.pcm, ex.t0, ex.t1);
  if (len !== null && s.repeating && s.params.period_s) len = Math.min(len, Math.round(0.9 * s.params.period_s * 20) / 20);
  return len;
}
