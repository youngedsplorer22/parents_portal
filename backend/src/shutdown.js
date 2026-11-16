/**
 * SIGTERM/SIGINT handler. Order: readiness goes 503 -> stop accepting connections -> stop background timers -> let
 * in-flight requests finish for `graceMs` -> drop whatever is still open -> close the database pool -> exit.
 * Exit code 0 when everything finished on its own, 1 when something had to be forced. Runs once however often it is called.
 */
export function createShutdown({ server, db, health, timers = [], graceMs = 10000, log = console, exit = process.exit }) {
  let running = null;

  return function shutdown(signal) {
    running ??= (async () => {
      let forced = false;
      log.log(`[shutdown] ${signal ?? "signal"} received: draining.`);
      health?.beginShutdown();
      for (const t of timers) clearInterval(t);

      const closed = new Promise((resolve) => server.close(resolve));
      // Keep-alive connections that go idle AFTER the first sweep (their request just finished) would hold the server open
      // until the grace period ended, so sweep repeatedly while draining.
      server.closeIdleConnections?.();
      const sweep = setInterval(() => server.closeIdleConnections?.(), 100);
      let graceTimer;
      const gracePassed = new Promise((resolve) => { graceTimer = setTimeout(() => resolve("grace"), graceMs); });
      if ((await Promise.race([closed.then(() => "closed"), gracePassed])) === "grace") {
        forced = true;
        log.error(`[shutdown] requests still open after ${graceMs} ms: closing them.`);
        server.closeAllConnections?.();
        await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
      }
      clearTimeout(graceTimer);
      clearInterval(sweep);

      let poolTimer;
      const poolClosed = await Promise.race([
        Promise.resolve().then(() => db.end()).then(() => true, () => false),
        new Promise((resolve) => { poolTimer = setTimeout(() => resolve(false), Math.min(graceMs, 5000)); }),
      ]);
      clearTimeout(poolTimer);
      if (!poolClosed) { forced = true; log.error("[shutdown] the database pool did not close in time."); }

      log.log(`[shutdown] done${forced ? " (forced)" : ""}.`);
      exit(forced ? 1 : 0);
    })();
    return running;
  };
}
