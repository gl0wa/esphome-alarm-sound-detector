"""Shared TMXC protocol v1 implementation (see docs/capture_protocol.md).

Used by the recorder and by the pure-Python reference device in tests.
Requires the ``cryptography`` package.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_std
import json
import os
import struct

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"TMXC"
VERSION = 0x01
NONCE_S_LEN = 16
NONCE_C_LEN = 16
IV_LEN = 12
DIRECTION_S2C = 1
TAG_LEN = 16

FRAME_HEADER = 0x01
FRAME_AUDIO = 0x02
FRAME_MARKER = 0x03
FRAME_STATS = 0x04

_MAX_PLAINTEXT = 65535


def _hmac(key: bytes, *parts: bytes) -> bytes:
    return hmac_std.new(key, b"".join(parts), hashlib.sha256).digest()


def client_auth_tag(psk: bytes, nonce_s: bytes, nonce_c: bytes) -> bytes:
    return _hmac(psk, b"tmxcap1-auth", nonce_s, nonce_c)


def session_key(psk: bytes, nonce_s: bytes, nonce_c: bytes) -> bytes:
    return _hmac(psk, b"tmxcap1-key", nonce_s, nonce_c)


def server_proof(psk: bytes, nonce_s: bytes, nonce_c: bytes) -> bytes:
    return _hmac(psk, b"tmxcap1-srv", nonce_c, nonce_s)


def iv_for_counter(counter: int) -> bytes:
    return struct.pack(">I", DIRECTION_S2C) + struct.pack("<Q", counter)


def encrypt_frame(key: bytes, counter: int, ftype: int, payload: bytes) -> bytes:
    """Build one wire frame: [u32 len LE][IV][ciphertext|tag]."""
    pt = bytes([ftype]) + payload
    if len(pt) > _MAX_PLAINTEXT:
        raise ValueError("frame payload too large")
    iv = iv_for_counter(counter)
    length = struct.pack("<I", IV_LEN + len(pt) + TAG_LEN)
    ct = AESGCM(key).encrypt(iv, pt, length)  # ciphertext + tag appended
    return length + iv + ct


def decrypt_frame(key: bytes, expected_counter: int, blob: bytes) -> tuple[int, bytes]:
    """Inverse of encrypt_frame; enforces counter == expected_counter exactly."""
    if len(blob) < 4 + IV_LEN + 1 + TAG_LEN:
        raise ValueError("frame too short")
    (length,) = struct.unpack("<I", blob[:4])
    if length != len(blob) - 4:
        raise ValueError("length prefix mismatch")
    iv = blob[4 : 4 + IV_LEN]
    if iv != iv_for_counter(expected_counter):
        raise ValueError(
            f"counter/IV mismatch: got {iv.hex()}, expected counter {expected_counter}"
        )
    pt = AESGCM(key).decrypt(iv, blob[4 + IV_LEN :], blob[:4])
    return pt[0], pt[1:]


def parse_hello(hello: bytes) -> bytes:
    """Validate server hello, return nonce_s."""
    if len(hello) != 4 + 1 + NONCE_S_LEN:
        raise ValueError("bad hello length")
    if hello[:4] != MAGIC:
        raise ValueError("bad magic")
    if hello[4] != VERSION:
        raise ValueError(f"unsupported version {hello[4]}")
    return hello[5:]


def make_hello(nonce_s: bytes) -> bytes:
    return MAGIC + bytes([VERSION]) + nonce_s


def make_client_response(psk: bytes, nonce_s: bytes, nonce_c: bytes) -> bytes:
    return nonce_c + client_auth_tag(psk, nonce_s, nonce_c)


def verify_server_proof(psk: bytes, nonce_s: bytes, nonce_c: bytes, proof: bytes) -> None:
    if len(proof) != 32:
        raise ValueError("bad server proof length")
    if not hmac_std.compare_digest(proof, server_proof(psk, nonce_s, nonce_c)):
        raise ValueError("server proof mismatch")


# --- frame payload helpers -------------------------------------------------


def encode_audio_payload(sample_index: int, pcm: bytes) -> bytes:
    return struct.pack("<Q", sample_index) + pcm


def decode_audio_payload(payload: bytes) -> tuple[int, bytes]:
    if len(payload) < 8:
        raise ValueError("audio payload too short")
    (idx,) = struct.unpack("<Q", payload[:8])
    return idx, payload[8:]


def encode_marker_payload(sample_index: int, label: str) -> bytes:
    lab = label.encode("utf-8")[:120]
    return struct.pack("<Q", sample_index) + lab


def decode_marker_payload(payload: bytes) -> tuple[int, str]:
    if len(payload) < 8:
        raise ValueError("marker payload too short")
    (idx,) = struct.unpack("<Q", payload[:8])
    return idx, payload[8:].decode("utf-8")


def random_nonce(n: int = 16) -> bytes:
    return os.urandom(n)


def header_json(**fields) -> bytes:
    return json.dumps(fields).encode("utf-8")


__all__ = [
    "MAGIC",
    "VERSION",
    "FRAME_HEADER",
    "FRAME_AUDIO",
    "FRAME_MARKER",
    "FRAME_STATS",
    "InvalidTag",
    "client_auth_tag",
    "session_key",
    "server_proof",
    "iv_for_counter",
    "encrypt_frame",
    "decrypt_frame",
    "parse_hello",
    "make_hello",
    "make_client_response",
    "verify_server_proof",
    "encode_audio_payload",
    "decode_audio_payload",
    "encode_marker_payload",
    "decode_marker_payload",
    "random_nonce",
    "header_json",
]
