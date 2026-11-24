"""Pure-Python reference implementation of the TMXC v1 *device* side.

Used to test the recorder end-to-end over localhost. Mirrors
docs/capture_protocol.md; any firmware change to the protocol must be
reflected here (and vice versa).
"""

from __future__ import annotations

import json
import socket
import struct
import threading

import proto


class FakeDevice:
    """Minimal single-client TMXC server streaming scripted PCM."""

    def __init__(self, psk: bytes, sample_rate=48000, bits=32,
                 tamper_at: int | None = None, skip_counter_at: int | None = None):
        self.psk = psk
        self.sample_rate = sample_rate
        self.bits = bits
        self.tamper_at = tamper_at
        self.skip_counter_at = skip_counter_at
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.thread: threading.Thread | None = None
        self.frames_sent = 0

    def serve_once(self, chunks: list[tuple[str, bytes | str | int]],
                   timeout: float = 10.0) -> None:
        """Serve one client in a thread.

        chunks: list of ("audio", pcm_bytes) | ("marker", label) | ("stats", dropped_int).
        """
        def _run():
            self.sock.settimeout(timeout)
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                conn.settimeout(timeout)
                try:
                    self._handle(conn, chunks)
                except (OSError, ValueError):
                    pass

        self.thread = threading.Thread(target=_run, daemon=True)
        self.thread.start()

    def _handle(self, conn: socket.socket, chunks) -> None:
        nonce_s = proto.random_nonce()
        conn.sendall(proto.make_hello(nonce_s))
        resp = _recv_exact(conn, 16 + 32)
        nonce_c, tag = resp[:16], resp[16:]
        import hashlib
        import hmac as hmac_std
        expect = hmac_std.new(self.psk, b"tmxcap1-auth" + nonce_s + nonce_c,
                              hashlib.sha256).digest()
        if not hmac_std.compare_digest(tag, expect):
            return  # auth failure: close with no further bytes
        key = proto.session_key(self.psk, nonce_s, nonce_c)
        conn.sendall(proto.server_proof(self.psk, nonce_s, nonce_c))
        counter = 0

        def send(ftype: int, payload: bytes, ctr: int) -> int:
            frame = proto.encrypt_frame(key, ctr, ftype, payload)
            if self.tamper_at == ctr:
                frame = frame[:-20] + bytes([frame[-20] ^ 0xFF]) + frame[-19:]
            conn.sendall(frame)
            self.frames_sent += 1
            return ctr + 1

        header = proto.header_json(sample_rate=self.sample_rate,
                                   bits_per_sample=self.bits, channels=1,
                                   node="test", esphome="test", uptime_ms=1)
        counter = send(proto.FRAME_HEADER, header, counter)
        sample_idx = 0
        bpf = self.bits // 8
        for kind, data in chunks:
            if kind == "audio":
                assert isinstance(data, bytes)
                # Mirror the firmware: max ~8 KiB audio payload per frame.
                step = 8064  # firmware MAX_AUDIO_PAYLOAD (multiple of 2, 3 and 4)
                for off in range(0, len(data), step):
                    piece = data[off:off + step]
                    counter = send(proto.FRAME_AUDIO,
                                   proto.encode_audio_payload(sample_idx, piece), counter)
                    sample_idx += len(piece) // bpf
                    if self.skip_counter_at is not None and counter == self.skip_counter_at:
                        counter += 1  # simulate a gap: receiver must reject
            elif kind == "gap":
                assert isinstance(data, int)
                sample_idx += data  # firmware dropped frames: index jumps
            elif kind == "marker":
                assert isinstance(data, str)
                counter = send(proto.FRAME_MARKER,
                               proto.encode_marker_payload(sample_idx, data), counter)
            elif kind == "stats":
                assert isinstance(data, int)
                counter = send(proto.FRAME_STATS,
                               json.dumps({"dropped_bytes": data}).encode(), counter)

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass
        if self.thread is not None:
            self.thread.join(timeout=5)


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return bytes(buf)


def sine_pcm(sample_rate: int, bits: int, seconds: float, freq: float = 440.0) -> bytes:
    import numpy as np
    t = np.arange(int(sample_rate * seconds)) / sample_rate
    w = np.sin(2 * np.pi * freq * t)
    if bits <= 16:
        return (w * 32767).astype("<i2").tobytes()
    if bits == 24:
        v = (w * 8388607).astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3]
        return v.tobytes()
    return (w * 2147483647).astype("<i4").tobytes()
