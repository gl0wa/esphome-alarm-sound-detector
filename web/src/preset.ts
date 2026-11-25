// Preset export: v2 JSON, ESPHome YAML snippet, labels JSON; ajv validation;
// bundled presets shipped with the site.
import Ajv from "ajv";
import schema from "../../components/alarm_sound_detector/presets/preset.schema.json";
import { BuiltTemplate, DetParams, Band } from "./const";

export interface PresetMeta {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  sound: string;
  description: string;
  aliases: string[];
  testedAgainst: string;
  validation: string;
  notes: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

export function validatePreset(doc: unknown): { ok: boolean; errors: string[] } {
  const ok = validate(doc) as boolean;
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
  if (!ok) return { ok: false, errors };
  // Extra rules preset_util.py enforces beyond the JSON schema.
  const d = doc as Record<string, unknown>;
  const det = d.detection as Record<string, number>;
  const extra: string[] = [];
  if (!(det.near_threshold < det.threshold)) extra.push("detection.near_threshold must be < detection.threshold");
  if (d.bins !== (d.bin_hi as number) - (d.bin_lo as number) + 1) extra.push("bins must equal bin_hi - bin_lo + 1");
  try {
    const raw = atob(d.data_int8_b64 as string);
    if (raw.length !== (d.frames as number) * (d.bins as number)) {
      extra.push(`data has ${raw.length} bytes, expected ${(d.frames as number) * (d.bins as number)}`);
    }
  } catch { extra.push("data_int8_b64 is not valid base64"); }
  return extra.length ? { ok: false, errors: extra } : { ok: true, errors: [] };
}

function b64encodeBytes(u8: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
  return btoa(s);
}

export function buildPresetDoc(
  meta: PresetMeta,
  tmpl: BuiltTemplate,
  band: Band,
  params: DetParams,
  nExamples: number,
): Record<string, unknown> {
  const tested = meta.testedAgainst.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    format: 2,
    id: meta.id,
    aliases: meta.aliases,
    name: meta.name || `${meta.manufacturer} ${meta.model} ${meta.sound}`.trim() || meta.id,
    manufacturer: meta.manufacturer,
    model: meta.model,
    sound: meta.sound,
    description: meta.description,
    sample_rate: 16000,
    n_fft: 512,
    hop: 256,
    bin_lo: band.binLo,
    bin_hi: band.binHi,
    frames: tmpl.frames,
    bins: tmpl.bins,
    data_int8_b64: b64encodeBytes(new Uint8Array(tmpl.q.buffer, tmpl.q.byteOffset, tmpl.q.length)),
    detection: {
      threshold: params.threshold,
      near_threshold: params.near_threshold,
      min_repetitions: params.min_repetitions,
      period_s: params.period_s,
      period_tolerance_s: params.period_tolerance_s,
      refractory_s: params.refractory_s,
      release_s: params.release_s,
    },
    provenance: {
      n_examples: nExamples,
      tested_against: tested,
      validation: meta.validation,
      notes: meta.notes,
    },
  };
}

export function buildYamlSnippet(presetId: string, fileName: string): string {
  return `# ${fileName} goes next to your ESPHome YAML file.
external_components:
  - source: github://gl0wa/esphome-alarm-sound-detector
    components: [alarm_sound_detector]

alarm_sound_detector:
  - id: ${presetId.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}
    microphone:
      microphone: mic
      bits_per_sample: 16   # stream must be 16 kHz mono
    template: ${fileName}
`;
}

export interface BundledPreset {
  id: string;
  name: string;
  doc: Record<string, unknown> | null;
}

export async function loadBundledIndex(base: string): Promise<{ id: string; name: string; model?: string }[]> {
  try {
    const r = await fetch(`${base}presets/index.json`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.presets ?? []).map((p: { id: string; name: string; model?: string }) => ({ id: p.id, name: p.name, model: p.model }));
  } catch { return []; }
}

export async function loadBundledPreset(base: string, id: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${base}presets/${id}.json`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Decode a preset doc's template (v2, or v1 with legacy defaults). */
export function presetTemplate(doc: Record<string, unknown>): {
  q: Int8Array; frames: number; bins: number; band: Band; params: DetParams;
} {
  const raw = atob(doc.data_int8_b64 as string);
  const q = new Int8Array(raw.length);
  for (let i = 0; i < raw.length; i++) q[i] = raw.charCodeAt(i) > 127 ? raw.charCodeAt(i) - 256 : raw.charCodeAt(i);
  const frames = doc.frames as number, bins = doc.bins as number;
  const band: Band = {
    loHz: (doc.bin_lo as number) * 31.25, hiHz: ((doc.bin_hi as number) + 1) * 31.25,
    binLo: doc.bin_lo as number, binHi: doc.bin_hi as number,
  };
  const fmt = (doc.format as number) ?? 1;
  let params: DetParams;
  if (fmt === 2) {
    const d = doc.detection as Record<string, number | null>;
    params = {
      threshold: d.threshold as number, near_threshold: d.near_threshold as number,
      min_repetitions: d.min_repetitions as number, period_s: d.period_s as number | null,
      period_tolerance_s: d.period_tolerance_s as number, refractory_s: d.refractory_s as number,
      release_s: d.release_s as number,
    };
  } else {
    const period = doc.period_s as number;
    params = { threshold: 0.55, near_threshold: 0.35, min_repetitions: 2, period_s: period, period_tolerance_s: 0.25, refractory_s: 1.5, release_s: 2 * period + 1 };
  }
  return { q, frames, bins, band, params };
}
