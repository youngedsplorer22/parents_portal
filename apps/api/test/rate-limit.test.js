import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateLimiter } from "../src/middleware/rate-limit.js";

describe("in-memory rate limiter", () => {
  it("allows `max` hits per window per key, then refuses with a retry delay, and recovers as the window slides", () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3, now: () => now });
    assert.deepEqual([1, 2, 3].map(() => limiter.hit("a").ok), [true, true, true]);
    const refused = limiter.hit("a");
    assert.equal(refused.ok, false);
    assert.equal(refused.retryAfterSeconds, 60);
    now += 30_000;
    assert.equal(limiter.hit("a").retryAfterSeconds, 30, "the delay shrinks as the oldest hit ages");
    now += 30_001;
    assert.equal(limiter.hit("a").ok, true);
  });

  it("keys are independent, and a refused hit is not counted (waiting works)", () => {
    let now = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => now });
    assert.equal(limiter.hit("a").ok, true);
    assert.equal(limiter.hit("b").ok, true);
    for (let i = 0; i < 50; i++) assert.equal(limiter.hit("a").ok, false);
    now += 1001;
    assert.equal(limiter.hit("a").ok, true, "50 refused attempts did not extend the lock");
  });

  it("forgets idle keys, so memory doesn't grow without bound", () => {
    let now = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 5, now: () => now, sweepEvery: 10 });
    for (let i = 0; i < 100; i++) limiter.hit(`user-${i}`);
    assert.equal(limiter.size(), 100);
    now += 5000;
    for (let i = 0; i < 10; i++) limiter.hit("fresh");
    assert.ok(limiter.size() <= 2, `still holding ${limiter.size()} keys`);
  });

  it("refuses nonsensical settings", () => {
    for (const bad of [{ windowMs: 0, max: 1 }, { windowMs: 1000, max: 0 }, { windowMs: 1.5, max: 1 }]) assert.throws(() => createRateLimiter(bad));
  });
});
