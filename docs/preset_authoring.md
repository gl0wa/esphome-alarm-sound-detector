# Authoring a preset with the preset studio

The preset studio is a static website — all processing happens in your browser
and the studio never uploads audio. Presets contain no audio either, only an
averaged fingerprint that cannot be turned back into sound.

Site URL: **https://gl0wa.github.io/esphome-alarm-sound-detector/**.
To try it locally: `cd web && npm install && npm run build && npm run preview`.

Your work (recordings, examples, decisions, settings and the built template) is
saved automatically in your browser and offered again when you come back; it
never leaves your device. Delete it any time on the Install step (“Your saved session”).

The studio has two modes, picked on the home screen (click the title to go back).

## Use a ready-made preset

For appliances already in the catalog (`components/alarm_sound_detector/presets/`).
Tick one or more appliances, check the Device settings card (defaults fit the
reference hardware), and paste the generated YAML as a new device in the
ESPHome dashboard:

1. New device → paste the YAML.
2. Make sure ESPHome's secrets contain `wifi_ssid` and `wifi_password`.
3. Install — the first install is over USB, later updates work over Wi-Fi.
4. Add the device in Home Assistant and test it with the real appliance sound.

The generated firmware keeps all sound on the device: it never sends audio anywhere.

## Create a preset for your appliance

The home screen offers two ways to record:

- **Record with the device** (most accurate — the microphone that will listen
  later). The first step, **Record with the device**, has two parts on one page:
  1. **Install the recording firmware.** The studio generates a temporary
     firmware (your Device settings plus a `capture_server` block). It is the ONLY
     firmware that can send sound — to your browser only, only while you press
     Record, unencrypted over your home Wi-Fi (protected by the key in the QR code).
  2. **Record with your phone.** Scan the QR code (`http://<device-name>.local/#k=…`).
     Most Android phones can't open `.local` names: enter the device's IP address
     and scan the second QR code. Record the alarm a few times plus everyday
     background sounds, then tap “Send to preset studio” — the studio opens in
     that browser with the clips. (The link also works on a computer on the same
     Wi-Fi; the device records, the browser is the remote control.)
- **Record with a phone or laptop** (quickest, no extra firmware): the first step
  is **Add audio & mark the alarm** — record in the page or load audio files.
- **Let an AI agent do it**: see [agent_guide.md](agent_guide.md).

Then, in both cases:

1. **Mark the alarm** (on the phone/laptop route: *Add audio & mark the alarm*).
   Drag across one occurrence on the spectrogram and press
   “＋ Example”. The sound length is measured from it automatically.
   Best material: one long recording with the alarm a few times plus everyday
   background — the background teaches the detector what not to react to.
2. **Find more examples.** “Find similar” searches all recordings for sounds like
   your example. Listen to the matches and accept the real ones (or use
   “Accept all” after checking a few). Search settings (sound length, minimum
   score, which example to search with) are folded away.
3. **Build.** “Tune automatically” picks the frequency band, the rhythm and timing,
   builds the fingerprint and sets the threshold, then rates the result by its
   **margin** (weakest example minus the most similar other sound): ✓ reliable
   from +0.20, usable from +0.10, fragile below. Every setting can still be
   changed under “Fine-tune settings”, explained in
   [preset_parameters.md](preset_parameters.md) (the “?” icons link there).
4. **Test.** Runs automatically: the firmware detector over every recording, with
   a verdict (examples recognised, false alarms) and a timeline per recording —
   green dots recognised, amber near misses, red line alarm on, grey alarm off.
   Optionally check whether a ready-made preset would react to your recordings.
5. **Install.** Give the appliance a name (used for the Home Assistant entities)
   and copy the device YAML with your preset inline. If you used the recording
   firmware, installing this switches the device back to private mode. The
   “Share it on GitHub” tab asks for the full preset details and walks you
   through contributing it.

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

1. Mark one beep (a loose selection is fine). The studio measures the **sound
   length** from the first example you mark (Search settings in the next step
   can measure it again); then run “Find similar” and accept every beep.
2. “Tune automatically” reads the period from the spacing of your examples (it
   needs at least 3 accepted repetitions of one alarm; gaps between separate
   alarms and a single missed repetition are ignored) and
   also sets *ignore re-matches for* (refractory) to 0.6 × period. Refractory
   must be shorter than the period, otherwise every other beep is ignored.
3. **Repetitions before alarm** must stay below the number of beeps the
   appliance plays, so a masked beep or two do not lose the alarm. Tuning picks
   3 for fast beeps when an alarm has at least 5 of them, otherwise 2.
4. A plain single-tone beep is less distinctive than a melody and other
   appliances' beeps may score close to it. Record those (microwave, oven timer)
   as background and check that the margin shown after tuning is at least
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
