import { isIP } from "node:net";
import { z } from "zod";
import { DatabaseTargetError, assertLocalDatabaseUrl as assertLocalTarget, resolveDatabaseTarget } from "./db/target.js";
import { defaultGateOptions } from "./modules/auth/work-gate.js";

const int = (fallback, min, max) => z.coerce.number().int().min(min).max(max).default(fallback);
const required = { error: "is required" };
const noControlChars = (s) => !/[\u0000-\u001f\u007f]/.test(s);
// An optional credential: unset or empty -> undefined. Messages never repeat the value.
const optionalSecret = () =>
  z.preprocess((v) => (v === "" ? undefined : v), z.string().max(2000).refine(noControlChars, "must not contain control characters").optional());
// Unset or empty -> undefined (an empty value must never silently become 0).
const optionalInt = (min, max) =>
  z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().min(min).max(max).optional());

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
  // Optional. Where parents open links, e.g. https://parents.example.com. If unset, staff get the path only.
  PUBLIC_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? undefined : v))
    .refine((v) => {
      if (v === undefined) return true;
      try {
        const u = new URL(v);
        return /^https?:$/.test(u.protocol) && u.pathname === "/" && !u.search && !u.hash && !u.username && !u.password;
      } catch {
        return false;
      }
    }, "must be an http(s) origin only, such as https://parents.example.com"),
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
  const parentLife = lifetimes("parent", e.PARENT_ACCESS_TOKEN_TTL_SECONDS, e.PARENT_SESSION_IDLE_TIMEOUT_SECONDS, e.SESSION_TTL_SECONDS, { access: 900, idle: 259200 });
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

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    // null = listen on every interface (production default); an address = listen only there (development: loopback).
    host: e.HOST ?? (e.NODE_ENV === "production" ? null : "127.0.0.1"),
    databaseUrl: e.DATABASE_URL,
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
      publicBaseUrl: e.PUBLIC_BASE_URL ? e.PUBLIC_BASE_URL.replace(/\/$/, "") : null,
      joinLookups: { windowSeconds: 60, max: e.JOIN_LOOKUPS_PER_MINUTE },
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
