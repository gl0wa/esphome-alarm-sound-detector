// Validation for capture clips posted by the temporary recording firmware page.
// Contract: {type:"asd-capture-clips", version:1,
//   device:{name, friendly_name}, clips:[{name, sampleRate:16000, pcm:ArrayBuffer (Int16 LE)}]}

export interface ValidClip {
  name: string;
  sampleRate: number;
  pcm: ArrayBuffer;
}

export interface ValidCaptureMsg {
  deviceName: string;
  friendlyName: string;
  clips: ValidClip[];
}

export const MAX_CLIPS = 50;
export const MAX_SECONDS = 30 * 60;
export const SAMPLE_RATE = 16000;
export const MAX_BYTES = MAX_SECONDS * SAMPLE_RATE * 2;

function isBuf(v: unknown): v is ArrayBuffer {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as ArrayBuffer).byteLength === "number" &&
    ((v as object).constructor?.name === "ArrayBuffer" ||
      (v as object).constructor?.name === "SharedArrayBuffer" ||
      (v as ArrayBuffer).slice !== undefined)
  );
}

export function validateCaptureClips(msg: unknown): { ok: true; value: ValidCaptureMsg } | { ok: false; error: string } {
  if (!msg || typeof msg !== "object") return { ok: false, error: "not an object" };
  const m = msg as Record<string, unknown>;
  if (m.type !== "asd-capture-clips") return { ok: false, error: "wrong message type" };
  if (m.version !== 1) return { ok: false, error: "unsupported version" };
  const dev = m.device as Record<string, unknown> | undefined;
  if (!dev || typeof dev.name !== "string" || !dev.name || typeof dev.friendly_name !== "string" || !dev.friendly_name) {
    return { ok: false, error: "missing device name" };
  }
  const clips = m.clips as unknown;
  if (!Array.isArray(clips) || !clips.length) return { ok: false, error: "no clips" };
  if (clips.length > MAX_CLIPS) return { ok: false, error: `too many clips (${clips.length} > ${MAX_CLIPS})` };
  const out: ValidClip[] = [];
  for (const c of clips) {
    if (!c || typeof c !== "object") return { ok: false, error: "bad clip entry" };
    const e = c as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name) return { ok: false, error: "clip without a name" };
    if (e.sampleRate !== SAMPLE_RATE) return { ok: false, error: `clip "${e.name}": sampleRate must be 16000` };
    if (!isBuf(e.pcm)) return { ok: false, error: `clip "${e.name}": pcm must be an ArrayBuffer` };
    const buf = e.pcm as ArrayBuffer;
    if (buf.byteLength === 0 || buf.byteLength % 2 !== 0) {
      return { ok: false, error: `clip "${e.name}": pcm must be non-empty Int16 audio` };
    }
    if (buf.byteLength > MAX_BYTES) {
      return { ok: false, error: `clip "${e.name}": longer than 30 minutes` };
    }
    out.push({ name: e.name, sampleRate: SAMPLE_RATE, pcm: buf });
  }
  return {
    ok: true,
    value: { deviceName: dev.name as string, friendlyName: dev.friendly_name as string, clips: out },
  };
}
