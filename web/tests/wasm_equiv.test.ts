// WASM (firmware C++ core) vs tools/detector/ref.py on synthetic audio:
// features must match, streaming scores within 1e-3, identical event types/frames.
import { describe, expect, it } from "vitest";
import { getFeatures, runDetector } from "../src/dsp";
import { loadFixtures, wasmReady } from "./helpers";


describe("wasm vs ref.py", () => {
  const fx = loadFixtures();
  it("generates fixtures", () => {
    expect(fx.featFrames).toBeGreaterThan(100);
    expect(fx.events.length).toBeGreaterThan(0);
  });

  it("features match ref.frames_db + above_floor", async () => {
    await wasmReady();
    const f = getFeatures(fx.pcm, 13, 144);
    expect(f.frames).toBe(fx.featFrames);
    expect(f.bins).toBe(fx.featBins);
    let max = 0, sum = 0;
    for (let i = 0; i < f.data.length; i++) {
      const d = Math.abs(f.data[i] - fx.feat[i]);
      if (d > max) max = d;
      sum += d;
    }
    console.log(`features: max abs diff ${max.toFixed(5)} dB, mean ${(sum / f.data.length).toExponential(2)} dB`);
    expect(max).toBeLessThan(0.02);
  });

  it("streaming scores and events match", async () => {
    await wasmReady();
    const r = runDetector(fx.pcm, fx.tmpl, fx.tmplFrames, fx.tmplBins, {
      threshold: 0.55, near_threshold: 0.35, min_repetitions: 2,
      period_s: 3.125, period_tolerance_s: 0.25, refractory_s: 1.5, release_s: 7.25,
    }, { binLo: 13, binHi: 144 });
    // ref.scores[0..W-2] are pre-window zeros; wasm starts at frame W.
    expect(r.scores.length).toBe(fx.scores.length - fx.tmplFrames + 1);
    let max = 0;
    for (let i = 0; i < r.scores.length; i++) {
      const d = Math.abs(r.scores[i] - fx.scores[fx.tmplFrames - 1 + i]);
      if (d > max) max = d;
    }
    console.log(`scores: max abs diff ${max.toExponential(3)} over ${r.scores.length} frames`);
    expect(max).toBeLessThan(1e-3);
    const got = r.events.map((e) => [e.type, Math.round(e.t * 62.5), +e.score.toFixed(4)]);
    const want = fx.events.map(([t, fr, s]) => [t, fr, +s.toFixed(4)]);
    expect(got.map((g) => g.slice(0, 2))).toEqual(want.map((w) => w.slice(0, 2)));
    for (let i = 0; i < got.length; i++) {
      expect(Math.abs((got[i][2] as number) - (want[i][2] as number))).toBeLessThan(1e-3);
    }
  });
});
