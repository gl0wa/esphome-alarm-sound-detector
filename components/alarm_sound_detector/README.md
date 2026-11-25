# `alarm_sound_detector`

On-device template matcher that raises an alarm when a known appliance sound
repeats (or, for single-sound presets, occurs). It is a port of the reference
detector in `tools/detector/ref.py` (the spec) to a portable C++ core
(`detector_core.h/.cpp`, no ESPHome includes) plus a thin ESPHome wrapper.

Each detector instance is driven by one **preset** (`presets/*.json`, format
v2, or a legacy v1 template file): an averaged, quantised spectral template
plus the DSP band and detection parameters tuned for that sound. Several
detectors can share one microphone, each with its own preset/entities.

## How it works

1. Microphone audio (16 kHz mono) is framed into 512-sample Hann windows with
   a 256-sample hop, converted to a log-power spectrum, restricted to the
   preset's band (`bin_lo..bin_hi`; 132 bins at 400–4500 Hz for the TM6),
   and normalised against a per-bin min-tracking noise floor
   (instant fall, +3 dB/s rise).
2. The normalised frame is quantised to uint8 in 0.5 dB steps into a circular
   history of the last W frames (W comes from the preset, 81 for the TM6).
3. Each frame, the normalised cross-correlation of the history against the
   quantised int8 template is scored exactly as `ncc_quantized` in `ref.py`.
4. `StreamingDetector` turns scores into events: a candidate peak opens when
   the score crosses `near_threshold` and closes 0.4 s after its best frame;
   peaks above `threshold` are `unit` repetitions (refractory 1.5 s by
   default). For periodic presets, units spaced by ~k·`period` (k = 1 or 2,
   tolerance `period_tolerance`·k) form a chain; stray units during an alarm
   are ignored; `min_repetitions` chained units raise the alarm; silence
   longer than `release_s` ends it. For single-sound presets (`period_s`
   null), any units within `release_s` of each other chain towards
   `min_repetitions` with no periodicity check (single-sound mode is
   `min_repetitions: 1`).

The core keeps timing in frame counts (no float drift) and shares no code
with ESPHome, so the same implementation is bit-checked on the host by
`tests/detector/test_equivalence.py` (worst observed score deviation 3e-5).

## Configuration

Multiple `alarm_sound_detector:` blocks may share one microphone — one per
preset, each with its own `id`, entities and triggers:

```yaml
alarm_sound_detector:
  - id: tm6
    microphone:
      microphone: mic
      bits_per_sample: 16   # 16 or 32; stream must be 16 kHz mono
    template: thermomix_tm6  # preset id, alias, legacy name, or path to a JSON file
    on_alarm_start:
      then:
        - logger.log: "TM6 alarm started"
    on_alarm_end:
      then:
        - logger.log: "TM6 alarm ended"
  - id: cooker
    microphone:
      microphone: mic
      bits_per_sample: 16
    template: path/to/rice_cooker.json  # v1/v2 file relative to the YAML
    threshold: 0.60      # optional: overrides the preset default
    on_alarm_start:
      then:
        - logger.log: "Rice cooker beeping"
```

`template:` accepts a preset `id` (e.g. `vorwerk_thermomix_tm6_alarm`), one
of its `aliases` (e.g. `thermomix_tm6` — existing configs keep working), a
path to a JSON file (v1 or v2)
**relative to the main YAML file**, or an **inline v2 preset mapping** with
the same fields as the JSON file (including `data_int8_b64`) — so a single
pasted YAML works without a separate file. Inline presets are validated
exactly like file presets: Every detection field is optional and
defaults to the preset's tuned value; YAML values win:

| Option | Default source | Meaning |
|---|---|---|
| `threshold` | preset `detection.threshold` | repetition score >= this -> unit |
| `near_threshold` | preset `detection.near_threshold` | candidate tracking floor; peaks below threshold -> near miss |
| `period` | preset `detection.period_s` (may be null) | expected repetition spacing (`3.125s`); omit to use the preset (single mode when null) |
| `period_tolerance` | preset `detection.period_tolerance_s` | per-period slack (scaled by k for k=2) |
| `min_repetitions` | preset `detection.min_repetitions` | chained units needed to raise the alarm (1 = single mode) |
| `refractory` | preset `detection.refractory_s` | blind time after each unit |
| `release` | preset `detection.release_s` | alarm ends this long after the last chained unit |

`period`/`period_tolerance`/`refractory`/`release` accept any ESPHome time
period (`3.125s`, `250ms`). The template JSON is validated at codegen
(preset schema, geometry, payload size) and emitted as a `static const
int8_t` array in flash — no RAM cost, and only the selected presets are
compiled in. Unknown names, missing files and inconsistent values
(`threshold` <= `near_threshold`, non-positive `period`/`release`) fail
validation with an explicit error.

Platforms (both take `alarm_sound_detector_id`):

```yaml
binary_sensor:
  - platform: alarm_sound_detector
    alarm_sound_detector_id: tm6
    name: "Thermomix alarm"        # ON while the alarm state is active

sensor:
  - platform: alarm_sound_detector
    alarm_sound_detector_id: tm6
    name: "Alarm match score"
    report_interval: 60s          # default; otherwise publishes the max score seen per interval
```

Inline preset (same fields as the preset JSON; the studio's "copy YAML"
button produces this):

```yaml
alarm_sound_detector:
  - id: tm6
    microphone:
      microphone: mic
      bits_per_sample: 16
    template:
      format: 2
      id: vorwerk_thermomix_tm6_alarm
      # ... all other v2 fields, including data_int8_b64 ...
```

The score sensor publishes the candidate peak immediately on every
repetition/near-miss event, and otherwise the max frame score of each
`report_interval` (rounded to 3 decimals). The binary sensor follows the
alarm state. All four triggers log at INFO on the device, as do repetitions
and near misses with their scores; average DSP time per hop is logged at
DEBUG every 60 s (and shown in `dump_config`, together with the band, the
periodic/single mode and the release).

The stream must be 16 kHz mono; anything else fails the component at boot
with an explicit log. The component is non-passive (it starts the microphone
itself, refcounted with `sound_level`), buffers ~16 KiB per detector in
internal RAM, and processes at most ~10 hops per `loop()` pass.

## Presets

Presets live in `presets/` (format v2, JSON Schema at
`presets/preset.schema.json`, catalog at `presets/index.json`). One preset =
one appliance model + one sound. See `presets/README.md` for the field
reference and how to contribute a preset (record with the `audio_capture`
dev firmware, build with `tools/detector/make_template.py`, tune with
`tools/detector/evaluate.py`, add aliases/provenance, rebuild the index).

## Resource usage (M5Stack Stamp S3, ESP-IDF, ESPHome 2026.11.0)

| Firmware | RAM (of 341 760 B) | Flash image | App partition free |
|---|---|---|---|
| `thermomix-detector.yaml` (1 detector) | 106 439 B (31.1%) | 861 631 B | 78% |
| minimal scratch config, 2 detectors (same TM6 preset twice) | 111 623 B (32.7%) | 867 543 B | — |
| minimal scratch config, 1 detector | 105 903 B (31.0%) | 855 943 B | — |
| `thermomix-detector-dev.yaml` | 107 175 B (31.4%) | 873 507 B | 78% |

Per detector steady-state RAM: 16 KiB ring buffer + ~10.7 KiB quantised
history (TM6: 81 × 132) + ~4 KiB FFT/window tables + staging FIFOs (all
internal RAM; no PSRAM needed). Template: 81 × 132 int8 ≈ 10.7 KiB in flash
per selected preset. A second detector on the same mic costs ~5.7 KiB static
RAM and ~11.6 KiB flash (mostly its own template copy) in the minimal config
above; runtime heap grows by the ~31 KiB per-detector buffers. Average DSP
load per hop is logged by the device at DEBUG level (see `dump_config`
after 60 s of runtime); on the host the core scores a TM6 hop in ~7 µs
(x86 proxy — the on-device number must be read from the device log).
