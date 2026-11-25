# Authoring a preset with the preset studio

The preset studio is a static website — all processing happens in your browser
and the studio never uploads audio. Presets contain no audio either, only an
averaged fingerprint that cannot be turned back into sound.

Site URL: **https://gl0wa.github.io/esphome-alarm-sound-detector/**.
To try it locally: `cd web && npm install && npm run build && npm run preview`.

Your work (recordings, examples, decisions, settings and the built template) is
saved automatically in your browser and offered again when you come back; it
never leaves your device. Delete it any time on the Export step.

The studio has two modes, picked on the home screen (click the title to go back).

## Use a ready-made preset

For appliances already in the catalog (`components/alarm_sound_detector/presets/`). Pick one or more
presets, fill in the Device settings card (one name, one board), and paste the
generated YAML as a new device in the ESPHome dashboard:

1. New device → paste the YAML.
2. Add `wifi_ssid` / `wifi_password` to ESPHome secrets if they are not there yet.
3. Install — the first install is over USB, later updates work over Wi-Fi.
4. Check the new binary sensor in Home Assistant with the real appliance sound.

The generated firmware keeps all sound on the device: it never sends audio anywhere.

## Create a preset for your appliance

A guided stepper wraps the classic Record → Examples → Build → Evaluate → Export
flow (steps 3–7 below — unchanged in behaviour), with two recording steps first:

1. **Install the recording firmware.** The studio generates it from your Device
   settings plus a `capture_server` block. It is temporary, and it is the ONLY
   firmware that can send sound — to your browser only, only while you press
   Record, unencrypted over your home Wi-Fi (protected by the key in the QR code).
2. **Record with your phone.** Scan the QR code (`http://<device-name>.local/#k=…`;
   enter the device IP address instead if your phone can't open `.local` names),
   record the alarm several times plus everyday background sounds, then tap
   “Send to preset studio”. The studio opens with `#import`, shows what arrived,
   and adds each clip as a recording on import.
3. **Record.** …or load audio files / record from a microphone instead.
   Aim for several alarm episodes plus background (speech, clatter, other appliances).
4. **Mark examples, find similar.** Mark one clear occurrence, “Find similar” scans
   everything with the firmware detector; accept the true ones, reject the rest.
5. **Build.** Every setting is explained in [preset_parameters.md](preset_parameters.md)
   (the “?” icons link there). Use “Suggest from examples” and “Suggest thresholds”;
   the margin (weakest example minus loudest background) should be at least +0.10.
6. **Evaluate.** Green dots are caught repetitions, amber near misses, red alarm
   on/off. Cross-check a bundled preset (e.g. the TM6 chime) against your recordings.
7. **Export & install.** The first tab shows the NORMAL device YAML with your new
   preset inline — install this to switch back to private mode; the recording
   firmware should not stay installed. The preset JSON can also be downloaded
   (for hand-written YAML), and the second tab walks you through sharing it on GitHub.

### What to mark as one example

Mark the **smallest unit that repeats**, not the whole alarm. If an appliance
beeps several times in a row (e.g. a rice cooker or washing machine playing
5 × 0.5 s beeps, 0.5 s apart), every beep is a separate example:

| Alarm | Mark as one example | Sound length | Repeating? | Period | Repetitions before alarm |
|---|---|---|---|---|---|
| Thermomix TM6: 1.3 s chime, repeats every 3.1 s | one chime | ~1.3 s | yes | 3.125 s | 2 |
| 5 short beeps, one per second, then silence | one beep | ~0.5–0.6 s | yes | ~1.0 s | 3 (4 if false alarms, 2 if misses) |
| A melody played once | the whole melody | its length (≤ 5 s) | no | – | 1 |

Why not the whole beep sequence as one example:

- The rhythm check (several matches exactly one period apart) is what rejects
  random kitchen noise; with one long template there is no rhythm to check.
- Each alarm would give you only one example, and the detector could react
  only after the last beep.
- Memory grows with the sound length (about 1 KB per 0.1 s at the default band).

For fast beeps:

1. Mark one beep (centre the selection on it), set **sound length** to about one
   beep, then run “Find similar” and accept every beep.
2. “Estimate repetition” reads the period from the spacing of your examples and
   also sets *ignore re-matches for* (refractory) to 0.6 × period. Refractory
   must be shorter than the period, otherwise every other beep is ignored.
3. Choose **repetitions before alarm** below the number of beeps the appliance
   plays, so a masked beep or two do not lose the alarm.
4. A plain single-tone beep is less distinctive than a melody and other
   appliances' beeps may score close to it. Record those (microwave, oven timer)
   as background and check that the margin from “Suggest thresholds” is at least
   +0.10.

What NOT to share: household audio stays yours. Never attach recordings to GitHub
issues/PRs — presets contain no audio, so they are safe to contribute.

## Contribute the preset

1. Copy the JSON to `components/alarm_sound_detector/presets/<id>.json`.
2. Fill in `provenance` (`tested_against`, `validation`, `notes`).
3. Run `python3 tools/presets/build_index.py` and commit the preset + `index.json`.
4. Open a PR with the story: what sound, how recorded, evaluation numbers
   (units caught, max background score, confusers checked). No audio attachments.

## Reference (the same pipeline as shell tools)

The studio mirrors `tools/detector/make_template.py` (alignment ±8 frames, mean,
`quantize_template`) and `tools/detector/evaluate.py`, but the DSP is the firmware
C++ core compiled to WebAssembly — verified sample-identical by `npm test`.
