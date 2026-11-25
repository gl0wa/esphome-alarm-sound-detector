// Detector constants shared with the firmware core
// (components/alarm_sound_detector/detector_core.h) and ref.py.
export const SR = 16000;
export const N_FFT = 512;
export const HOP = 256;
export const FPS = SR / HOP; // 62.5 frames/s
export const BIN_MAX = N_FFT / 2; // 256
export const BIN_HZ = SR / N_FFT; // 31.25 Hz per bin

export const hzToBinLo = (hz: number) => Math.ceil(hz / BIN_HZ);
export const hzToBinHi = (hz: number) => Math.floor(hz / BIN_HZ);
export const binLoToHz = (bin: number) => bin * BIN_HZ;
export const binHiToHz = (bin: number) => (bin + 1) * BIN_HZ;

export type EventType = "unit" | "near" | "alarm_on" | "alarm_off";

export interface DetEvent {
  type: EventType;
  t: number; // s, end of the matched window
  score: number;
}

export interface DetParams {
  threshold: number;
  near_threshold: number;
  min_repetitions: number;
  period_s: number | null; // null = single (no-periodicity) mode
  period_tolerance_s: number;
  refractory_s: number;
  release_s: number;
}

export const DEFAULT_PARAMS: DetParams = {
  threshold: 0.55,
  near_threshold: 0.35,
  min_repetitions: 2,
  period_s: 3.125,
  period_tolerance_s: 0.25,
  refractory_s: 1.5,
  release_s: 7.25,
};

export interface Band {
  loHz: number;
  hiHz: number;
  binLo: number;
  binHi: number;
}

export function bandFromHz(loHz: number, hiHz: number): Band {
  const binLo = Math.max(1, hzToBinLo(loHz));
  const binHi = Math.min(BIN_MAX, hzToBinHi(hiHz));
  if (binLo > binHi) throw new Error(`band ${loHz}-${hiHz} Hz maps to empty bins ${binLo}..${binHi}`);
  return { loHz, hiHz, binLo, binHi };
}

export const DEFAULT_BAND = bandFromHz(400, 4500);

export interface BuiltTemplate {
  q: Int8Array; // quantised, frames x bins row-major
  frames: number;
  bins: number;
}
