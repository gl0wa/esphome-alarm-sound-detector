# `alarm_sound_detector`

On-device template matcher that raises an alarm when the Thermomix TM6 end-of-step
chime repeats. It is a port of the reference detector in `tools/detector/ref.py`
(the spec) to a portable C++ core (`detector_core.h/.cpp`, no ESPHome includes)
plus a thin ESPHome wrapper.

## How it works

1. Microphone audio (16 kHz mono) is framed into 512-sample Hann windows with a
   256-sample hop, converted to a log-power spectrum, restricted to 400–4500 Hz
   (132 bins), and normalised against a per-bin min-tracking noise floor
   (instant fall, +3 dB/s rise).
2. The normalised frame is quantised to uint8 in 0.5 dB steps into a circular
   history of the last W frames (W comes from the template, 81 for the TM6).
3. Each frame, the normalised cross-correlation of the history against the
   quantised int8 template is scored exactly as `ncc_quantized` in `ref.py`.
4. `StreamingDetector` turns scores into events: a candidate peak opens when the
   score crosses `near_threshold` and closes 0.4 s after its best frame; peaks
   above `threshold` are `unit` repetitions (refractory 1.5 s). Units spaced by
   ~k·`period` (k = 1 or 2, tolerance `period_tolerance`·k) form a chain; stray
   units during an alarm are ignored; `min_repetitions` chained units raise the
   alarm; silence longer than 2·`period` + 1 s ends it.

The core keeps timing in frame counts (no float drift) and shares no code with
ESPHome, so the same implementation is bit-checked on the host by
`tests/detector/test_equivalence.py` (worst observed score deviation 3e-5).

## Configuration

```yaml
alarm_sound_detector:
  id: tm6
  microphone:
    microphone: mic
    bits_per_sample: 16   # 16 or 32; stream must be 16 kHz mono
  template: thermomix_tm6  # builtin name, or a path to a JSON template file
  threshold: 0.55         # repetition score >= this -> unit
  near_threshold: 0.35    # candidate tracking floor; peaks below threshold -> near miss
  period: 3.125s          # default: template period_s; expected chime spacing
  period_tolerance: 250ms # per-period slack (scaled by k for k=2)
  min_repetitions: 2      # chained units needed to raise the alarm
  on_alarm_start:
    then:
      - logger.log: "TM6 alarm started"
  on_alarm_end:
    then:
      - logger.log: "TM6 alarm ended"
  on_repetition:
    then:
      - logger.log: {format: "repetition score %.3f", args: [score]}
  on_near_miss:
    then:
      - logger.log: {format: "near miss score %.3f", args: [score]}
```

`period`/`period_tolerance` accept any ESPHome time period (`3.125s`, `250ms`).
`template` is either a builtin name from this directory's `templates/` or a path
to a JSON file **relative to the main YAML file** (as produced by
`tools/detector/make_template.py`). The template JSON is validated at codegen
(sample rate, FFT/hop geometry, frame count vs. payload size) and emitted as a
`static const int8_t` array in flash — no RAM cost.

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

The score sensor publishes the candidate peak immediately on every
repetition/near-miss event, and otherwise the max frame score of each
`report_interval` (rounded to 3 decimals). The binary sensor follows the alarm
state. All four triggers log at INFO on the device, as do repetitions and near
misses with their scores; average DSP time per hop is logged at DEBUG every
60 s (and shown in `dump_config`).

The stream must be 16 kHz mono; anything else fails the component at boot with
an explicit log. The component is non-passive (it starts the microphone
itself, refcounted with `sound_level`), buffers ~16 KiB in internal RAM, and
processes at most ~10 hops per `loop()` pass.

## Making a template for another appliance

1. Record labelled sessions with the `audio_capture` dev firmware and label the
   chime onsets (see `docs/data_collection.md`).
2. Run `tools/detector/make_template.py --session <dir> --name <appliance> ...`
   — the output JSON contains only an averaged, quantised spectral template, no
   audio. Drop it into this directory's `templates/` to make it a builtin, or
   reference its path from the YAML.
3. Tune `threshold`/`near_threshold` with `tools/detector/evaluate.py` (alarm
   units vs. the max score outside alarms), then set `period` to the appliance's
   repetition interval and `min_repetitions` to taste.

## Resource usage (M5Stack Stamp S3, ESP-IDF, ESPHome 2026.11.0)

| Firmware                      | RAM (of 341 760 B) | Flash image | App partition free |
|-------------------------------|--------------------|-------------|--------------------|
| `thermomix-detector.yaml`     | 106 543 B (31.2%)  | 863 527 B   | 78%                |
| `thermomix-detector-dev.yaml` | 107 287 B (31.4%)  | 875 151 B   | 78%                |

Detector steady-state RAM: 16 KiB ring buffer + ~10.7 KiB quantised history +
~4 KiB FFT/window tables + staging FIFOs (all internal RAM; no PSRAM needed).
Template: 81 × 132 int8 ≈ 10.7 KiB in flash.
