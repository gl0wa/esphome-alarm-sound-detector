# Agent guide: set up an appliance alarm detector for your user

This guide is for **AI agents** (Claude Code, OpenAI Codex, Gemini CLI, Cursor,
GitHub Copilot, Aider, Windsurf, Cline, … — anything that can read files and run
shell commands) working on behalf of a user. It tells you how to do, from a
terminal, everything the browser [preset studio](https://gl0wa.github.io/esphome-alarm-sound-detector/)
does: pick a ready-made preset, or record an appliance, teach the detector its
alarm, test it, and produce the ESPHome configuration.

The project: an [ESPHome](https://esphome.io) external component that runs on
an ESP32-S3 with an INMP441 I2S microphone, recognises an appliance's alarm
sound (Thermomix finished, rice cooker done, washing machine end beep, …) and
reports it to Home Assistant as a binary sensor. Detection runs on the device;
the normal firmware never sends sound anywhere.

If you only have a chat (no shell), you cannot run the tools below: guide the
user through the browser studio instead — it does the same, step by step.

---

## 1. Ground rules (read first)

1. **Audio is private.** Recordings are household audio. Process them **only
   locally** with the tools below. Never upload them, never send them (or
   transcriptions, or spectrogram images) to any external service or model, never
   attach them to issues or pull requests, never commit them. Work with the
   numbers the tools print (times, pitches, scores).
2. **Secrets.** `device.json` (created by `asd device`) holds the device's API
   encryption key and the recording-page key. The generated YAML contains the
   API key too. Keep these files out of version control and out of messages to
   external services. Wi-Fi credentials belong in ESPHome's `secrets.yaml`
   (`wifi_ssid`, `wifi_password`) — never ask the user to paste them into chat if
   you can avoid it; let them edit the file themselves.
3. **Ask the user for physical actions**: wiring, plugging in USB for the first
   flash, placing the device, making the appliance play its alarm, and any
   decision about which sound is "the alarm". Tell them exactly what to do and
   for how long, then wait for confirmation.
4. **Ask before flashing or changing their ESPHome / Home Assistant setup**, and
   before publishing anything (pull requests, issues).
5. **Do not claim what you did not verify.** A preset that tests well on
   recordings is not yet verified on the device: say so, and ask the user to
   trigger the real alarm once after installing.
6. **The recording firmware is temporary.** It is the only firmware that can
   stream sound (unencrypted on the LAN, key-protected). Always finish by
   installing the normal firmware, and tell the user you did.

---

## 2. What you need

| Need | Why | Check |
|---|---|---|
| Node.js 20 or newer | runs the `asd` tool | `node --version` |
| ESPHome (dashboard or CLI, 2026.11.0+) | builds and installs firmware | `esphome version` or the user's dashboard |
| Home Assistant with the ESPHome integration | receives the alarm | ask the user |
| ESP32-S3 board + INMP441 microphone | the device | ask the user; wiring in [wiring.md](wiring.md) |
| ffmpeg (optional) | converts non-WAV recordings | `ffmpeg -version` |

### Get the `asd` tool

`asd` is one self-contained JavaScript file: the studio's own code plus the
firmware's detector compiled to WebAssembly. No install, no dependencies.

```sh
curl -fsSLO https://gl0wa.github.io/esphome-alarm-sound-detector/cli/asd.mjs
node asd.mjs help
```

From a clone of the repository instead (needs Emscripten for the WebAssembly
build): `cd web && npm ci && npm run build` → `web/dist/cli/asd.mjs`.

Every command accepts `--json` for machine-readable output. Examples below
write `asd` for `node asd.mjs`.

---

## 3. Choose the path

Ask the user which appliance (manufacturer, model, which sound) and whether
they already have the hardware and a recording.

```
Is the appliance in the catalog? ──yes──▶ Path A: ready-made preset
        │ no
        ▼
Does the user have recordings (phone, files)? ──yes──▶ Path B: from recordings
        │ no / wants best accuracy
        ▼
Path C: record with the device itself (temporary recording firmware), then Path B
```

The catalog: <https://gl0wa.github.io/esphome-alarm-sound-detector/presets/index.json>
(also `components/alarm_sound_detector/presets/index.json` in the repository).
Match on manufacturer + model + sound; the same appliance family often shares
sounds, but do not assume — if unsure, record (Path B/C) and `asd test` the
catalog preset against the recording.

Recording with the device (Path C) is the most accurate (same microphone, same
spot). Phone recordings (Path B) are quickest and usually fine for beeps and
chimes.

---

## 4. Device settings (all paths)

```sh
asd device --file device.json --name kitchen-sound-detector
# other board or wiring:
asd device --file device.json --board-id esp32-s3-devkitc-1 --pins GPIO1,GPIO7,GPIO5 --channel left
```

- `--name`: lowercase letters, digits, dashes; becomes the ESPHome node name and
  `<name>.local`.
- Default hardware: M5Stack Stamp S3 + INMP441 wired SCK→GPIO1, WS→GPIO7,
  SD→GPIO5, L/R→GND (left channel), VDD→3V3. See [wiring.md](wiring.md).
- Run it **once** and keep `device.json`: the API key in it must stay the same
  across the recording firmware and the final firmware, otherwise Home Assistant
  loses the connection.

---

## 5. Path A — ready-made preset

```sh
asd yaml --device device.json --ready vorwerk_thermomix_tm6_alarm --out kitchen-sound-detector.yaml
# several appliances on one device: repeat --ready
```

Then [install](#8-install-and-verify).

---

## 6. Path B — build a preset from recordings

### 6.1 Get WAV files

The ideal material: **one long recording** (2–5 min) containing the alarm a few
times plus everyday background (talking, dishes, other appliances, the
appliance running). The background is what teaches the detector what *not* to
react to. Several files are fine.

`asd` reads WAV (any sample rate, mono or stereo, 8/16/24/32-bit or float).
Convert anything else: `ffmpeg -i in.m4a -ac 1 -ar 16000 rec.wav`.

### 6.2 Find the alarm

```sh
asd events rec.wav
```

prints every distinct sound (time, length, dominant pitch, loudness) and
**groups of similar sounds**, e.g.

```
Repeated sounds (alarm candidates):
group D: 5× ~4031 Hz, ~0.53 s long, typically 1 s apart
group A: 3× ~344 Hz, ~0.1 s long
```

Appliance alarms are usually tonal (one or a few pitches, 1–5 kHz), repeat with
a steady rhythm, and are the loudest repeated group. **Confirm with the user**
in plain words ("5 beeps at about 4 kHz, one per second, at 18.7–22.7 s — is
that the rice cooker?"). If unsure, ask the user roughly when the alarm played.

What one example is: **the smallest unit that repeats** — one beep of a beep
sequence, one chime of a repeating chime, the whole melody if it plays once.
`events` already splits sounds that way.

### 6.3 Mark examples (labels.json)

Fastest: write a group's sounds as examples:

```sh
asd events rec.wav more.wav --group D --labels-out labels.json
```

Or find occurrences from one known example (as the studio's "Find similar"):

```sh
asd similar --seed rec.wav@18.6-19.26 rec.wav more.wav
```

and write the real ones into `labels.json` yourself:

```json
{ "examples": [ {"file": "rec.wav", "t0": 18.60, "t1": 19.26},
                {"file": "rec.wav", "t0": 19.62, "t1": 20.27} ],
  "recordings": ["rec.wav", "background.wav"] }
```

- Paths are relative to `labels.json`. List background-only files under
  `recordings` so they count as "must not match".
- Every occurrence of the alarm in the listed recordings must be an example:
  an unlabelled occurrence counts as a false alarm and ruins the threshold.
- The studio's "Download labels JSON" (Share tab) uses the same format.

### 6.4 Tune

```sh
asd tune --labels labels.json --out rice_cooker.json --name "Rice cooker"
```

`tune` measures the sound length, picks the frequency band, estimates the
rhythm (repeating vs single sound, period, how many matches before the alarm
turns on), builds the fingerprint and sets the threshold. It prints a
**verdict** from the **margin** = weakest example score − score of the most
similar other sound:

| Verdict | Margin | Meaning / action |
|---|---|---|
| reliable | ≥ +0.20 | go ahead |
| usable but close | +0.10 … +0.20 | works; more examples from another recording help |
| FRAGILE | < +0.10 | something else looks like the alarm — see 6.6 |

`--name` sets the Home Assistant entity names ("Rice cooker alarm"). Without
`--id --manufacturer --model --sound --validation` the preset is *personal*
(valid for the user's device, not for the shared catalog).

### 6.5 Test

```sh
asd test --preset rice_cooker.json --labels labels.json
asd test --preset rice_cooker.json other_recording.wav   # recordings not used for tuning
```

Reports, per file: when the alarm turned on, matches, near misses, max score,
and with `--labels` which examples were missed and which matches fell outside
examples. Good: every alarm episode turns the alarm on, no "matches away from
examples". Also test the user's other recordings (other appliances, TV) if any,
and catalog presets against the user's recordings when the user has several
appliances (`asd test --preset <catalog preset json> rec.wav`).

### 6.6 When the result is not good

| Symptom | Likely cause | Fix |
|---|---|---|
| FRAGILE margin, "most similar other sound" high | an unlabelled alarm occurrence; or a similar sound | check `asd similar` matches near that score; label missed occurrences; ask the user about the confusing sound |
| examples missed | weak/masked examples, length wrong | drop examples drowned by other noise; `--length` = one unit (+0.1 s) |
| alarm never turns on although matches appear | rhythm settings | `period_s`, `refractory_s` < period, `min_repetitions` ≤ number of units in the alarm (see [preset_parameters.md](preset_parameters.md)) |
| many near misses on speech/clatter | band too wide | normally fine; the threshold decides |
| simple single beep, other beeps match | beeps carry little information | record the other beeping appliances too; repeating alarms rely on rhythm |

All parameters can be edited in the preset JSON (`detection.*`) and are
explained in [preset_parameters.md](preset_parameters.md). Re-run `asd test`
after editing; `asd validate` checks the file.

---

## 7. Path C — record with the device

1. Generate and install the **temporary recording firmware**:
   ```sh
   asd yaml --device device.json --recording --out kitchen-sound-detector.yaml
   ```
   Install it (section 8). It adds a `capture_server` web page and a
   "Sound capture active" sensor in Home Assistant.
2. Record — either yourself:
   ```sh
   asd record --device device.json --seconds 240 --out rec.wav      # uses <name>.local
   asd record --device device.json --ip 192.168.1.42 --seconds 240 --out rec.wav
   ```
   Start the command, then tell the user: "Recording for 4 minutes now: let the
   appliance play its alarm 2–3 times, and in between make normal kitchen noise
   (talk, put dishes away)." The tool prints the peak level; below −45 dBFS
   means the microphone hears almost nothing (wiring, `--channel right`, distance).
   — or let the user record on their phone: `asd link --device device.json [--ip IP]`
   prints the device page link (it contains the key; give it to the user only,
   e.g. as a QR code or directly). The page sends clips to the browser studio.
3. Continue with Path B (6.2 onwards).
4. **Install the normal firmware** with the preset (`asd yaml --preset …`), which
   removes the recording page. Tell the user the device is private again.

Errors: `401` key mismatch (device.json differs from the installed firmware),
`409` someone else is streaming (close the page on the phone), `429` too many
wrong keys — wait 30 s. Android phones often cannot open `.local` names: use the IP.

---

## 8. Install and verify

```sh
asd yaml --device device.json --preset rice_cooker.json --out kitchen-sound-detector.yaml
```

- **ESPHome dashboard:** the user creates a new device and pastes the YAML (or
  replaces the existing device's YAML), then installs. Put the file in the
  dashboard's config folder only if the user asks you to.
- **ESPHome CLI:** with `secrets.yaml` next to the YAML (`wifi_ssid`,
  `wifi_password`):
  ```sh
  esphome config kitchen-sound-detector.yaml        # validate
  esphome run kitchen-sound-detector.yaml           # first time over USB (user plugs it in)
  esphome run kitchen-sound-detector.yaml --device kitchen-sound-detector.local   # later, over Wi-Fi
  ```
- **Home Assistant:** the device is discovered by the ESPHome integration; it
  asks for the **encryption key** — the `api: encryption: key:` value from the
  YAML / `apiKey` in device.json. Give it to the user privately.
- **Verify on the device:** ask the user to trigger the real alarm and watch the
  "… alarm" binary sensor and the "… match score" sensor (or the ESPHome logs:
  `esphome logs kitchen-sound-detector.yaml`; matches log at INFO, near misses too).
- **Notification:** the blueprint
  [`notify_when_still_ringing.yaml`](../homeassistant/blueprints/automation/alarm_sound_detector/notify_when_still_ringing.yaml)
  notifies a phone only if the alarm is still ringing after a delay —
  [home_assistant.md](home_assistant.md).

The YAML uses `external_components: github://gl0wa/esphome-alarm-sound-detector@main`,
so ESPHome downloads the component when building. A preset made with `asd tune`
is embedded inline in the YAML; no extra files are needed.

---

## 9. Sharing a preset (only with the user's consent)

A good preset helps every owner of the same appliance. Only the preset JSON is
shared — an averaged fingerprint, no audio. Re-run `tune` with full details:

```sh
asd tune --labels labels.json --out <id>.json --id bosch_serie6_dishwasher_end \
  --name "Bosch Serie 6 dishwasher – end of programme" --manufacturer Bosch \
  --model SMS6ECI03E --sound "end-of-programme melody" \
  --validation "one household, volume high" --tested-against "speech,dishes,microwave beep"
```

then open a pull request adding it to `components/alarm_sound_detector/presets/`
(the maintainers regenerate `index.json`), or an issue with the file attached.
Never attach recordings. Checks: `python tools/presets/validate.py <file>`.

---

## 10. Command reference

| Command | Purpose | Key output (`--json`) |
|---|---|---|
| `device --file F [--name N] [--board stamp-s3\|other] [--board-id ID] [--pins SCK,WS,SD] [--channel left\|right]` | create/update device settings (keys inside) | `deviceName, board, pins` |
| `yaml --device F (--recording \| --preset P… \| --ready ID…) [--label L] [--out Y]` | full ESPHome YAML | YAML text / `out` |
| `link --device F [--ip IP]` | recording page link (contains key) | `link` |
| `record --device F [--ip IP] --seconds S --out W` | record from the recording firmware | `seconds, peak_dbfs, complete` |
| `events W… [--group G --labels-out L]` | sounds + groups of similar sounds | `events[], groups[]` |
| `similar --seed W@T0-T1 [--length S] [--min 0.35] W…` | find occurrences like an example | `length_s, matches[{file,t0,t1,score}]` |
| `tune --labels L --out P [--length S] [--name …] [sharing details]` | build + tune a preset | `verdict, margin, band_hz, period_s, min_repetitions, threshold, shareable` |
| `test --preset P [W…] [--labels L]` | run the firmware detector | `results[{alarm_on[], matches, near_misses[], max_score, missed[], stray_matches[]}]` |
| `validate P…` | schema check | `ok, errors` |

Times are seconds from the start of the file. Exit code 2 = usage or input
error (message on stderr), 1 = validation failed.

---

## 11. Where agents find these instructions

- `AGENTS.md` at the repository root (read by Codex, Cursor, GitHub Copilot's
  coding agent, Jules, Aider, Windsurf, and others) points here.
- `CLAUDE.md` (Claude Code) and `GEMINI.md` (Gemini CLI) import `AGENTS.md`.
- `.github/copilot-instructions.md` (GitHub Copilot) points here.
- Without the repository: <https://gl0wa.github.io/esphome-alarm-sound-detector/agent-guide.md>
  and <https://gl0wa.github.io/esphome-alarm-sound-detector/llms.txt>.
