import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkGate, defaultGateOptions } from "../src/modules/auth/work-gate.js";

// A job the test finishes by hand, so concurrency can be observed exactly.
function controllable() {
  const jobs = [];
  const job = (name) => () =>
    new Promise((resolve, reject) => {
      jobs.push({ name, resolve, reject });
    });
  const tick = () => new Promise((r) => setImmediate(r));
  return { jobs, job, tick };
}

describe("work gate (bounds password-hashing work)", () => {
  it("runs at most `concurrency` jobs at once and starts the rest in arrival order", async () => {
    const gate = createWorkGate({ concurrency: 2, maxQueue: 5 });
    const { jobs, job, tick } = controllable();
    const done = ["a", "b", "c", "d"].map((n) => {
      const t = gate.reserve();
      return t.run(job(n)).finally(() => t.release());
    });
    await tick();
    assert.deepEqual(jobs.map((j) => j.name), ["a", "b"]);
    assert.deepEqual(gate.stats(), { running: 2, waiting: 2, admitted: 4 });
    jobs[1].resolve();
    await tick();
    assert.deepEqual(jobs.map((j) => j.name), ["a", "b", "c"]);
    jobs[0].resolve();
    await tick();
    assert.deepEqual(jobs.map((j) => j.name), ["a", "b", "c", "d"]);
    jobs[2].resolve();
    jobs[3].resolve();
    await Promise.all(done);
    assert.deepEqual(gate.stats(), { running: 0, waiting: 0, admitted: 0 });
  });

  it("admits at most concurrency + maxQueue at a time, refusing the rest at once instead of queueing forever", () => {
    const gate = createWorkGate({ concurrency: 2, maxQueue: 1 });
    const held = [gate.reserve(), gate.reserve(), gate.reserve()];
    assert.ok(held.every(Boolean));
    assert.equal(gate.reserve(), null);
    held[0].release();
    const again = gate.reserve();
    assert.ok(again);
    assert.equal(gate.reserve(), null);
  });

  it("release is idempotent: releasing twice never frees someone else's place", () => {
    const gate = createWorkGate({ concurrency: 1, maxQueue: 0 });
    const t = gate.reserve();
    t.release();
    t.release();
    assert.equal(gate.stats().admitted, 0);
    const other = gate.reserve();
    t.release();
    assert.equal(gate.stats().admitted, 1);
    assert.equal(gate.reserve(), null, "the other ticket still holds the only place");
    other.release();
  });

  it("a job that fails still frees its worker slot, and the error reaches the caller", async () => {
    const gate = createWorkGate({ concurrency: 1, maxQueue: 1 });
    const a = gate.reserve();
    const b = gate.reserve();
    await assert.rejects(a.run(async () => {
      throw new Error("boom");
    }), /boom/);
    assert.equal(await b.run(async () => "ok"), "ok");
    a.release();
    b.release();
    assert.deepEqual(gate.stats(), { running: 0, waiting: 0, admitted: 0 });
  });

  it("one ticket can run several jobs in turn (verify the old password, then hash the new one)", async () => {
    const gate = createWorkGate({ concurrency: 1, maxQueue: 0 });
    const t = gate.reserve();
    assert.equal(await t.run(async () => 1), 1);
    assert.equal(await t.run(async () => 2), 2);
    t.release();
  });

  it("a released ticket can't start new work", async () => {
    const gate = createWorkGate({ concurrency: 1, maxQueue: 0 });
    const t = gate.reserve();
    t.release();
    await assert.rejects(t.run(async () => 1), /released/);
  });

  it("estimates a short, bounded retry delay from how long jobs take and how many are ahead", async () => {
    let now = 0;
    const gate = createWorkGate({ concurrency: 2, maxQueue: 10, now: () => now });
    assert.equal(gate.retryAfterSeconds(), 1, "with no history, ask for a quick retry");
    const t = gate.reserve();
    await t.run(async () => {
      now += 2000; // a 2-second job
    });
    t.release();
    const held = Array.from({ length: 12 }, () => gate.reserve());
    // 12 admitted, 2 at a time, about 2 s each: about 12 s of work ahead
    assert.equal(gate.retryAfterSeconds(), 12);
    now += 0;
    held.forEach((h) => h.release());
    const slow = createWorkGate({ concurrency: 1, maxQueue: 100, now: () => now });
    const s = slow.reserve();
    await s.run(async () => {
      now += 60_000;
    });
    s.release();
    Array.from({ length: 100 }, () => slow.reserve());
    assert.equal(slow.retryAfterSeconds(), 30, "never more than 30 s");
  });

  it("refuses nonsensical limits", () => {
    for (const bad of [{ concurrency: 0, maxQueue: 1 }, { concurrency: 1.5, maxQueue: 1 }, { concurrency: 1, maxQueue: -1 }, { concurrency: 1, maxQueue: 0.5 }]) {
      assert.throws(() => createWorkGate(bad), /concurrency|maxQueue/);
    }
  });

  it("by default leaves one libuv worker thread free (for DNS lookups and files) and never exceeds the CPU count", () => {
    assert.deepEqual(defaultGateOptions({ cpus: 4, threadpool: 4 }), { concurrency: 3, maxQueue: 24 });
    assert.deepEqual(defaultGateOptions({ cpus: 2, threadpool: 4 }), { concurrency: 2, maxQueue: 16 });
    assert.deepEqual(defaultGateOptions({ cpus: 16, threadpool: 8 }), { concurrency: 7, maxQueue: 56 });
    assert.deepEqual(defaultGateOptions({ cpus: 1, threadpool: 1 }), { concurrency: 1, maxQueue: 8 });
  });
});
