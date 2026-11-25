// TS template builder vs make_template.py logic (same synth signal + labels):
// int8 template must match up to 1 LSB on at most 1% of values.
import { describe, expect, it } from "vitest";
import { loadFixtures, tsBuiltTemplate, wasmReady } from "./helpers";

describe("ts template builder vs make_template.py", () => {
  it("matches the reference quantised template", async () => {
    await wasmReady();
    const fx = loadFixtures();
    const { q, alignedStarts } = tsBuiltTemplate(fx);
    expect(q.length).toBe(fx.tmpl.length);
    let diff1 = 0, diffMore = 0;
    for (let i = 0; i < q.length; i++) {
      const d = Math.abs(q[i] - fx.tmpl[i]);
      if (d === 1) diff1++;
      else if (d > 1) diffMore++;
    }
    const pct = ((diff1 + diffMore) / q.length) * 100;
    console.log(`template: ${q.length} values, ${diff1} differ by 1 LSB, ${diffMore} differ by more (${pct.toFixed(3)}% total)`);
    console.log(`aligned starts (frames): ${alignedStarts.join(",")}`);
    expect(diffMore).toBe(0);
    expect(pct).toBeLessThanOrEqual(1);
  });
});
