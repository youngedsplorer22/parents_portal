import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHealth } from "../src/health.js";

describe("readiness is cheap to hammer", () => {
  it("many concurrent calls share one database query, and a short cache absorbs the next ones", async () => {
    let n = 0;
    let t = 1000;
    const health = createHealth({ db: { query: async () => { n++; await new Promise((r) => setTimeout(r, 20)); return { rows: [] }; } }, timeoutMs: 500, cacheMs: 1000, now: () => t });
    const results = await Promise.all(Array.from({ length: 50 }, () => health.checkReady()));
    assert.ok(results.every((r) => r === true));
    assert.equal(n, 1);
    await health.checkReady();
    assert.equal(n, 1, "cached");
    t += 1500;
    await health.checkReady();
    assert.equal(n, 2);
  });

  it("a shutdown answer is never cached as ready", async () => {
    const health = createHealth({ db: { query: async () => ({ rows: [] }) }, timeoutMs: 500, cacheMs: 60000 });
    assert.equal(await health.checkReady(), true);
    health.beginShutdown();
    assert.equal(await health.checkReady(), false);
  });
});
