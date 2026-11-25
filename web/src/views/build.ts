// Step 3: build the template, tune detection parameters.
import { bandFromHz } from "../const";
import { button, field, fmtT, h, note } from "../helpers";
import { State } from "../store";
import { helpIcon } from "../help";
import { estimatePeriod } from "../template";
import { player } from "./recordings";
import { TuneResult, autoTune, bandSuggestion, doBuild, pendingCount, r2, thresholdSuggestion, timesPerRecording } from "../pipeline";

export function renderBuild(root: HTMLElement, s: State, refresh: () => void) {
  root.innerHTML = "";
  if (s.examples.length < 1) {
    note(root, "Mark at least one example first.");
    return;
  }
  const pend = pendingCount(s);
  if (pend) {
    h("p", "instruction", root, `${pend} match${pend > 1 ? "es are" : " is"} still unreviewed in the previous step — ` +
      "review them first for a reliable result (unreviewed ones are left out).");
  }
  const trow = h("div", "row", root);
  const tmsg = h("span", "muted", trow, "");
  button(trow, s.template ? "Tune again" : "Tune automatically", () => {
    try {
      const r = autoTune(s);
      (renderBuild as { last?: TuneResult }).last = r;
      refresh();
    } catch (e) { tmsg.textContent = `Tuning failed: ${e}`; }
  }, s.template ? "" : "primary");
  if (!s.template) {
    note(root, `Builds the detector from your ${s.examples.length} example${s.examples.length > 1 ? "s" : ""}: ` +
      "which pitches to listen to, the sound's rhythm, and how close a match must be.");
  } else {
    renderSummary(root, s, (renderBuild as { last?: TuneResult }).last);
  }

  const root0 = root;
  const det = h("details", "", root0) as HTMLDetailsElement;
  det.open = !!(renderBuild as { open?: boolean }).open;
  det.ontoggle = () => { (renderBuild as { open?: boolean }).open = det.open; };
  root = det;
  h("summary", "", root, "Fine-tune settings (optional)");
  note(root, "Hover or tap ? for an explanation of each setting. After changing something, press “Rebuild” at the bottom.");
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
  note(root, `Current: ${s.band.loHz}–${s.band.hiHz} Hz. Default 400–4500 Hz covers most buzzers and chimes.`);

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
  const p = h("div", "grid", root);
  const pThr = field(p, "threshold (match score 0–1)", r2(s.params.threshold), { type: "number", step: "0.01", help: "threshold" });
  const pNear = field(p, "near-miss level", r2(s.params.near_threshold), { type: "number", step: "0.01", help: "near_threshold" });
  const pMin = field(p, "repetitions before alarm", s.params.min_repetitions, { type: "number", step: "1", help: "min_repetitions" });
  const pPer = field(p, "repeats every (s)", s.params.period_s ?? "", { type: "number", step: "0.001", help: "period" });
  const pTol = field(p, "rhythm tolerance (s)", s.params.period_tolerance_s, { type: "number", step: "0.01", help: "period_tolerance" });
  const pRefr = field(p, "ignore re-matches for (s)", s.params.refractory_s, { type: "number", step: "0.1", help: "refractory" });
  const pRel = field(p, "alarm off after silence (s)", s.params.release_s, { type: "number", step: "0.1", help: "release" });
  const readParams = () => {
    const lo = parseFloat(loInp.value) || 400, hi = parseFloat(hiInp.value) || 4500;
    if (lo !== s.band.loHz || hi !== s.band.hiHz) s.band = bandFromHz(lo, hi);
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
  button(brow, "Rebuild", () => {
    try {
      readParams();
      doBuild(s);
      // Re-measure the margin for the new template; keep the user's threshold.
      const t = thresholdSuggestion(s);
      s.margin = { minPos: t.minPos, maxNeg: t.maxNeg, margin: t.margin };
      s.evals = [];
      msg.textContent = `Rebuilt from ${s.examples.length} example(s).`;
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
        (pendingCount(s) ? ` ${pendingCount(s)} unreviewed match(es) were left out.` : "");
      refresh();
    } catch (e) { msg.textContent = `Suggestion failed: ${e}`; }
  });

  void fmtT;
}

function renderSummary(root: HTMLElement, s: State, last?: TuneResult) {
  const m = s.margin?.margin;
  const verdict = m === undefined ? "fair" : m >= 0.2 ? "good" : m >= 0.1 ? "fair" : "bad";
  const box = h("div", `verdict ${verdict}`, root);
  const head = { good: "✓ Looks reliable", fair: "Usable, but close", bad: "⚠ Fragile" }[verdict];
  h("strong", "", box, m === undefined ? "Built" : `${head} — margin ${m >= 0 ? "+" : ""}${m.toFixed(2)}`);
  if (s.margin) {
    h("span", "", box, `Your weakest example scores ${s.margin.minPos.toFixed(2)}; the most similar other sound in your recordings ` +
      `scores ${s.margin.maxNeg.toFixed(2)}. The alarm threshold is ${r2(s.params.threshold)}.`);
  }
  const other = last?.mostSimilarOther;
  const rec = other ? s.recordings.find((r) => r.id === other.recId) : undefined;
  if (other && rec) {
    const p = h("p", "", box, `Most similar other sound: ${rec.name} ${other.t0.toFixed(1)}–${other.t1.toFixed(1)} s `);
    button(p, "▶ listen", () => player.play(rec, Math.max(0, other.t0 - 0.3), other.t1 + 0.3));
    if (verdict !== "good") h("span", "", p, " — if it is your alarm, mark it as an example and tune again.");
  }
  if (verdict === "bad") {
    h("p", "", box, "Some background sound looks almost like the alarm. Check the matches you rejected or left out, " +
      "add another recording of the alarm, or record the confusing sound separately and test again.");
  } else if (verdict === "fair") {
    h("p", "", box, "It will work, but a similar sound could occasionally trigger it. More examples from another recording help.");
  }
  const ul = h("ul", "summary-list", root);
  h("li", "", ul, `Listens to ${s.band.loHz}–${s.band.hiHz} Hz`);
  h("li", "", ul, `One sound lasts ${s.duration} s`);
  h("li", "", ul, s.repeating && s.params.period_s
    ? `Repeats every ${s.params.period_s.toFixed(2)} s — alarm after ${s.params.min_repetitions} matches`
    : `Single sound — alarm after ${s.params.min_repetitions} match${s.params.min_repetitions > 1 ? "es" : ""}`);
  if (last) {
    const d = h("p", "note", root, `${last.bandText} ${last.periodText}`);
    void d;
  }
  if (s.template && s.tmplMean) {
    const cv = h("canvas", "tmpl", root) as HTMLCanvasElement;
    cv.title = "The learned fingerprint: time left to right, pitch bottom to top";
    drawTemplate(cv, s.tmplMean, s.template.frames, s.template.bins);
  }
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
