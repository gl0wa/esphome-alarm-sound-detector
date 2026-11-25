# `capture_server`

Temporary "recording firmware" component: serves a self-contained recorder
page and streams raw microphone audio to the browser that opened it, so the
preset studio website can get recordings straight from the device. This is
**not** part of the production firmware — flash the normal detection
firmware back when you are done recording.

See `examples/stamp-s3-inmp441-recording.yaml` for a complete firmware.

## Privacy model

- Audio leaves the device **only while you press Record** in the browser,
  and only to **that browser tab** (same LAN/Wi-Fi).
- The stream is **plain HTTP** (unencrypted on the LAN). Use it on a
  trusted home network; anyone on the LAN who guesses the URL path gets
  nothing without the key, but the bytes themselves are not encrypted.
- The device stores no audio: the ring buffer holds ~1 s, clips persist
  only in the browser tab's IndexedDB until sent or deleted.
- The key is never logged. The boot log prints the page URL
  (`http://<ip>:<port>/`) **without** the key; open it via the QR code in
  the preset studio (the key travels in the URL fragment `#k=…`, which is
  never sent to the device).
- `binary_sensor` (`platform: capture_server`) is ON while a recording
  stream is active — a privacy indicator in Home Assistant.

## Configuration

```yaml
capture_server:
  id: recorder
  microphone:
    microphone: mic
    bits_per_sample: 16   # the stream is always 16 kHz mono 16-bit
  key: !secret capture_key   # required, >= 16 chars, [A-Za-z0-9_-] only
  port: 80                   # default; must not clash with `web_server`
  max_duration: 30min        # default; longest single recording stream
  studio_url: "https://gl0wa.github.io/esphome-alarm-sound-detector/"   # default

binary_sensor:
  - platform: capture_server
    capture_server_id: recorder
    name: "Recording in progress"
```

| Option | Meaning |
|---|---|
| `microphone` | standard microphone source schema; the stream **must** be 16 kHz mono (enforced at codegen against the microphone config, and re-checked when a stream starts) |
| `key` | bearer key for `/api/*`; required, at least 16 characters, `[A-Za-z0-9_-]` only |
| `port` | HTTP listen port, default 80; config validation fails if ESPHome `web_server` is configured on the same port |
| `max_duration` | per-stream recording cap, default `30min` |
| `studio_url` | base URL of the preset studio the page sends clips to (default the GitHub Pages site) |

## HTTP contract

One streaming client at a time; a second `/api/stream` request gets
`409 {"error":"busy"}`. No CORS headers (same-origin only).

- `GET /` → the recorder page (`page.html`, gzipped at codegen and
  embedded in flash). `Content-Type: text/html`, `Content-Encoding: gzip`,
  `Cache-Control: no-store`. No auth (the page is useless without the key,
  which lives in the URL fragment).
- `GET /api/info` → requires auth → JSON
  `{"name","friendly_name","sample_rate":16000,"bits":16,"channels":1,`
  `"max_duration_s","studio_url","version":1,"busy"}`.
  `Cache-Control: no-store`.
- `GET /api/stream` → requires auth → `200` chunked
  `application/octet-stream`: raw PCM signed 16-bit little-endian mono at
  16 kHz, sent continuously in ~20–60 ms chunks until the client
  disconnects, `max_duration` is reached, or the server stops. Stops
  promptly (~1 s) when the browser aborts the fetch. If the ring buffer
  overflows, whole chunks are dropped (never misaligned; nothing is
  inserted) and counted; the count is logged when the stream ends.
- Auth: header `Authorization: Bearer <key>`, compared in constant time.
  `401 {"error":"unauthorized"}` otherwise. After 10 failed attempts all
  auth is locked for 30 s (`429`). The key never appears in logs.
- Unknown paths → 404.

## How it works

- Own `esp_http_server` instance (independent of `web_server`), with an
  8 KiB httpd task stack so the `/api/stream` handler can block in short
  reads without starving ESPHome's loop.
- The microphone callback (mic task) writes into a ~32 KiB internal-RAM
  ring buffer **only while a stream is active**; the
  `MicrophoneSource` is started when a stream starts and stopped
  afterwards (refcounted — the alarm detector keeps running undisturbed).
- Boot logs once at INFO: `Capture page: http://<ip>:<port>/ (open it via
  the QR code in the preset studio)`.

## The recorder page

`page.html` is fully self-contained (inline CSS/JS, zero external
requests — works offline) and under 14 KB:

- Reads the key from `location.hash` (`#k=<key>`); without a key it shows
  a fallback key input. The key is kept in `sessionStorage` and scrubbed
  from the visible URL.
- Record/Stop with elapsed time and a live level meter computed from the
  received PCM; handles odd byte counts across fetch chunks and keeps
  what was received if the stream ends (locked phone, app switch,
  max duration).
- Clips persist in the page's IndexedDB until sent or deleted; each clip
  can be played (WebAudio 16 kHz), renamed, deleted, and downloaded as a
  16-bit 16 kHz mono WAV (per clip, or all concatenated with gaps).
- **Send N clips to the preset studio**: opens `studio_url + "#import"`
  in a new tab (from the click), waits up to 15 s for
  `{type:"asd-studio-ready",version:1}` from that window, replies with
  `{type:"asd-capture-clips",version:1,device:{name,friendly_name},clips:[{name,sampleRate:16000,pcm:ArrayBuffer}]}` 
  (copies — stored buffers are never transferred), then waits for
  `{type:"asd-capture-received",count}` and offers to delete the sent
  clips. Timeout/popup-block text guides recovery.

## Resource usage

Measured by compiling the example (ESP-IDF, M5Stack Stamp S3) — see the
report in the implementation notes; steady-state RAM is the 32 KiB ring
buffer plus httpd task/socket overhead (no PSRAM needed). Runtime free
heap can only be read from a live device log, not from a build.
