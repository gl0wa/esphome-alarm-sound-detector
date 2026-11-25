// Fast repeating beeps (5 × 0.55 s at 4 kHz, one per second, twice in one
// recording): "Find similar" must list every beep and "Estimate repetition"
// must find the 1 s period despite the long gap between the two alarms.
import { describe, expect, it } from "vitest";
import { findSimilar } from "../src/similar";
import { freshState } from "../src/store";
import { estimatePeriod } from "../src/template";
import { wasmReady } from "./helpers";

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
