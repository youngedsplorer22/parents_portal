import pg from "pg";

/** Tests TRUNCATE tables, so they may only ever touch parents_portal_test on this machine. */
export function createTestPool() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("TEST_DATABASE_URL is not set (run via `npm test`)");
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/parents_portal_test") {
    throw new Error("Refusing to run tests: TEST_DATABASE_URL must be local and use parents_portal_test");
  }
  return new pg.Pool({ connectionString: raw, max: 10 });
}

export const resetTables = (pool) => pool.query("TRUNCATE audit_log, trip_link_lookups, trip_live_locations, trip_enrolments, trip_links, trips, schools, staff_login_attempts, staff_sessions, staff_users, onboarding_forms, auth_sessions, password_login_attempts, parent_registrations, email_otps, email_verification_tokens, drive_folders, registration_pdfs CASCADE");

/** Controllable clock. clock() returns a Date; clock.advance(ms) moves time forward. */
export function fakeClock(startMs = Date.now()) {
  let t = startMs;
  const clock = () => new Date(t);
  clock.advance = (ms) => {
    t += ms;
  };
  return clock;
}

/** Deterministic codes: 100001, 100002, ... ("000000" is never generated, so it is a safe wrong guess). */
export function counterCodes() {
  let n = 100000;
  return () => String(++n);
}

export function captureSender() {
  const sent = [];
  const notices = []; // password-changed notices
  const staffNotices = []; // staff password set/changed notices
  return {
    mode: "dev-console",
    sent,
    notices,
    staffNotices,
    last: () => sent[sent.length - 1],
    async send(message) {
      sent.push(message);
    },
    async sendPasswordChanged(message) {
      notices.push(message);
    },
    async sendStaffPasswordChanged(message) {
      staffNotices.push(message);
    },
  };
}

export const testOtpConfig = (overrides = {}) => ({
  hmacSecret: "a".repeat(64),
  ttlSeconds: 300,
  staffTtlSeconds: 900,
  resendCooldownSeconds: 30,
  maxAttempts: 5,
  maxSendsPerEmailPerHour: 5,
  maxSendsPerIpPerHour: 20,
  verificationTokenTtlSeconds: 900,
  ...overrides,
});

export const TEST_SCRYPT_COST = { N: 1024, r: 8, p: 1 };
export const TEST_PASSWORD = "correct-horse-battery";

export const testAuthConfig = (overrides = {}) => ({
  hmacSecret: "a".repeat(64),
  sessionTtlSeconds: 3600, // absolute
  accessTtlSeconds: 300,
  idleTimeoutSeconds: 1800,
  reuseGraceSeconds: 20,
  cookieSecure: false,
  passwordLogin: { windowSeconds: 900, maxPerEmail: 5, maxPerIp: 20 },
  // Tests use a cheap scrypt cost so the suite stays fast; production uses the default.
  scryptCost: TEST_SCRYPT_COST,
  ...overrides,
});

export const testStaffConfig = (overrides = {}) => ({
  hmacSecret: "a".repeat(64),
  sessionTtlSeconds: 3600, // absolute
  accessTtlSeconds: 300,
  idleTimeoutSeconds: 1200,
  reuseGraceSeconds: 20,
  cookieSecure: false,
  login: { windowSeconds: 900, maxPerEmail: 5, maxPerIp: 20 },
  scryptCost: TEST_SCRYPT_COST,
  publicBaseUrl: "https://parents.example.test",
  joinLookups: { windowSeconds: 60, max: 30 },
  ...overrides,
});

/** Resolves to the AppError code a promise rejects with (or "no error"). */
export const errorCode = (promise) =>
  promise.then(
    () => "no error",
    (err) => err.code,
  );

/** Wraps a pg Pool so queries matching `failWhen` reject, to simulate database failures inside a transaction. */
export function failingDb(pool, failWhen) {
  const fail = () => Promise.reject(Object.assign(new Error("simulated database failure"), { code: "57P01" }));
  const breaks = (sql) => typeof sql === "string" && failWhen.test(sql);
  return {
    query: (sql, ...rest) => (breaks(sql) ? fail() : pool.query(sql, ...rest)),
    async connect() {
      const client = await pool.connect();
      const real = client.query.bind(client);
      const release = client.release.bind(client);
      client.query = (sql, ...rest) => (breaks(sql) ? fail() : real(sql, ...rest));
      // Pooled clients are reused: undo the patch before the client goes back, or the next test inherits it.
      client.release = (...args) => {
        delete client.query;
        delete client.release;
        return release(...args);
      };
      return client;
    },
  };
}

export const registrationFields = (email = "parent@example.com", over = {}) => ({
  firstName: "Asha",
  lastName: "Rao",
  role: "Teacher",
  phone: "9876543210",
  email,
  password: TEST_PASSWORD,
  ...over,
});

/** The three address words of a trip's public page, from the staff API's publicPath: { school, branch, trip }. */
export function slugsOf(trip) {
  const [, join, school, branch, slug] = trip.publicPath.split("/");
  if (join !== "join") throw new Error(`unexpected publicPath ${trip.publicPath}`);
  return { school, branch, trip: slug };
}

/** What a final submission must carry besides the version: the accepted declaration and a typed signature. */
export const ACK = Object.freeze({ declarationAccepted: true, declarationVersion: "2026-10-v1", signatureName: "Asha Rao" });
