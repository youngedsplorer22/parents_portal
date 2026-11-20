import { Router } from "express";

/**
 * Liveness: the process answers (never touches the database, so a database outage does not make the platform restart a
 * healthy server). Readiness: the database answers within a short time AND the server is not shutting down.
 * Answers are bare {status} bodies: no error text, host, version or counts. Readiness shares one query between concurrent
 * callers and remembers the answer briefly, so an unauthenticated caller cannot turn it into database load.
 */
export function createHealth({ db, timeoutMs = 2000, cacheMs = 1000, now = () => Date.now() }) {
  let shuttingDown = false;
  let cached = null; // { ok, at }
  let inflight = null;

  const probe = () => {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const query = Promise.resolve().then(() => db.query("SELECT 1")).then(() => true, () => false);
    return Promise.race([query, timeout]).finally(() => clearTimeout(timer));
  };

  async function checkReady() {
    if (shuttingDown) return false;
    if (cached && now() - cached.at < cacheMs) return cached.ok;
    inflight ??= probe().then((ok) => { cached = { ok, at: now() }; return ok; }).finally(() => { inflight = null; });
    const ok = await inflight;
    return shuttingDown ? false : ok;
  }

  const router = Router();
  router.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const live = (req, res) => res.json({ status: "ok" });
  router.get("/", live);
  router.get("/live", live);
  router.get("/ready", async (req, res) => {
    const ok = await checkReady();
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "unavailable" });
  });

  return { router, checkReady, beginShutdown: () => { shuttingDown = true; } };
}
