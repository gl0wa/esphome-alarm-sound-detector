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
6. [~] Public release: MIT license, README, wiring, example config, CI done.
   Browser preset studio done (web/, WASM build of detector_core, Pages workflow); verified
   on the real TM6 session (both episodes, 23/23 units; studio template == Python tools
   with 16-bit input). Tools now model the 16-bit device input; TM6 preset rebuilt that way.
   Pending: rice-cooker preset (user will do it with the studio later), final history scan +
   rewrite (strip private notes, unify authorship), user go-ahead to make public.

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
