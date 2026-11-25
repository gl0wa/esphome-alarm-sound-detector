// Step 4: evaluate the candidate preset with the firmware streaming detector.
import { FPS } from "../const";
import { runDetector } from "../dsp";
import { button, fmtT, h, note } from "../helpers";
import { loadBundledIndex, loadBundledPreset, presetTemplate } from "../preset";
import { EvalRec, State } from "../store";
import { exampleFrameRange } from "../template";
import { player } from "./recordings";
import { Timeline } from "../widgets";

const BASE = import.meta.env.BASE_URL;

export function renderEvaluate(root: HTMLElement, s: State, refresh: () => void) {
  root.innerHTML = "";
  if (!s.template) {
    note(root, "Build the detector in the previous step first.");
    return;
  }
  // Run automatically whenever there is nothing to show yet.
  if (!s.evals.length) {
    try { s.evals = evaluateAll(s, s.template.q, s.template.frames, s.template.bins, s.band, s.params, false); }
    catch (e) { note(root, `Test failed: ${e}`); return; }
  }
  const verdictBox = h("div", "verdict", root);
  note(root, "The device's own detector ran over your recordings with the new preset. On each timeline: green bars = your " +
    "examples, green dots = recognised, amber = close but not enough, red line = alarm on, grey line = alarm off. Tap a timeline to listen there.");
  const row = h("div", "row", root);
  button(row, "Run again", () => {
    try {
      s.evals = evaluateAll(s, s.template!.q, s.template!.frames, s.template!.bins, s.band, s.params, false);
      refresh();
    } catch (e) { alert(`Test failed: ${e}`); }
  });
  const more = h("details", "", root);
  h("summary", "", more, "Also check: would a ready-made preset react to these recordings?");
  const cRow = h("div", "row", more);
  h("span", "muted", cRow, "Preset:");
  const sel = h("select", "", cRow) as HTMLSelectElement;
  const idx = ((renderEvaluate as { idx?: { id: string; name: string }[] }).idx ?? []);
  const cur = (renderEvaluate as { cur?: string }).cur ?? "";
  const none = h("option", "", sel, "— pick —") as HTMLOptionElement;
  none.value = "";
  for (const p of idx) {
    const o = h("option", "", sel, p.name) as HTMLOptionElement;
    o.value = p.id;
  }
  sel.value = cur;
  sel.onchange = () => { (renderEvaluate as { cur?: string }).cur = sel.value; };
  button(cRow, "Check", async () => {
    if (!sel.value) return;
    try {
      const doc = await loadBundledPreset(BASE, sel.value);
      if (!doc) { alert("Preset not found in the site bundle."); return; }
      const p = presetTemplate(doc);
      const evs = evaluateAll(s, p.q, p.frames, p.bins, p.band, p.params, true);
      const hits = evs.flatMap((e) => e.events.filter((x) => x.type === "alarm_on" || x.type === "unit"));
      alert(hits.length
        ? `“${sel.value}” fires ${hits.length}× on these recordings — listen to them before shipping.`
        : `“${sel.value}” stays silent on these recordings. Good.`);
    } catch (e) { alert(`Confuser check failed: ${e}`); }
  });
  void loadIndexOnce();

  const W = s.template.frames;
  let totExp = 0, totMissed = 0, totFalse = 0, totAlarms = 0, totUnreviewed = 0;
  for (const ev of s.evals) {
    const rec = s.recordings.find((r) => r.id === ev.recId)!;
    h("h3", "", root, rec.name);
    const tlWrap = h("div", "", root);
    const tl = new Timeline(tlWrap);
    const spans = s.examples.filter((e) => e.recId === rec.id)
      .map((e) => {
        const f0 = exampleFrameRange(e.t0, e.t1, 1e9, W).f0;
        return { t0: f0 / FPS, t1: (f0 + W) / FPS, color: "#3ddc84" };
      });
    tl.setData(ev.scores, ev.firstFrame, ev.events, spans, rec.pcm.length / 16000);
    tl.onSeek = (t) => player.play(rec, Math.max(0, t - 0.5));
    // misses vs false alarms
    const units = ev.events.filter((e) => e.type === "unit");
    const expected = s.examples.filter((e) => e.recId === rec.id)
      .map((e) => (exampleFrameRange(e.t0, e.t1, 1e9, W).f0 + W) / FPS);
    const missed = expected.filter((t) => !units.some((u) => Math.abs(u.t - t) < 0.6));
    // Unreviewed candidates are probably real occurrences: neither caught examples nor false.
    const unreviewed = s.candidates.filter((c) => c.recId === rec.id && c.status === "pending")
      .map((c) => (exampleFrameRange(c.t0, c.t1, 1e9, W).f0 + W) / FPS);
    const onUnreviewed = units.filter((u) => !expected.some((t) => Math.abs(u.t - t) < 1.0) &&
      unreviewed.some((t) => Math.abs(u.t - t) < 1.0));
    const faUnits = units.filter((u) => !expected.some((t) => Math.abs(u.t - t) < 1.0) && !onUnreviewed.includes(u));
    // An alarm is legitimate if it starts within/just after a known or unreviewed occurrence.
    const legit = [...spans.map((sp) => sp.t1), ...unreviewed];
    const faAlarms = ev.events.filter((e) => e.type === "alarm_on" &&
      !legit.some((t) => e.t >= t - W / FPS - 1 && e.t <= t + 8));
    const alarms = ev.events.filter((e) => e.type === "alarm_on").length;
    totExp += expected.length; totMissed += missed.length; totFalse += faUnits.length + faAlarms.length;
    totAlarms += alarms - faAlarms.length; totUnreviewed += onUnreviewed.length;
    const line = h("p", missed.length || faUnits.length || faAlarms.length ? "warn" : "ok", root);
    const near = ev.events.filter((e) => e.type === "near").length;
    const parts = [
      `${expected.length - missed.length} of ${expected.length} examples recognised`,
      `alarm turned on ${alarms}×`,
      ...(onUnreviewed.length ? [`${onUnreviewed.length} on unreviewed matches`] : []),
      ...(near ? [`${near} near miss${near > 1 ? "es" : ""}`] : []),
    ];
    line.textContent = parts.join(" · ");
    if (missed.length) {
      const m = h("p", "warn", root, `Missed ${missed.length}: `);
      for (const t of missed) {
        button(m, `play ${fmtT(t)}`, () => player.play(rec, Math.max(0, t - 1.5)));
      }
    }
    if (faUnits.length || faAlarms.length) {
      const m = h("p", "warn", root, `Reacted to something else: ${faUnits.length} stray match(es), ${faAlarms.length} false alarm(s) — listen: `);
      for (const u of [...faUnits, ...faAlarms]) {
        button(m, `play ${fmtT(u.t)}`, () => player.play(rec, Math.max(0, u.t - 1.5)));
      }
    }
  }
  const ok = !totMissed && !totFalse;
  verdictBox.classList.add(totFalse ? "bad" : totMissed ? "fair" : "good");
  h("strong", "", verdictBox, ok ? "✓ Every example recognised, no false alarms"
    : totFalse ? `⚠ ${totFalse} false reaction(s) to other sounds` : `${totMissed} of ${totExp} examples missed`);
  h("span", "", verdictBox, ok
    ? `The alarm turned on ${totAlarms}× across your recordings. Continue to Install.`
    : totFalse
      ? "Listen to the marked places below. If it is really your alarm, accept it in “Find more examples”; otherwise raise the threshold slightly (Build → Fine-tune) or add more examples."
      : "Missing a few single examples is fine as long as the alarm itself turns on. Otherwise lower the threshold slightly (Build → Fine-tune).");
  if (totUnreviewed) h("p", "", verdictBox, `${totUnreviewed} reaction(s) were on matches you haven't reviewed yet.`);
}

async function loadIndexOnce() {
  if ((renderEvaluate as { idx?: unknown }).idx) return;
  (renderEvaluate as { idx?: unknown }).idx = await loadBundledIndex(BASE);
}

export function evaluateAll(
  s: State, q: Int8Array, frames: number, bins: number,
  band: { binLo: number; binHi: number },
  params: State["params"], forConfuser: boolean,
): EvalRec[] {
  void forConfuser;
  return s.recordings.map((r) => {
    const { scores, firstFrame, events } = runDetector(r.pcm, q, frames, bins, params, band);
    const expected = s.examples.filter((e) => e.recId === r.id)
      .map((e) => (exampleFrameRange(e.t0, e.t1, 1e9, frames).f0 + frames) / FPS);
    let maxNeg = -Infinity;
    for (let i = 0; i < scores.length; i++) {
      const t = (firstFrame + i) / FPS;
      if (!expected.some((et) => Math.abs(t - et) < 1.0) && scores[i] > maxNeg) maxNeg = scores[i];
    }
    return { recId: r.id, scores, firstFrame, events, maxNeg: isFinite(maxNeg) ? maxNeg : 0 };
  });
}
