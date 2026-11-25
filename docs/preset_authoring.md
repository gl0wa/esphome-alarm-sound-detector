# Authoring a preset with the preset studio

A **preset** is one appliance model + one sound: an averaged, quantised
spectral template plus the detection parameters tuned for it. The preset
studio is a static website — all processing happens in your browser, audio
never leaves your device, and no audio is ever stored in a preset (only the
template, which cannot be turned back into audio).

Site URL (after the repo goes public + Pages is enabled):
**https://gl0wa.github.io/esphome-alarm-sound-detector/**.
To try it locally: `cd web && npm install && npm run build && npm run preview`.

## 1. Record

- **Best:** flash the `audio_capture` dev firmware (`firmware/thermomix-detector-dev.yaml`),
  record with the device's own INMP441 mic (`tools/capture/tmx_capture.py`), and load the
  FLAC files into the studio. This is the exact microphone the detector will listen with.
- **Also fine for a first try:** the studio can record from your phone/laptop mic
  (step 1, “Record from microphone”). A phone/laptop mic hears differently from the
  INMP441, so treat mic-made presets as drafts and re-check them against device recordings.

Record one long session if you can: several alarm episodes plus everyday background
sounds (speech, clatter, other appliances). The background is what the false-alarm
check in step 4 needs.

What NOT to share: household audio stays yours. Never attach recordings to GitHub
issues/PRs — presets contain no audio, so they are safe to contribute.

## 2. Mark examples, find similar (steps 1–2)

1. Open a recording: the spectrogram shows the 400–4500 Hz band by default. Play it,
   drag across one clear occurrence of the sound, **Mark as example**.
2. Pick it as the seed and run **Find similar**. Every recording is scanned by the
   actual firmware detector and the hits are listed with scores — play each one,
   **Accept** the true occurrences, **Reject** the rest. You can also select any
   region directly and mark it.
3. Aim for 3+ accepted examples from different episodes, plus recordings of sounds
   it must NOT match (confusers).

## 3. Build (step 3)

Every setting is explained in detail in [preset_parameters.md](preset_parameters.md)
(the studio's “?” icons link there).

- **Band:** start with 400–4500 Hz; “Suggest from examples” narrows it to where your
  sound stands out from the background. Narrower is usually more robust.
- **Sound length:** how long one beep/chime lasts (default 1.3 s).
- **Repeating vs single:** repeating alarms chain repetitions spaced ~`period` apart
  (“Estimate repetition” reads it off your examples); a lone beep is “single sound”
  with `min_repetitions: 1`.
- **Build template**, then **Suggest thresholds**: the studio scores your examples
  against the loudest background and places the threshold between them. The margin
  (weakest example minus loudest background) should be at least +0.10 — below that,
  the preset is fragile: add better examples or narrow the band.

## 4. Evaluate (step 4)

Runs the firmware detector over every loaded recording: green dots are caught
repetitions, amber are near misses, red lines are alarm on/off. Check that:

- every accepted example is caught,
- there are no stray repetitions or false alarms — click any of them to listen,
- a bundled preset (e.g. the TM6 chime) stays silent on your recordings and yours
  stays silent on others (cross-confusion check).

If anything is off, go back: reject bad examples, adjust the band/thresholds,
rebuild, re-evaluate.

## 5. Export (step 5)

Fill in the identity fields (id must be `snake_case`, e.g.
`milex_rice_cooker_finished`), then download:

- **`<id>.json`** — the v2 preset, validated against `preset.schema.json` in the page.
- **`<id>.yaml`** — the ESPHome snippet: put the JSON next to your YAML, paste the
  snippet, install. (Needs the public GitHub repo: `external_components` points at
  `github://gl0wa/esphome-alarm-sound-detector`.)
- **`<id>.labels.json`** (optional) — which regions of which files your examples came
  from, for your own records. No audio.

## 6. Contribute the preset

1. Copy the JSON to `components/alarm_sound_detector/presets/<id>.json`.
2. Fill in `provenance` (`tested_against`, `validation`, `notes`).
3. Run `python3 tools/presets/build_index.py` and commit the preset + `index.json`.
4. Open a PR with the story: what sound, how recorded, evaluation numbers
   (units caught, max background score, confusers checked). No audio attachments.

## Reference (the same pipeline as shell tools)

The studio mirrors `tools/detector/make_template.py` (alignment ±8 frames, mean,
`quantize_template`) and `tools/detector/evaluate.py`, but the DSP is the firmware
C++ core compiled to WebAssembly — verified sample-identical by `npm test`.
