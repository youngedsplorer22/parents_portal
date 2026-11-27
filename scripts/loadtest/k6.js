// k6 load tests for the Parents Portal API, built from the REAL parent flows (read from the code and the web client):
//
//   Registration  GET  /api/join/:school/:branch/:trip   (public trip page)
//                 POST /api/email-otp/send    { email, purpose: "registration" }                 -> 200  (code mailed)
//                 POST /api/email-otp/verify  { email, purpose, code }                           -> 200  { verificationToken }
//                 POST /api/registrations     { firstName, lastName, role, phone, email, password, verificationToken, publicTrip }
//                                                                                                -> 201  (scrypt HASH; session cookies set)
//                 GET  /api/onboarding                                                           -> 200  (signed in)
//   Password login GET  /api/auth/session                                                        -> 401  (page load, not signed in)
//                 POST /api/auth/login/password { email, password }                              -> 200  (scrypt VERIFY; session cookies)
//                 GET  /api/onboarding                                                           -> 200
//                 (some flows then) POST /api/auth/refresh, POST /api/auth/logout                -> 200
//   OTP login     GET /api/auth/session (401), POST /api/email-otp/send { purpose: "login" }, POST /api/email-otp/verify,
//                 POST /api/auth/login { email, verificationToken }                              -> 200  (NO hash), GET /api/onboarding
//
// Run:  k6 run -e SCENARIO=<name> -e SCHOOL=<slug> -e TRIP=<slug> [-e BRANCH=main] [options] scripts/loadtest/k6.js
//   SCENARIO: smoke | registration | login | combined | concurrency | burst | capacity | integrity | ratelimit
//   PROFILE (default per scenario): registration | login | combined | submit    RPS (default 100)    DURATION (default 10m)
//   BASE_URL (API, default http://127.0.0.1:4000)   SMTP_ADMIN (fake SMTP admin, default http://127.0.0.1:2526)
// NEVER point BASE_URL at production. Flow weights and request counts are PROPOSED assumptions (README: "Workload profiles").
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import exec from "k6/execution";
import { SharedArray } from "k6/data";
import { sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:4000";
const SMTP_ADMIN = __ENV.SMTP_ADMIN || "http://127.0.0.1:2526";
if (/railway|up\.app|prod|young/i.test(BASE)) throw new Error(`Refusing to load-test ${BASE}: looks like a deployed environment.`);
const TRIP = { school: __ENV.SCHOOL, branch: __ENV.BRANCH || "main", trip: __ENV.TRIP };
const T = new SharedArray("seed", () => [JSON.parse(open("./tokens.json"))])[0];
const RUN = T.run, RPS = Number(__ENV.RPS || 100), DURATION = __ENV.DURATION || "10m";
const TAIL = Number(__ENV.SESSION_TAIL || 0.1); // share of password-login flows that go on to refresh + logout
// Per client address: one random address per flow (needs TRUST_PROXY_HOPS=1 on the TEST API). This is how many parents
// on many networks look to the API. It does NOT switch any limit off; the `ratelimit` scenario proves the limits still work.
const SPREAD = (__ENV.SPREAD_IPS || "true") === "true";

// ---- Proposed workload profiles (flow weights; see README) --------------------------------------------------------------
const PROFILES = {
  registration: { R: 90, L: 5, J: 5 },
  login: { L: 85, O: 10, R: 5 },
  combined: { R: 40, L: 45, O: 15 },
  // Literal "mostly submissions": single requests, registration uses SEEDED tokens (no OTP round trip), so it isolates the hash + write path.
  submit: { sreg: 40, slogin: 40, sotp: 3, sprobe: 4 },
};
const REQS = { R: 5, L: 3 + 2 * TAIL, O: 5, J: 1, sreg: 1, slogin: 1, sotp: 2, sprobe: 1 }; // API requests per iteration
const defaultProfile = { registration: "registration", login: "login", combined: "combined", concurrency: "combined", burst: "combined", capacity: "submit", smoke: "combined" };
const SCENARIO = __ENV.SCENARIO || "smoke";
const PROFILE = __ENV.PROFILE || defaultProfile[SCENARIO] || "combined";
const weights = PROFILES[PROFILE];
if (!weights) throw new Error(`unknown PROFILE ${PROFILE}`);
const wsum = Object.values(weights).reduce((a, b) => a + b, 0);
const avgReq = Object.entries(weights).reduce((a, [k, w]) => a + (w / wsum) * REQS[k], 0);
const rateFor = (rps) => ({ rate: Math.max(1, Math.round((rps / avgReq) * 10)), timeUnit: "10s" }); // iterations (flows) per 10 s

// ---- Metrics ------------------------------------------------------------------------------------------------------------
const EP = ["join", "session", "otp_send", "otp_verify", "register", "login_pw", "login_otp", "onboarding", "refresh", "logout"];
const EXPECT = { join: [200], session: [401], otp_send: [200], otp_verify: [200], register: [201], login_pw: [200], login_otp: [200], onboarding: [200], refresh: [200], logout: [200] };
const CODES = [200, 201, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504, 0];
const resp = Object.fromEntries(EP.map((e) => [e, Object.fromEntries([...CODES, "other"].map((c) => [c, new Counter(`resp_${e}_${c}`)]))]));
const lat = Object.fromEntries(EP.map((e) => [e, new Trend(`latency_${e}`, true)]));
const apiRequests = new Counter("api_requests");               // API requests only (the SMTP sink polls are excluded)
const okTotal = new Counter("resp_expected");                    // the status that endpoint is meant to return in a valid flow
const rateLimited = new Counter("resp_429_rate_limited");        // MUST be 0 in a performance test (else the run is INVALID)
const busy = new Counter("resp_503_busy");                       // deliberate SERVER_BUSY from the hash gate
const validation = new Counter("resp_400_validation");           // 400/422: a "valid" flow was rejected
const authFail = new Counter("resp_401_403_unexpected");         // credentials / session rejected where success was expected
const conflict = new Counter("resp_409_unexpected");
const unexpected5xx = new Counter("resp_5xx_unexpected");        // any 5xx except 503, and status 0 (timeout / reset)
const otherUnexpected = new Counter("resp_other_unexpected");
const poolExhausted = new Counter("test_identity_pool_exhausted"); // test ran out of seeded identities: run INVALID
const smtpMissing = new Counter("smtp_code_missing");            // mail never reached the sink within 10 s
const smtpWait = new Trend("smtp_code_wait", true);              // ms from the OTP send response until the code is readable at the sink
const flowOk = {}, flowFail = {}, flowDur = {};
for (const f of ["R", "L", "O", "J", "sreg", "slogin", "sotp", "sprobe"]) { flowOk[f] = new Counter(`flow_ok_${f}`); flowFail[f] = new Counter(`flow_failed_${f}`); flowDur[f] = new Trend(`flow_duration_${f}`, true); }
const dupWins = new Counter("dup_email_201"), reuseWins = new Counter("token_reuse_201"), otpVerifyWins = new Counter("otp_verify_200");
const loginRace = { 200: new Counter("login_race_200"), 429: new Counter("login_race_429"), other: new Counter("login_race_other") };
const refreshRace = { 200: new Counter("refresh_race_200"), 409: new Counter("refresh_race_409"), other: new Counter("refresh_race_other") };
const rlEmailFirst429 = new Trend("rl_email_first429_attempt"), rlIpFirst429 = new Trend("rl_ip_first429_attempt"), rlResendStatus = new Trend("rl_resend_status");

const ipv4 = () => `10.${(Math.random() * 256) | 0}.${(Math.random() * 256) | 0}.${1 + ((Math.random() * 254) | 0)}`;
const hdr = (ip) => ({ headers: { "Content-Type": "application/json", ...(SPREAD ? { "X-Forwarded-For": ip } : {}) } });
let flowIp = ipv4();

function rec(ep, res) {
  apiRequests.add(1);
  (resp[ep][res.status] ?? resp[ep].other).add(1);
  lat[ep].add(res.timings.duration);
  if (EXPECT[ep].includes(res.status)) { okTotal.add(1); return true; }
  const s = res.status;
  if (s === 429) rateLimited.add(1); else if (s === 503) busy.add(1); else if (s === 400 || s === 422) validation.add(1);
  else if (s === 401 || s === 403) authFail.add(1); else if (s === 409) conflict.add(1);
  else if (s >= 500 || s === 0) unexpected5xx.add(1); else otherUnexpected.add(1);
  return false;
}
const get = (ep, path) => rec(ep, http.get(`${BASE}${path}`, hdr(flowIp)));
const post = (ep, path, body) => { const r = http.post(`${BASE}${path}`, JSON.stringify(body), hdr(flowIp)); return [rec(ep, r), r]; };

// One OTP round trip: send (OTP generation + mail), read the code from the sink, verify. Each step is measured on its own.
function otp(email, purpose) {
  const [ok, s] = post("otp_send", "/api/email-otp/send", { email, purpose });
  if (!ok) return null;
  const t0 = Date.now(); let code = null;
  for (let n = 0; n < 200 && !code; n++) {
    const c = http.get(`${SMTP_ADMIN}/code?email=${encodeURIComponent(email)}&consume=1`, { tags: { name: "smtp_admin" } });
    if (c.status === 200) code = c.json("code"); else sleep(0.05);
  }
  if (!code) { smtpMissing.add(1); return null; }
  smtpWait.add(Date.now() - t0);
  const [vok, v] = post("otp_verify", "/api/email-otp/verify", { email, purpose, code });
  return vok ? v.json("verificationToken") : null;
}
const regBody = (email, token, n) => ({
  firstName: "Load", lastName: "Test", role: "Student", phone: `9${String(100000000 + ((n * 7919) % 899999999))}`.slice(0, 10),
  email, password: `Lt-Zq7!pass-${n}-Xv`, verificationToken: token, publicTrip: TRIP,
});
const uniq = () => `${exec.scenario.name}-${exec.scenario.iterationInTest}`;
const offset = () => (exec.scenario.name === "overlay" ? 1500 : 0);
function account(pool, perAccount) { // sequential with a prime stride: simultaneous flows never share an account (per-email limit is 5 in flight)
  const i = exec.scenario.iterationInTest + offset(), n = pool.length;
  if (Math.floor(i / n) >= perAccount) { poolExhausted.add(1); return null; }
  return pool[(i * 7919) % n];
}

// ---- Flows --------------------------------------------------------------------------------------------------------------
function flowR() {
  const email = `lt-${RUN}-f-${uniq()}@loadtest.example.org`;
  get("join", `/api/join/${TRIP.school}/${TRIP.branch}/${TRIP.trip}`);
  const token = otp(email, "registration"); if (!token) return false;
  const [ok] = post("register", "/api/registrations", regBody(email, token, exec.scenario.iterationInTest));
  if (ok) get("onboarding", "/api/onboarding");
  return ok;
}
function flowL() {
  const email = account(T.accounts, 1e9); if (!email) return false;
  get("session", "/api/auth/session");
  const [ok] = post("login_pw", "/api/auth/login/password", { email, password: T.accountPassword });
  if (!ok) return false;
  get("onboarding", "/api/onboarding");
  if (Math.random() < TAIL) { post("refresh", "/api/auth/refresh", {}); post("logout", "/api/auth/logout", {}); }
  return true;
}
function flowO() {
  const email = account(T.otpAccounts, 3); if (!email) return false; // OTP sends are capped per email (default 5/hour): 3 uses each
  get("session", "/api/auth/session");
  const token = otp(email, "login"); if (!token) return false;
  const [ok] = post("login_otp", "/api/auth/login", { email, verificationToken: token });
  if (ok) get("onboarding", "/api/onboarding");
  return ok;
}
function flowJ() { return get("join", `/api/join/${TRIP.school}/${TRIP.branch}/${TRIP.trip}`); }
function flowSreg() {
  const i = exec.scenario.iterationInTest + offset() * 20; if (i >= T.singles.length) { poolExhausted.add(1); return false; }
  const t = T.singles[i]; return post("register", "/api/registrations", regBody(t.email, t.token, i))[0];
}
function flowSlogin() { const e = account(T.accounts, 1e9); return e ? post("login_pw", "/api/auth/login/password", { email: e, password: T.accountPassword })[0] : false; }
function flowSotp() { const e = account(T.otpAccounts, 3); return e ? Boolean(otp(e, "login")) : false; }
function flowSprobe() { return get("session", "/api/auth/session"); }
const FLOW = { R: flowR, L: flowL, O: flowO, J: flowJ, sreg: flowSreg, slogin: flowSlogin, sotp: flowSotp, sprobe: flowSprobe };

function pick() { let r = Math.random() * wsum; for (const [k, w] of Object.entries(weights)) { if ((r -= w) < 0) return k; } return Object.keys(weights)[0]; }
function runFlow() {
  const f = pick(); flowIp = ipv4(); const t0 = Date.now();
  const ok = FLOW[f]();
  flowDur[f].add(Date.now() - t0); (ok ? flowOk[f] : flowFail[f]).add(1);
}
export function flows() { runFlow(); }         // open model (arrival rate)
export function closedLoop() { runFlow(); }    // closed loop (no think time)

// ---- E. Integrity (separate from performance runs) ----------------------------------------------------------------------
const body = (o) => JSON.stringify(o);
export function dupRace() { // 20 simultaneous registrations for ONE email, 20 different valid tokens: at most one 201
  const g = T.dup[exec.scenario.iterationInInstance % T.dup.length], token = g.tokens[(exec.vu.idInInstance - 1) % g.tokens.length];
  const r = http.post(`${BASE}/api/registrations`, body(regBody(g.email, token, exec.scenario.iterationInInstance)), hdr(ipv4())); if (r.status === 201) dupWins.add(1); rec("register", r);
}
export function reuseRace() { // 20 simultaneous registrations with the SAME email and SAME token: exactly one 201
  const g = T.reuse[exec.scenario.iterationInInstance % T.reuse.length];
  const r = http.post(`${BASE}/api/registrations`, body(regBody(g.email, g.token, 1e6 + exec.scenario.iterationInInstance)), hdr(ipv4())); if (r.status === 201) reuseWins.add(1); rec("register", r);
}
export function otpRace() { // one email: 20 simultaneous sends (one live code), then 20 simultaneous verifies of that code (one success)
  const email = `lt-${RUN}-race${exec.scenario.iterationInInstance}-${Date.now()}@loadtest.example.org`;
  for (const r of http.batch(Array.from({ length: 20 }, () => ["POST", `${BASE}/api/email-otp/send`, body({ email, purpose: "registration" }), hdr(ipv4())]))) rec("otp_send", r);
  let code = null;
  for (let n = 0; n < 40 && !code; n++) { const c = http.get(`${SMTP_ADMIN}/code?email=${encodeURIComponent(email)}&consume=1`, { tags: { name: "smtp_admin" } }); if (c.status === 200) code = c.json("code"); else sleep(0.25); }
  if (!code) { smtpMissing.add(1); return; }
  for (const r of http.batch(Array.from({ length: 20 }, () => ["POST", `${BASE}/api/email-otp/verify`, body({ email, purpose: "registration", code }), hdr(ipv4())]))) { rec("otp_verify", r); if (r.status === 200) otpVerifyWins.add(1); }
}
export function loginSameAccount() { // 10 simultaneous correct-password logins for ONE account: some 200, the rest may be 429 (per-email limit), never 5xx
  const email = T.accounts[exec.scenario.iterationInInstance % T.accounts.length];
  for (const r of http.batch(Array.from({ length: 10 }, () => ["POST", `${BASE}/api/auth/login/password`, body({ email, password: T.accountPassword }), hdr(ipv4())]))) {
    (loginRace[r.status] ?? loginRace.other).add(1); rec("login_pw", r);
  }
}
export function refreshSameSession() { // login once, then 5 simultaneous refreshes with the one refresh cookie: exactly one 200, others 409 (race grace)
  const email = T.accounts[(exec.scenario.iterationInInstance + 1000) % T.accounts.length];
  const l = http.post(`${BASE}/api/auth/login/password`, body({ email, password: T.accountPassword }), hdr(ipv4())); if (!rec("login_pw", l)) return;
  for (const r of http.batch(Array.from({ length: 5 }, () => ["POST", `${BASE}/api/auth/refresh`, "{}", hdr(ipv4())]))) { (refreshRace[r.status] ?? refreshRace.other).add(1); rec("refresh", r); }
}

// ---- Security controls stay ON: prove they still answer 429 ------------------------------------------------------------------
export function rateLimits() {
  const email = T.otpAccounts[T.otpAccounts.length - 1], ip = "10.250.250.250", h = hdr(ip);
  for (let n = 1; n <= 8; n++) { // wrong password for ONE email from ONE address: the per-email limit (default 5) must answer 429
    const r = http.post(`${BASE}/api/auth/login/password`, body({ email, password: "definitely-wrong-password" }), h);
    if (r.status === 429) { rlEmailFirst429.add(n); break; }
  }
  for (let n = 1; n <= 30; n++) { // wrong password for many emails from ONE address: the per-IP limit (default 20) must answer 429
    const r = http.post(`${BASE}/api/auth/login/password`, body({ email: `lt-${RUN}-nobody${n}@loadtest.example.org`, password: "definitely-wrong-password" }), h);
    if (r.status === 429) { rlIpFirst429.add(n); break; }
  }
  const e = `lt-${RUN}-cool${Date.now()}@loadtest.example.org`;
  http.post(`${BASE}/api/email-otp/send`, body({ email: e, purpose: "registration" }), hdr(ipv4()));
  rlResendStatus.add(http.post(`${BASE}/api/email-otp/resend`, body({ email: e, purpose: "registration" }), hdr(ipv4())).status); // inside the cooldown: expect 429
}

// ---- Scenarios ----------------------------------------------------------------------------------------------------------
const VUS = Number(__ENV.VUS || 200);
const openModel = { executor: "constant-arrival-rate", ...rateFor(RPS), duration: DURATION, preAllocatedVUs: 300, maxVUs: 4000, exec: "flows" };
const scenarios = {
  smoke: { executor: "per-vu-iterations", vus: 1, iterations: 6, exec: "flows" },
  registration: openModel, login: openModel, // 1 and 2: same open-model executor, different PROFILE
  combined: { base: { ...openModel, startTime: "0s" } },
  // 4. Concurrency: closed loop. Pass/fail is read from the SERVER probe (max in flight, seconds at >= 100), not from VUS.
  concurrency: { executor: "ramping-vus", startVUs: 0, stages: [{ duration: "30s", target: VUS }, { duration: DURATION, target: VUS }, { duration: "10s", target: 0 }], gracefulRampDown: "60s", exec: "closedLoop" },
  // 5. Burst: baseline, jump to BURST_RPS, back to baseline (recovery window).
  burst: { executor: "ramping-arrival-rate", startRate: rateFor(RPS).rate, timeUnit: "10s", preAllocatedVUs: 500, maxVUs: 6000, exec: "flows",
    stages: [{ duration: "2m", target: rateFor(RPS).rate }, { duration: "5s", target: rateFor(Number(__ENV.BURST_RPS || RPS * 3)).rate }, { duration: "30s", target: rateFor(Number(__ENV.BURST_RPS || RPS * 3)).rate }, { duration: "5s", target: rateFor(RPS).rate }, { duration: "3m", target: rateFor(RPS).rate }] },
  // Capacity: steps up the literal write-heavy profile to find where the hash gate / pool / CPU gives out. A search, not an acceptance test.
  capacity: { executor: "ramping-arrival-rate", startRate: 1, timeUnit: "10s", preAllocatedVUs: 500, maxVUs: 6000, exec: "flows",
    stages: [10, 20, 40, 60, 80, 100].flatMap((r) => [{ duration: "20s", target: rateFor(r).rate }, { duration: "100s", target: rateFor(r).rate }]) },
  integrity: {
    dup: { executor: "per-vu-iterations", vus: (T.dup[0]?.tokens.length) || 20, iterations: T.dup.length, maxDuration: "5m", exec: "dupRace" },
    reuse: { executor: "per-vu-iterations", vus: 20, iterations: T.reuse.length, maxDuration: "5m", startTime: "30s", exec: "reuseRace" },
    otp: { executor: "per-vu-iterations", vus: 1, iterations: Number(__ENV.OTP_GROUPS || 25), maxDuration: "10m", startTime: "60s", exec: "otpRace" },
    sameAccountLogin: { executor: "per-vu-iterations", vus: 1, iterations: 25, maxDuration: "10m", startTime: "90s", exec: "loginSameAccount" },
    sameSessionRefresh: { executor: "per-vu-iterations", vus: 1, iterations: 25, maxDuration: "10m", startTime: "120s", exec: "refreshSameSession" },
  },
  ratelimit: { executor: "per-vu-iterations", vus: 1, iterations: 1, exec: "rateLimits" },
};
if (SCENARIO === "combined") { // overlay: closed-loop clients in the middle of the run, so 100 RPS and >= 100 in flight hold at once
  scenarios.combined.overlay = { executor: "constant-vus", vus: Number(__ENV.OVERLAY_VUS || 100), duration: __ENV.OVERLAY_DURATION || "5m", startTime: __ENV.OVERLAY_START || "5m", exec: "closedLoop" };
}
const chosen = scenarios[SCENARIO];
if (!chosen) throw new Error(`unknown SCENARIO ${SCENARIO}`);
export const options = {
  scenarios: chosen.executor ? { [SCENARIO]: chosen } : chosen,
  batchPerHost: 25,
  noCookiesReset: false, // each flow starts signed out
  thresholds: ["registration", "login", "combined"].includes(SCENARIO) ? { dropped_iterations: ["count==0"], resp_5xx_unexpected: ["count==0"] } : {},
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};
