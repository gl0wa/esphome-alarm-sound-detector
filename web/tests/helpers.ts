// Shared fixture loading: runs tests/gen_ref.py (numpy synth + ref.py outputs)
// once per worker, then initialises the WASM module once.
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getFeatures, initWasm, runDetector } from "../src/dsp";
import { buildTemplate } from "../src/template";
import { FPS } from "../src/const";

export interface Fixtures {
  pcm: Int16Array;
  units: number[];
  feat: Float32Array;
  featFrames: number;
  featBins: number;
  tmpl: Int8Array;
  tmplFrames: number;
  tmplBins: number;
  scores: number[];
  events: [string, number, number][];
}

const REPO = join(__dirname, "..", "..");

function b64u8(s: string): Uint8Array {
  const b = Buffer.from(s, "base64");
  return new Uint8Array(b.buffer, b.byteOffset, b.length);
}

let cache: Fixtures | null = null;

export function loadFixtures(): Fixtures {
  if (cache) return cache;
  const dir = mkdtempSync(join(tmpdir(), "preset-studio-"));
  const out = join(dir, "fixtures.json");
  const python = process.env.PYTHON ?? "python3";
  try {
    execFileSync(python, [join(REPO, "web", "tests", "gen_ref.py"), out], {
      cwd: REPO,
      stdio: "pipe",
    });
  } catch (e) {
    throw new Error(
      `could not generate fixtures with ${python} (needs numpy): ${e}`,
    );
  }
  const j = JSON.parse(readFileSync(out, "utf8"));
  const pcmB = b64u8(j.pcm16_b64);
  const pcm = new Int16Array(pcmB.buffer, pcmB.byteOffset, pcmB.length / 2);
  const featB = b64u8(j.feat_b64);
  const tmplB = b64u8(j.tmpl_b64);
  cache = {
    pcm,
    units: j.units,
    feat: new Float32Array(featB.buffer, featB.byteOffset, featB.length / 4),
    featFrames: j.feat_frames,
    featBins: j.feat_bins,
    tmpl: new Int8Array(tmplB.buffer, tmplB.byteOffset, tmplB.length),
    tmplFrames: j.tmpl_frames,
    tmplBins: j.tmpl_bins,
    scores: j.scores,
    events: j.events,
  };
  return cache;
}

export async function wasmReady() {
  await initWasm();
}

/** TS-built template from the fixture audio, mirroring make_template.py usage. */
export function tsBuiltTemplate(fx: Fixtures) {
  const W = Math.round(1.3 * FPS);
  const f = getFeatures(fx.pcm, 13, 144);
  const starts = fx.units.slice(0, 3).map((u) => Math.round(u * FPS));
  return { ...buildTemplate([f, f, f], starts, W), W, f };
}
