// TS port of tools/detector/make_template.py: alignment (+-8 frames by
// correlation against the first example), mean of float features, and
// ref.quantize_template. Feature extraction itself is WASM (dsp.ts).
import { FPS } from "./const";
import { getFeatures } from "./dsp";

export interface ExampleWindow {
  data: Float32Array; // float features, W x bins
}

export function exampleFrameRange(
  t0: number, t1: number, frames: number, W: number,
): { f0: number } {
  const center = ((t0 + t1) / 2) * FPS;
  const f0 = Math.max(0, Math.round(center - W / 2));
  return { f0: Math.min(f0, Math.max(0, frames - W)) };
}

function pearson(a: Float32Array, b: Float32Array): number {
  let sa = 0, sb = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : -2;
}

/** Align each example window (+-8 frames, first-max wins ties) against the
 *  first example's fixed window, then average. Mirrors make_template.py. */
export function buildTemplate(
  feats: { data: Float32Array; frames: number; bins: number }[],
  starts: number[], // onset frames, one per example, parallel to feats
  W: number,
): { mean: Float32Array; q: Int8Array; alignedStarts: number[] } {
  const bins = feats[0].bins;
  const base = feats[0].data.slice(starts[0] * bins, (starts[0] + W) * bins);
  const aligned: Float32Array[] = [base.slice(0, W * bins)];
  const alignedStarts: number[] = [starts[0]];
  for (let k = 1; k < feats.length; k++) {
    const f = feats[k];
    const s = starts[k];
    let best = Math.max(0, Math.min(s, f.frames - W));
    let bestC = -2;
    const lo = Math.max(0, s - 8), hi = Math.min(s + 8, f.frames - W);
    for (let d = lo; d <= hi; d++) {
      const cand = f.data.subarray(d * bins, (d + W) * bins);
      const c = pearson(base.subarray(0, W * bins), cand);
      if (c > bestC) { bestC = c; best = d; }
    }
    aligned.push(f.data.slice(best * bins, (best + W) * bins));
    alignedStarts.push(best);
  }
  const mean = new Float32Array(W * bins);
  for (const w of aligned) for (let i = 0; i < mean.length; i++) mean[i] += w[i];
  for (let i = 0; i < mean.length; i++) mean[i] /= aligned.length;
  return { mean, q: quantizeTemplate(mean), alignedStarts };
}

/** Port of ref.quantize_template: zero-mean int8, scale 127/max-abs. */
export function quantizeTemplate(tmplDb: Float32Array): Int8Array {
  const n = tmplDb.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += tmplDb[i];
  const mean = s / n;
  const t = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) { t[i] = tmplDb[i] - mean; const a = Math.abs(t[i]); if (a > m) m = a; }
  const q = new Int8Array(n);
  if (!(m > 0)) return q; // flat template (invalid for detection, like ref)
  const scale = 127 / m;
  let qs = 0;
  for (let i = 0; i < n; i++) { q[i] = Math.max(-127, Math.min(127, Math.round(t[i] * scale))); qs += q[i]; }
  const adj = Math.round(qs / n);
  if (adj !== 0) for (let i = 0; i < n; i++) q[i] = Math.max(-127, Math.min(127, q[i] - adj)) as number;
  return q;
}

/** Suggest a spectral band from the accepted examples' spectrum. */
export function suggestBand(
  exampleMeans: Float32Array, // mean example spectrum (bins)
  bgMean: Float32Array, // whole-recording mean spectrum (bins)
  bins: number,
  curBinLo: number,
): { loHz: number; hiHz: number; text: string } {
  const snr: number[] = [];
  for (let b = 0; b < bins; b++) snr.push(exampleMeans[b] - bgMean[b]);
  const peak = Math.max(...snr);
  const keep: number[] = [];
  for (let b = 0; b < bins; b++) if (snr[b] > Math.max(peak - 15, 3)) keep.push(b);
  if (!keep.length) {
    return { loHz: 400, hiHz: 4500, text: "No clear peak found — keeping 400–4500 Hz." };
  }
  const lo = Math.min(...keep) + curBinLo, hi = Math.max(...keep) + curBinLo;
  const loHz = Math.max(31, Math.floor((lo * 16000) / 512 / 50) * 50);
  const hiHz = Math.ceil((((hi + 1) * 16000) / 512 / 50)) * 50;
  return {
    loHz, hiHz,
    text: `Examples stand out most at ${loHz}–${hiHz} Hz (peak +${peak.toFixed(1)} dB over background).`,
  };
}

/** Estimate the repetition period from example times within one recording. */
export function estimatePeriod(timesS: number[]): { period: number | null; text: string } {
  if (timesS.length < 3) {
    return { period: null, text: "Fewer than 3 examples in one recording — defaulting to single-sound mode." };
  }
  const t = [...timesS].sort((a, b) => a - b);
  const diffs = t.slice(1).map((v, i) => v - t[i]);
  const med = diffs.sort((a, b) => a - b)[Math.floor(diffs.length / 2)];
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length);
  if (med > 0.4 && sd / med < 0.2) {
    return { period: Math.round(med * 1000) / 1000, text: `Examples repeat about every ${med.toFixed(2)} s — suggesting repeating mode.` };
  }
  return { period: null, text: "Example spacing is irregular — suggesting single-sound mode." };
}

/** Suggest threshold/near_threshold from positive vs background scores. */
export function suggestThresholds(
  scores: Float32Array, firstFrame: number, expectedTimes: number[], W: number,
  ignoreTimes: number[] = [], // unreviewed candidates: neither positive nor background
): { threshold: number; near: number; margin: number; minPos: number; maxNeg: number } {
  const fps = FPS;
  const at = (t: number) => Math.round(t * fps) - firstFrame; // score index
  const skip = [...expectedTimes, ...ignoreTimes];
  const isNearEx = (idx: number) => skip.some((t) => Math.abs(idx - at(t)) * 2 <= 2 * fps);
  let minPos = Infinity;
  for (const t of expectedTimes) {
    let best = -Infinity;
    for (let i = Math.max(0, at(t) - 32); i < Math.min(scores.length, at(t) + 33); i++) {
      if (scores[i] > best) best = scores[i];
    }
    if (best < minPos) minPos = best;
  }
  let maxNeg = -Infinity;
  for (let i = 0; i < scores.length; i++) {
    if (!isNearEx(i) && scores[i] > maxNeg) maxNeg = scores[i];
  }
  if (!isFinite(minPos)) minPos = 0.55;
  if (!isFinite(maxNeg)) maxNeg = 0.3;
  const threshold = Math.round(((minPos + maxNeg) / 2) * 100) / 100;
  const near = Math.min(threshold - 0.05, Math.round((maxNeg + 0.05) * 100) / 100);
  return { threshold, near: Math.max(0.05, near), margin: minPos - maxNeg, minPos, maxNeg };
}
