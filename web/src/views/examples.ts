// Step 2: examples, "find similar" (provisional template + firmware NCC scan).
import { FPS } from "../const";
import { button, field, fmtT, h, note } from "../helpers";
import { Candidate, State, uid } from "../store";
import { helpIcon } from "../help";
import { player } from "./recordings";
import { findSimilar } from "../similar";

export function renderExamples(root: HTMLElement, s: State, refresh: () => void) {
  root.innerHTML = "";
  h("h2", "", root, "2 · Examples & find similar");
  note(root, "Mark one clear occurrence of the sound, then “Find similar” scans every recording with the " +
    "firmware detector and lists everything that resembles it. Accept the true ones, reject the rest. " +
    "Aim for 3+ accepted examples from different episodes, plus recordings of sounds it must NOT match. " +
    "If the alarm is several identical beeps, mark ONE beep — each beep is an example, and the rhythm is set in step 3.");

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
      for (const c of s.candidates) if (c.exampleId === e.id) { c.status = "pending"; c.exampleId = undefined; }
      refresh();
    });
  }
  seedId = (renderExamples as { seed?: string }).seed ?? s.examples[0]?.id;
  (renderExamples as { seed?: string }).seed = seedId;
  const seed = s.examples.find((e) => e.id === seedId) ?? s.examples[0];

  const row = h("div", "row", root);
  const durInp = field(row, "sound length (s)", s.duration, { type: "number", step: "0.05", help: "duration" });
  durInp.onchange = () => { s.duration = Math.max(0.2, Math.min(5, parseFloat(durInp.value) || s.duration)); };
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
  const pending = s.candidates.filter((c) => c.status === "pending").length;
  const ch = h("h3", "", root, `Candidates (${pending} to review, ${s.candidates.length - pending} decided)`);
  helpIcon(ch, "candidates");
  note(root, "Each candidate box is exactly one template length (step 3 “sound length”), placed where the match is best. " +
    "Accept it if the whole characteristic sound is inside, even with some quiet around it — that is expected. " +
    "Reject it if it is a different sound, or only a fragment of yours. If the sound fills only a small part of every box, " +
    "lower the sound length in step 3. You can change any decision later.");
  const cl = h("div", "list", root);
  const accept = (c: Candidate) => {
    c.status = "accepted";
    if (!c.exampleId || !s.examples.some((e) => e.id === c.exampleId)) {
      const dup = s.examples.find((e) => e.recId === c.recId && Math.abs(e.t0 - c.t0) < 0.3);
      if (dup) c.exampleId = dup.id;
      else {
        const id = uid();
        s.examples.push({ id, recId: c.recId, t0: c.t0, t1: c.t1 });
        c.exampleId = id;
      }
    }
    refresh();
  };
  const unaccept = (c: Candidate, to: "pending" | "rejected") => {
    if (c.exampleId) s.examples = s.examples.filter((e) => e.id !== c.exampleId);
    c.exampleId = undefined;
    c.status = to;
    refresh();
  };
  for (const c of s.candidates) {
    const rec = s.recordings.find((r) => r.id === c.recId);
    const item = h("div", `list-item ${c.status}`, cl);
    h("span", "badge", item, c.score.toFixed(2));
    h("span", `status-badge ${c.status}`, item, c.status === "pending" ? "to review" : c.status);
    h("span", "", item, `${rec?.name ?? "?"} ${fmtT(c.t0)}–${fmtT(c.t1)}`);
    button(item, "▶ Play", () => { if (rec) player.play(rec, Math.max(0, c.t0 - 0.3), c.t1 + 0.3); });
    if (c.status === "pending") {
      button(item, "Accept", () => accept(c));
      button(item, "Reject", () => unaccept(c, "rejected"));
    } else if (c.status === "accepted") {
      button(item, "Reject instead", () => unaccept(c, "rejected"));
      button(item, "Undo", () => unaccept(c, "pending"));
    } else {
      button(item, "Accept instead", () => accept(c));
      button(item, "Undo", () => unaccept(c, "pending"));
    }
  }
  void W;
}
