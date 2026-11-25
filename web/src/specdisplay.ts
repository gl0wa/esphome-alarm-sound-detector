// Display-only spectrogram (what a person would expect to see): log power over the
// full 0–8 kHz range with automatic contrast. Detection never uses this code; the
// detector's own features come from the WebAssembly build of the firmware core.

export const DISPLAY_SR = 16000;
export const DISPLAY_N_FFT = 512;
export const DISPLAY_HOP = 256;
export const DISPLAY_BINS = DISPLAY_N_FFT / 2 + 1; // 257 bins, 31.25 Hz each
const DYN_RANGE_DB = 70; // never stretch contrast over less/more than this

export interface DisplaySpec {
  data: Uint8Array; // [frames x DISPLAY_BINS], 0 = quiet .. 255 = loud
  frames: number;
  bins: number;
  hzPerBin: number;
  dbLo: number; // dB mapped to 0
  dbHi: number; // dB mapped to 255
}

// In-place iterative radix-2 complex FFT.
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const cache = new WeakMap<Int16Array, DisplaySpec>();

export function displaySpectrogram(pcm: Int16Array): DisplaySpec {
  const hit = cache.get(pcm);
  if (hit) return hit;
  const frames = pcm.length >= DISPLAY_N_FFT ? 1 + Math.floor((pcm.length - DISPLAY_N_FFT) / DISPLAY_HOP) : 0;
  const db = new Float32Array(frames * DISPLAY_BINS);
  const win = new Float32Array(DISPLAY_N_FFT);
  for (let i = 0; i < DISPLAY_N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / DISPLAY_N_FFT);
  const re = new Float32Array(DISPLAY_N_FFT), im = new Float32Array(DISPLAY_N_FFT);
  for (let f = 0; f < frames; f++) {
    const off = f * DISPLAY_HOP;
    for (let i = 0; i < DISPLAY_N_FFT; i++) { re[i] = (pcm[off + i] / 32768) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < DISPLAY_BINS; k++) {
      db[f * DISPLAY_BINS + k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12);
    }
  }
  // Auto contrast from a sample of values: quiet end at the 5th percentile, loud end
  // at the 99.8th, with the range clamped so near-silent files don't look like noise.
  let dbLo = -100, dbHi = -30;
  if (db.length) {
    const step = Math.max(1, Math.floor(db.length / 200000));
    const sample: number[] = [];
    for (let i = 0; i < db.length; i += step) sample.push(db[i]);
    sample.sort((a, b) => a - b);
    const q = (p: number) => sample[Math.min(sample.length - 1, Math.floor(p * sample.length))];
    dbHi = q(0.998);
    // Most cells are background; starting the scale near its median keeps the
    // background dark so actual sounds stand out.
    dbLo = Math.max(q(0.35), dbHi - DYN_RANGE_DB);
    if (dbHi - dbLo < 30) dbLo = dbHi - 30;
  }
  const data = new Uint8Array(db.length);
  const scale = 255 / (dbHi - dbLo);
  for (let i = 0; i < db.length; i++) {
    const v = (db[i] - dbLo) * scale;
    data[i] = v <= 0 ? 0 : v >= 255 ? 255 : v | 0;
  }
  const spec = { data, frames, bins: DISPLAY_BINS, hzPerBin: DISPLAY_SR / DISPLAY_N_FFT, dbLo, dbHi };
  cache.set(pcm, spec);
  return spec;
}
