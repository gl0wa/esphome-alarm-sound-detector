"""End-to-end protocol tests: recorder client vs reference device."""

import json
import os
import struct
import sys
import threading

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import proto  # noqa: E402
from tmx_capture import ClipsRecorder, ContinuousRecorder, TmxClient, load_psk  # noqa: E402

sys.path.insert(0, os.path.dirname(__file__))
from fake_device import FakeDevice, sine_pcm  # noqa: E402

PSK = b"test-psk-0123456789"


def test_handshake_and_audio_roundtrip(tmp_path):
    dev = FakeDevice(PSK)
    pcm = sine_pcm(48000, 32, 0.5)
    dev.serve_once([("audio", pcm), ("marker", "thermomix_alarm"),
                    ("audio", pcm), ("stats", 0)])
    try:
        c = TmxClient("127.0.0.1", dev.port, PSK)
        header = c.connect()
        assert header["sample_rate"] == 48000
        assert header["bits_per_sample"] == 32
        got = []
        while True:
            ftype, payload = c.read_frame()
            got.append((ftype, payload))
            if ftype == proto.FRAME_STATS:
                break
        c.close()
        types = [t for t, _ in got]
        assert types[0] == proto.FRAME_AUDIO
        assert proto.FRAME_MARKER in types and types[-1] == proto.FRAME_STATS
        # First audio chunk starts at sample 0 with exact PCM.
        idx, back = proto.decode_audio_payload(got[0][1])
        assert idx == 0 and back == pcm[:8064]
        # Audio indexes are contiguous across chunk boundaries.
        bpf = 4
        full = pcm + pcm  # two identical chunks stream back-to-back
        off = 0
        for t, p in got:
            if t != proto.FRAME_AUDIO:
                continue
            idx, chunk = proto.decode_audio_payload(p)
            assert idx == off // bpf
            assert chunk == full[off:off + len(chunk)]
            off += len(chunk)
        assert off == 2 * len(pcm)
        mframe = next(p for t, p in got if t == proto.FRAME_MARKER)
        midx, label = proto.decode_marker_payload(mframe)
        assert label == "thermomix_alarm" and midx == len(pcm) // bpf
        assert json.loads(got[-1][1].decode())["dropped_bytes"] == 0
    finally:
        dev.close()


def test_bad_psk_rejected():
    dev = FakeDevice(PSK)
    dev.serve_once([("audio", b"\x00" * 64)])
    try:
        c = TmxClient("127.0.0.1", dev.port, b"wrong-psk-xxxxxxxx")
        with pytest.raises((ConnectionError, OSError, ValueError)):
            c.connect()
    finally:
        dev.close()


def test_tampered_frame_rejected():
    dev = FakeDevice(PSK, tamper_at=1)
    dev.serve_once([("audio", sine_pcm(48000, 32, 0.1))])
    try:
        c = TmxClient("127.0.0.1", dev.port, PSK)
        c.connect()
        with pytest.raises(Exception):
            c.read_frame()  # GCM tag must fail
        c.close()
    finally:
        dev.close()


def test_counter_gap_rejected():
    dev = FakeDevice(PSK, skip_counter_at=2)
    dev.serve_once([("audio", sine_pcm(48000, 32, 0.1)),
                     ("audio", sine_pcm(48000, 32, 0.1))])
    try:
        c = TmxClient("127.0.0.1", dev.port, PSK)
        c.connect()
        c.read_frame()  # counter 1 ok
        with pytest.raises(ValueError, match="counter/IV mismatch"):
            c.read_frame()  # counter 3 sent, 2 expected
        c.close()
    finally:
        dev.close()


def test_server_proof_mismatch():
    nonce_s, nonce_c = proto.random_nonce(), proto.random_nonce()
    with pytest.raises(ValueError, match="server proof mismatch"):
        proto.verify_server_proof(PSK, nonce_s, nonce_c, b"\x00" * 32)


def test_continuous_writes_flac_and_sidecar(tmp_path):
    dev = FakeDevice(PSK)
    pcm = sine_pcm(48000, 32, 0.2)
    dev.serve_once([("audio", pcm), ("marker", "background"),
                    ("audio", pcm), ("stats", 7)])
    try:
        c = TmxClient("127.0.0.1", dev.port, PSK)
        header = c.connect()
        rec = ContinuousRecorder(str(tmp_path), header, rotate_s=3600)
        wall = 1_700_000_000.0
        while True:
            ftype, payload = c.read_frame()
            if ftype == proto.FRAME_AUDIO:
                idx, chunk = proto.decode_audio_payload(payload)
                rec.audio(idx, chunk, wall + idx / 48000)
            elif ftype == proto.FRAME_MARKER:
                idx, label = proto.decode_marker_payload(payload)
                rec.marker(idx, label, wall + idx / 48000)
            elif ftype == proto.FRAME_STATS:
                rec.stats(int(json.loads(payload.decode())["dropped_bytes"]))
                break
        rec.finish()
        c.close()
        flacs = list(tmp_path.glob("*.flac"))
        sides = list(tmp_path.glob("*.json"))
        assert len(flacs) == 1 and len(sides) == 1
        side = json.loads(sides[0].read_text())
        assert side["markers"][0]["label"] == "background"
        assert side["dropped_bytes"] == 7
        assert side["frames_written"] == 2 * len(pcm) // 4
        import soundfile as sf
        data, sr = sf.read(str(flacs[0]), dtype="int32")
        assert sr == 48000 and len(data) == 2 * len(pcm) // 4
    finally:
        dev.close()


def test_clips_extract_around_marker(tmp_path):
    dev = FakeDevice(PSK)
    pcm = sine_pcm(48000, 32, 0.5)  # 0.5 s per chunk
    # 4 s of audio with a marker at t=2 s.
    chunks = [("audio", pcm)] * 4
    chunks.insert(2, ("marker", "thermomix_alarm"))
    chunks.append(("stats", 0))
    dev.serve_once(chunks)
    try:
        c = TmxClient("127.0.0.1", dev.port, PSK)
        header = c.connect()
        rec = ClipsRecorder(str(tmp_path), header, buffer_s=10.0, pre_s=1.0, post_s=1.0)
        wall = 1_700_000_000.0
        while True:
            ftype, payload = c.read_frame()
            if ftype == proto.FRAME_AUDIO:
                idx, chunk = proto.decode_audio_payload(payload)
                rec.audio(idx, chunk, wall + idx / 48000)
            elif ftype == proto.FRAME_MARKER:
                idx, label = proto.decode_marker_payload(payload)
                rec.marker(idx, label, wall + idx / 48000)
            elif ftype == proto.FRAME_STATS:
                break
        rec.finish()
        c.close()
        flacs = list(tmp_path.glob("clip_*.flac"))
        assert len(flacs) == 1
        assert "thermomix_alarm" in flacs[0].name
        import soundfile as sf
        data, sr = sf.read(str(flacs[0]), dtype="int32")
        # pre 1 s + post 1 s around t=2 s
        assert sr == 48000 and len(data) == 2 * 48000
        side = json.loads(tmp_path.glob("clip_*.json").__iter__().__next__().read_text())
        assert side["complete"] is True and side["missing_frames"] == 0
    finally:
        dev.close()


def test_load_psk(tmp_path):
    f = tmp_path / "secrets.yaml"
    f.write_text('wifi_ssid: "x"\ncapture_psk: "0123456789abcdef"\n')
    assert load_psk(str(f)) == b"0123456789abcdef"
    f.write_text('capture_psk: "short"\n')
    with pytest.raises(SystemExit):
        load_psk(str(f))


def test_run_record_24bit_exact_with_gap_zero_fill(tmp_path):
    """End-to-end through run_record: 24-bit packed wire PCM is stored losslessly
    and a sample-index jump (firmware drop) is zero-filled and reported."""
    import threading
    import numpy as np
    import soundfile as sf
    from tmx_capture import run_record

    sr = 48000
    pcm = sine_pcm(sr, 24, 0.25, freq=1000.0)
    n = len(pcm) // 3
    gap = 480
    dev = FakeDevice(PSK, sample_rate=sr, bits=24)
    dev.serve_once([("audio", pcm), ("gap", gap), ("audio", pcm), ("marker", "thermomix_alarm"),
                    ("stats", 0)])
    stop = threading.Event()

    def on_frame(ftype, _payload):
        if ftype == proto.FRAME_STATS:
            stop.set()

    try:
        run_record("127.0.0.1", dev.port, PSK, str(tmp_path), "continuous", stop,
                   on_frame=on_frame, rotate_s=3600)
    finally:
        dev.close()
    flac = next(tmp_path.glob("*.flac"))
    side = json.loads(next(tmp_path.glob("*.json")).read_text())
    got, fsr = sf.read(flac, dtype="int32")
    assert fsr == sr and sf.info(flac).subtype == "PCM_24"
    b = np.frombuffer(pcm, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
    ref = ((b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)) << 8).astype(np.int32)  # left-justified
    expected = np.concatenate([ref, np.zeros(gap, np.int32), ref])
    assert len(got) == 2 * n + gap
    assert np.array_equal(got, expected)
    assert side["gaps_zero_filled"] == [{"at_sample_index": n, "frames": gap}]
    assert side["markers"][0]["label"] == "thermomix_alarm"
    assert side["markers"][0]["sample_offset"] == 2 * n + gap
    assert side["header"]["wire_bits_per_sample"] == 24
