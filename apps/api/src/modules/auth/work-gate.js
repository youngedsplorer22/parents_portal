import { availableParallelism } from "node:os";

/**
 * Bounds how much password-hashing work the server takes on at once.
 *
 * scrypt runs on libuv's small shared worker pool (4 threads by default), which DNS lookups (including the database
 * host "localhost") and file access also use. Unbounded, a burst of sign-ins fills that pool's queue: every other job
 * waits behind all of them, and each sign-in waits minutes instead of being told to come back. The gate keeps at most
 * `concurrency` jobs on the pool and at most `maxQueue` more waiting here, and refuses the rest straight away.
 *
 * A caller reserves a place (a ticket) before doing anything that could cost work, runs one or more jobs with it, and
 * releases it when done. The hashing cost itself is untouched.
 */
export function createWorkGate({ concurrency, maxQueue, now = () => performance.now() }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new Error("maxQueue must be a non-negative integer");

  let admitted = 0;
  let running = 0;
  const waiting = []; // resolvers, first come first served
  let averageMs = null;

  const startNext = () => {
    while (running < concurrency && waiting.length > 0) {
      running++;
      waiting.shift()();
    }
  };

  async function runJob(fn) {
    await new Promise((resolve) => {
      waiting.push(resolve);
      startNext();
    });
    const started = now();
    try {
      return await fn();
    } finally {
      const ms = now() - started;
      averageMs = averageMs === null ? ms : averageMs * 0.8 + ms * 0.2;
      running--;
      startNext();
    }
  }

  /** -> a ticket, or null when the gate is full (the caller answers "busy, retry shortly"). */
  function reserve() {
    if (admitted >= concurrency + maxQueue) return null;
    admitted++;
    let released = false;
    return {
      run(fn) {
        if (released) return Promise.reject(new Error("ticket already released"));
        return runJob(fn);
      },
      release() {
        if (released) return;
        released = true;
        admitted--;
      },
    };
  }

  /** Roughly how long until a retry could be admitted: the work ahead, at the observed speed. 1-30 seconds. */
  function retryAfterSeconds() {
    if (averageMs === null) return 1;
    const seconds = Math.ceil((averageMs * admitted) / concurrency / 1000);
    return Math.min(30, Math.max(1, seconds));
  }

  const stats = () => ({ running, waiting: waiting.length, admitted });

  return { reserve, retryAfterSeconds, stats };
}

/**
 * Defaults: one job per CPU, but always one libuv worker thread left free so DNS lookups and file access never queue
 * behind hashing; and a queue of 8 per worker, which at production cost (about 0.4 s per hash) is a few seconds' wait.
 */
export function defaultGateOptions({
  cpus = availableParallelism(),
  threadpool = Number(process.env.UV_THREADPOOL_SIZE) || 4,
} = {}) {
  const concurrency = Math.max(1, Math.min(cpus, threadpool - 1));
  return { concurrency, maxQueue: concurrency * 8 };
}
