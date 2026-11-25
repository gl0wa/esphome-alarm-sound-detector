# Preset studio (web/)

Static site (Vite + TypeScript) that is the single entry point for the detector:
a home screen with two modes — use a ready-made preset, or create one for your
appliance — plus the full teaching flow (record → examples → build → evaluate →
export) wrapped in a guided stepper. Exports v2 preset JSON + full ESPHome device
YAML (normal and temporary-recording flavours). All processing is in the browser —
audio never leaves the device, and the only network requests are the site's own
static assets (the QR code is generated locally with the bundled `qrcode-generator`).

## How it works

- **`src/main.ts`** — home screen (`views/home.ts`) shown when there is no
  session; header title returns there. The mode + device settings persist in
  `localStorage`; recordings/labels autosave to IndexedDB as before.
- **`src/device.ts`** — device settings (name, board preset, pins, channel,
  generated API/capture keys) and the full-device YAML builders: normal firmware
  (sound never leaves the device, Wi-Fi via `!secret`) and temporary recording
  firmware (`capture_server` + “Sound capture active” sensor). Inline presets are
  emitted as YAML mappings with exactly the preset JSON keys.
- **`src/views/usePreset.ts`** — pick bundled preset(s) from `presets/index.json`
  (each becomes its own detector + binary sensor), device card, generated YAML
  with Copy/Download and the 4 ESPHome-dashboard steps.
- **`src/views/createPreset.ts`** — stepper: install recording firmware (plain-language
  privacy box + recording YAML) → record with your phone (QR for
  `http://<name>.local/#k=<key>`, optional IP override for Android) → the existing
  steps unchanged → Export, whose first tab installs the normal firmware with the
  new preset inline.
- **`src/importClips.ts`** — validates `{type:"asd-capture-clips", …}` messages
  posted by the recording page (`#import` + `window.opener` handshake in `main.ts`):
  sampleRate 16000, ≤ 30 min each, ≤ 50 clips; unit-tested.
- **`src/device.ts`, `src/importClips.ts`** have unit tests (`tests/device.test.ts`,
  `tests/import.test.ts`).
- **`wasm/detector_wasm.cpp`** — thin C API over the *firmware* core
  (`components/alarm_sound_detector/detector_core.*`, a port of
  `tools/detector/ref.py`):
  - `det_features_int16` — float dB-above-floor features via the core's own
    feature tap (`StreamingDetector::set_float_frame_listener`, unset by
    default; zero behaviour change on the device),
  - `det_create/feed/copy/destroy` — streaming detector runs returning
    per-frame scores and events.
  - The handle owns a copy of the template (`begin()` only borrows the
    pointer — on firmware it lives in flash).
- **`wasm/build.sh`** — compiles the core + wrapper with emscripten to a
  single-file ES module (`src/wasm/detector.js`, gitignored; `SINGLE_FILE`,
  `ENVIRONMENT=node,web` so tests and the page share it).
- **`src/dsp.ts`** — buffer marshalling only (no DSP).
- **`src/template.ts`** — TypeScript port of `make_template.py`: ±8-frame
  correlation alignment vs the first example, mean, `quantize_template`.
- **`src/preset.ts`** — v2 JSON/YAML/labels export, ajv validation, bundled
  presets (copied from `components/alarm_sound_detector/presets/` at build time
  by `scripts/copy-presets.mjs`).
- **`src/views/`** — home, ready-made-preset flow, create-preset stepper, and the
  5 classic steps (recordings, examples, build, evaluate, export);
  **`src/widgets.ts`** — spectrogram/timeline canvases.

## Develop

```sh
cd web
npm install
npm run build:wasm        # needs emscripten (pinned: 7.0.1, `brew install emscripten`)
npm run dev               # + open the printed URL
```

`npm run build` outputs `dist/` with base `/esphome-alarm-sound-detector/`
(GitHub Pages). `npm run preview` serves it.

Environment: tests shell out to Python for reference data — set `PYTHON` if
`python3` lacks numpy (e.g. `PYTHON=../.venv/bin/python`), or
`pip install -r ../tools/requirements.txt`.

## Test

```sh
cd web
PYTHON=../.venv/bin/python npm test   # build:wasm + copy-presets + vitest
```

- `tests/device.test.ts` — secret shapes, friendly names, normal vs recording
  YAML contents (capture_server, secrets, mic block, inline template mapping).
- `tests/import.test.ts` — capture-clips validation (good message accepted;
  wrong type/rate/shape/size/count rejected).
- `tests/wasm_equiv.test.ts` — on seeded synthetic audio, WASM features and
  streaming scores/events vs `tools/detector/ref.py` (scores < 1e-3; identical
  event types/frames). Reference data is generated at test time by
  `tests/gen_ref.py` (numpy); nothing from `data/` is ever read.
- `tests/template.test.ts` — TS builder vs `make_template.py` logic on the same
  signal/labels: int8 template equal up to 1 LSB on ≤1% of values (reports actual).
- `tests/export.test.ts` — exported preset validates against
  `preset.schema.json` (ajv) and loads with `preset_util.py` (subprocess);
  rejects an invalid doc; YAML snippet points at the github external_component.
