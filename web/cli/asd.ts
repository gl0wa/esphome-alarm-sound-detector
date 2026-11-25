// asd — command-line preset studio for AI agents and scripts.
//
// Same code as the browser studio (web/src) and the same detector (the firmware's
// C++ core compiled to WebAssembly), bundled into one file: `node asd.mjs <command>`.
// Needs only Node.js 20+. Audio stays on this machine; nothing is uploaded.
// Full guide: docs/agent_guide.md.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { FPS, SR } from "../src/const";
import CATALOG from "../../components/alarm_sound_detector/presets/index.json";
import { getFeatures, initWasm, runDetector } from "../src/dsp";
import { findSimilar } from "../src/similar";
import { autoTune, measureSoundLength } from "../src/pipeline";
import { freshState, State } from "../src/store";
import {
  buildPresetDoc, personalPresetDoc, PresetMeta, presetTemplate, validatePreset,
} from "../src/preset";
import {
  applyHardware, BoardPreset, buildDeviceYaml, captureLink, defaultDeviceSettings, DeviceSettings, HARDWARE, hardwareOf,
  normalizeDevice, safeId, YamlPreset,
} from "../src/device";

const VERSION = "1";
const HELP = `asd — alarm sound detector preset tool (v${VERSION}). Guide: docs/agent_guide.md

Usage: node asd.mjs <command> [options]        (add --json for machine-readable output)

  boards   List hardware presets (board + microphone) for --board.
  device   --file device.json [--name kitchen-sound-detector]
           [--board stamp-s3|i2s|pdm|cores3|xiao-s3-sense|atom-echo]
           [--chip esp32s3|esp32] [--board-id ID] [--pins SCK,WS,SD | CLK,DATA] [--channel left|right]
           Create/update the device settings file (holds the API + capture keys — keep it private).
  yaml     --device device.json (--recording | --preset p.json... | --ready ID...) [--label NAME] [--out f.yaml]
           Generate the complete ESPHome YAML. --recording = temporary recording firmware.
  link     --device device.json [--ip 192.168.1.42]
           Print the recording page link (contains the capture key).
  record   --device device.json [--ip IP] --seconds N --out rec.wav
           Record N seconds from a device running the recording firmware (16 kHz WAV).
  events   rec.wav [more.wav...] [--group A --labels-out labels.json]
           List distinct sounds (time, length, pitch) and groups of similar sounds;
           optionally write one group's sounds as examples into labels.json.
  similar  --seed rec.wav@T0-T1 [--length S] [--min 0.35] files... [--labels-out labels.json [--accept 0.45]]
           Find sounds like the seed example (like "Find similar" in the studio);
           optionally write the seed + matches scoring >= --accept as examples.
  tune     --labels labels.json [--length S] --out preset.json [--name "Rice cooker"]
           [--id ID --manufacturer M --model X --sound S --validation V --tested-against A,B]
           Build and tune a preset from marked examples; prints a verdict.
  test     --preset preset.json files... [--labels labels.json]
           Run the firmware detector over recordings and report alarms / misses / false alarms.
  validate preset.json...
           Check presets against the schema.

labels.json: {"examples": [{"file": "rec.wav", "t0": 18.6, "t1": 19.26}, ...]}  (paths relative to the labels file)
`;

// ---------- argument parsing ----------
const BOOL_FLAGS = new Set(["json", "recording", "help"]);
type Args = { _: string[]; [k: string]: string | string[] | boolean };
function parseArgs(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (BOOL_FLAGS.has(k) || next === undefined || next.startsWith("--")) { a[k] = true; continue; }
      i++;
      const prev = a[k];
      a[k] = prev === undefined || prev === true ? next : Array.isArray(prev) ? [...prev, next] : [prev as string, next];
    } else a._.push(t);
  }
  return a;
}
const str = (a: Args, k: string, d?: string): string | undefined => {
  const v = a[k];
  return typeof v === "string" ? v : Array.isArray(v) ? v[v.length - 1] : d;
};
const list = (a: Args, k: string): string[] => {
  const v = a[k];
  return typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
};
const num = (a: Args, k: string, d?: number): number | undefined => {
  const v = str(a, k);
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) die(`--${k} must be a number`);
  return n;
};
function die(msg: string): never {
  process.stderr.write(`asd: ${msg}\n`);
  process.exit(2);
}
let JSON_OUT = false;
function out(human: string, data: unknown) {
  process.stdout.write(JSON_OUT ? JSON.stringify(data, null, 1) + "\n" : human.replace(/\n?$/, "\n"));
}

// ---------- WAV I/O ----------
export function readWav(path: string): Int16Array {
  const b = readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") {
    die(`${path}: not a WAV file. Convert first, e.g. ffmpeg -i in.m4a -ac 1 -ar 16000 out.wav`);
  }
  let off = 12, fmt = 0, ch = 1, rate = 0, bits = 0, data: Buffer | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    const body = b.subarray(off + 8, off + 8 + size);
    if (id === "fmt ") {
      fmt = body.readUInt16LE(0); ch = body.readUInt16LE(2); rate = body.readUInt32LE(4); bits = body.readUInt16LE(14);
      if (fmt === 0xfffe && body.length >= 26) fmt = body.readUInt16LE(24);
    } else if (id === "data") data = body;
    off += 8 + size + (size & 1);
  }
  if (!data || !rate) die(`${path}: no audio data`);
  const bps = bits / 8, n = Math.floor(data.length / (bps * ch));
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) {
      const p = (i * ch + c) * bps;
      acc += fmt === 3 ? (bits === 32 ? data.readFloatLE(p) : data.readDoubleLE(p))
        : bits === 16 ? data.readInt16LE(p) / 32768
          : bits === 24 ? data.readIntLE(p, 3) / 8388608
            : bits === 32 ? data.readInt32LE(p) / 2147483648
              : bits === 8 ? (data[p] - 128) / 128 : die(`${path}: unsupported ${bits}-bit WAV`);
    }
    mono[i] = acc / ch;
  }
  const x = rate === SR ? mono : resample(mono, rate, SR);
  const pcm = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768)));
  return pcm;
}

/** Windowed-sinc resampler (anti-aliased), good enough for analysis. */
function resample(x: Float32Array, from: number, to: number): Float32Array {
  const ratio = to / from, n = Math.floor(x.length * ratio), y = new Float32Array(n);
  const cutoff = Math.min(1, ratio) * 0.95, half = 24;
  for (let i = 0; i < n; i++) {
    const c = i / ratio, c0 = Math.floor(c);
    let acc = 0, wsum = 0;
    for (let k = c0 - half + 1; k <= c0 + half; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = c - k, t = Math.PI * d * cutoff;
      const sinc = d === 0 ? 1 : Math.sin(t) / t;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / half);
      acc += x[k] * sinc * w; wsum += sinc * w;
    }
    y[i] = wsum ? acc / wsum : 0;
  }
  return y;
}

function writeWav(path: string, pcm: Int16Array) {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i], 44 + i * 2);
  writeFileSync(path, b);
}

// ---------- device settings ----------
function loadDevice(path: string | undefined, create = false): DeviceSettings {
  if (!path) die("--device device.json is required (create it with: asd device --file device.json)");
  if (!existsSync(path)) {
    if (!create) die(`${path} not found (create it with: asd device --file ${path})`);
    return defaultDeviceSettings();
  }
  return normalizeDevice(JSON.parse(readFileSync(path, "utf8")));
}

function cmdDevice(a: Args) {
  const file = str(a, "file") ?? die("--file device.json is required");
  const d = loadDevice(file, true);
  const name = str(a, "name");
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) die("--name: lowercase letters, digits and dashes only");
    d.deviceName = name;
  }
  const board = str(a, "board");
  if (board) {
    if (!HARDWARE.some((h) => h.id === board)) die(`--board must be one of: ${HARDWARE.map((h) => h.id).join(", ")}`);
    Object.assign(d, applyHardware(d, board as BoardPreset));
  }
  const hw = hardwareOf(d.board);
  const custom = (what: string) => { if (!hw.editable) die(`--${what} needs a generic board: --board i2s or --board pdm`); };
  const bid = str(a, "board-id"); if (bid) { custom("board-id"); d.boardId = bid; }
  const chip = str(a, "chip");
  if (chip) { custom("chip"); if (chip !== "esp32" && chip !== "esp32s3") die("--chip esp32 or esp32s3"); d.chip = chip; }
  const pins = str(a, "pins");
  if (pins) {
    custom("pins");
    const p = pins.split(",").map((x) => x.trim());
    if (hw.mic === "i2s") { if (p.length !== 3) die("--pins SCK,WS,SD e.g. GPIO1,GPIO7,GPIO5"); [d.sck, d.ws, d.sd] = p; }
    else { if (p.length !== 2) die("--pins CLK,DATA e.g. GPIO42,GPIO41"); [d.ws, d.sd] = p; }
  }
  const chn = str(a, "channel"); if (chn === "left" || chn === "right") { custom("channel"); d.channel = chn; }
  writeFileSync(file, JSON.stringify(d, null, 1) + "\n", { mode: 0o600 });
  const hw2 = hardwareOf(d.board);
  const pinTxt = hw2.mic === "i2s" ? `SCK ${d.sck}, WS ${d.ws}, SD ${d.sd}, ${d.channel}` : hw2.mic === "pdm" ? `CLK ${d.ws}, DATA ${d.sd}, ${d.channel}` : "built-in ES7210";
  out(`wrote ${file}: device "${d.deviceName}", ${hw2.label} — ${d.chip}, board ${d.boardId}, ${pinTxt}.\n` +
    (hw2.tested ? "" : "This hardware is not yet verified by the project: check the microphone level after installing (asd record peak > -45 dBFS).\n") +
    "It contains the API encryption key and the capture key: keep it private, do not commit it.",
  { file, deviceName: d.deviceName, board: d.board, label: hw2.label, tested: hw2.tested, chip: d.chip, boardId: d.boardId, mic: hw2.mic, pins: hw2.mic === "i2s" ? [d.sck, d.ws, d.sd] : [d.ws, d.sd], channel: d.channel });
}

function cmdYaml(a: Args) {
  const dev = loadDevice(str(a, "device"));
  const presets: YamlPreset[] = [];
  for (const p of list(a, "preset")) {
    const doc = JSON.parse(readFileSync(p, "utf8"));
    const v = validatePreset(doc);
    if (!v.ok) die(`${p}: ${v.errors.join("; ")}`);
    const label = str(a, "label") ?? (doc.name as string);
    presets.push({ id: safeId(label || (doc.id as string)), ref: null, doc, label });
  }
  for (const id of list(a, "ready")) {
    const known = (CATALOG.presets as { id: string; aliases?: string[] }[]).some((p) => p.id === id || (p.aliases ?? []).includes(id));
    if (!known) die(`--ready ${id}: not in the bundled catalog (${CATALOG.presets.map((p: { id: string }) => p.id).join(", ")})`);
    presets.push({ id: safeId(id.replace(/^vorwerk_/, "").replace(/_alarm$/, "")), ref: id });
  }
  const rec = a.recording === true;
  if (rec && presets.length) die("--recording makes the temporary recording firmware; it cannot be combined with --preset/--ready (install the normal firmware with the preset afterwards)");
  if (!rec && !presets.length) die("give --recording, or at least one --preset / --ready");
  const yaml = buildDeviceYaml(dev, presets, rec);
  const o = str(a, "out");
  if (o) writeFileSync(o, yaml, { mode: 0o600 }); // contains the API (and capture) key
  if (o || JSON_OUT) out(`wrote ${o}`, { out: o ?? null, yaml: o ? undefined : yaml, recording: rec });
  else process.stdout.write(yaml);
}

function cmdLink(a: Args) {
  const dev = loadDevice(str(a, "device"));
  const link = captureLink(dev.deviceName, dev.captureKey, str(a, "ip") ?? "");
  out(link, { link });
}

async function cmdRecord(a: Args) {
  const dev = loadDevice(str(a, "device"));
  const secs = num(a, "seconds") ?? die("--seconds is required");
  const file = str(a, "out") ?? die("--out rec.wav is required");
  const host = str(a, "ip") ?? `${dev.deviceName}.local`;
  const want = Math.round(secs * SR) * 2;
  const ctrl = new AbortController();
  const res = await fetch(`http://${host}/api/stream`, { headers: { Authorization: `Bearer ${dev.captureKey}` }, signal: ctrl.signal })
    .catch((e) => die(`cannot reach http://${host}/ (${e}). Is the recording firmware installed? Try --ip.`));
  if (res.status === 401) die("the device rejected the capture key (device.json differs from the installed recording firmware?)");
  if (res.status === 409) die("the device is already streaming to another browser (close the recording page there)");
  if (res.status === 429) die("too many wrong keys: the device locked access for 30 s");
  if (!res.ok || !res.body) die(`unexpected HTTP ${res.status}`);
  const chunks: Uint8Array[] = [];
  let got = 0;
  process.stderr.write(`recording ${secs} s from ${host}…\n`);
  const reader = res.body.getReader();
  while (got < want) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
  }
  ctrl.abort();
  const buf = Buffer.concat(chunks).subarray(0, Math.min(got, want) & ~1);
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  writeWav(file, pcm);
  let peak = 0; for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  out(`wrote ${file}: ${(pcm.length / SR).toFixed(1)} s, peak ${(20 * Math.log10(peak / 32768 + 1e-9)).toFixed(1)} dBFS` +
    (got < want ? " (stream ended early)" : ""), { file, seconds: pcm.length / SR, peak_dbfs: 20 * Math.log10(peak / 32768 + 1e-9), complete: got >= want });
}

// ---------- analysis ----------
interface Ev { file: string; t0: number; t1: number; dur: number; hz: number; db: number; group?: string }
/** Each event's spectral shape (mean dB above the noise floor per bin, smoothed), for grouping. */
const SHAPE = new WeakMap<Ev, Float32Array>();
function shapeOf(spec: Float32Array, n: number): Float32Array {
  const out = new Float32Array(spec.length);
  for (let b = 0; b < spec.length; b++) {
    let acc = 0, w = 0;
    for (let d = -3; d <= 3; d++) { const v = spec[b + d]; if (v !== undefined) { acc += Math.max(0, v / n); w++; } }
    out[b] = acc / w;
  }
  let norm = 0; for (const v of out) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let b = 0; b < out.length; b++) out[b] /= norm;
  return out;
}
const cosine = (a: Float32Array, b: Float32Array) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; };

function detectEvents(file: string, pcm: Int16Array): Ev[] {
  const lo = 3, f = getFeatures(pcm, lo, 252);
  if (!f.frames) return [];
  const lvl = new Float32Array(f.frames);
  const top = new Float32Array(5);
  for (let k = 0; k < f.frames; k++) {
    top.fill(0);
    for (let b = 0; b < f.bins; b++) { const v = f.data[k * f.bins + b]; if (v > top[4]) { top[4] = v; top.sort((x, y) => y - x); } }
    lvl[k] = (top[0] + top[1] + top[2] + top[3] + top[4]) / 5;
  }
  const sorted = Array.from(lvl).sort((x, y) => x - y);
  const base = sorted[Math.floor(sorted.length * 0.2)];
  const on = base + 10, maxGap = Math.round(0.08 * FPS);
  const tOf = (k: number) => (k * 256 + 256) / SR;
  const evs: Ev[] = [];
  let k = 0;
  while (k < f.frames) {
    if (lvl[k] < on) { k++; continue; }
    let end = k, gap = 0, j = k;
    for (; j < f.frames; j++) { if (lvl[j] >= on) { end = j; gap = 0; } else if (++gap > maxGap) break; }
    if ((end - k + 1) / FPS >= 0.08) {
      const spec = new Float32Array(f.bins);
      let peak = 0;
      for (let q = k; q <= end; q++) { peak = Math.max(peak, lvl[q]); for (let b = 0; b < f.bins; b++) spec[b] += f.data[q * f.bins + b]; }
      let bb = 0; for (let b = 1; b < f.bins; b++) if (spec[b] > spec[bb]) bb = b;
      const ev: Ev = { file, t0: +tOf(k).toFixed(2), t1: +tOf(end).toFixed(2), dur: +((end - k + 1) / FPS).toFixed(2),
        hz: Math.round((bb + lo) * 31.25), db: +(peak - base).toFixed(1) };
      SHAPE.set(ev, shapeOf(spec, end - k + 1));
      evs.push(ev);
    }
    k = j;
  }
  return evs;
}

function groupEvents(evs: Ev[]) {
  // Same sound = similar spectral shape (not just the loudest pitch, which room
  // echo and the microphone can shift) and similar length.
  const groups: { id: string; hz: number; dur: number; shape: Float32Array; members: Ev[] }[] = [];
  for (const e of evs) {
    const sh = SHAPE.get(e)!;
    let best: (typeof groups)[number] | null = null, bestSim = 0.85;
    for (const g of groups) {
      if (e.dur / g.dur >= 1.6 || g.dur / e.dur >= 1.6) continue;
      if (Math.max(e.hz, g.hz) / Math.max(1, Math.min(e.hz, g.hz)) >= 1.6) continue;
      const sim = cosine(sh, g.shape);
      if (sim > bestSim) { bestSim = sim; best = g; }
    }
    if (best) { best.members.push(e); e.group = best.id; }
    else {
      const id = String.fromCharCode(65 + (groups.length % 26)) + (groups.length >= 26 ? groups.length : "");
      groups.push({ id, hz: e.hz, dur: e.dur, shape: sh, members: [e] }); e.group = id;
    }
  }
  return groups.filter((g) => g.members.length >= 2).map((g) => {
    const sp: number[] = [];
    for (let i = 1; i < g.members.length; i++) {
      const a = g.members[i - 1], b = g.members[i];
      if (a.file === b.file) sp.push(+(b.t0 - a.t0).toFixed(2));
    }
    const med = (v: number[]) => v.length ? [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)] : null;
    return { group: g.id, count: g.members.length, pitch_hz: g.hz, median_length_s: med(g.members.map((m) => m.dur)), median_spacing_s: med(sp.filter((x) => x < 30)) };
  }).sort((x, y) => y.count - x.count);
}

function cmdEvents(a: Args) {
  if (!a._.length) die("give one or more WAV files");
  const all: Ev[] = [];
  for (const f of a._) all.push(...detectEvents(f, readWav(f)));
  const groups = groupEvents(all);
  const lines = all.map((e) => `${e.file}  ${e.t0.toFixed(2)}–${e.t1.toFixed(2)} s  ${e.dur.toFixed(2)} s  ~${e.hz} Hz  +${e.db} dB  group ${e.group}`);
  const gl = groups.map((g) => `group ${g.group}: ${g.count}× ~${g.pitch_hz} Hz, ~${g.median_length_s} s long` + (g.median_spacing_s ? `, typically ${g.median_spacing_s} s apart` : ""));
  const lo = str(a, "labels-out");
  if (lo) {
    const g = str(a, "group") ?? die("--labels-out needs --group (a group id from this list)");
    const base = dirname(resolve(lo));
    const ex = all.filter((e) => e.group === g).map((e) => ({
      file: relative(base, resolve(e.file)), t0: +Math.max(0, e.t0 - 0.05).toFixed(2), t1: +(e.t1 + 0.05).toFixed(2),
    }));
    if (!ex.length) die(`no sounds in group ${g}`);
    writeFileSync(lo, JSON.stringify({ examples: ex, recordings: [...new Set(a._.map((f) => relative(base, resolve(f))))] }, null, 1) + "\n");
    process.stderr.write(`wrote ${lo} with ${ex.length} examples from group ${g}\n`);
  }
  out(`${all.length} sounds:\n${lines.join("\n")}\n\nRepeated sounds (alarm candidates):\n${gl.join("\n") || "(none)"}`, { events: all, groups });
}

function loadState(files: string[]): State {
  const s = freshState();
  s.recordings = files.map((f) => ({ id: resolve(f), name: relative(process.cwd(), resolve(f)) || f, pcm: readWav(f) }));
  return s;
}

function cmdSimilar(a: Args) {
  const seed = str(a, "seed") ?? die("--seed file.wav@T0-T1 is required");
  const m = /^(.*)@([\d.]+)-([\d.]+)$/.exec(seed) ?? die("--seed format: file.wav@18.6-19.26");
  const files = [...new Set([m[1], ...a._])];
  const s = loadState(files);
  s.examples = [{ id: "seed", recId: resolve(m[1]), t0: +m[2], t1: +m[3] }];
  const rec = s.recordings.find((r) => r.id === resolve(m[1]))!;
  s.duration = num(a, "length") ?? measureSoundLength(rec.pcm, +m[2], +m[3]) ?? Math.max(0.2, Math.min(5, +m[3] - +m[2]));
  findSimilar(s, "seed", num(a, "min", 0.35)!);
  const rows = s.candidates.map((c) => ({ file: s.recordings.find((r) => r.id === c.recId)!.name, t0: +c.t0.toFixed(2), t1: +c.t1.toFixed(2), score: +c.score.toFixed(3) }));
  const lo = str(a, "labels-out");
  if (lo) {
    const acc = num(a, "accept", num(a, "min", 0.35))!;
    const base = dirname(resolve(lo));
    const keep = rows.filter((r) => r.score >= acc);
    const ex = [{ file: m[1], t0: +m[2], t1: +m[3] }, ...keep].map((r) => ({ file: relative(base, resolve(r.file)), t0: r.t0, t1: r.t1 }));
    writeFileSync(lo, JSON.stringify({ examples: ex, recordings: files.map((f) => relative(base, resolve(f))) }, null, 1) + "\n");
    process.stderr.write(`wrote ${lo}: the seed + ${keep.length} matches scoring ≥ ${acc} (check the lowest ones; raise --accept to drop doubtful matches)\n`);
  }
  out(`sound length ${s.duration} s; ${rows.length} matches (highest first):\n` +
    rows.map((r) => `${r.score.toFixed(2)}  ${r.file}  ${r.t0.toFixed(2)}–${r.t1.toFixed(2)} s`).join("\n") +
    (lo ? "" : "\nWrite the real ones into labels.json (or use --labels-out), then run: asd tune --labels labels.json"),
  { length_s: s.duration, seed: { file: m[1], t0: +m[2], t1: +m[3] }, matches: rows });
}

function readLabels(path: string): { s: State; base: string } {
  const j = JSON.parse(readFileSync(path, "utf8"));
  const ex = (j.examples ?? []) as { file: string; t0: number; t1: number }[];
  if (!ex.length) die(`${path}: no "examples"`);
  const base = dirname(resolve(path));
  const files = [...new Set([...ex.map((e) => resolve(base, e.file)), ...((j.recordings ?? []) as string[]).map((f) => resolve(base, f))])];
  const s = loadState(files);
  s.examples = ex.map((e, i) => ({ id: `e${i}`, recId: resolve(base, e.file), t0: e.t0, t1: e.t1 }));
  return { s, base };
}

function cmdTune(a: Args) {
  const { s } = readLabels(str(a, "labels") ?? die("--labels labels.json is required"));
  const nameOf = (id: string) => s.recordings.find((r) => r.id === id)?.name ?? id;
  const first = s.examples[0], rec = s.recordings.find((r) => r.id === first.recId)!;
  s.duration = num(a, "length") ?? measureSoundLength(rec.pcm, first.t0, first.t1) ?? 1.3;
  const r = autoTune(s);
  const meta: PresetMeta = {
    id: str(a, "id") ?? "", name: str(a, "name") ?? "", manufacturer: str(a, "manufacturer") ?? "", model: str(a, "model") ?? "",
    sound: str(a, "sound") ?? "", description: str(a, "description") ?? "", aliases: list(a, "alias"),
    testedAgainst: str(a, "tested-against") ?? "", validation: str(a, "validation") ?? "", notes: str(a, "notes") ?? "",
  };
  const full = buildPresetDoc(meta, s.template!, s.band, s.params, s.examples.length);
  const shareable = validatePreset(full).ok;
  const doc = shareable ? full : personalPresetDoc(meta, s.template!, s.band, s.params, s.examples.length);
  const file = str(a, "out") ?? die("--out preset.json is required");
  writeFileSync(file, JSON.stringify(doc, null, 1) + "\n");
  const summary = {
    out: file, verdict: r.verdict, margin: +r.margin.toFixed(3),
    weakest_example: +s.margin!.minPos.toFixed(3), most_similar_other: +s.margin!.maxNeg.toFixed(3),
    band_hz: [s.band.loHz, s.band.hiHz], length_s: s.duration, period_s: s.params.period_s,
    min_repetitions: s.params.min_repetitions, threshold: s.params.threshold, near_threshold: s.params.near_threshold,
    examples: s.examples.length, shareable,
    most_similar_other_at: r.mostSimilarOther ? { file: nameOf(r.mostSimilarOther.recId), t0: +r.mostSimilarOther.t0.toFixed(2), t1: +r.mostSimilarOther.t1.toFixed(2) } : null,
    weakest_example_at: r.weakestExample ? { file: nameOf(r.weakestExample.recId), t: +r.weakestExample.t.toFixed(2) } : null,
  };
  out(`wrote ${file} — on these recordings: ${{ good: "reliable", fair: "usable but close", bad: "FRAGILE" }[r.verdict]} (margin ${r.margin >= 0 ? "+" : ""}${r.margin.toFixed(2)}: weakest example ${summary.weakest_example}, most similar other sound ${summary.most_similar_other})\n` +
    `listens to ${s.band.loHz}–${s.band.hiHz} Hz, sound ${s.duration} s, ` +
    (s.params.period_s ? `repeats every ${s.params.period_s.toFixed(2)} s, alarm after ${s.params.min_repetitions} matches` : `single sound, alarm after ${s.params.min_repetitions} match(es)`) +
    `, threshold ${s.params.threshold}\n${r.bandText} ${r.periodText}` +
    (summary.most_similar_other_at ? `\nmost similar other sound: ${summary.most_similar_other_at.file} ${summary.most_similar_other_at.t0}–${summary.most_similar_other_at.t1} s` +
      (r.verdict !== "good" ? " — if this is an unlabelled occurrence of the alarm, add it to labels.json and tune again" : "") : "") +
    (summary.weakest_example_at ? `\nweakest example: ${summary.weakest_example_at.file} around ${summary.weakest_example_at.t} s` : "") +
    "\nVerify with recordings not used for tuning (asd test) and, after installing, with the real appliance." +
    (shareable ? "" : "\n(personal preset: give --id --name --manufacturer --model --sound --validation to make it shareable)"), summary);
}

function cmdTest(a: Args) {
  const pfile = str(a, "preset") ?? die("--preset preset.json is required");
  const doc = JSON.parse(readFileSync(pfile, "utf8"));
  const v = validatePreset(doc); if (!v.ok) die(`${pfile}: ${v.errors.join("; ")}`);
  const p = presetTemplate(doc);
  const lf = str(a, "labels");
  const lab = lf ? readLabels(lf) : null;
  const files = lab ? lab.s.recordings.map((r) => r.name) : a._;
  const extra = lab ? a._.filter((f) => !lab.s.recordings.some((r) => r.id === resolve(f))) : [];
  const recs = [...(lab ? lab.s.recordings : []), ...loadState(lab ? extra : files).recordings];
  if (!recs.length) die("give WAV files or --labels");
  const results = recs.map((r) => {
    const { scores, firstFrame, events } = runDetector(r.pcm, p.q, p.frames, p.bins, p.params, p.band);
    const units = events.filter((e) => e.type === "unit").map((e) => +e.t.toFixed(2));
    const expected = lab ? lab.s.examples.filter((e) => e.recId === r.id).map((e) => (e.t0 + e.t1) / 2) : [];
    const W = p.frames / FPS;
    // One detection recognises at most one example (closest first).
    const fits = (u: number, t: number) => u - W - 0.6 <= t && t <= u + 0.6;
    const usedU = new Set<number>(), usedE = new Set<number>();
    const pairs: [number, number, number][] = [];
    units.forEach((u, ui) => expected.forEach((t, ei) => { if (fits(u, t)) pairs.push([Math.abs(u - W / 2 - t), ui, ei]); }));
    pairs.sort((x, y) => x[0] - y[0]);
    for (const [, ui, ei] of pairs) if (!usedU.has(ui) && !usedE.has(ei)) { usedU.add(ui); usedE.add(ei); }
    const missed = expected.filter((_, ei) => !usedE.has(ei)).map((t) => +t.toFixed(2));
    const stray = lab ? units.filter((_, ui) => !usedU.has(ui)) : [];
    let max = 0; for (const x of scores) max = Math.max(max, x);
    void firstFrame;
    return {
      file: r.name, alarm_on: events.filter((e) => e.type === "alarm_on").map((e) => +e.t.toFixed(2)),
      matches: units.length, near_misses: events.filter((e) => e.type === "near").map((e) => ({ t: +e.t.toFixed(2), score: +e.score.toFixed(2) })),
      max_score: +max.toFixed(3), ...(lab ? { examples: expected.length, missed, stray_matches: stray } : {}),
    };
  });
  const lines = results.map((x) => `${x.file}: alarm on at [${x.alarm_on.join(", ")}] s, ${x.matches} matches, ${x.near_misses.length} near misses, max score ${x.max_score}` +
    (lab ? `; examples ${x.examples! - x.missed!.length}/${x.examples} recognised` + (x.missed!.length ? ` (missed at ${x.missed!.join(", ")})` : "") +
      (x.stray_matches!.length ? `; ${x.stray_matches!.length} matches away from examples at ${x.stray_matches!.join(", ")} — listen/ask the user` : "") : ""));
  out(lines.join("\n"), { preset: pfile, results });
}

function cmdValidate(a: Args) {
  if (!a._.length) die("give preset JSON files");
  let bad = 0;
  const res = a._.map((f) => { const v = validatePreset(JSON.parse(readFileSync(f, "utf8"))); if (!v.ok) bad++; return { file: f, ...v }; });
  out(res.map((r) => `${r.ok ? "ok " : "BAD"} ${r.file}${r.ok ? "" : ": " + r.errors.join("; ")}`).join("\n"), res);
  if (bad) process.exit(1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  JSON_OUT = a.json === true;
  if (!cmd || cmd === "help" || cmd === "--help" || a.help) { process.stdout.write(HELP); return; }
  if (cmd === "version" || cmd === "--version") { out(VERSION, { version: VERSION }); return; }
  if (cmd === "boards") {
    out(HARDWARE.map((h) => `${h.id.padEnd(14)} ${h.tested ? "tested  " : "untested"} ${h.label}\n${" ".repeat(24)}${h.note}`).join("\n"),
      HARDWARE.map(({ id, label, mic, chip, boardId, tested, note }) => ({ id, label, mic, chip, boardId, tested, note })));
    return;
  }
  if (cmd === "device") return cmdDevice(a);
  if (cmd === "yaml") return cmdYaml(a);
  if (cmd === "link") return cmdLink(a);
  if (cmd === "record") return cmdRecord(a);
  if (cmd === "validate") return cmdValidate(a);
  await initWasm();
  if (cmd === "events") return cmdEvents(a);
  if (cmd === "similar") return cmdSimilar(a);
  if (cmd === "tune") return cmdTune(a);
  if (cmd === "test") return cmdTest(a);
  die(`unknown command "${cmd}" (try: node asd.mjs help)`);
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
