/**
 * A sliding-window limiter held in memory: `max` hits per `windowMs` per key. Used for cheap, per-signed-in-user limits
 * (the PDF endpoints). A refused hit is not counted, so waiting always works. One process only: a limit that must be
 * shared between servers or survive a restart (sign-in attempts, email codes) lives in the database instead.
 */
export function createRateLimiter({ windowMs, max, now = () => Date.now(), sweepEvery = 200 }) {
  if (!Number.isInteger(windowMs) || windowMs < 1 || !Number.isInteger(max) || max < 1) throw new Error("windowMs and max must be positive integers");
  const hits = new Map(); // key -> timestamps, oldest first
  let calls = 0;

  function sweep(t) {
    for (const [key, times] of hits) {
      while (times.length && times[0] <= t - windowMs) times.shift();
      if (times.length === 0) hits.delete(key);
    }
  }

  return {
    /** -> { ok: true } or { ok: false, retryAfterSeconds } */
    hit(key) {
      const t = now();
      if (++calls % sweepEvery === 0) sweep(t);
      const times = hits.get(key) ?? [];
      while (times.length && times[0] <= t - windowMs) times.shift();
      if (times.length >= max) {
        hits.set(key, times);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((times[0] + windowMs - t) / 1000)) };
      }
      times.push(t);
      hits.set(key, times);
      return { ok: true };
    },
    size: () => hits.size,
  };
}
