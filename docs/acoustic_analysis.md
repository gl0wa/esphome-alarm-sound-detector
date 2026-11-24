# Acoustic analysis of the Thermomix TM6 alarm

Measurements from recordings made with the target hardware (INMP441 on the
ESP32-S3, 48 kHz / 24-bit, device placed in the kitchen ~1-2 m from the TM6).
Recordings themselves are private and not part of this repository.

## Session 1 (2026-11-25, 161 s, one TM6 volume setting)

- **Structure:** the alarm is a short chime phrase (marimba-like arpeggio of
  ~4 note onsets within ~0.6 s, ringing/decaying for ~2 s) **repeated every
  3.125 s** until acknowledged. Two episodes: 5 and 20 repetitions.
- **Spectrum:** stable tonal partials; strongest around 550, ~650-680, ~860,
  1000, 1100 Hz, with weaker partials ~1700, 2450, 3000, 3350, 4000 Hz.
  Essentially nothing above ~5 kHz -> 16 kHz sampling is sufficient for detection.
- **Background in this kitchen:** -33 dBFS RMS dominated by < 100 Hz rumble;
  500 Hz-5 kHz bands ~50 dB lower when quiet. Impulsive dish clatter is broadband.
- **Template matching** (normalised cross-correlation of a 1.3 s,
  400-4500 Hz, background-normalised log spectrogram against one alarm unit):
  alarm units score 0.73-0.86; maximum score elsewhere 0.075 (speech, clatter,
  noise). The first unit of each episode scored only 0.21-0.25 because a loud
  harmonic sound (f0 ≈ 950-1000 Hz with vibrato) overlapped it.

## Open questions
- Behaviour at other TM6 volume settings and with competing noise (hood, water,
  radio/TV, conversation).
- False-positive rate over many hours of normal kitchen activity.
