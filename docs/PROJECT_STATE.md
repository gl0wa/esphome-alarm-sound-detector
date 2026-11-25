# Project state (living document for resuming work across sessions)

Private, household-specific operational notes live in `local/PRIVATE_NOTES.md`
(gitignored). This file must stay safe to publish.

## Hardware
- Reference device: M5Stack Stamp S3 (ESP32-S3FN8, 8 MB flash, no PSRAM) + INMP441.
- Wiring: SCK→GPIO1, WS→GPIO7, SD→GPIO5, L/R→GND, VDD→3V3 (docs/wiring.md).

## Toolchain
- `python3.13 -m venv .venv && .venv/bin/pip install esphome==2026.11.0 -r tools/requirements.txt`
- Tests: `.venv/bin/python -m pytest` (C++/Python equivalence, presets, capture protocol).
- Reference firmware: `cd firmware && ../.venv/bin/esphome run thermomix-detector.yaml`
  (secrets in gitignored `firmware/secrets.yaml`; template `secrets.example.yaml`).

## Status
1. [x] Base firmware + secure OTA (2026-11-24). Default 8 MB layout: 2 × 3.75 MB OTA slots.
2. [x] Encrypted dev audio capture (`components/audio_capture`, `tools/capture`), verified
   on hardware; fixed-size TX buffer + backpressure; gaps reported and zero-filled.
3. [x] Analysis (docs/acoustic_analysis.md): spectral template matching chosen.
4. [x] Component `alarm_sound_detector`, deployed and verified with a real TM6 alarm
   (repetitions 0.76–0.78, near misses: lid actuator 0.41, voice imitation 0.36).
   Generalised 2026-11-25: v2 presets (per-preset band + detection params + provenance),
   several detectors per microphone, single-sound mode; TM6 behaviour bit-identical.
5. [x] Home Assistant: entities + "notify if still ringing" blueprint (docs/home_assistant.md);
   in use; the user reports it works (no recorded end-to-end notification test by the agent).
6. [x] Public release (2026-11-25): github.com/gl0wa/esphome-alarm-sound-detector (MIT),
   preset studio on GitHub Pages (gl0wa.github.io/esphome-alarm-sound-detector), CI green
   (pytest, studio WASM tests, firmware + examples compile). Studio verified on the real TM6
   session; tools model 16-bit device input and the TM6 preset was rebuilt that way.
   Next: rice-cooker preset via the studio (user), more field validation of the TM6 preset.
7. [x] Recording from the device into the studio (2026-11-25): `capture_server` component
   (ESP-IDF httpd, own task per stream, bearer key from the studio's QR link, 401/409/429,
   lockout, max duration) + device-served recorder page (clips in IndexedDB, postMessage
   hand-off to the studio). Studio: home with two modes (ready-made / create), YAML
   generator with defaults (+ inline presets), QR code, import banner. Verified on the real
   device: 8 s stream at -34 dBFS no drops, abort, busy, lockout, page->studio import of 2 clips.
   Generated YAMLs validated by `esphome config` in CI (examples job).
8. [x] Agent support (2026-11-25): `asd` command-line tool (web/cli, same TS pipeline + WASM
   detector, one file published at /cli/asd.mjs): device settings, YAML, record from
   capture_server, events/groups, similar, auto-tune, test, validate. docs/agent_guide.md
   (+ AGENTS.md, CLAUDE.md/GEMINI.md imports, copilot-instructions, llms.txt). Studio:
   route-aware steps, one-click tuning, home page with a third "AI agent" entry point.
   Verified: smoke test in CI on synthetic beeps; `events` finds the real rice-cooker alarm
   (5× ~4 kHz, 1 s apart); `record` tested against a simulated device only (not hardware).

9. [x] Hardware generalised (2026-11-25): board/microphone presets in the studio and `asd`
   (stamp-s3, generic i2s, generic pdm, cores3 [ES7210], xiao-s3-sense, atom-echo); YAML for each
   validated by `esphome config` in CI; examples/m5stack-cores3-thermomix-tm6.yaml.
   CoreS3 SE verified on hardware: recording firmware (-35 dBFS room, -16 dBFS test beeps),
   agent test ride (OpenCode/Muse Spark 1.3) via docs/agent_guide.md end to end: preset margin
   +0.52, on-device repetitions 0.74-0.84, "Alarm started", no false alarm in 35 s silence.
   Device left running the final test-ride firmware ("testride-detector"). Other presets untested.

## Decisions
- ESP-IDF; detector at 16 kHz (TM6 content < 5 kHz); production firmware has no audio
  egress, capture is dev-only.
- Template matching + rhythm check rather than ML: wide measured margins, ~10 KB per
  preset, explainable; revisit only if real-world false positives demand it.
- Detection parameters live in presets; YAML may override. One preset = one appliance
  model + one sound. TM7 lacks the TM6 lid actuator — never rely on it.
- MVP thresholds 0.55 / near 0.35; watch match-score history for near misses.
- Repo: gl0wa/esphome-alarm-sound-detector (private until the user approves publishing);
  keep the user's existing author email; T3 Code-authored commits to be reattributed.
