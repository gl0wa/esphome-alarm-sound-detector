// Step 2: examples, "find similar" (provisional template + firmware NCC scan).
import { FPS } from "../const";
import { runDetector } from "../dsp";
import { button, fmtT, h, note } from "../helpers";
import { State, uid } from "../store";
import { exampleFrameRange, quantizeTemplate } from "../template";
import { player } from "./recordings";
import { getFeatures } from "../dsp";

export function renderExamples(root: HTMLElement, s: State, refresh: () => void) {
  root.innerHTML = "";
  h("h2", "", root, "2 · Examples & find similar");
  note(root, "Mark one clear occurrence of the sound, then “Find similar” scans every recording with the " +
    "firmware detector and lists everything that resembles it. Accept the true ones, reject the rest. " +
    "Aim for 3+ accepted examples from different episodes, plus recordings of sounds it must NOT match.");

  if (!s.examples.length) {
    note(root, "No examples yet — select a region on a spectrogram in step 1.");
    return;
  }
  const W = Math.round(s.duration * FPS);
  const list = h("div", "list", root);
  let seedId: string | undefined = (renderExamples as { seed?: string }).seed ?? s.examples[0]?.id;
  for (const e of s.examples) {
    const rec = s.recordings.find((r) => r.id === e.recId);
    const item = h("div", "list-item", list);
    const radio = h("input", "", item) as HTMLInputElement;
    radio.type = "radio"; radio.name = "seed"; radio.checked = e.id === seedId;
    radio.onchange = () => { (renderExamples as { seed?: string }).seed = e.id; };
    h("span", "", item, `${rec?.name ?? "?"} ${fmtT(e.t0)}–${fmtT(e.t1)}${e.id === seedId ? " (seed)" : ""}`);
    button(item, "Play", () => { if (rec) player.play(rec, e.t0, e.t1); });
    button(item, "✕", () => {
      s.examples = s.examples.filter((x) => x !== e);
      refresh();
    });
  }
  seedId = (renderExamples as { seed?: string }).seed ?? s.examples[0]?.id;
  (renderExamples as { seed?: string }).seed = seedId;
  const seed = s.examples.find((e) => e.id === seedId) ?? s.examples[0];

  const row = h("div", "row", root);
  const thrInp = h("input", "", row) as HTMLInputElement;
  thrInp.type = "number"; thrInp.step = "0.05"; thrInp.value = "0.35";
  thrInp.title = "candidate score floor";
  button(row, "Find similar", () => {
    try {
      findSimilar(s, seed.id, parseFloat(thrInp.value) || 0.35);
    } catch (e) { alert(`Find similar failed: ${e}`); }
    refresh();
  });
  button(row, "Clear candidates", () => { s.candidates = []; refresh(); });
  note(root, "The seed region becomes a provisional template (same builder as step 3); every recording is " +
    "then scored by the firmware detector and peaks above the floor are listed.");

  if (!s.candidates.length) {
    note(root, "No candidates yet.");
    return;
  }
  h("h3", "", root, `Candidates (${s.candidates.filter((c) => c.status === "pending").length} pending)`);
  const cl = h("div", "list", root);
  for (const c of s.candidates) {
    const rec = s.recordings.find((r) => r.id === c.recId);
    const item = h("div", "list-item", cl);
    h("span", "badge", item, c.score.toFixed(2));
    h("span", "", item, `${rec?.name ?? "?"} ${fmtT(c.t0)}–${fmtT(c.t1)} [${c.status}]`);
    button(item, "Play", () => { if (rec) player.play(rec, Math.max(0, c.t0 - 0.5)); });
    if (c.status === "pending") {
      button(item, "Accept", () => {
        c.status = "accepted";
        if (!s.examples.some((e) => e.recId === c.recId && Math.abs(e.t0 - c.t0) < 0.3)) {
          s.examples.push({ id: uid(), recId: c.recId, t0: c.t0, t1: c.t1 });
        }
        refresh();
      });
      button(item, "Reject", () => { c.status = "rejected"; refresh(); });
    }
  }
  void W;
}

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
  const peakWin = Math.round(0.4 * FPS), refr = Math.round(1.5 * FPS);
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
        if (!isSeed && bestI - lastKept >= refr) {
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
