import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { createSender } from "./create-sender.js";
import { createPool } from "./db/pool.js";
import { listen } from "./listen.js";
import { createShutdown } from "./shutdown.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const sender = createSender(config);

// Fail fast on bad SMTP settings instead of discovering them on the first registration.
if (sender.verify) {
  try {
    await sender.verify();
    console.log(`SMTP connection to ${config.smtp.host}:${config.smtp.port} verified.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

const db = createPool(config.databaseUrl, config.db);

// The built frontend: on in production (a missing build is a deployment mistake, so fail now rather than serve a blank
// site), off in development where the Vite dev server serves it and proxies /api.
let frontendDist;
if (config.serveFrontend) {
  frontendDist = config.frontendDist ? path.resolve(config.frontendDist) : fileURLToPath(new URL("../../../packages/web-core/dist", import.meta.url));
  if (!existsSync(path.join(frontendDist, "index.html"))) {
    console.error("SERVE_FRONTEND is on but the frontend build was not found (index.html is missing). Run `npm run build` at the repository root first.");
    process.exit(1);
  }
}
if (config.nodeEnv === "production" && config.trustProxyHops === 0) {
  console.warn("TRUST_PROXY_HOPS is 0: behind a reverse proxy (Railway) every visitor shares the proxy's address, so per-IP limits will treat everyone as one client. Set TRUST_PROXY_HOPS=1 on Railway.");
}
const { app, services, lifecycle } = createApp({ db, sender, config, frontendDist });

// Development and test listen on this machine only (127.0.0.1) unless HOST says otherwise; production listens on every
// interface so the hosting platform can reach it (see config.js and listen.js).
const server = listen(app, config, () => {
  console.log(config.host ? `Parents Portal backend on http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}` : `Parents Portal backend listening on all interfaces, port ${config.port}`);
  // Say plainly WHICH database and WHICH delivery mode this process is using (names only, never credentials),
  // so a stray or stale backend can be recognised at a glance.
  const dbUrl = new URL(config.databaseUrl);
  console.log(`Database: ${decodeURIComponent(dbUrl.pathname.slice(1))} on ${dbUrl.hostname}:${dbUrl.port || "5432"}. Environment: ${config.nodeEnv}.`);
  console.log(
    sender.mode === "smtp"
      ? `OTP delivery: smtp via ${config.smtp.host}. Codes are emailed and never logged.`
      : "OTP delivery: dev-console. No email is sent; codes are printed in this terminal.",
  );
});

// Say plainly where submitted PDFs are kept (never a credential): a missing setting is named, and the portal runs without it.
const storage = services.onboarding.pdfStorageInfo();
if (storage.configured) {
  console.log(`PDF storage: Google Drive, destination account ${storage.destination}. A copy of each submitted registration PDF is kept there, privately.`);
} else if (storage.mode === "google-drive") {
  console.warn(`PDF storage: PDF_STORAGE=google-drive but ${storage.missing.join(", ")} ${storage.missing.length === 1 ? "is" : "are"} not set, so nothing is stored in Google Drive yet. The portal works without it; see GOOGLE_DRIVE_SETUP.md.`);
} else {
  console.log("PDF storage: off (PDF_STORAGE=disabled). PDFs are made on request and nothing is saved to Google Drive.");
}

// A second backend on the same port used to die with a raw stack trace while the OLD one kept answering,
// which is easy to mistake for "the new settings don't work". Say exactly what is wrong instead.
server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(
      `Port ${config.port} is already in use by another process. That process, not this one, is answering requests on this port ` +
        "(it may be an old or test backend with different settings). Stop it, then start this backend again.",
    );
  } else {
    console.error(`The server could not start: ${err?.code ?? err?.message}`);
  }
  db.end().finally(() => process.exit(1));
});

// Housekeeping: expired sessions and old sign-in attempt rows are deleted hourly (they were only ever cleaned when
// something else happened to run). It never blocks a request and a failure is logged by message only.
const HOUSEKEEPING_MS = 60 * 60 * 1000;
async function housekeeping() {
  for (const [name, service] of [["parent sessions", services.auth], ["staff sessions", services.staff], ["live locations", services.liveLocation]]) {
    try {
      await service.purgeExpired();
    } catch (err) {
      console.error(`[housekeeping] ${name}: ${err?.code ?? ""} ${err?.message ?? err}`);
    }
  }
}
const housekeepingTimer = setInterval(housekeeping, HOUSEKEEPING_MS);
housekeepingTimer.unref(); // never keeps the process alive on its own
housekeeping();

// Every minute: store the PDF copies that are still missing or failed and are due for another try (a few at a time,
// with back-off per registration), so a Drive outage or a fixed setting heals by itself without anyone resubmitting.
const PDF_SWEEP_MS = 60 * 1000;
async function sweepPdfStorage() {
  try {
    await services.onboarding.sweepPdfStorage({ limit: 5 });
  } catch (err) {
    console.error(`[pdf-storage] sweep: ${err?.code ?? ""} ${err?.message ?? err}`);
  }
}
const pdfSweepTimer = setInterval(sweepPdfStorage, PDF_SWEEP_MS);
pdfSweepTimer.unref();
setTimeout(sweepPdfStorage, 5000).unref();

// Graceful stop (Railway sends SIGTERM on every deploy): readiness turns 503, in-flight requests finish (up to
// SHUTDOWN_GRACE_MS), then the pool closes. A second signal does nothing extra.
const shutdown = createShutdown({ server, db, health: lifecycle, timers: [housekeepingTimer, pdfSweepTimer], graceMs: config.shutdownGraceMs });
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
