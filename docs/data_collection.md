# Data collection: capturing labelled Thermomix audio

This covers building the **development-only** capture firmware, recording
raw microphone audio with the Python recorder, and labelling clips with
Home Assistant buttons. For the wire protocol see
[`capture_protocol.md`](capture_protocol.md).

> Privacy: `clips` mode (the default) saves only short windows around
> markers you press and discards everything else. `continuous` mode
> records everything — use it only with everyone nearby informed.
> The dev firmware must never be deployed permanently; re-flash the
> base firmware when a collection session is done.

## 1. One-time setup

```bash
python3.13 -m venv .venv
.venv/bin/pip install esphome==2026.11.0
.venv/bin/pip install -r tools/requirements.txt
cp firmware/secrets.example.yaml firmware/secrets.yaml  # then fill in
```

`firmware/secrets.yaml` is gitignored. Generate keys with
`openssl rand -base64 32` (API key) and pick a long random `capture_psk`
(min 16 chars). The lead engineer owns the real secrets; recipients of
this repo create their own.

## 2. Build and flash the dev firmware

```bash
cd firmware
../.venv/bin/esphome compile thermomix-detector-dev.yaml
../.venv/bin/esphome run thermomix-detector-dev.yaml   # flashes via USB/OTA
```

The dev config (`thermomix-detector-dev.yaml`) includes the base config
as a package and adds:

- `external_components` from `../components` (the `audio_capture`
  component; compiles only into this dev firmware),
- microphone at **48 kHz** (base uses 16 kHz; kept working for
  `sound_level`),
- `audio_capture` TCP server on port 6060 (PSK from `capture_psk`),
- switch **"Audio capture"** (default OFF),
- four template buttons: **"Mark: Thermomix alarm"**,
  **"Mark: Thermomix other sound"**, **"Mark: Confuser sound"**,
  **"Mark: Background"**,
- sensors for dropped bytes / client-connected state.

## 3. Record

Turn **on** "Audio capture" in Home Assistant (or leave it off — the
recorder will wait and the device will accept it when enabled), then:

```bash
# Privacy-preserving default: only marked clips are saved.
.venv/bin/python tools/capture/tmx_capture.py record \
  --host thermomix-detector.local --psk-file firmware/secrets.yaml \
  --out data/recordings --mode clips

# Or: everything, rotated every 10 min with sidecar JSON.
.venv/bin/python tools/capture/tmx_capture.py record \
  --host ... --psk-file ... --out ... --mode continuous --rotate-min 10
```

Useful flags: `--port`, `--buffer-s` (rolling buffer, default 60),
`--pre-s`/`--post-s` (clip window, defaults 40/15). The recorder prints
a live level meter and marker events, reconnects with backoff if Wi-Fi
drops, and finalizes files on Ctrl-C.

## 4. Label with Home Assistant buttons

1. Start the recorder **before** making sound (markers only land while
   a client is connected; presses with no client are dropped).
2. Trigger the sound (Thermomix alarm, confuser appliance, background).
3. Immediately press the matching **Mark:** button in Home Assistant.
   The marker is stamped with the current sample index; the clip window
   is cut around it automatically in `clips` mode.
4. File names and sidecar JSON carry the label, sample offsets and
   wall-clock times, e.g.
   `clip_20261124T120000Z_thermomix_alarm.flac` + `.json`.

Tips:

- Press **Background** periodically so the training set has negatives
  from the same room/conditions.
- Watch the recorder's level meter: if it sits at full scale the mic
  gain is clipping (adjust `gain_factor`); if drops accumulate in the
  stats output, the network/client is not keeping up.
- `dropped_bytes` is cumulative per session; any clip whose window
  overlaps a drop is flagged `"complete": false` in its sidecar.

## 5. Output layout

```
data/recordings/
  clip_<UTC>_<label>.flac        # 16-bit FLAC (16-bit source) or 24-bit FLAC (32-bit source)
  clip_<UTC>_<label>.json        # label, sample indexes, wall-clock, missing_frames, drops
  cont_<UTC>_sr48000.flac        # continuous mode, rotated
  cont_<UTC>_sr48000.json
```

`data/` is gitignored — recordings never enter git.

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Recorder: `Handshake auth failed` / immediate close | wrong `capture_psk` in local `secrets.yaml` |
| Markers "ignored (no client)" in ESPHome log | recorder not connected; check switch is ON, port 6060 reachable |
| `sound_level` shows warning while capturing | mic start race after reboot; toggle the capture switch off/on |
| Build error in `audio_capture` | ensure `.venv` is `esphome==2026.11.0` and IDF 5.5 (the pinned default) |
