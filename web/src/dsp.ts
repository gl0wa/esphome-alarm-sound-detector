// WASM DSP wrapper. All signal processing runs in the firmware C++ core
// compiled with emscripten (web/wasm/detector_wasm.cpp); this file only
// moves buffers across the boundary. No audio or DSP math here.
import { BIN_MAX, DetEvent, DetParams, EventType } from "./const";

interface WasmModule {
  HEAP8: Int8Array;
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _det_free(p: number): void;
  _det_features_int16(pcm: number, n: number, binLo: number, binHi: number, outFrames: number, outBins: number): number;
  _det_create(tmpl: number, frames: number, bins: number, thr: number, near: number, period: number, tol: number, minRep: number, peakWin: number, refr: number, release: number, binLo: number, binHi: number): number;
  _det_feed_int16(h: number, pcm: number, n: number): void;
  _det_num_scores(h: number): number;
  _det_copy_scores(h: number, out: number): void;
  _det_num_events(h: number): number;
  _det_copy_events(h: number, types: number, times: number, scores: number): void;
  _det_destroy(h: number): void;
}

// The generated glue (built by web/wasm/build.sh into src/wasm/detector.js,
// gitignored). Typed loosely here so tests can substitute a loader.
export type WasmFactory = (opts?: object) => Promise<WasmModule>;

let mod: WasmModule | null = null;
let loadPromise: Promise<WasmModule> | null = null;

export async function initWasm(factory?: WasmFactory): Promise<WasmModule> {
  if (mod) return mod;
  if (!loadPromise) {
    loadPromise = (async () => {
      const create: WasmFactory = factory ?? (await import("./wasm/detector.js")).default;
      mod = await create();
      return mod!;
    })();
  }
  return loadPromise;
}

function m(): WasmModule {
  if (!mod) throw new Error("WASM not initialised (call initWasm first)");
  return mod!;
}

function withAlloc<T>(nBytes: number, fn: (ptr: number) => T): T {
  const mm = m();
  const p = mm._malloc(nBytes);
  try {
    return fn(p);
  } finally {
    mm._free(p);
  }
}

function copyInt16ToHeap(pcm: Int16Array): number {
  const mm = m();
  const p = mm._malloc(pcm.length * 2);
  mm.HEAP16.set(pcm, p >> 1);
  return p;
}

export interface Features {
  data: Float32Array; // row-major [frames x bins], dB above floor
  frames: number;
  bins: number;
}

/** Float dB-above-floor features from int16 16 kHz mono audio (firmware DSP). */
export function getFeatures(pcm: Int16Array, binLo: number, binHi: number): Features {
  const mm = m();
  if (binLo < 1 || binHi > BIN_MAX || binLo > binHi) throw new Error("invalid band");
  if (pcm.length < 512) return { data: new Float32Array(0), frames: 0, bins: binHi - binLo + 1 };
  const pPcm = copyInt16ToHeap(pcm);
  try {
    return withAlloc(8, (pOut) => {
      const pFeat = mm._det_features_int16(pPcm, pcm.length, binLo, binHi, pOut, pOut + 4);
      const frames = mm.HEAP32[pOut >> 2];
      const bins = mm.HEAP32[(pOut >> 2) + 1];
      if (!pFeat || frames === 0) return { data: new Float32Array(0), frames: 0, bins };
      const data = new Float32Array(frames * bins);
      data.set(mm.HEAPF32.subarray(pFeat >> 2, (pFeat >> 2) + frames * bins));
      mm._det_free(pFeat);
      return { data, frames, bins };
    });
  } finally {
    mm._free(pPcm);
  }
}

const TYPE_NAMES: EventType[] = ["unit", "near", "alarm_on", "alarm_off"];

export interface RunResult {
  scores: Float32Array; // one per scored frame, starting at frame W (1-based)
  firstFrame: number; // 1-based frame index of scores[0] (= template frames W)
  events: DetEvent[];
}

/** Run the firmware streaming detector over int16 audio with a preset. */
export function runDetector(
  pcm: Int16Array,
  tmpl: Int8Array,
  frames: number,
  bins: number,
  params: DetParams,
  band: { binLo: number; binHi: number },
): RunResult {
  const mm = m();
  const pTmpl = mm._malloc(tmpl.length);
  mm.HEAP8.set(tmpl, pTmpl);
  const period = params.period_s === null ? -1 : params.period_s;
  const h = mm._det_create(
    pTmpl, frames, bins, params.threshold, params.near_threshold, period,
    params.period_tolerance_s, params.min_repetitions, 0.4, params.refractory_s,
    params.release_s, band.binLo, band.binHi,
  );
  mm._free(pTmpl);
  if (!h) throw new Error("detector rejected the parameters/template");
  try {
    // Feed in chunks to keep memory use flat on long recordings.
    const pPcm = copyInt16ToHeap(pcm);
    try {
      const CH = 16000;
      for (let off = 0; off < pcm.length; off += CH) {
        mm._det_feed_int16(h, pPcm + off * 2, Math.min(CH, pcm.length - off));
      }
    } finally {
      mm._free(pPcm);
    }
    const nScores = mm._det_num_scores(h);
    const scores = new Float32Array(nScores);
    if (nScores > 0) {
      const pS = mm._malloc(nScores * 4);
      try {
        mm._det_copy_scores(h, pS);
        scores.set(mm.HEAPF32.subarray(pS >> 2, (pS >> 2) + nScores));
      } finally {
        mm._free(pS);
      }
    }
    const nEv = mm._det_num_events(h);
    const events: DetEvent[] = [];
    if (nEv > 0) {
      const pTy = mm._malloc(nEv * 4), pTi = mm._malloc(nEv * 8), pSc = mm._malloc(nEv * 4);
      try {
        mm._det_copy_events(h, pTy, pTi, pSc);
        for (let i = 0; i < nEv; i++) {
          events.push({
            type: TYPE_NAMES[mm.HEAP32[(pTy >> 2) + i]] ?? "near",
            t: mm.HEAPF64[(pTi >> 3) + i],
            score: mm.HEAPF32[(pSc >> 2) + i],
          });
        }
      } finally {
        mm._free(pTy);
        mm._free(pTi);
        mm._free(pSc);
      }
    }
    return { scores, firstFrame: frames, events };
  } finally {
    mm._det_destroy(h);
  }
}
