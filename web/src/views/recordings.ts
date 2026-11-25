// Step 1: load recordings (files or microphone), spectrogram, select regions.
import { bufferToPcm16, fileToPcm16, Player, recordFromMic } from "../audio";
import { SR } from "../const";
import { button, fmtT, h, note } from "../helpers";
import { Recording, State, uid } from "../store";
import { SpecView } from "../widgets";

export interface RecCallbacks {
  refresh: () => void; // re-render dependent views
}

export function renderRecordings(root: HTMLElement, s: State, cb: RecCallbacks) {
  root.innerHTML = "";
  h("h2", "", root, "1 · Recordings");
  note(root, "Load recordings of the appliance sound. Everything runs in this page — audio never leaves your device. " +
    "Best results come from the ESP32 recorder (tools/capture); a phone or laptop mic also works but sounds " +
    "different from the INMP441, so always re-check with device recordings before exporting.");
  note(root, "Tip: record one long session with several alarm episodes plus everyday background sounds (speech, clatter). " +
    "Supported: whatever your browser can play — WAV, FLAC (incl. the ESP32 recorder's 24-bit FLAC), MP3, M4A, OGG.");

  const row = h("div", "row", root);
  const file = h("input", "", row) as HTMLInputElement;
  file.type = "file";
  file.accept = "audio/*,.flac,.wav";
  file.multiple = true;
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
  const drop = h("div", "drop", root, "…or drop audio files here");
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
  const micRow = h("div", "row", root);
  const micBtn = button(micRow, "● Record from microphone", () => { void toggleMic(); });
  const meter = h("span", "muted", micRow, "");
  let stopFn: (() => void) | null = null;
  async function toggleMic() {
    if (stopFn) { stopFn(); return; }
    try {
      const r = await recordFromMic((v) => { meter.textContent = `level ${"▮".repeat(Math.min(20, Math.round(v * 60)))}`; }, () => {
        stopFn = null;
        micBtn.textContent = "● Record from microphone";
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
  note(root, "Microphone recordings are handy for a first try, but a phone/laptop mic hears differently " +
    "from the INMP441 on the device. Treat mic-made presets as drafts.");

  if (!s.recordings.length) {
    note(root, "No recordings yet.");
    return;
  }
  h("h3", "", root, `Loaded (${s.recordings.length})`);
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
  const rec: Recording | undefined = s.recordings.find((r) => r.id === selId) ?? s.recordings[0];
  (renderRecordings as { sel?: string }).sel = rec.id;
  h("h3", "", root, `Spectrogram — ${rec.name}`);
  note(root, "Time runs left to right, pitch bottom to top; brighter = louder. Drag across the sound to select it, then “Mark as example”. Scroll sideways; +/−, Fit or Ctrl/⌘ + scroll zooms.");
  const specWrap = h("div", "", root);
  const spec = new SpecView(specWrap);
  const ctl = h("div", "row", root);
  const playBtn = button(ctl, "▶ Play", () => player.toggle(rec));
  const stopBtn = button(ctl, "■ Stop", () => player.stop());
  void stopBtn;
  const selLabel = h("span", "muted", ctl, "no selection");
  let pendingSel: { t0: number; t1: number } | null = null;
  spec.onSelect = (t0, t1) => {
    pendingSel = { t0, t1 };
    selLabel.textContent = `selected ${fmtT(t0)} – ${fmtT(t1)}`;
    markBtn.disabled = false;
  };
  const markBtn = button(ctl, "Mark as example", () => {
    if (!pendingSel) return;
    s.examples.push({ id: uid(), recId: rec.id, t0: pendingSel.t0, t1: pendingSel.t1 });
    pendingSel = null;
    spec.clearSelection();
    selLabel.textContent = "no selection";
    markBtn.disabled = true;
    cb.refresh();
  });
  markBtn.disabled = true;
  try {
    spec.setData(rec.pcm, s.band);
    spec.setOverlays([
      ...s.examples.filter((e) => e.recId === rec.id).map((e) => ({ t0: e.t0, t1: e.t1, color: "#3ddc84", label: "ex" })),
      ...s.candidates.filter((c) => c.recId === rec.id && c.status === "pending").map((c) => ({ t0: c.t0, t1: c.t1, color: "#ffbf3f", label: `${c.score.toFixed(2)}` })),
    ]);
  } catch (e) {
    note(root, `Spectrogram failed: ${e}`);
    return;
  }
  player.onTime = (t) => spec.setCursor(t);
  player.onEnd = () => { spec.setCursor(null); playBtn.textContent = "▶ Play"; };
  const origToggle = player.toggle.bind(player);
  void origToggle;
}

class RecPlayer {
  private p = new Player();
  private current: Recording | null = null;
  onTime: ((t: number) => void) | null = null;
  onEnd: (() => void) | null = null;
  constructor() {
    this.p.onTime = (t) => this.onTime?.(t);
    this.p.onEnd = () => this.onEnd?.();
  }
  play(r: Recording, from = 0) {
    if (this.current !== r) { this.p.load(r.pcm); this.current = r; }
    this.p.play(from);
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
