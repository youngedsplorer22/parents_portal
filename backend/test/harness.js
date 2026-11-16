import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createStaff } from "../src/modules/staff/provision.js";
import { answerFields, getDefinition } from "../src/modules/onboarding/definitions.js";
import { captureSender, counterCodes, fakeClock, registrationFields, testAuthConfig, testOtpConfig, testStaffConfig } from "./helpers.js";

const SEC = 1000;
export const STAFF_PASSWORD = "staff-passphrase-123";

/** The real app on a random local port, with a capturing sender and a controllable OTP clock. */
export async function startApp({ db, auth = {}, staff = {}, passwordHashing, renderPdf, pdfRendering, drive, pdfStorage, liveLocation, mobile }) {
  const clock = fakeClock();
  const sender = captureSender();
  const logged = [];
  const { app, services } = createApp({
    db,
    sender,
    // `drive` is a fake Google Drive (test/fake-drive.js): the app then stores PDFs in it, over real HTTP to it.
    config: {
      otp: testOtpConfig(), auth: testAuthConfig(auth), staff: testStaffConfig(staff), passwordHashing, pdfRendering, liveLocation, mobile,
      pdfStorage: pdfStorage ?? (drive ? { mode: "google-drive", drive: { clientId: drive.options.clientId, clientSecret: drive.options.clientSecret, refreshToken: drive.options.refreshToken, account: drive.options.account }, missing: [], rootName: "Young Edsplorer" } : undefined),
    },
    driveEndpoints: drive ? { apiBase: drive.options.apiBase, uploadBase: drive.options.uploadBase, tokenUrl: drive.options.tokenUrl, timeoutMs: 1500 } : undefined,
    clock,
    generateCode: counterCodes(),
    logger: { error: (m) => logged.push(m) },
    renderPdf,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { body, cookie, raw, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    // `raw` is the body's bytes (for files such as the registration PDF); `body` is the parsed JSON, when it is JSON.
    const bytes = Buffer.from(await res.arrayBuffer());
    let parsed = null;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      /* no body, or not JSON */
    }
    return { status: res.status, headers: res.headers, body: parsed, raw: bytes, setCookie: res.headers.getSetCookie?.() ?? [] };
  };
  const api = {
    get: (p, o) => call("GET", p, o),
    post: (p, body, o) => call("POST", p, { ...o, body }),
    put: (p, body, o) => call("PUT", p, { ...o, body }),
    patch: (p, body, o) => call("PATCH", p, { ...o, body }),
    del: (p, o) => call("DELETE", p, o),
    delete: (p, _body, o) => call("DELETE", p, o), // same shape as post/put, for route tables
  };

  /** Real OTP flow over HTTP -> single-use verification token. */
  async function verifiedToken(email, purpose) {
    clock.advance(31 * SEC);
    const sent = await api.post("/api/email-otp/send", { email, purpose });
    assert.equal(sent.status, 200);
    const res = await api.post("/api/email-otp/verify", { email, purpose, code: sender.last().code });
    assert.equal(res.status, 200);
    return res.body.verificationToken;
  }
  // The ACCESS cookie ("pp_access=...") is what protected requests carry; the refresh cookie only goes to /api/auth.
  const cookieOf = (res) => (res.setCookie.find((c) => c.startsWith("pp_access=") && !c.startsWith("pp_access=;")) ?? "").split(";")[0];
  const refreshCookieOf = (res) => (res.setCookie.find((c) => c.startsWith("pp_refresh=") && !c.startsWith("pp_refresh=;")) ?? "").split(";")[0];

  /** Registers a new account and returns its access cookie ("pp_access=...") and refresh cookie. */
  async function signUp(email, { role = "Student", ...over } = {}) {
    const verificationToken = await verifiedToken(email, "registration");
    const res = await api.post("/api/registrations", { ...registrationFields(email, { role, ...over }), verificationToken });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { cookie: cookieOf(res), refreshCookie: refreshCookieOf(res), registrationId: res.body.registrationId, res };
  }
  /** Logs in with a fresh login OTP. */
  async function logIn(email) {
    const verificationToken = await verifiedToken(email, "login");
    const res = await api.post("/api/auth/login", { email, verificationToken });
    return { res, cookie: cookieOf(res), refreshCookie: refreshCookieOf(res) };
  }

  /** Creates a staff account the way the provisioning script does (no HTTP route exists for this). */
  async function makeStaff({ email = "admin@example.com", role = "admin", name = "Alex Admin", password = STAFF_PASSWORD } = {}) {
    await createStaff(db, services.staff.passwords, { email, name, role, password, allowAdditionalAdmin: true });
    return { email, password };
  }
  const staffCookieOf = (res) => (res.setCookie.find((c) => c.startsWith("pp_staff_access=") && !c.startsWith("pp_staff_access=;")) ?? "").split(";")[0];
  const staffRefreshCookieOf = (res) => (res.setCookie.find((c) => c.startsWith("pp_staff_refresh=") && !c.startsWith("pp_staff_refresh=;")) ?? "").split(";")[0];
  /** Signs a staff member in over HTTP and returns their cookie plus a small authenticated client. */
  async function staffSignIn(email, password = STAFF_PASSWORD, opts) {
    const res = await api.post("/api/admin/auth/login", { email, password }, opts);
    const cookie = staffCookieOf(res);
    const as = {
      get: (p, o) => api.get(p, { cookie, ...o }),
      post: (p, b, o) => api.post(p, b, { cookie, ...o }),
      patch: (p, b, o) => api.patch(p, b, { cookie, ...o }),
      put: (p, b, o) => api.put(p, b, { cookie, ...o }),
      del: (p, o) => api.del(p, { cookie, ...o }),
    };
    return { res, cookie, refreshCookie: staffRefreshCookieOf(res), as };
  }
  /** makeStaff + staffSignIn in one step. */
  async function staffUser(over = {}) {
    const made = await makeStaff(over);
    return staffSignIn(made.email, made.password);
  }

  /**
   * The real first-time-setup / forgot-password flow over HTTP: request -> emailed code -> verify -> confirm.
   * Resolves to the confirm response. Asserts that a code really was "emailed" to this address.
   */
  async function staffSetPassword(email, password, { confirmPassword = password } = {}) {
    clock.advance(31 * SEC);
    const before = sender.sent.length;
    const asked = await api.post("/api/admin/auth/password/request", { email });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    await new Promise((r) => setTimeout(r, 50)); // delivery runs in the background
    assert.equal(sender.sent.length, before + 1, "a code was emailed");
    assert.equal(sender.last().email, email);
    const verified = await api.post("/api/admin/auth/password/verify", { email, code: sender.last().code });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return api.post("/api/admin/auth/password/confirm", { email, verificationToken: verified.body.verificationToken, password, confirmPassword });
  }

  return {
    staffSetPassword,
    makeStaff, staffSignIn, staffUser, staffCookieOf, staffRefreshCookieOf,
    api, base, clock, sender, logged, services, verifiedToken, signUp, logIn, cookieOf, refreshCookieOf,
    close: () => new Promise((r) => server.close(r)),
  };
}

const SAMPLE = {
  age: "10",
  dateOfBirth: "2012-05-04",
  passportIssueDate: "2020-01-10",
  passportExpiryDate: "2030-01-09",
  panHolderDob: "1985-03-02",
  phone: "9876543210",
  passportNumber: "AW246971",
  panNumber: "ACGPA3164K",
};

/** A complete, valid set of answers for a tour and role, built from the definition itself. */
export function validAnswers(tourType, role) {
  const def = getDefinition(tourType, role);
  const out = {};
  for (const field of answerFields(def)) {
    if (SAMPLE[field.key]) out[field.key] = SAMPLE[field.key];
    else if (field.type === "select") out[field.key] = field.options[0];
    else out[field.key] = `Sample ${field.key}`.slice(0, field.max);
  }
  return out;
}
