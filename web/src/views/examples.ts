// Step 2: examples, "find similar" (provisional template + firmware NCC scan).
import { button, field, fmtT, h, note } from "../helpers";
import { Candidate, State, uid } from "../store";
import { helpIcon } from "../help";
import { player } from "./recordings";
import { findSimilar } from "../similar";
import { soundLengthFor } from "../pipeline";

export function renderExamples(root: HTMLElement, s: State, refresh: () => void) {
  root.innerHTML = "";
  if (!s.examples.length) {
    note(root, "Mark one occurrence of the alarm in the previous step first.");
    return;
  }
  const getSeed = () => {
    const id = (renderExamples as { seed?: string }).seed;
    return s.examples.find((e) => e.id === id) ?? s.examples[0];
  };
  const seed = getSeed();
  (renderExamples as { seed?: string }).seed = seed.id;

  const pendingN = s.candidates.filter((c) => c.status === "pending").length;
  const instr = h("p", "instruction", root, "");
  instr.textContent = !s.candidates.length
    ? "Press “Find similar”: the detector searches all recordings for sounds like your example. Then listen to each match and accept the real ones."
    : pendingN
      ? "Listen (▶) to each match: accept it if it is your alarm, reject anything else. The highest scores are at the top."
      : `✓ All matches reviewed — ${s.examples.length} examples. Continue to Build.`;

  const row = h("div", "row", root);
  button(row, s.candidates.length ? "Find similar again" : "Find similar", () => {
    try {
      findSimilar(s, getSeed().id, parseFloat(thrInp.value) || 0.35);
    } catch (e) { alert(`Find similar failed: ${e}`); }
    refresh();
  }, s.candidates.length ? "" : "primary");

  // Search settings (rarely needed).
  const det = h("details", "", root);
  h("summary", "", det, `Search settings — sound length ${s.duration} s`);
  const srow = h("div", "row", det);
  const durInp = field(srow, "sound length (s)", s.duration, { type: "number", step: "0.05", help: "duration" });
  durInp.onchange = () => { s.duration = Math.max(0.2, Math.min(5, parseFloat(durInp.value) || s.duration)); refresh(); };
  const measured = h("span", "muted", det, "");
  button(srow, "Measure from the example", () => {
    const len = soundLengthFor(s, getSeed());
    if (len === null) { measured.textContent = "The example doesn't stand out from the background — set the length by hand."; return; }
    s.duration = len;
    refresh();
  });
  const thrInp = field(srow, "show matches scoring at least", "0.35", { type: "number", step: "0.05" });
  note(det, "Sound length is measured automatically from your first example: one beep, chime or phrase. " +
    "Change it if the boxes below cut the sound off or contain mostly silence, then search again.");
  if (s.examples.length > 1) {
    h("p", "muted", det, "Search with this example:");
    const list = h("div", "list", det);
    for (const e of s.examples) {
      const rec = s.recordings.find((r) => r.id === e.recId);
      const item = h("label", "list-item", list);
      const radio = h("input", "", item) as HTMLInputElement;
      radio.type = "radio"; radio.name = "seed"; radio.checked = e.id === seed.id;
      radio.onchange = () => {
        (renderExamples as { seed?: string }).seed = e.id;
        const len = soundLengthFor(s, e);
        if (len !== null) s.duration = len;
        refresh();
      };
      h("span", "", item, `${rec?.name ?? "?"} ${fmtT(e.t0)}–${fmtT(e.t1)}`);
      button(item, "▶", () => { if (rec) player.play(rec, e.t0, e.t1); });
    }
  }

  if (!s.candidates.length) return;

  const ch = h("h3", "", root, `Matches (${pendingN} to review, ${s.candidates.length - pendingN} decided)`);
  helpIcon(ch, "candidates");
  note(root, "Accept if the box holds the whole sound — some quiet around it is fine. Reject other sounds and fragments. " +
    "Decisions can be changed any time.");
  const accept = (c: Candidate) => {
    c.status = "accepted";
    if (!c.exampleId || !s.examples.some((e) => e.id === c.exampleId)) {
      const dup = s.examples.find((e) => e.recId === c.recId && Math.abs((e.t0 + e.t1) / 2 - (c.t0 + c.t1) / 2) < 0.3);
      if (dup) c.exampleId = dup.id;
      else {
        const id = uid();
        s.examples.push({ id, recId: c.recId, t0: c.t0, t1: c.t1 });
        c.exampleId = id;
      }
    }
  };
  const unaccept = (c: Candidate, to: "pending" | "rejected") => {
    if (c.exampleId) s.examples = s.examples.filter((e) => e.id !== c.exampleId);
    c.exampleId = undefined;
    c.status = to;
  };
  if (pendingN > 1) {
    const bulk = h("div", "row", root);
    button(bulk, `Accept all ${pendingN} to review`, () => {
      for (const c of s.candidates) if (c.status === "pending") accept(c);
      refresh();
    });
    button(bulk, "Reject all to review", () => {
      for (const c of s.candidates) if (c.status === "pending") unaccept(c, "rejected");
      refresh();
    });
    h("span", "muted", bulk, "— only after listening to a few");
  }
  const cl = h("div", "list", root);
  for (const c of s.candidates) {
    const rec = s.recordings.find((r) => r.id === c.recId);
    const item = h("div", `list-item ${c.status}`, cl);
    h("span", "badge", item, c.score.toFixed(2));
    h("span", `status-badge ${c.status}`, item, c.status === "pending" ? "to review" : c.status);
    h("span", "", item, `${rec?.name ?? "?"} ${fmtT(c.t0)}–${fmtT(c.t1)}`);
    button(item, "▶ Play", () => { if (rec) player.play(rec, Math.max(0, c.t0 - 0.3), c.t1 + 0.3); });
    const act = (f: () => void) => () => { f(); refresh(); };
    if (c.status === "pending") {
      button(item, "Accept", act(() => accept(c)));
      button(item, "Reject", act(() => unaccept(c, "rejected")));
    } else if (c.status === "accepted") {
      button(item, "Reject instead", act(() => unaccept(c, "rejected")));
      button(item, "Undo", act(() => unaccept(c, "pending")));
    } else {
      button(item, "Accept instead", act(() => accept(c)));
      button(item, "Undo", act(() => unaccept(c, "pending")));
    }
  }
}
