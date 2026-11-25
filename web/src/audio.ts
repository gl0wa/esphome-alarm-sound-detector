// Audio loading, resampling to 16 kHz mono int16, mic capture, playback.
import { SR } from "./const";

let actx: AudioContext | null = null;
export function audioCtx(): AudioContext {
  if (!actx) actx = new AudioContext();
  if (actx.state === "suspended") void actx.resume();
  return actx;
}

/** Decode any browser-supported file and convert to 16 kHz mono int16. */
export async function fileToPcm16(file: File | Blob): Promise<Int16Array> {
  const buf = await file.arrayBuffer();
  const ctx = audioCtx();
  const audio = await ctx.decodeAudioData(buf.slice(0));
  return bufferToPcm16(audio);
}

/** Resample an AudioBuffer to 16 kHz mono int16 (mean removed, like tools). */
export async function bufferToPcm16(audio: AudioBuffer): Promise<Int16Array> {
  const len = Math.max(1, Math.ceil((audio.length / audio.sampleRate) * SR));
  const off = new OfflineAudioContext(1, len, SR);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start(0);
  const out = await off.startRendering();
  const ch = out.getChannelData(0);
  let mean = 0;
  for (let i = 0; i < ch.length; i++) mean += ch[i];
  mean /= ch.length;
  const pcm = new Int16Array(ch.length);
  for (let i = 0; i < ch.length; i++) {
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round((ch[i] - mean) * 32768)));
  }
  return pcm;
}

/** Record from the microphone; returns 16 kHz mono int16. */
export async function recordFromMic(
  onLevel: (v: number) => void,
  onStop: () => void,
): Promise<{ stop: () => void; done: Promise<Int16Array> }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = audioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  // Level meter (not part of the recording path).
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const tmp = new Float32Array(an.fftSize);
  let live = true;
  const tick = () => {
    if (!live) return;
    an.getFloatTimeDomainData(tmp);
    let s = 0;
    for (let i = 0; i < tmp.length; i++) s += tmp[i] * tmp[i];
    onLevel(Math.sqrt(s / tmp.length));
    requestAnimationFrame(tick);
  };
  tick();
  let resolve!: (v: Int16Array) => void;
  const done = new Promise<Int16Array>((r) => { resolve = r; });
  rec.onstop = async () => {
    live = false;
    onStop();
    stream.getTracks().forEach((t) => t.stop());
    src.disconnect();
    try {
      const audio = await ctx.decodeAudioData(await new Blob(chunks).arrayBuffer());
      resolve(await bufferToPcm16(audio));
    } catch {
      resolve(new Int16Array(0));
    }
  };
  rec.start(250);
  return { stop: () => rec.stop(), done };
}

/** Simple player with a time cursor callback. */
export class Player {
  private src: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private startAt = 0;
  private offset = 0;
  private raf = 0;
  onTime: ((t: number) => void) | null = null;
  onEnd: (() => void) | null = null;

  load(pcm: Int16Array) {
    const ctx = audioCtx();
    const buf = ctx.createBuffer(1, pcm.length, SR);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    this.buffer = buf;
  }

  /** Play from `from` seconds; if `until` is given, stop there. */
  play(from = 0, until?: number) {
    this.stop(false);
    if (!this.buffer) return;
    const ctx = audioCtx();
    this.src = ctx.createBufferSource();
    this.src.buffer = this.buffer;
    this.src.connect(ctx.destination);
    this.offset = Math.max(0, Math.min(from, this.buffer.duration));
    this.startAt = ctx.currentTime;
    this.src.onended = () => { this.stop(false); this.onEnd?.(); };
    if (until !== undefined && until > this.offset) this.src.start(0, this.offset, until - this.offset);
    else this.src.start(0, this.offset);
    const tick = () => {
      this.onTime?.(this.offset + (audioCtx().currentTime - this.startAt));
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(notify = true) {
    cancelAnimationFrame(this.raf);
    try { this.src?.stop(); } catch { /* already stopped */ }
    try { this.src?.disconnect(); } catch { /* noop */ }
    this.src = null;
    if (notify) this.onEnd?.();
  }

  get playing() { return this.src !== null; }
}
