// Fast repeating beeps (5 × 0.55 s at 4 kHz, one per second, twice in one
// recording): "Find similar" must list every beep and "Estimate repetition"
// must find the 1 s period despite the long gap between the two alarms.
import { describe, expect, it } from "vitest";
import { findSimilar } from "../src/similar";
import { freshState } from "../src/store";
import { estimatePeriod, nearLevel, suggestBand } from "../src/template";
import { wasmReady } from "./helpers";
import { autoTune, measureSoundLength } from "../src/pipeline";

const SR = 16000;

function beeps(starts: number[], dur: number, total: number): Int16Array {
  const pcm = new Int16Array(total * SR);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(rnd() * 600); // background hiss
  for (const t0 of starts) {
    for (let i = Math.round(t0 * SR); i < Math.round((t0 + dur) * SR); i++) {
      pcm[i] += Math.round(8000 * Math.sin((2 * Math.PI * 4000 * i) / SR));
    }
  }
  return pcm;
}

describe("estimatePeriod", () => {
  it("finds the period of one alarm", () => {
    expect(estimatePeriod([[18.9, 19.9, 20.9, 21.9, 22.9]]).period).toBeCloseTo(1.0, 2);
  });
  it("ignores the gap between two alarms and a missed repetition", () => {
    const r = estimatePeriod([[2, 3, 5, 6, 40, 41, 42, 43.02, 44]]);
    expect(r.period).toBeCloseTo(1.0, 1);
  });
  it("pools examples from several recordings", () => {
    expect(estimatePeriod([[1, 4.1], [10, 13.15], [7]]).period).toBeCloseTo(3.125, 1);
  });
  it("falls back to single mode with too few or irregular examples", () => {
    expect(estimatePeriod([[1, 2]]).period).toBeNull();
    expect(estimatePeriod([[1, 2.7, 3.1, 7.9, 9.0]]).period).toBeNull();
  });
});

describe("findSimilar with fast beeps", () => {
  it("lists every beep and the period estimate is 1 s", async () => {
    await wasmReady();
    const starts = [3, 4, 5, 6, 7, 20, 21, 22, 23, 24];
    const s = freshState();
    s.recordings = [{ id: "r1", name: "beeps", pcm: beeps(starts, 0.55, 30) }];
    s.duration = 0.65;
    s.examples = [{ id: "e1", recId: "r1", t0: 2.95, t1: 3.6 }];
    findSimilar(s, "e1", 0.35);
    // Every other beep is a candidate (the old fixed 1.5 s spacing skipped every second one).
    const centres = s.candidates.map((c) => (c.t0 + c.t1) / 2);
    const found = starts.slice(1).map((t) => centres.find((c) => Math.abs(c - (t + 0.275)) < 0.15));
    expect(found.every((c) => c !== undefined)).toBe(true);
    const times = [(2.95 + 3.6) / 2, ...(found as number[])];
    expect(estimatePeriod([times]).period).toBeCloseTo(1.0, 1);
  });
});

describe("find similar keeps earlier decisions", () => {
  it("lists already accepted examples as accepted, not as new candidates", async () => {
    await wasmReady();
    const starts = [3, 4, 5, 6, 7];
    const s = freshState();
    s.recordings = [{ id: "r1", name: "beeps", pcm: beeps(starts, 0.55, 12) }];
    s.duration = 0.65;
    s.examples = [
      { id: "e1", recId: "r1", t0: 2.95, t1: 3.6 },
      { id: "e2", recId: "r1", t0: 4.0, t1: 4.6 }, // accepted in an earlier run
    ];
    findSimilar(s, "e1", 0.35);
    const near = (t: number) => s.candidates.filter((c) => Math.abs((c.t0 + c.t1) / 2 - t) < 0.3);
    expect(near(3.275).length).toBe(0); // the seed itself is not a candidate
    expect(near(4.275).map((c) => [c.status, c.exampleId])).toEqual([["accepted", "e2"]]);
    expect(near(5.275).map((c) => c.status)).toEqual(["pending"]);
  });
});

describe("band and near-miss suggestions", () => {
  it("widens a pure-tone band to about half an octave", () => {
    const bins = 250, lo = 3;
    const ex = new Float32Array(bins), bg = new Float32Array(bins);
    const tone = Math.round(4031 / 31.25) - lo;
    ex[tone] = 40; ex[tone + 1] = 30;
    const r = suggestBand(ex, bg, bins, lo);
    expect(r.loHz).toBeLessThanOrEqual(3100);
    expect(r.hiHz).toBeGreaterThanOrEqual(5000);
    expect(r.text).toContain("4000–4100");
  });
  it("keeps a wide band as found", () => {
    const bins = 250, lo = 3;
    const ex = new Float32Array(bins), bg = new Float32Array(bins);
    for (let b = 10; b < 140; b++) ex[b - lo] = 20;
    const r = suggestBand(ex, bg, bins, lo);
    expect(r.hiHz - r.loHz).toBeGreaterThan(3500);
    expect(r.text).not.toContain("suggesting");
  });
  it("near-miss level stays within 0.2 below the threshold", () => {
    expect(nearLevel(0.44, 0.08)).toBe(0.24);
    expect(nearLevel(0.55, 0.45)).toBe(0.5);
    expect(nearLevel(0.5, 0.48)).toBe(0.45);
  });
});

describe("measureSoundLength", () => {
  it("measures one beep, also from a loose selection", async () => {
    await wasmReady();
    const pcm = beeps([5, 6, 7], 0.55, 10);
    for (const [t0, t1] of [[4.95, 5.6], [4.6, 5.8]]) {
      const len = measureSoundLength(pcm, t0, t1)!;
      expect(len).toBeGreaterThanOrEqual(0.5);
      expect(len).toBeLessThanOrEqual(0.75);
    }
  });
  it("returns null when nothing stands out", async () => {
    await wasmReady();
    expect(measureSoundLength(beeps([], 0.5, 8), 5, 5.6)).toBeNull();
  });
});

describe("autoTune", () => {
  it("tunes fast beeps end to end: band, 1 s rhythm, 3 matches, clear margin", async () => {
    await wasmReady();
    const starts = [3, 4, 5, 6, 7, 20, 21, 22, 23, 24];
    const s = freshState();
    s.recordings = [{ id: "r1", name: "beeps", pcm: beeps(starts, 0.55, 30) }];
    s.duration = 0.65;
    s.examples = starts.map((t, i) => ({ id: `e${i}`, recId: "r1", t0: t - 0.05, t1: t + 0.6 }));
    const r = autoTune(s);
    expect(s.repeating).toBe(true);
    expect(s.params.period_s).toBeCloseTo(1.0, 1);
    expect(s.params.refractory_s).toBeLessThan(s.params.period_s!);
    expect(s.params.min_repetitions).toBe(3);
    expect(s.band.loHz).toBeLessThan(4000);
    expect(s.band.hiHz).toBeGreaterThan(4000);
    expect(r.margin).toBeGreaterThan(0.2);
    expect(r.verdict).toBe("good");
    expect(s.params.near_threshold).toBeLessThan(s.params.threshold);
  });
});
