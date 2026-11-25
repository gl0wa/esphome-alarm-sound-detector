# Alarm sound presets

One preset = one appliance model + one sound. A preset is a JSON file in
this directory (format v2, validated against `preset.schema.json`):

- **Identity**: `format` (must be `2`), `id` (snake_case, e.g.
  `vorwerk_thermomix_tm6_alarm`), `aliases` (old/alternative names —
  `thermomix_tm6` keeps existing YAML configs working), `name`,
  `manufacturer`, `model`, `sound`, `description`.
- **DSP**: `sample_rate` (16000), `n_fft` (512), `hop` (256), `bin_lo` /
  `bin_hi` (per-preset spectral band, 1..255; the TM6 chime uses 13..144,
  i.e. ~400–4500 Hz), `frames` / `bins` (`bins` must equal
  `bin_hi - bin_lo + 1`), `data_int8_b64` (quantised template, exactly
  `frames * bins` bytes).
- **Detection** (`detection`): `threshold`, `near_threshold` (< threshold),
  `min_repetitions`, `period_s` (number, or `null` for non-repeating sounds:
  any units within `release_s` then chain with no periodicity check —
  single-sound mode is `min_repetitions: 1`), `period_tolerance_s`,
  `refractory_s`, `release_s` (alarm ends this long after the last chained
  unit; for the TM6 that is 2·3.125 + 1 = 7.25 s).
- **Provenance** (`provenance`): `n_examples` (template units averaged),
  `tested_against` (confuser sounds checked), `validation` (e.g. "single
  household, one TM6, one volume"), `notes`.

Format v1 template files (no `detection` block) keep
loading with the original TM6 defaults; new presets must be v2.

`index.json` is the machine-readable catalog (id, aliases, band, duration,
periodic/single mode, validation). It is generated — do not edit it:

```sh
python3 tools/presets/build_index.py [--check]
```

`tests/test_presets.py` fails if the index is stale or any preset stops
validating.

## Contributing a preset

1. Record labelled sessions with the `audio_capture` dev firmware and label
   the sound onsets (see `docs/data_collection.md`).
2. Build the preset — only the averaged, quantised spectral template is
   stored, no audio:
   ```sh
   python3 tools/detector/make_template.py --session <dir>... \
     --id <manufacturer>_<model>_<sound> --manufacturer ... --model ... \
     --sound ... --band-hz 400 4500 --duration 1.3 --period 3.125 \
     --tested-against "speech, dish clatter" --validation "..." \
     --out components/alarm_sound_detector/presets/<id>.json
   ```
   Use `--no-period --release <s> --min-repetitions 1` for a non-repeating
   (single) sound; omit `--period` tuning until step 3.
3. Tune `threshold`/`near_threshold` (plus `period`, `min_repetitions`) with
   `tools/detector/evaluate.py` — it loads the preset's own detection
   parameters unless a CLI flag overrides them. Aim for all labelled units
   detected with margin above the max score outside alarms, then re-emit the
   JSON with the tuned values.
4. Add `aliases` if the sound already has a name users know, fill in
   `provenance`, run `tools/presets/build_index.py`, and add the preset +
   index to the same commit.
