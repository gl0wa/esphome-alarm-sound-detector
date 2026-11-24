#!/usr/bin/env python3
"""TMXC v1 recorder: stream raw mic audio from the dev firmware to FLAC files.

See docs/data_collection.md and docs/capture_protocol.md.

Usage:
    tmx_capture.py record --host HOST --psk-file firmware/secrets.yaml \\
        --out data/recordings [--mode continuous|clips] [...]

Modes:
  continuous  Write FLAC files rotated every N minutes (default 10) plus a
              sidecar JSON per file (markers, header info, drop stats).
  clips       Keep a rolling in-memory buffer (default 60 s) and save only a
              clip [-pre, +post] (defaults 40 s / 15 s) around each received
              marker. Discards everything else (privacy-preserving default).
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import queue
import signal
import socket
import sys
import threading
import time

import numpy as np
import soundfile as sf
import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import proto  # noqa: E402

DEFAULT_PORT = 6060
HANDSHAKE_TIMEOUT_S = 10
# The device streams continuously, so silence this long means a dead (half-open) link.
RECV_TIMEOUT_S = 8.0
BACKOFFS = (1, 2, 4, 8, 15, 30)


# --- helpers ---------------------------------------------------------------


def load_psk(secrets_path: str) -> bytes:
    with open(secrets_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    psk = data.get("capture_psk")
    if not psk or len(str(psk)) < 16:
        raise SystemExit(f"{secrets_path}: missing or too-short capture_psk (>= 16 chars)")
    return str(psk).encode("utf-8")


def recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("peer closed connection")
        buf += chunk
    return bytes(buf)


MAX_FRAME_LEN = 16384
# Larger sample-index jumps are treated as a protocol violation, never zero-filled.
MAX_GAP_SECONDS = 10.0


def wire_pcm_to_i32(pcm: bytes, bits: int) -> np.ndarray:
    """Decode wire PCM (16, 24 packed, or 32-bit LE) to left-justified int32."""
    if bits == 16:
        return np.frombuffer(pcm, dtype="<i2").astype(np.int32) << 16
    if bits == 24:
        b = np.frombuffer(pcm, dtype=np.uint8).reshape(-1, 3).astype(np.uint32)
        return ((b[:, 0] << 8) | (b[:, 1] << 16) | (b[:, 2] << 24)).view(np.int32)
    if bits == 32:
        return np.frombuffer(pcm, dtype="<i4")
    raise ValueError(f"unsupported bits_per_sample {bits}")


def pcm_to_mono_float(pcm: bytes, bits: int) -> np.ndarray:
    if bits <= 16:
        a = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
        return a / 32768.0
    a = np.frombuffer(pcm, dtype="<i4").astype(np.float32)
    return a / 2147483648.0


def level_bar(rms: float, width: int = 30) -> str:
    db = 20 * np.log10(max(rms, 1e-6))
    fill = max(0, min(width, int((db + 90) * width / 90)))
    return "#" * fill + "-" * (width - fill) + f" {db:6.1f} dBFS"


# --- client ----------------------------------------------------------------


class TmxClient:
    """Blocking TMXC v1 client with strict counter enforcement."""

    def __init__(self, host: str, port: int, psk: bytes):
        self.host = host
        self.port = port
        self.psk = psk
        self.sock: socket.socket | None = None
        self.key: bytes | None = None
        self.counter = 0

    def connect(self) -> dict:
        sock = socket.create_connection((self.host, self.port), timeout=HANDSHAKE_TIMEOUT_S)
        sock.settimeout(RECV_TIMEOUT_S)
        try:
            hello = recv_exact(sock, 4 + 1 + proto.NONCE_S_LEN)
            nonce_s = proto.parse_hello(hello)
            nonce_c = proto.random_nonce()
            sock.sendall(proto.make_client_response(self.psk, nonce_s, nonce_c))
            proof = recv_exact(sock, 32)
            proto.verify_server_proof(self.psk, nonce_s, nonce_c, proof)
            self.key = proto.session_key(self.psk, nonce_s, nonce_c)
        except Exception:
            sock.close()
            raise
        self.sock = sock
        self.counter = 0
        ftype, payload = self.read_frame()
        if ftype != proto.FRAME_HEADER:
            raise ConnectionError(f"expected header frame, got type {ftype:#x}")
        return json.loads(payload.decode("utf-8"))

    def read_frame(self) -> tuple[int, bytes]:
        assert self.sock is not None and self.key is not None
        blob = recv_exact(self.sock, 4)
        length = int.from_bytes(blob, "little")
        # Bound attacker-controlled length before allocating (IV + type + 8 KiB audio + tag fits easily).
        if not (12 + 1 + 16) <= length <= MAX_FRAME_LEN:
            raise ConnectionError(f"invalid frame length {length}")
        blob += recv_exact(self.sock, length)
        ftype, payload = proto.decrypt_frame(self.key, self.counter, blob)
        self.counter += 1
        return ftype, payload

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None


# --- writers ---------------------------------------------------------------


def flac_subtype_for(bits: int) -> str:
    return "PCM_16" if bits <= 16 else "PCM_24"


def pcm_to_write_array(pcm: bytes, bits: int, channels: int) -> np.ndarray:
    if channels != 1:
        raise ValueError("only mono capture is currently supported")
    if bits <= 16:
        return np.frombuffer(pcm, dtype="<i2")
    # Left-justified int32: libsndfile treats int32 as full scale and keeps the
    # top 24 bits when writing PCM_24, so no manual shifting here.
    return np.frombuffer(pcm, dtype="<i4")


def utc_stamp(wall_ts: float) -> str:
    return dt.datetime.fromtimestamp(wall_ts, tz=dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


class ContinuousRecorder:
    """Write FLAC files rotated every rotate_s seconds + sidecar JSON."""

    def __init__(self, out_dir: str, header: dict, rotate_s: int):
        self.out_dir = out_dir
        self.header = header
        self.rotate_s = rotate_s
        os.makedirs(out_dir, exist_ok=True)
        self.sr = int(header["sample_rate"])
        self.bits = int(header["bits_per_sample"])
        self.file: sf.SoundFile | None = None
        self.file_start_idx: int = 0
        self.file_start_wall: float = 0.0
        self.fname_base = ""
        self.markers: list[dict] = []
        self.dropped = 0
        self.frames_written = 0
        self.gaps: list[dict] = []

    def _open(self, sample_idx: int, wall: float) -> None:
        self._close(final=False)
        self.fname_base = f"cont_{utc_stamp(wall)}_sr{self.sr}"
        path = os.path.join(self.out_dir, self.fname_base + ".flac")
        self.file = sf.SoundFile(
            path, mode="w", samplerate=self.sr, channels=1,
            subtype=flac_subtype_for(self.bits),
        )
        self.file_start_idx = sample_idx
        self.file_start_wall = wall
        self.markers = []
        self.gaps = []
        self.frames_written = 0
        print(f"[file] {path}", flush=True)

    def _close(self, final: bool = True) -> None:
        if self.file is None:
            return
        self.file.close()
        self.file = None
        sidecar = {
            "file": self.fname_base + ".flac",
            "header": self.header,
            "start_sample_index": self.file_start_idx,
            "start_wall_utc": self.file_start_wall,
            "frames_written": self.frames_written,
            "dropped_bytes": self.dropped,
            "markers": self.markers,
            "gaps_zero_filled": self.gaps,
            "last_device_stats": getattr(self, "device_stats", None),
            "complete": final,
        }
        with open(os.path.join(self.out_dir, self.fname_base + ".json"), "w") as f:
            json.dump(sidecar, f, indent=2)

    def audio(self, sample_idx: int, pcm: bytes, wall: float) -> None:
        if self.file is None or (wall - self.file_start_wall) >= self.rotate_s:
            self._open(sample_idx, wall)
        assert self.file is not None
        self.file.write(pcm_to_write_array(pcm, self.bits, 1))
        self.frames_written += len(pcm) // (self.bits // 8)

    def marker(self, sample_idx: int, label: str, wall: float) -> None:
        print(f"[marker] +{(sample_idx - self.file_start_idx) / self.sr:.1f}s {label}", flush=True)
        self.markers.append({
            "label": label,
            "sample_offset": sample_idx - self.file_start_idx,
            "wall_utc": wall,
        })

    def stats(self, dropped: int) -> None:
        self.dropped = dropped

    def finish(self) -> None:
        self._close(final=True)


class ClipsRecorder:
    """Rolling buffer; save [-pre, +post] around each marker, discard the rest."""

    def __init__(self, out_dir: str, header: dict, buffer_s: float, pre_s: float, post_s: float):
        self.out_dir = out_dir
        self.header = header
        os.makedirs(out_dir, exist_ok=True)
        self.sr = int(header["sample_rate"])
        self.bits = int(header["bits_per_sample"])
        self.bytes_per_frame = (self.bits // 8)
        self.buffer_frames = int(buffer_s * self.sr)
        self.pre_frames = int(pre_s * self.sr)
        self.post_frames = int(post_s * self.sr)
        self.buf: collections.deque[tuple[int, bytes]] = collections.deque()
        self.buf_frames = 0
        self.pending: list[dict] = []
        self.dropped = 0
        self.start_wall: float | None = None

    def audio(self, sample_idx: int, pcm: bytes, wall: float) -> None:
        if self.start_wall is None:
            self.start_wall = wall - sample_idx / self.sr
        self.buf.append((sample_idx, pcm))
        self.buf_frames += len(pcm) // self.bytes_per_frame
        while self.buf_frames > self.buffer_frames and self.buf:
            _, old = self.buf.popleft()
            self.buf_frames -= len(old) // self.bytes_per_frame
        self._try_finalize(sample_idx)

    def marker(self, sample_idx: int, label: str, wall: float) -> None:
        print(f"[marker] {label} @sample {sample_idx}", flush=True)
        self.pending.append({
            "label": label,
            "at": sample_idx,
            "start": max(0, sample_idx - self.pre_frames),
            "end": sample_idx + self.post_frames,
            "wall_utc": wall,
        })

    def _try_finalize(self, newest_idx: int) -> None:
        ready = [p for p in self.pending if p["end"] <= newest_idx]
        for clip in ready:
            self._write_clip(clip)
            self.pending.remove(clip)

    def _gather(self, start: int, end: int) -> tuple[bytes, int]:
        """Collect PCM for [start, end); returns (bytes, missing_frames)."""
        out = bytearray()
        missing = 0
        want = start
        for idx, chunk in self.buf:
            n = len(chunk) // self.bytes_per_frame
            if idx + n <= want:
                continue
            if idx > want:
                missing += idx - want
                want = idx
            skip = max(0, want - idx) * self.bytes_per_frame
            take_end = min(len(chunk), skip + (end - want) * self.bytes_per_frame)
            out += chunk[skip:take_end]
            want += (take_end - skip) // self.bytes_per_frame
            if want >= end:
                break
        if want < end:
            missing += end - want
        return bytes(out), missing

    def _write_clip(self, clip: dict) -> None:
        pcm, missing = self._gather(clip["start"], clip["end"])
        if not pcm:
            print(f"[clip] empty, skipped ({clip['label']})", flush=True)
            return
        wall = (self.start_wall or 0.0) + clip["start"] / self.sr
        base = f"clip_{utc_stamp(wall)}_{clip['label']}"
        path = os.path.join(self.out_dir, base + ".flac")
        with sf.SoundFile(path, mode="w", samplerate=self.sr, channels=1,
                           subtype=flac_subtype_for(self.bits)) as f:
            f.write(pcm_to_write_array(pcm, self.bits, 1))
        sidecar = {
            "file": base + ".flac",
            "header": self.header,
            "label": clip["label"],
            "marker_sample_index": clip["at"],
            "clip_start_sample_index": clip["start"],
            "clip_end_sample_index": clip["end"],
            "missing_frames": missing,
            "dropped_bytes_session": self.dropped,
            "complete": missing == 0,
        }
        with open(os.path.join(self.out_dir, base + ".json"), "w") as f:
            json.dump(sidecar, f, indent=2)
        print(f"[clip] {path} ({len(pcm) / self.bytes_per_frame / self.sr:.1f}s, "
              f"missing={missing})", flush=True)

    def stats(self, dropped: int) -> None:
        self.dropped = dropped

    def finish(self) -> None:
        # Finalize whatever is buffered (possibly partial tails).
        for clip in list(self.pending):
            self._write_clip(clip)
        self.pending.clear()


# --- main loop -------------------------------------------------------------


def run_record(host: str, port: int, psk: bytes, out_dir: str, mode: str,
               stop: threading.Event, on_frame=None, **kw) -> None:
    """Connect, record, auto-reconnect with backoff until stop is set."""
    backoff_idx = 0
    while not stop.is_set():
        client = TmxClient(host, port, psk)
        try:
            header = client.connect()
            print(f"[connected] {header}", flush=True)
            backoff_idx = 0
            rec_header = dict(header, bits_per_sample=32,
                              wire_bits_per_sample=int(header["bits_per_sample"]))
            rec = (ContinuousRecorder(out_dir, rec_header, kw.get("rotate_s", 600))
                   if mode == "continuous"
                   else ClipsRecorder(out_dir, rec_header, kw.get("buffer_s", 60.0),
                                      kw.get("pre_s", 40.0), kw.get("post_s", 15.0)))
            sr = int(header["sample_rate"])
            wire_bits = int(header["bits_per_sample"])
            # Recorders work on left-justified int32 mono PCM internally.
            bits = 32
            expected_idx: int | None = None
            wall0: float | None = None
            idx0 = 0
            try:
                while not stop.is_set():
                    try:
                        ftype, payload = client.read_frame()
                    except socket.timeout as e:
                        # Never resume after a timeout: it may have hit mid-frame (desync),
                        # and a silent link is dead anyway. Reconnect with a fresh session.
                        raise ConnectionError(f"no data for {RECV_TIMEOUT_S:.0f} s; reconnecting") from e
                    if on_frame is not None:
                        on_frame(ftype, payload)
                    if ftype == proto.FRAME_AUDIO:
                        idx, wire_pcm = proto.decode_audio_payload(payload)
                        samples = wire_pcm_to_i32(wire_pcm, wire_bits)
                        if expected_idx is not None and idx != expected_idx:
                            if idx < expected_idx:
                                raise ValueError(f"sample index went backwards {idx} < {expected_idx}")
                            gap = idx - expected_idx
                            if gap > MAX_GAP_SECONDS * sr:
                                raise ValueError(f"implausible sample-index jump of {gap} frames")
                            print(f"\n[gap] {gap} frames ({gap / sr * 1000:.0f} ms) zero-filled", flush=True)
                            if hasattr(rec, "gaps"):
                                rec.gaps.append({"at_sample_index": expected_idx, "frames": gap})
                            samples = np.concatenate([np.zeros(gap, dtype=np.int32), samples])
                            idx = expected_idx
                        expected_idx = idx + len(samples)
                        pcm = samples.astype("<i4").tobytes()
                        if wall0 is None:
                            wall0, idx0 = time.time(), idx
                        wall = wall0 + (idx - idx0) / sr
                        rms = float(np.sqrt(np.mean(pcm_to_mono_float(pcm, bits) ** 2)))
                        print(f"\r[level] {level_bar(rms)}", end="", flush=True)
                        rec.audio(idx, pcm, wall)
                    elif ftype == proto.FRAME_MARKER:
                        idx, label = proto.decode_marker_payload(payload)
                        wall = (wall0 or time.time()) + (idx - idx0) / sr
                        print(flush=True)
                        rec.marker(idx, label, wall)
                    elif ftype == proto.FRAME_STATS:
                        st = json.loads(payload.decode("utf-8"))
                        rec.stats(int(st.get("dropped_bytes", 0)))
                        rec.device_stats = st
                    elif ftype == proto.FRAME_HEADER:
                        pass
                    else:
                        print(f"\n[warn] unknown frame type {ftype:#x}", flush=True)
            finally:
                print(flush=True)
                rec.finish()
        except (OSError, ConnectionError, ValueError) as e:
            print(f"\n[error] {e}", flush=True)
        except Exception as e:  # noqa: BLE001 - must not kill a long recording
            print(f"\n[error] unexpected: {e!r}", flush=True)
        finally:
            client.close()
        if stop.is_set():
            break
        delay = BACKOFFS[min(backoff_idx, len(BACKOFFS) - 1)]
        backoff_idx += 1
        print(f"[reconnect] in {delay}s ...", flush=True)
        if stop.wait(delay):
            break


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="TMXC v1 audio recorder")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record", help="record from device")
    r.add_argument("--host", required=True)
    r.add_argument("--port", type=int, default=DEFAULT_PORT)
    r.add_argument("--psk-file", required=True, help="path to secrets.yaml with capture_psk")
    r.add_argument("--out", required=True, help="output directory")
    r.add_argument("--mode", choices=("continuous", "clips"), default="clips")
    r.add_argument("--rotate-min", type=float, default=10.0)
    r.add_argument("--buffer-s", type=float, default=60.0)
    r.add_argument("--pre-s", type=float, default=40.0)
    r.add_argument("--post-s", type=float, default=15.0)
    args = ap.parse_args(argv)

    psk = load_psk(args.psk_file)
    stop = threading.Event()

    def _sig(*_a):
        print("\n stopping, finalizing files...", flush=True)
        stop.set()

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    run_record(args.host, args.port, psk, args.out, args.mode, stop,
               rotate_s=int(args.rotate_min * 60),
               buffer_s=args.buffer_s, pre_s=args.pre_s, post_s=args.post_s)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
