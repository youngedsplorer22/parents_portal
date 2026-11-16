import { isIP } from "node:net";
import express from "express";
import helmet from "helmet";
import { createFrontend } from "./frontend.js";
import { createHealth } from "./health.js";
import { createErrorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { createAuthModule, requireSession } from "./modules/auth/index.js";
import { createWorkGate, defaultGateOptions } from "./modules/auth/work-gate.js";
import { createDriveClient } from "./modules/pdf-storage/drive-client.js";
import { createCatalogModule } from "./modules/catalog/index.js";
import { createEnrolmentsModule } from "./modules/enrolments/index.js";
import { createLiveLocationModule } from "./modules/live-location/index.js";
import { createMobileModule } from "./modules/mobile/index.js";
import { createEmailOtpModule } from "./modules/email-otp/index.js";
import { createOnboardingModule } from "./modules/onboarding/index.js";
import { createRegistrationsModule } from "./modules/registrations/index.js";
import { createStaffModule, requireRole, sameOriginForWrites } from "./modules/staff/index.js";

/** Builds the Express app. Everything environment-specific is passed in. */
export function createApp({ db, sender, config, clock, generateCode, logger, renderPdf, driveEndpoints, pdfLimits, frontendDist, healthTimeoutMs, healthCacheMs }) {
  const app = express();
  app.disable("x-powered-by");
  // How many reverse proxies in front of this server are trusted (0 = none). Express then takes the client address from
  // X-Forwarded-For counting that many entries from the RIGHT (the ones the trusted proxies added), so anything a caller
  // wrote further left is ignored. Every per-IP limit reads req.ip. X-Real-IP, Forwarded and X-Forwarded-Host are never used.
  app.set("trust proxy", config.trustProxyHops ?? 0);
  // If the forwarded value is not an IP address (garbage in X-Forwarded-For), the limiters would find "no address" and skip
  // their check. Fall back to the connection's own address so a bad header can only ever cost the caller, never help them.
  app.use((req, res, next) => {
    if (!isIP(req.ip ?? "") && req.socket?.remoteAddress) Object.defineProperty(req, "ip", { value: req.socket.remoteAddress, configurable: true });
    next();
  });
  // helmet's defaults, except images may come from any https host: the live map draws tiles from a tile server
  // (OpenStreetMap by default, or VITE_MAP_TILE_URL).
  app.use(helmet({
    contentSecurityPolicy: {
      directives: { "img-src": ["'self'", "data:", "https:"] },
    },
  }));

  const emailOtp = createEmailOtpModule({ db, sender, config: config.otp, clock, generateCode });

  // One gate for ALL password hashing (parents and staff share the same CPUs and worker threads).
  const passwordGate = createWorkGate(config.passwordHashing ?? defaultGateOptions());
  const auth = createAuthModule({ db, emailOtp: emailOtp.service, config: config.auth, sender, logger, gate: passwordGate });
  // Staff: separate identity, sessions and cookie from parents. Everything under /api/admin except
  // the login route needs a staff session; admin-only routes check the role again.
  const staff = createStaffModule({ db, config: config.staff, emailOtp: emailOtp.service, sender, logger, gate: passwordGate });
  const catalog = createCatalogModule({ db, config: config.staff, listAudit: staff.listAudit });
  const registrations = createRegistrationsModule({ db, emailOtp: emailOtp.service, sessions: auth.service, passwords: auth.service.passwords, catalog: catalog.service, cookie: config.auth });
  // The private Google Drive that keeps a copy of each submitted PDF. Null when it isn't configured: the portal then
  // works without it. `driveEndpoints` lets tests point the client at a fake Drive; production uses Google's own hosts.
  const pdfStorage = config.pdfStorage ?? { mode: "disabled", drive: null, missing: [], rootName: "Young Edsplorer" };
  const drive = pdfStorage.drive ? createDriveClient({ ...pdfStorage.drive, ...driveEndpoints }) : null;
  const onboarding = createOnboardingModule({
    db, requireSession: requireSession(auth.service), renderPdf, logger, pdfRendering: config.pdfRendering,
    drive, driveRootName: pdfStorage.rootName, pdfStorageNote: { mode: pdfStorage.mode, missing: pdfStorage.missing }, limits: pdfLimits,
  });
  const enrolments = createEnrolmentsModule({ db, catalog: catalog.service, requireSession: requireSession(auth.service) });
  const liveLocation = createLiveLocationModule({ db, catalog: catalog.service, requireSession: requireSession(auth.service), policy: config.liveLocation?.policy, limits: config.liveLocation?.limits });

  const mobile = createMobileModule({ auth: auth.service, liveLocation: liveLocation.service, limits: config.mobile?.limits });

  const admin = express.Router();
  admin.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  admin.use(sameOriginForWrites);
  admin.use(express.json({ limit: "8kb", inflate: false }));
  admin.use("/auth", staff.authRouter);
  admin.use(staff.requireStaff);
  admin.use("/staff", requireRole("admin"), staff.adminRouter);
  admin.use(catalog.adminRouter);
  admin.use(liveLocation.staffRouter);

  // Defence in depth on top of SameSite=Strict cookies, for EVERY API write (parents' as well as staff): a state-changing
  // request that carries an Origin header must come from this same host. Non-browser clients send no Origin and pass.
  app.use("/api", sameOriginForWrites);

  // /api/health and /api/health/live: the process answers. /api/health/ready: the database answers and we are not shutting down.
  const health = createHealth({ db, timeoutMs: healthTimeoutMs, cacheMs: healthCacheMs });
  app.use("/api/health", health.router);
  app.use(emailOtp.mountPath, emailOtp.router);
  app.use(registrations.mountPath, registrations.router);
  app.use(auth.mountPath, auth.router);
  app.use(onboarding.mountPath, onboarding.router);
  app.use(enrolments.mountPath, enrolments.router);
  app.use(liveLocation.mountPath, liveLocation.router);
  app.use(mobile.mountPath, mobile.router);
  app.use("/api/admin", admin);
  app.use("/api/join", catalog.joinRouter);
  app.use("/api/school-logos", catalog.logoRouter);

  // The built frontend (production). It answers only what the API did not, and /api/* stays JSON.
  if (frontendDist) app.use(createFrontend({ distDir: frontendDist }));
  app.use(notFoundHandler);
  app.use(createErrorHandler({ logger }));

  return { app, lifecycle: { beginShutdown: health.beginShutdown }, health, services: { staff: staff.service, catalog: catalog.service, emailOtp: emailOtp.service, registrations: registrations.service, auth: auth.service, onboarding: onboarding.service, enrolments: enrolments.service, liveLocation: liveLocation.service, passwordGate } };
}
