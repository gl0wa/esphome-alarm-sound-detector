// Types for the emscripten-generated glue (built by web/wasm/build.sh into
// detector.js next to this file; gitignored). Kept loose: dsp.ts re-checks.
declare const createModule: (opts?: object) => Promise<{
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
}>;
export default createModule;
