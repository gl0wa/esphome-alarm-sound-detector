// Step 3: build the template, tune detection parameters.
import { FPS, bandFromHz } from "../const";
import { getFeatures, runDetector } from "../dsp";
import { button, field, fmtT, h, note } from "../helpers";
import { State } from "../store";
import { helpIcon } from "../help";
import { buildTemplate, estimatePeriod, exampleFrameRange, suggestBand, suggestThresholds } from "../template";

export function renderBuild(root: HTMLElement, s: State, refresh: () => void) {
  root.innerHTML = "";
  h("h2", "", root, "3 · Build the template");
  note(root, "The builder averages your accepted examples (aligned ±8 frames, like tools/detector/make_template.py) " +
    "and quantises the result. Nothing is uploaded; this all happens in the page.");

  if (s.examples.length < 1) {
    note(root, "Accept at least one example in step 2 first.");
    return;
  }
  const W = Math.round(s.duration * 62.5);

  // --- band ---
  helpIcon(h("h3", "", root, "Frequency band"), "band");
  const bandRow = h("div", "row", root);
  const loInp = field(bandRow, "lowest pitch (Hz)", s.band.loHz, { type: "number" });
  const hiInp = field(bandRow, "highest pitch (Hz)", s.band.hiHz, { type: "number" });
  const sugLabel = h("span", "muted", root, "");
  button(bandRow, "Suggest from examples", () => {
    try {
      const r = bandSuggestion(s);
      sugLabel.textContent = r.text;
      loInp.value = String(r.loHz); hiInp.value = String(r.hiHz);
    } catch (e) { sugLabel.textContent = `Suggestion failed: ${e}`; }
  });
  button(bandRow, "Apply band", () => {
    try {
      s.band = bandFromHz(parseFloat(loInp.value) || 400, parseFloat(hiInp.value) || 4500);
      s.template = null; s.evals = [];
      refresh();
    } catch (e) { alert(e); }
  });
  note(root, `Current: ${s.band.loHz}–${s.band.hiHz} Hz (bins ${s.band.binLo}..${s.band.binHi}). Default 400–4500 Hz covers most buzzers and chimes.`);

  // --- duration / mode ---
  h("h3", "", root, "Sound shape");
  note(root, "How long one occurrence of the sound is, and whether the appliance repeats it until someone reacts.");
  const shRow = h("div", "row", root);
  const durInp = field(shRow, "sound length (s)", s.duration, { type: "number", step: "0.1", help: "duration" });
  const modeWrap = h("label", "field", shRow);
  helpIcon(h("span", "", modeWrap, "pattern"), "mode");
  const repSel = h("select", "", modeWrap) as HTMLSelectElement;
  for (const [v, t] of [["rep", "repeats at a steady rhythm"], ["single", "single sound"]]) {
    const o = h("option", "", repSel, t) as HTMLOptionElement;
    o.value = v;
  }
  repSel.value = s.repeating ? "rep" : "single";
  const perLabel = h("span", "muted", root, "");
  button(shRow, "Estimate repetition", () => {
    const r = estimatePeriod(timesPerRecording(s));
    perLabel.textContent = r.text;
    if (r.period !== null) {
      s.repeating = true; repSel.value = "rep";
      s.params.period_s = r.period;
      s.params.release_s = Math.round((2 * r.period + 1) * 1000) / 1000;
      // Must stay shorter than the period, or every other repetition is ignored
      // (fast beeps, e.g. one per second).
      s.params.refractory_s = Math.min(1.5, Math.round(0.6 * r.period * 10) / 10);
    } else {
      s.repeating = false; repSel.value = "single";
      s.params.period_s = null;
      s.params.min_repetitions = 1;
    }
    refresh();
  });

  // --- detection params ---
  h("h3", "", root, "Detection");
  note(root, "Usually you only adjust the threshold (use “Suggest thresholds”). Hover or tap ? for an explanation of each setting.");
  const p = h("div", "grid", root);
  const pThr = field(p, "threshold (match score 0–1)", r2(s.params.threshold), { type: "number", step: "0.01", help: "threshold" });
  const pNear = field(p, "near-miss level", r2(s.params.near_threshold), { type: "number", step: "0.01", help: "near_threshold" });
  const pMin = field(p, "repetitions before alarm", s.params.min_repetitions, { type: "number", step: "1", help: "min_repetitions" });
  const pPer = field(p, "repeats every (s)", s.params.period_s ?? "", { type: "number", step: "0.001", help: "period" });
  const pTol = field(p, "rhythm tolerance (s)", s.params.period_tolerance_s, { type: "number", step: "0.01", help: "period_tolerance" });
  const pRefr = field(p, "ignore re-matches for (s)", s.params.refractory_s, { type: "number", step: "0.1", help: "refractory" });
  const pRel = field(p, "alarm off after silence (s)", s.params.release_s, { type: "number", step: "0.1", help: "release" });
  const readParams = () => {
    s.duration = Math.max(0.2, Math.min(5, parseFloat(durInp.value) || 1.3));
    s.repeating = repSel.value === "rep";
    const per = parseFloat(pPer.value);
    s.params = {
      threshold: parseFloat(pThr.value) || 0.55,
      near_threshold: parseFloat(pNear.value) || 0.35,
      min_repetitions: Math.max(1, parseInt(pMin.value) || 1),
      period_s: s.repeating ? (isFinite(per) && per > 0 ? per : 3.125) : null,
      period_tolerance_s: parseFloat(pTol.value) || 0,
      refractory_s: parseFloat(pRefr.value) || 0,
      release_s: Math.max(0.5, parseFloat(pRel.value) || 2),
    };
  };

  const msg = h("p", "note", root, "");
  const brow = h("div", "row", root);
  button(brow, "Build template", () => {
    try {
      readParams();
      doBuild(s);
      msg.textContent = `Built ${s.template!.frames} frames × ${s.template!.bins} bins from ${s.examples.length} example(s).`;
      refresh();
    } catch (e) { msg.textContent = `Build failed: ${e}`; }
  });
  button(brow, "Suggest thresholds", () => {
    try {
      readParams();
      if (!s.template) doBuild(s);
      const r = thresholdSuggestion(s);
      s.params.threshold = r.threshold;
      s.params.near_threshold = r.near;
      s.margin = { minPos: r.minPos, maxNeg: r.maxNeg, margin: r.margin };
      msg.textContent = `Suggested threshold ${r.threshold} / near ${r.near}: ` +
        `weakest example scores ${r.minPos.toFixed(2)}, loudest background ${r.maxNeg.toFixed(2)} ` +
        `(margin ${r.margin >= 0 ? "+" : ""}${r.margin.toFixed(2)}).` +
        (pendingCount(s) ? ` ${pendingCount(s)} unreviewed candidate(s) were left out — review them in step 2 for a reliable margin.` : "");
      refresh();
    } catch (e) { msg.textContent = `Suggestion failed: ${e}`; }
  });

  if (s.template) {
    h("h3", "", root, `Template preview (${s.template.frames} × ${s.template.bins})`);
    const cv = h("canvas", "tmpl", root) as HTMLCanvasElement;
    drawTemplate(cv, s.tmplMean!, s.template.frames, s.template.bins);
    if (s.margin) {
      note(root, `Margin check: weakest example ${s.margin.minPos.toFixed(2)} vs loudest background ` +
        `${s.margin.maxNeg.toFixed(2)} (margin ${s.margin.margin >= 0 ? "+" : ""}${s.margin.margin.toFixed(2)}). ` +
        `Bigger is better; below +0.10 is fragile.`);
    }
  }
  void fmtT;
}

const pendingCount = (s: State) => s.candidates.filter((c) => c.status === "pending").length;
const r2 = (v: number) => Math.round(v * 100) / 100;

function featsForExamples(s: State) {
  const { binLo, binHi } = s.band;
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

function doBuild(s: State) {
  const { feats, starts, W } = featsForExamples(s);
  if (feats.some((f) => f.frames < W + 16)) throw new Error("a recording is shorter than the template + alignment margin");
  const { mean, q } = buildTemplate(feats, starts, W);
  s.template = { q, frames: W, bins: feats[0].bins };
  s.tmplMean = mean;
}

function bandSuggestion(s: State): { loHz: number; hiHz: number; text: string } {
  const { feats, starts, W, bins } = featsForExamples(s);
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
  return suggestBand(exMean, bg, bins, s.band.binLo);
}

function timesPerRecording(s: State): number[][] {
  return s.recordings.map((r) => s.examples.filter((e) => e.recId === r.id).map((e) => (e.t0 + e.t1) / 2));
}

function thresholdSuggestion(s: State) {
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
    const r2 = suggestThresholds(scores, firstFrame, expected, W, ignore);
    if (expected.length && r2.minPos < minPos) minPos = r2.minPos;
    if (r2.maxNeg > maxNeg) maxNeg = r2.maxNeg;
  }
  if (!isFinite(minPos)) minPos = 0.55;
  if (!isFinite(maxNeg)) maxNeg = 0.3;
  const threshold = Math.round(((minPos + maxNeg) / 2) * 100) / 100;
  const near = r2(Math.max(0.05, Math.min(threshold - 0.05, maxNeg + 0.05)));
  return { threshold, near, margin: minPos - maxNeg, minPos, maxNeg };
}

function drawTemplate(cv: HTMLCanvasElement, mean: Float32Array, frames: number, bins: number) {
  const Wpx = Math.min(640, frames * 4), Hpx = 200;
  cv.width = Wpx; cv.height = Hpx;
  const g = cv.getContext("2d")!;
  let mn = Infinity, mx = -Infinity;
  for (const v of mean) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const img = g.createImageData(Wpx, Hpx);
  for (let x = 0; x < Wpx; x++) {
    const f = Math.min(frames - 1, Math.floor((x / Wpx) * frames));
    for (let y = 0; y < Hpx; y++) {
      const b = Math.floor(((Hpx - 1 - y) / Hpx) * bins);
      const v = (mean[f * bins + b] - mn) / Math.max(1e-6, mx - mn);
      const o = (y * Wpx + x) * 4;
      img.data[o] = v * 255; img.data[o + 1] = v * 200; img.data[o + 2] = v * 120 + 40; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}
