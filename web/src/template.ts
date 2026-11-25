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
  let loHz = Math.max(100, Math.floor((lo * 16000) / 512 / 50) * 50);
  let hiHz = Math.min(7900, Math.ceil((((hi + 1) * 16000) / 512 / 50)) * 50);
  const coreLo = loHz, coreHi = hiHz;
  // A band of a few bins (a pure tone) makes background noise look like the
  // template and any beep of that pitch match perfectly; keep at least about
  // half an octave (min 1 kHz) around the sound so the quiet surroundings of
  // the tone count too.
  const minW = Math.max(1000, 0.5 * (loHz + hiHz) / 2);
  if (hiHz - loHz < minW) {
    const pad = (minW - (hiHz - loHz)) / 2;
    loHz = Math.max(100, Math.floor((loHz - pad) / 50) * 50);
    hiHz = Math.min(7900, Math.ceil((hiHz + pad) / 50) * 50);
    if (hiHz - loHz < minW) { if (loHz === 100) hiHz = Math.min(7900, loHz + Math.ceil(minW / 50) * 50); else loHz = Math.max(100, hiHz - Math.ceil(minW / 50) * 50); }
  }
  const widened = loHz !== coreLo || hiHz !== coreHi;
  return {
    loHz, hiHz,
    text: `Examples stand out most at ${coreLo}–${coreHi} Hz (peak +${peak.toFixed(1)} dB over background)` +
      (widened ? `; suggesting ${loHz}–${hiHz} Hz so the quiet around the tone is compared too.` : "."),
  };
}

/**
 * Estimate the repetition period from example centre times, grouped per
 * recording. Robust to (a) several alarm episodes in one recording (long gaps
 * between them are ignored) and (b) a missed repetition (a gap of 2 periods).
 */
export function estimatePeriod(groups: number[][]): { period: number | null; text: string } {
  const diffs: number[] = [];
  for (const g of groups) {
    const t = [...g].sort((a, b) => a - b);
    for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > 0.3) diffs.push(t[i] - t[i - 1]);
  }
  if (diffs.length < 2) {
    return { period: null, text: "Fewer than 3 examples of one alarm in a recording — defaulting to single-sound mode. Accept more repetitions in step 2 if the sound repeats." };
  }
  diffs.sort((a, b) => a - b);
  // Try each spacing as the base period; keep the one explaining most spacings
  // as 1× or 2× the period (larger gaps = between episodes, not counted).
  let best: { period: number; n: number; total: number } | null = null;
  for (const base of diffs) {
    let sum = 0, n = 0, total = 0;
    for (const d of diffs) {
      if (d > 2.5 * base) continue;
      total++;
      const k = Math.round(d / base);
      if ((k === 1 || k === 2) && Math.abs(d - k * base) <= 0.12 * k * base) { sum += d / k; n++; }
    }
    if (n >= 2 && n >= 0.75 * total && (!best || n > best.n)) best = { period: sum / n, n, total };
  }
  if (best) {
    const per = Math.round(best.period * 1000) / 1000;
    return { period: per, text: `Examples repeat about every ${per.toFixed(2)} s (${best.n} spacings) — suggesting repeating mode.` };
  }
  return { period: null, text: "Example spacing is irregular — suggesting single-sound mode." };
}

/** Suggest threshold/near_threshold from positive vs background scores. */
export function suggestThresholds(
  scores: Float32Array, firstFrame: number, expectedTimes: number[], W: number,
  ignoreTimes: number[] = [], // unreviewed candidates: neither positive nor background
  refractoryS = 0, // the detector ignores matches this long after a repetition
): { threshold: number; near: number; margin: number; minPos: number; maxNeg: number } {
  const fps = FPS;
  const at = (t: number) => Math.round(t * fps) - firstFrame; // score index
  const skip = [...expectedTimes, ...ignoreTimes];
  // Not background: within one template length / the refractory time (at least
  // 1 s) of an example — partial overlaps and sub-peaks of the same sound score
  // high by nature, and the detector ignores them during the refractory time.
  const half = Math.max(fps, W, Math.round(refractoryS * fps));
  const isNearEx = (idx: number) => skip.some((t) => Math.abs(idx - at(t)) <= half);
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
  const near = nearLevel(threshold, maxNeg);
  return { threshold, near, margin: minPos - maxNeg, minPos, maxNeg };
}

/**
 * Near-miss level: just above the loudest background, but no more than 0.2
 * below the threshold (a very quiet background would otherwise report every
 * small bump as a near miss) and at least 0.05 below it.
 */
export function nearLevel(threshold: number, maxNeg: number): number {
  const v = Math.min(threshold - 0.05, Math.max(maxNeg + 0.05, threshold - 0.2));
  return Math.round(Math.max(0.05, v) * 100) / 100;
}
