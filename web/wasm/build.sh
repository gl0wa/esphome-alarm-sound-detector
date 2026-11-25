#!/bin/sh
# Build the detector WebAssembly module (runs the FIRMWARE DSP in the browser).
# Usage: web/wasm/build.sh [outdir]   (default: web/src/wasm)
# Requires emscripten (emcc). In CI the emsdk version is pinned in
# .github/workflows/pages.yml / ci.yml; locally `brew install emscripten` works.
set -eu
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTDIR="${1:-$REPO_ROOT/web/src/wasm}"
mkdir -p "$OUTDIR"
em++ -O2 -std=c++17 \
  -I"$REPO_ROOT" \
  "$REPO_ROOT/components/alarm_sound_detector/detector_core.cpp" \
  "$REPO_ROOT/web/wasm/detector_wasm.cpp" \
  -o "$OUTDIR/detector.js" \
  -sWASM=1 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sSINGLE_FILE=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=node,web \
  -sEXPORTED_FUNCTIONS=_det_free,_det_features_int16,_det_create,_det_feed_int16,_det_num_scores,_det_copy_scores,_det_num_events,_det_copy_events,_det_destroy,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAP8,HEAPU8,HEAP16,HEAP32,HEAPF32,HEAPF64 \
  -sINCOMING_MODULE_JS_API=onRuntimeInitialized
echo "wrote $OUTDIR/detector.js"
