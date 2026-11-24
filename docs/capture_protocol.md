# Audio capture protocol v1 ("TMXC")

Development-only protocol for streaming raw microphone audio from the
ESP32-S3 detector to a LAN recorder (`tools/capture/tmx_capture.py`).
It is **not** a public API and must never be enabled in release firmware:
the dev firmware (`firmware/thermomix-detector-dev.yaml`) is the only
config that includes the `audio_capture` component.

Transport: TCP, default port 6060. At most **one** client at a time;
further connections are rejected. All multi-byte integers are
little-endian unless noted.

## 0. Notation

- `||` is byte concatenation.
- `HMAC(k, m)` is HMAC-SHA256.
- `psk` is the pre-shared key from the `capture_psk` secret (raw UTF-8
  bytes of the secret string, minimum 16 characters).

## 1. Handshake (mutual authentication, PSK)

1. Client connects. Server sends 21 bytes:
   `magic "TMXC" (4) || version 0x01 (1) || nonce_s (16, esp_fill_random)`.
   Client aborts if magic/version mismatch.
2. Client generates `nonce_c` (16 random bytes) and sends 48 bytes:
   `nonce_c (16) || HMAC(psk, "tmxcap1-auth" || nonce_s || nonce_c) (32)`.
   Server verifies with a constant-time compare; on failure it closes
   the connection with no further bytes. The client must complete this
   step within **5 s** of connecting (server-side timeout).
3. Both sides derive the session key:
   `key = HMAC(psk, "tmxcap1-key" || nonce_s || nonce_c)` (32 bytes).
4. Server sends a 32-byte server proof so the client authenticates the
   device (prevents connecting to an impostor that merely knows the
   port is open):
   `HMAC(psk, "tmxcap1-srv" || nonce_c || nonce_s)`.
   Client verifies (constant-time) and aborts on mismatch.

Domain strings (`tmxcap1-auth/key/srv`) separate the three HMAC usages
so a value from one step is useless in another.

## 2. Encrypted frames (server -> client only)

After the handshake the channel is strictly unidirectional; any bytes
received from the client (or an orderly TCP shutdown) terminate the
session.

Each frame on the wire:

```
[u32 len LE][12-byte IV][ciphertext || 16-byte GCM tag]
```

- `len` = number of bytes following the length prefix
  (`12 + plaintext_len + 16`).
- IV = `0x00 0x00 0x00 0x01` (4-byte big-endian direction marker,
  server->client = 1) followed by a `u64` **little-endian** counter
  starting at 0 for the first encrypted frame of the session and
  incremented by exactly 1 per frame. The client must reject a counter
  that is not exactly previous + 1 (gap or replay).
- Cipher: AES-256-GCM with `key`, this IV, and **additional
  authenticated data (AAD) = the 4 length-prefix bytes**. Binding the
  length prefix prevents frame splicing/truncation confusion.
- Plaintext of every frame: `[u8 type][type-specific payload...]`.

Frame types:

| Type | Name   | Payload |
|------|--------|---------|
| 0x01 | header | UTF-8 JSON: `sample_rate`, `bits_per_sample`, `channels`, `node` (ESPHome node name), `esphome` (firmware version), `uptime_ms`. Sent once, first frame after the handshake. |
| 0x02 | audio  | `u64 sample_index LE` (index of the **first frame** in this chunk, in frames per channel, counting from 0 at session start) followed by interleaved little-endian PCM bytes **exactly as delivered by `MicrophoneSource`** (no resampling/repacking; chunk boundaries are frame-aligned). |
| 0x03 | marker | `u64 sample_index LE` (next undrained frame index at press time) + UTF-8 label (max 120 bytes). Emitted for each `audio_capture.mark` action call while streaming. |
| 0x04 | stats  | UTF-8 JSON every ~5 s: `dropped_bytes` (cumulative ring-buffer overflow bytes this session), `rssi_dbm` (or null), `free_heap`, `uptime_ms`. |

## 3. Behavioural notes

- The microphone (`MicrophoneSource`, non-passive) is started when the
  handshake completes and stopped when the session ends. The I2S driver
  refcounts listeners, so the concurrently running `sound_level`
  sensor is unaffected.
- Mic audio arrives on another task into a 64 KiB internal-RAM ring
  buffer; the main loop drains it into audio frames (max ~8 KiB audio
  payload each, max 6 frames per loop iteration). Overflow bytes are
  **counted, never blocking**, and reported via stats frames and the
  `dropped_bytes` sensor.
- A slow client (more than 256 KiB of unsent encrypted backlog) is
  disconnected rather than growing RAM without bound.
- Markers pressed with no client connected are dropped with a warning
  (still logged on-device).

## 4. Test vector guidance

`tools/capture/tests/` contains a pure-Python reference implementation
of the device side used to test the recorder end-to-end (handshake,
framing, bad-PSK rejection, tampered frame, counter gap, clip
extraction). Any firmware change to this document must update the
reference implementation and the recorder together.
