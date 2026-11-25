// Step 1: load recordings (files or microphone), spectrogram, select regions.
import { bufferToPcm16, fileToPcm16, Player, recordFromMic } from "../audio";
import { SR } from "../const";
import { button, fmtT, h, note } from "../helpers";
import { Recording, State, uid } from "../store";
import { measureSoundLength } from "../pipeline";
import { getRoute } from "../device";
import { type Region, SpecView, type SpecViewState } from "../widgets";

export interface RecCallbacks {
  refresh: () => void; // re-render dependent views
}

export function renderRecordings(root: HTMLElement, s: State, cb: RecCallbacks) {
  root.innerHTML = "";
  const has = s.recordings.length > 0;
  if (!has && getRoute() === "device") {
    h("p", "instruction", root, "No clips in this browser yet. “Send to preset studio” on the device's page opens the studio " +
      "with the clips in the browser you recorded with — continue there. You can also load audio files here.");
  } else if (!has) {
    note(root, "Best: one long recording with the alarm a few times, plus everyday background — talking, dishes, " +
      "other appliances. The background is what teaches the detector what NOT to react to.");
  }
  const row = h("div", "row", root);
  const file = h("input", "", row) as HTMLInputElement;
  file.type = "file";
  file.accept = "audio/*,.flac,.wav";
  file.multiple = true;
  file.hidden = true;
  button(row, has ? "Add audio files" : "Load audio files", () => file.click(), has ? "" : "primary");
  file.onchange = async () => {
    for (const f of Array.from(file.files ?? [])) {
      try {
        const pcm = await fileToPcm16(f);
        s.recordings.push({ id: uid(), name: f.name, pcm });
      } catch (e) {
        alert(`Could not decode ${f.name}: ${e}`);
      }
    }
    file.value = "";
    cb.refresh();
  };
  // drag & drop
  const drop = h("div", "drop", root, "…or drop audio files here (WAV, FLAC, MP3, M4A, OGG)");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = async (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    for (const f of Array.from(e.dataTransfer?.files ?? [])) {
      try {
        s.recordings.push({ id: uid(), name: f.name, pcm: await fileToPcm16(f) });
      } catch (err) {
        alert(`Could not decode ${f.name}: ${err}`);
      }
    }
    cb.refresh();
  };

  // microphone
  const micBtn = button(row, "● Record here", () => { void toggleMic(); });
  const meter = h("span", "muted", row, "");
  let stopFn: (() => void) | null = null;
  async function toggleMic() {
    if (stopFn) { stopFn(); return; }
    try {
      const r = await recordFromMic((v) => { meter.textContent = `level ${"▮".repeat(Math.min(20, Math.round(v * 60)))}`; }, () => {
        stopFn = null;
        micBtn.textContent = "● Record here";
        meter.textContent = "";
      });
      stopFn = r.stop;
      micBtn.textContent = "■ Stop recording";
      const pcm = await r.done;
      if (pcm.length > SR) {
        s.recordings.push({ id: uid(), name: `mic ${new Date().toLocaleTimeString()}`, pcm });
        cb.refresh();
      }
    } catch (e) {
      alert(`Microphone unavailable: ${e}`);
    }
  }
  if (!has) {
    note(root, "“Record here” uses this phone's or computer's microphone. It hears a little differently from the " +
      "device's microphone — usually fine for beeps and chimes; check the result in the Test step.");
    return;
  }
  // Move the drop zone below the list once recordings exist (less prominent).
  drop.remove();
  h("h3", "", root, `Recordings (${s.recordings.length})`);
  const list = h("div", "list", root);
  const selId = (renderRecordings as { sel?: string }).sel ?? s.recordings[0].id;
  for (const r of s.recordings) {
    const item = h("div", "list-item" + (r.id === selId ? " sel" : ""), list);
    h("span", "", item, `${r.name} (${(r.pcm.length / SR).toFixed(1)}s)`);
    button(item, "Show", () => { (renderRecordings as { sel?: string }).sel = r.id; cb.refresh(); });
    button(item, "Play", () => player.play(r));
    button(item, "✕", () => {
      s.recordings = s.recordings.filter((x) => x !== r);
      s.examples = s.examples.filter((e) => e.recId !== r.id);
      s.candidates = s.candidates.filter((c) => c.recId !== r.id);
      cb.refresh();
    });
  }

  // spectrogram of the selected recording
  const rec: Recording = s.recordings.find((r) => r.id === selId) ?? s.recordings[0];
  (renderRecordings as { sel?: string }).sel = rec.id;
  h("h3", "", root, `Spectrogram — ${rec.name}`);
  const marked = s.examples.length;
  const instr = h("p", "instruction", root, "");
  instr.textContent = marked
    ? `✓ ${marked} example${marked > 1 ? "s" : ""} marked. Mark more if you like, or continue — the next step finds the other occurrences for you.`
    : "Drag across one occurrence of the alarm, then press “＋ Example”. For a sound made of several identical beeps, select just one beep.";
  const specWrap = h("div", "", root);
  const spec = new SpecView(specWrap);
  const ctl = h("div", "row", root);
  const playBtn = button(ctl, "▶ Play", () => player.toggle(rec));
  button(ctl, "■ Stop", () => player.stop());
  const selLabel = h("span", "muted", ctl, "no selection");
  let pendingSel: { t0: number; t1: number } | null = null;
  const markBtn = button(ctl, "Mark as example", () => markSelection());
  markBtn.disabled = true;

  const exampleIdx = () => s.examples.filter((e) => e.recId === rec.id);
  const regions = (): Region[] => [
    ...exampleIdx().map((e, i) => ({
      id: e.id, t0: e.t0, t1: e.t1, color: "#3ddc84", label: `example ${i + 1}`,
      editable: true, playable: true, deletable: true,
    })),
    ...s.candidates.filter((c) => c.recId === rec.id && c.status === "pending").map((c) => ({
      id: c.id, t0: c.t0, t1: c.t1, color: "#ffbf3f", label: c.score.toFixed(2), playable: true,
    })),
    ...(pendingSel ? [{
      id: SEL, t0: pendingSel.t0, t1: pendingSel.t1, color: "#4da3ff", label: "selection",
      editable: true, playable: true, deletable: true,
      action: { text: "＋ Example", title: "Mark this selection as an example", run: () => markSelection() },
    }] : []),
  ];
  const showSelection = () => {
    selLabel.textContent = pendingSel ? `selected ${fmtT(pendingSel.t0)} – ${fmtT(pendingSel.t1)} (${(pendingSel.t1 - pendingSel.t0).toFixed(2)} s)` : "no selection";
    markBtn.disabled = !pendingSel;
    spec.setRegions(regions());
  };
  const keepView = () => { viewState.set(rec.id, spec.getView()); };
  function markSelection() {
    if (!pendingSel) return;
    // The first marked example sets the sound length (template duration),
    // measured from the audio (the selection length if nothing stands out);
    // it can be changed in step 2 or 3.
    if (!s.examples.length) {
      let len: number | null = null;
      try { len = measureSoundLength(rec.pcm, pendingSel.t0, pendingSel.t1); } catch { /* keep selection length */ }
      s.duration = len ?? Math.max(0.2, Math.min(5, Math.round((pendingSel.t1 - pendingSel.t0) * 20) / 20));
    }
    s.examples.push({ id: uid(), recId: rec.id, t0: pendingSel.t0, t1: pendingSel.t1 });
    pendingSel = null;
    keepView();
    cb.refresh();
  }
  spec.onSelect = (t0, t1) => { pendingSel = { t0, t1 }; showSelection(); };
  spec.onRegionChange = (id, t0, t1) => {
    if (id === SEL) { pendingSel = { t0, t1 }; showSelection(); return; }
    const ex = s.examples.find((e) => e.id === id);
    if (!ex) return;
    ex.t0 = t0; ex.t1 = t1;
    keepView();
    cb.refresh(); // examples feed the later steps
  };
  spec.onRegionDelete = (id) => {
    if (id === SEL) { pendingSel = null; showSelection(); return; }
    s.examples = s.examples.filter((e) => e.id !== id);
    keepView();
    cb.refresh();
  };
  spec.onRegionPlay = (id) => {
    const r = id === SEL ? pendingSel : (s.examples.find((e) => e.id === id) ?? s.candidates.find((c) => c.id === id));
    if (r) { player.play(rec, r.t0, r.t1); playBtn.textContent = "▶ Play"; }
  };
  spec.onTap = (t) => player.play(rec, t);
  try {
    spec.setData(rec.pcm, s.band);
    const v = viewState.get(rec.id);
    if (v) spec.setView(v);
    showSelection();
  } catch (e) {
    note(root, `Spectrogram failed: ${e}`);
    return;
  }
  player.onTime = (t) => spec.setCursor(t);
  player.onEnd = () => { spec.setCursor(null); playBtn.textContent = "▶ Play"; };
}

const SEL = "__selection";
/** Zoom/scroll per recording, so edits (which re-render the view) keep your place. */
const viewState = new Map<string, SpecViewState>();

class RecPlayer {
  private p = new Player();
  private current: Recording | null = null;
  onTime: ((t: number) => void) | null = null;
  onEnd: (() => void) | null = null;
  constructor() {
    this.p.onTime = (t) => this.onTime?.(t);
    this.p.onEnd = () => this.onEnd?.();
  }
  play(r: Recording, from = 0, until?: number) {
    if (this.current !== r) { this.p.load(r.pcm); this.current = r; }
    this.p.play(from, until);
  }
  toggle(r: Recording) {
    if (this.p.playing) this.p.stop();
    else this.play(r);
  }
  stop() { this.p.stop(); }
}

export const player = new RecPlayer();
export async function pcmFromAudioBuffer(ab: AudioBuffer): Promise<Int16Array> {
  return bufferToPcm16(ab);
}
