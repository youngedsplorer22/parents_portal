import { isIP } from "node:net";
import { z } from "zod";
import { DatabaseTargetError, assertLocalDatabaseUrl as assertLocalTarget, resolveDatabaseTarget } from "./db/target.js";
import { defaultGateOptions } from "./modules/auth/work-gate.js";
import { missingLinkHosts } from "./modules/catalog/public-url.js";
import { PAYMENT_MODES, TOUR_TYPES } from "./modules/catalog/validation.js";

const int = (fallback, min, max) => z.coerce.number().int().min(min).max(max).default(fallback);
const required = { error: "is required" };
const noControlChars = (s) => !/[\u0000-\u001f\u007f]/.test(s);
// An optional credential: unset or empty -> undefined. Messages never repeat the value.
const optionalSecret = () =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().max(2000).refine(noControlChars, "must not contain control characters").optional());
// Unset or empty -> undefined (an empty value must never silently become 0).
const optionalInt = (min, max) =>
  z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(min).max(max).optional());

// An http(s) origin only (no path, query, fragment or credentials). Leading and trailing whitespace is trimmed; unset, empty
// or whitespace-only -> undefined. Whitespace, tabs or line breaks INSIDE the value are refused. Messages never echo the value.
const originUrl = () =>
  z
    .string()
    .optional()
    .transform((v) => {
      const t = v?.trim();
      return t === undefined || t === "" ? undefined : t;
    })
    .refine((v) => v === undefined || !/[\s\u0000-\u001f\u007f]/.test(v), "must not contain spaces, tabs or line breaks")
    .refine((v) => {
      if (v === undefined) return true;
      try {
        const u = new URL(v);
        return /^https?:$/.test(u.protocol) && u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password;
      } catch {
        return false;
      }
    }, "must be an http(s) origin only, such as https://parents.example.com");
// The existing template keys (the trips.template_key values: tour type + "_" + payment mode), and the variable per key.
const TEMPLATE_KEYS = TOUR_TYPES.flatMap((tourType) => PAYMENT_MODES.map((paymentMode) => `${tourType}_${paymentMode}`));
const variantEnvName = (templateKey) => `PUBLIC_BASE_URL_${templateKey.toUpperCase()}`;
const portalSecretEnvName = (templateKey) => `PORTAL_PROXY_SECRET_${templateKey.toUpperCase()}`;
// The key a public portal's web server (apps/web-server) sends with every API call, so the API knows which of the four portals
// a request really came from. A long random value, different for each portal. Never put one in a frontend or a commit.
const portalSecret = () =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().min(32, "must be at least 32 characters").max(200).regex(/^[A-Za-z0-9_\-+/=.~]+$/, "may only contain letters, digits and _-+/=.~").optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(4000, 1, 65535),
  // Optional. The address to listen on (an IP address). Unset: development and test listen on this machine only
  // (127.0.0.1); production listens on every interface, which is what a hosting platform needs to reach it.
  HOST: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().refine((v) => isIP(v) !== 0, "must be an IP address such as 0.0.0.0 or 127.0.0.1").optional(),
  ),
  DATABASE_URL: z.string(required).min(1, "is required"),
  // How many reverse proxies sit in FRONT of this server and are trusted to append the client's address to
  // X-Forwarded-For. 0 (default): none, the connection address is the client (right for local development). Railway: 1.
  // Only the entries those proxies added are trusted; anything a client put further left is ignored.
  TRUST_PROXY_HOPS: int(0, 0, 5),
  // Database pool. Timeouts are in milliseconds. 0 turns a timeout off and is refused for the ones that protect the pool.
  DB_POOL_MAX: int(10, 1, 50),
  DB_CONNECTION_TIMEOUT_MS: int(5000, 500, 60000),
  DB_IDLE_TIMEOUT_MS: int(30000, 1000, 600000),
  DB_STATEMENT_TIMEOUT_MS: int(15000, 500, 120000),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: int(30000, 1000, 300000),
  // After SIGTERM: how long in-flight requests get to finish before connections are closed.
  SHUTDOWN_GRACE_MS: int(10000, 1000, 120000),
  // Serve the built frontend (frontend/dist) from this server. Default: on in production, off elsewhere (development uses
  // the Vite dev server and its /api proxy). FRONTEND_DIST overrides the folder.
  SERVE_FRONTEND: z.enum(["true", "false"], { error: 'must be "true" or "false"' }).optional(),
  FRONTEND_DIST: z.preprocess((v) => (v === "" ? undefined : v), z.string().max(500).refine(noControlChars, "must not contain control characters").optional()),
  OTP_HMAC_SECRET: z.string(required).regex(/^[0-9a-fA-F]{64,}$/, "must be at least 64 hex characters (openssl rand -hex 32)"),
  // No default on purpose: the delivery method must be chosen explicitly, so a
  // missing or mistyped value can never silently become console mode.
  OTP_DELIVERY: z.enum(["dev-console", "smtp"], { error: 'must be "dev-console" or "smtp"' }),
  OTP_TTL_SECONDS: int(300, 5, 600),
  // Staff first-time-setup / forgot-password codes live longer than the parents' (15 minutes by default).
  STAFF_OTP_TTL_SECONDS: int(900, 60, 1800),
  OTP_RESEND_COOLDOWN_SECONDS: int(30, 1, 3600),
  OTP_MAX_ATTEMPTS: int(5, 1, 20),
  OTP_MAX_SENDS_PER_EMAIL_PER_HOUR: int(5, 1, 100),
  OTP_MAX_SENDS_PER_IP_PER_HOUR: int(20, 1, 1000),
  VERIFICATION_TOKEN_TTL_SECONDS: int(900, 30, 86400),
  // Sign-in lifetimes (see AUTH_SESSIONS.md). SESSION_TTL_SECONDS / STAFF_SESSION_TTL_SECONDS are the ABSOLUTE end of
  // a sign-in (never extended); the access token is short; the inactivity limit is how long a sign-in survives unused.
  SESSION_TTL_SECONDS: int(604800, 300, 2592000),
  STAFF_SESSION_TTL_SECONDS: int(28800, 300, 604800),
  // Optional: when unset, the default is used, capped so it fits inside the limit above it.
  PARENT_ACCESS_TOKEN_TTL_SECONDS: optionalInt(60, 3600),
  PARENT_SESSION_IDLE_TIMEOUT_SECONDS: optionalInt(300, 2592000),
  STAFF_ACCESS_TOKEN_TTL_SECONDS: optionalInt(60, 3600),
  STAFF_SESSION_IDLE_TIMEOUT_SECONDS: optionalInt(300, 604800),
  // A refresh token presented again within this many seconds of being used is treated as two tabs racing (answered
  // "already renewed", nothing issued); later than that it is a replay and ends the sign-in.
  REFRESH_REUSE_GRACE_SECONDS: int(20, 0, 120),
  JOIN_LOOKUPS_PER_MINUTE: int(30, 1, 10000),
  // "true": a registration template with no row in portal_deployments (no trip bound to it) accepts NO new registrations.
  // Unset or "false": such a template behaves as before (development and tests only). Production REQUIRES "true": the server
  // refuses to start in production without it.
  PORTAL_BINDING_REQUIRED: z.enum(["true", "false"], { error: 'must be "true" or "false"' }).optional(),
  // Optional. Where parents open links, e.g. https://parents.example.com. If unset, staff get the path only.
  PUBLIC_BASE_URL: originUrl(),
  // Optional, one per template key (trips.template_key): the origin of the portal that serves that variant. A link for a
  // trip uses its own variant's origin; a variant with none set falls back to PUBLIC_BASE_URL. Same rules as PUBLIC_BASE_URL.
  ...Object.fromEntries(TEMPLATE_KEYS.map((key) => [variantEnvName(key), originUrl()])),
  // One secret per public portal (see portalSecret). With PORTAL_BINDING_REQUIRED=true a registration is accepted only from a
  // portal whose secret matches, and only for the trip bound to that portal.
  ...Object.fromEntries(TEMPLATE_KEYS.map((key) => [portalSecretEnvName(key), portalSecret()])),
  PASSWORD_LOGIN_WINDOW_SECONDS: int(900, 60, 86400),
  PASSWORD_LOGIN_MAX_ATTEMPTS_PER_EMAIL: int(5, 1, 100),
  PASSWORD_LOGIN_MAX_ATTEMPTS_PER_IP: int(20, 1, 1000),
  // Optional. How many password hashes may run at once, and how many more may wait, before sign-ins are told
  // "busy, retry shortly" (503). Unset: sized from the machine (see modules/auth/work-gate.js).
  // Where submitted registration PDFs are kept. "disabled" (the default): nothing is stored anywhere and a PDF is made
  // on request. "google-drive": stored in the destination Google account's Drive (see GOOGLE_DRIVE_SETUP.md). The
  // credentials below are optional so a missing one can never stop the portal; the parts that are missing are listed
  // at startup (by name only) and storage simply stays unconfigured until they are set.
  PDF_STORAGE: z.enum(["disabled", "google-drive"], { error: 'must be "disabled" or "google-drive"' }).default("disabled"),
  GOOGLE_OAUTH_CLIENT_ID: optionalSecret(),
  GOOGLE_OAUTH_CLIENT_SECRET: optionalSecret(),
  GOOGLE_DRIVE_REFRESH_TOKEN: optionalSecret(),
  GOOGLE_DRIVE_ACCOUNT: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().trim().max(254).regex(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/, "must be an email address").transform((v) => v.toLowerCase()).optional(),
  ),
  GOOGLE_DRIVE_ROOT_FOLDER_NAME: z
    .string()
    .trim()
    .min(1)
    .max(80, "must be 80 characters or fewer")
    .regex(/^[^/\\\u0000-\u001f\u007f]+$/, "must not contain slashes or control characters")
    .default("Young Edsplorer"),
  PASSWORD_HASH_CONCURRENCY: optionalInt(1, 64),
  PASSWORD_HASH_QUEUE: optionalInt(0, 10000),
  // Production only: a database on another host (Railway's PostgreSQL) is used ONLY when this is exactly "true"
  // (see db/target.js). The value itself is checked there, so a typo is refused, not ignored.
  ALLOW_PRODUCTION_DATABASE: z.string().optional(),
  // Must stay unset in production (the server refuses to start otherwise): it is the local test database setting.
  TEST_DATABASE_URL: z.string().optional(),
  // Which of the four portal deployment template keys this staff portal serves. The API looks up portal_deployments for
  // this key to find the trip that all authenticated Sales accounts may access. Unset: trip list is empty.
  STAFF_DEPLOYMENT_TEMPLATE_KEY: z.enum(["domestic_payment", "domestic_none", "international_payment", "international_none"]).optional(),
});


const smtpSchema = z.object({
  SMTP_HOST: z.string(required).regex(/^(?:\[::1\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)$/, "must be a hostname"),
  SMTP_PORT: z.coerce.number(required).int().min(1).max(65535),
  SMTP_SECURE: z.enum(["true", "false"], { error: 'must be "true" or "false"' }).transform((v) => v === "true"),
  SMTP_USER: z.string(required).min(1, "is required").max(320).refine(noControlChars, "must not contain control characters"),
  SMTP_PASSWORD: z.string(required).min(1, "is required").max(512).refine(noControlChars, "must not contain control characters"),
  SMTP_FROM: z
    .string(required)
    .max(320)
    .refine(noControlChars, "must not contain control characters")
    .regex(
      /^(?:[^<>"]{1,100}<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)$/,
      'must be an address ("no-reply@example.com") or "Name <no-reply@example.com>"',
    ),
});

export class ConfigError extends Error {}

/**
 * Refuses any database that is not on this machine (e.g. a shared or ERP server). For the local tools; the server itself
 * uses resolveDatabaseTarget, which also allows an explicitly approved production database.
 */
export function assertLocalDatabaseUrl(connectionString, label = "DATABASE_URL") {
  try {
    assertLocalTarget(connectionString, label);
  } catch (err) {
    throw err instanceof DatabaseTargetError ? new ConfigError(err.message) : err;
  }
}

const issueLines = (error) => error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);

/** Values are never echoed in error messages, only variable names and rules. */
export function loadConfig(env = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment configuration:\n${issueLines(parsed.error).join("\n")}`);
  }
  const e = parsed.data;

  // Which database this process may use (a local one; or, in production only and on purpose, another host's).
  try {
    resolveDatabaseTarget({ ...env, NODE_ENV: e.NODE_ENV });
  } catch (err) {
    throw err instanceof DatabaseTargetError ? new ConfigError(err.message) : err;
  }
  // Explicit values must nest; a value left unset takes its default, capped to fit (so setting only the absolute
  // limit, as before this change, keeps working).
  const lifetimes = (who, accessSet, idleSet, absolute, defaults) => {
    const idle = idleSet ?? Math.min(defaults.idle, absolute);
    const access = accessSet ?? Math.min(defaults.access, idle);
    if (!(access <= idle && idle <= absolute)) {
      throw new ConfigError(`Invalid ${who} sign-in lifetimes: the access token (${access}s) must not outlast the inactivity limit (${idle}s), and that must not outlast the absolute limit (${absolute}s).`);
    }
    return { access, idle };
  };
  const parentLife = lifetimes("parent", e.PARENT_ACCESS_TOKEN_TTL_SECONDS, e.PARENT_SESSION_IDLE_TIMEOUT_SECONDS, e.SESSION_TTL_SECONDS, { access: 900, idle: 900 });
  const staffLife = lifetimes("staff", e.STAFF_ACCESS_TOKEN_TTL_SECONDS, e.STAFF_SESSION_IDLE_TIMEOUT_SECONDS, e.STAFF_SESSION_TTL_SECONDS, { access: 900, idle: 7200 });

  // An empty SMTP_* value counts as "not set".
  const smtpEnv = Object.fromEntries(
    Object.entries(env).filter(([k, v]) => k.startsWith("SMTP_") && typeof v === "string" && v !== ""),
  );

  let smtp = null;
  if (e.OTP_DELIVERY === "smtp") {
    const s = smtpSchema.safeParse(smtpEnv);
    if (!s.success) {
      throw new ConfigError(
        `OTP_DELIVERY=smtp but the SMTP configuration is incomplete or invalid (not falling back to console mode):\n${issueLines(s.error).join("\n")}`,
      );
    }
    const v = s.data;
    smtp = { host: v.SMTP_HOST, port: v.SMTP_PORT, secure: v.SMTP_SECURE, user: v.SMTP_USER, pass: v.SMTP_PASSWORD, from: v.SMTP_FROM };
  } else {
    // OTP_DELIVERY=dev-console
    if (e.NODE_ENV !== "development") {
      throw new ConfigError(
        "OTP_DELIVERY=dev-console prints codes to the terminal and is only allowed when NODE_ENV=development. " +
          "Use OTP_DELIVERY=smtp in any other environment.",
      );
    }
    const stray = Object.keys(smtpEnv);
    if (stray.length > 0) {
      throw new ConfigError(
        `OTP_DELIVERY=dev-console but SMTP settings are present (${stray.join(", ")}). ` +
          "Set OTP_DELIVERY=smtp to send real email, or remove the SMTP_* variables. Not choosing for you.",
      );
    }
  }

  // Registration links: a PARTIAL per-variant setup with no PUBLIC_BASE_URL fallback would leave some tours without a host, and
  // the staff panel would then show a link to its own (staff) portal. Refuse it now, naming the variables (never their values).
  const linkHosts = {
    publicBaseUrl: e.PUBLIC_BASE_URL ? e.PUBLIC_BASE_URL.replace(/\/$/, "") : null,
    publicBaseUrls: Object.fromEntries(TEMPLATE_KEYS.map((key) => [key, e[variantEnvName(key)] ? e[variantEnvName(key)].replace(/\/$/, "") : null])),
  };
  const unlinked = missingLinkHosts(linkHosts);
  if (unlinked.length > 0) {
    throw new ConfigError(
      `Incomplete registration link hosts: ${unlinked.map(variantEnvName).join(", ")} ${unlinked.length === 1 ? "is" : "are"} not set, and PUBLIC_BASE_URL (the fallback) is not set. ` +
        "Set a host for every template, or set PUBLIC_BASE_URL, or set none of them.",
    );
  }

  // Portal identity: each portal's secret must differ (two portals with one secret could not be told apart), and the required
  // mode needs at least one (otherwise no portal could ever register anyone).
  const portalSecrets = Object.fromEntries(TEMPLATE_KEYS.map((key) => [key, e[portalSecretEnvName(key)] ?? null]));
  const secretValues = Object.values(portalSecrets).filter(Boolean);
  if (new Set(secretValues).size !== secretValues.length) {
    throw new ConfigError("Two PORTAL_PROXY_SECRET_* variables have the same value. Each public portal needs its own secret.");
  }
  // Production must never silently accept registrations from callers that are not one of the identified portals: the legacy
  // (unenforced) mode is for local development and tests only.
  if (e.NODE_ENV === "production" && e.PORTAL_BINDING_REQUIRED !== "true") {
    throw new ConfigError(
      e.PORTAL_BINDING_REQUIRED === "false"
        ? 'PORTAL_BINDING_REQUIRED=false is not allowed when NODE_ENV=production. Set PORTAL_BINDING_REQUIRED=true (and the PORTAL_PROXY_SECRET_* variables).'
        : "NODE_ENV=production requires PORTAL_BINDING_REQUIRED=true (and the PORTAL_PROXY_SECRET_* variables). It is not set.",
    );
  }
  // In production the API sits privately behind the portal web servers, which send it exactly one validated address, so it trusts
  // exactly one hop. That value has to be said, not defaulted: left at 0 every visitor would share the web server's address for
  // the per-IP limits. (Another value is right only if something else sits in front of the API; see docs/CLIENT-IP-STAGING-VERIFICATION.md.)
  if (e.NODE_ENV === "production") {
    if (env.TRUST_PROXY_HOPS === undefined || env.TRUST_PROXY_HOPS === "") {
      throw new ConfigError("NODE_ENV=production requires TRUST_PROXY_HOPS to be set explicitly. For the API that sits privately behind the portal web servers it is 1 (see DEPLOYMENT.md). It is not set.");
    }
    if (e.TRUST_PROXY_HOPS === 0) {
      throw new ConfigError("TRUST_PROXY_HOPS=0 is not allowed in production: behind the portal web servers every visitor would share one address for the per-IP limits. Set it to 1 for the private API behind the portal web servers (see DEPLOYMENT.md).");
    }
  }
  if (e.PORTAL_BINDING_REQUIRED === "true" && secretValues.length === 0) {
    throw new ConfigError(
      `PORTAL_BINDING_REQUIRED=true needs at least one portal secret (${TEMPLATE_KEYS.map(portalSecretEnvName).join(", ")}), or no portal could register anyone.`,
    );
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    portalSecrets,
    // null = listen on every interface (production default); an address = listen only there (development: loopback).
    host: e.HOST ?? (e.NODE_ENV === "production" ? null : "127.0.0.1"),
    databaseUrl: e.DATABASE_URL,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    db: {
      max: e.DB_POOL_MAX,
      connectionTimeoutMs: e.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: e.DB_IDLE_TIMEOUT_MS,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: e.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
    serveFrontend: (e.SERVE_FRONTEND ?? (e.NODE_ENV === "production" ? "true" : "false")) === "true",
    frontendDist: e.FRONTEND_DIST ?? null,
    delivery: e.OTP_DELIVERY,
    smtp,
    otp: {
      hmacSecret: e.OTP_HMAC_SECRET,
      ttlSeconds: e.OTP_TTL_SECONDS,
      staffTtlSeconds: e.STAFF_OTP_TTL_SECONDS,
      resendCooldownSeconds: e.OTP_RESEND_COOLDOWN_SECONDS,
      maxAttempts: e.OTP_MAX_ATTEMPTS,
      maxSendsPerEmailPerHour: e.OTP_MAX_SENDS_PER_EMAIL_PER_HOUR,
      maxSendsPerIpPerHour: e.OTP_MAX_SENDS_PER_IP_PER_HOUR,
      verificationTokenTtlSeconds: e.VERIFICATION_TOKEN_TTL_SECONDS,
    },
    auth: {
      // Domain-separated inside the session code, so the same secret never produces a valid OTP hash.
      hmacSecret: e.OTP_HMAC_SECRET,
      sessionTtlSeconds: e.SESSION_TTL_SECONDS, // absolute
      accessTtlSeconds: parentLife.access,
      idleTimeoutSeconds: parentLife.idle,
      reuseGraceSeconds: e.REFRESH_REUSE_GRACE_SECONDS,
      // Browsers refuse Secure cookies over plain http, so only production sets it.
      cookieSecure: e.NODE_ENV === "production",
      passwordLogin: {
        windowSeconds: e.PASSWORD_LOGIN_WINDOW_SECONDS,
        maxPerEmail: e.PASSWORD_LOGIN_MAX_ATTEMPTS_PER_EMAIL,
        maxPerIp: e.PASSWORD_LOGIN_MAX_ATTEMPTS_PER_IP,
      },
    },
    pdfStorage: pdfStorageConfig(e),
    passwordHashing: {
      concurrency: e.PASSWORD_HASH_CONCURRENCY ?? defaultGateOptions().concurrency,
      maxQueue: e.PASSWORD_HASH_QUEUE ?? defaultGateOptions().maxQueue,
    },
    staff: {
      hmacSecret: e.OTP_HMAC_SECRET, // domain-separated inside the staff and link code
      sessionTtlSeconds: e.STAFF_SESSION_TTL_SECONDS, // absolute
      accessTtlSeconds: staffLife.access,
      idleTimeoutSeconds: staffLife.idle,
      reuseGraceSeconds: e.REFRESH_REUSE_GRACE_SECONDS,
      cookieSecure: e.NODE_ENV === "production",
      // Staff sign-in uses the same limits as parent password sign-in.
      login: {
        windowSeconds: e.PASSWORD_LOGIN_WINDOW_SECONDS,
        maxPerEmail: e.PASSWORD_LOGIN_MAX_ATTEMPTS_PER_EMAIL,
        maxPerIp: e.PASSWORD_LOGIN_MAX_ATTEMPTS_PER_IP,
      },
      publicBaseUrl: linkHosts.publicBaseUrl,
      // template key -> that variant's portal origin (null when not set: PUBLIC_BASE_URL is then used)
      publicBaseUrls: linkHosts.publicBaseUrls,
      joinLookups: { windowSeconds: 60, max: e.JOIN_LOOKUPS_PER_MINUTE },
      requireBinding: e.PORTAL_BINDING_REQUIRED === "true",
      // Which portal deployment this staff portal serves (resolved via portal_deployments table at request time).
      deploymentTemplateKey: e.STAFF_DEPLOYMENT_TEMPLATE_KEY ?? null,
    },
  };
}

/**
 * { mode, drive, missing, rootName }. `drive` is set only when mode is "google-drive" AND every credential is present;
 * otherwise it is null and `missing` names what is absent (names only, never values), so the portal runs without it.
 */
function pdfStorageConfig(e) {
  const rootName = e.GOOGLE_DRIVE_ROOT_FOLDER_NAME;
  if (e.PDF_STORAGE !== "google-drive") return { mode: "disabled", drive: null, missing: [], rootName };
  const wanted = {
    GOOGLE_OAUTH_CLIENT_ID: e.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: e.GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_DRIVE_REFRESH_TOKEN: e.GOOGLE_DRIVE_REFRESH_TOKEN,
    GOOGLE_DRIVE_ACCOUNT: e.GOOGLE_DRIVE_ACCOUNT,
  };
  const missing = Object.entries(wanted).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) return { mode: "google-drive", drive: null, missing, rootName };
  return {
    mode: "google-drive",
    drive: { clientId: wanted.GOOGLE_OAUTH_CLIENT_ID, clientSecret: wanted.GOOGLE_OAUTH_CLIENT_SECRET, refreshToken: wanted.GOOGLE_DRIVE_REFRESH_TOKEN, account: wanted.GOOGLE_DRIVE_ACCOUNT },
    missing: [],
    rootName,
  };
}
