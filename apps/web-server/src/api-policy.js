// What a portal's web server may forward to the (private) API. A portal forwards ONLY the calls its own frontend makes: an exact
// method and path, strictly shaped ids and slugs, and only the query parameters that route documents. Everything else is
// answered here with a plain 404 and never reaches the API.
//
//   "public"  the four registration portals: the parent calls (join page, registration, emailed codes, sign-in, enrolment,
//             the registration form, its PDF, live location, school logos) PLUS the Sales staff calls (sign-in, password
//             setup/reset, itinerary). The Sales UI ships in every public portal build (vite-config.js __HAS_STAFF__=true),
//             so the staff API routes must be reachable from the public portal's own host.
//   "staff"   a dedicated Sales-only build (PORTAL_ROLE=staff): exactly the same Sales routes, no parent routes.
//
// The API still checks every permission itself (sessions, ownership, portal key, Sales assignment). For the Sales routes in
// the public policy the API's own auth is the only wall; the proxy no longer provides a second one for those 13 paths.
// /api/mobile/* and all developer-only admin paths (/api/admin/schools, /api/admin/trips, /api/admin/staff, etc.) remain
// blocked on both portals.
//
// Written from the inventory of every call in packages/web-core/src/api/*.js and admin/adminApi.js. Deliberately NOT forwarded
// by any portal: /api/mobile/* (the mobile app is not part of this launch; the API keeps it), /api/health*, the enrolment list
// (GET /api/enrolments), discarding a draft (DELETE /api/onboarding), and every other route the frontends never call.

const SLUG = "(?=[a-z0-9-]{1,70}(?:/|$))[a-z0-9]+(?:-[a-z0-9]+)*";
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const ENROLMENT = { enrolment: new RegExp(`^${UUID}$`) };
const VERSION = { v: /^[0-9]{1,15}$/ };

// The largest request body each route may carry, in bytes. These are the API's OWN limits, copied from the express.json({ limit })
// each router sets (not chosen here), so a legitimate call is never refused and anything bigger is stopped before it is streamed
// to the API: /api/email-otp 2kb, /api/registrations 4kb, /api/auth 4kb, /api/enrolments 2kb, /api/live-location 1kb,
// /api/onboarding 64kb, /api/admin 8kb, /api/admin trip-documents 10mb, /api/admin school-logo 512kb. A route that takes no body
// (every GET) gets 0. A test in apps/api checks each JSON route against the real API, so those cannot drift apart unnoticed.
const KB = 1024;
const MB = 1024 * KB;
const rule = (method, pattern, query = {}, maxBody = 0) => ({ method, re: new RegExp(`^${pattern}$`), query, maxBody });

// Query validators for trip-document uploads. `name` is a URLSearchParams-encoded filename: URLSearchParams keeps letters,
// digits, `-`, `_`, `.`, `*` as-is and encodes spaces as `+`. Allow those chars (and nothing else) up to 200 chars.
const DOC_UPLOAD = {
  type: /^(itinerary|insurance|transport)$/,
  name: /^[A-Za-z0-9._*+-]{1,200}$/,
};

const POLICIES = {
  public: [
    rule("GET", `/api/join/${SLUG}/${SLUG}/${SLUG}`),
    rule("POST", "/api/registrations", {}, 4 * KB),
    rule("POST", "/api/email-otp/send", {}, 2 * KB),
    rule("POST", "/api/email-otp/resend", {}, 2 * KB),
    rule("POST", "/api/email-otp/verify", {}, 2 * KB),
    rule("POST", "/api/auth/login", {}, 4 * KB),
    rule("POST", "/api/auth/login/password", {}, 4 * KB),
    rule("POST", "/api/auth/password-reset/request", {}, 4 * KB),
    rule("POST", "/api/auth/password-reset/resend", {}, 4 * KB),
    rule("POST", "/api/auth/password-reset/verify", {}, 4 * KB),
    rule("POST", "/api/auth/password-reset/confirm", {}, 4 * KB),
    rule("GET", "/api/auth/session"),
    rule("POST", "/api/auth/refresh", {}, 4 * KB),
    rule("POST", "/api/auth/logout", {}, 4 * KB),
    rule("GET", "/api/enrolments/resume"),
    rule("POST", "/api/enrolments", {}, 2 * KB),
    rule("GET", `/api/enrolments/${UUID}/itinerary`),
    rule("GET", "/api/onboarding", ENROLMENT),
    rule("PUT", "/api/onboarding", {}, 64 * KB),
    rule("POST", "/api/onboarding/submit", {}, 64 * KB),
    rule("GET", "/api/onboarding/pdf", ENROLMENT),
    rule("GET", "/api/onboarding/pdf/status", ENROLMENT),
    rule("POST", "/api/onboarding/pdf/retry", {}, 64 * KB),
    rule("GET", "/api/live-location", ENROLMENT),
    rule("POST", "/api/live-location/start", {}, 1 * KB),
    rule("POST", "/api/live-location/location", {}, 1 * KB),
    rule("POST", "/api/live-location/stop", {}, 1 * KB),
    rule("GET", `/api/school-logos/${SLUG}/${SLUG}`, VERSION),
    // Sales staff UI ships in every public portal build (vite-config.js __HAS_STAFF__=true). These are the same 13 routes
    // as the staff policy; the API enforces authorization on each one independently.
    rule("POST", "/api/admin/auth/login", {}, 8 * KB),
    rule("GET", "/api/admin/auth/session"),
    rule("POST", "/api/admin/auth/refresh", {}, 8 * KB),
    rule("POST", "/api/admin/auth/logout", {}, 8 * KB),
    rule("POST", "/api/admin/auth/password/request", {}, 8 * KB),
    rule("POST", "/api/admin/auth/password/resend", {}, 8 * KB),
    rule("POST", "/api/admin/auth/password/verify", {}, 8 * KB),
    rule("POST", "/api/admin/auth/password/confirm", {}, 8 * KB),
    rule("POST", "/api/admin/auth/password", {}, 8 * KB),
    rule("GET", "/api/admin/itinerary/trips"),
    rule("GET", `/api/admin/trips/${UUID}/itinerary`),
    rule("POST", `/api/admin/trips/${UUID}/itinerary`, {}, 8 * KB),
    rule("PATCH", `/api/admin/trips/${UUID}/itinerary/${UUID}`, {}, 8 * KB),
    // Manage Trip: trip documents (itinerary PDF, insurance, transport) and school logo.
    rule("GET", `/api/admin/trips/${UUID}/documents`),
    rule("POST", `/api/admin/trips/${UUID}/documents`, DOC_UPLOAD, 10 * MB),
    rule("GET", `/api/admin/trips/${UUID}/documents/${UUID}`),
    rule("DELETE", `/api/admin/trips/${UUID}/documents/${UUID}`),
    rule("GET", `/api/admin/trips/${UUID}/school-logo`),
    rule("PUT", `/api/admin/trips/${UUID}/school-logo`, {}, 512 * KB),
  ],
  staff: [
    rule("POST", "/api/admin/auth/login", {}, 8 * KB),
    rule("GET", "/api/admin/auth/session"),
    rule("POST", "/api/admin/auth/refresh", {}, 8 * KB),
    rule("POST", "/api/admin/auth/logout", {}, 8 * KB),
    rule("POST", "/api/admin/auth/password/request", {}, 8 * KB),
    rule("POST", "/api/admin/auth/password/resend", {}, 8 * KB),
    rule("POST", "/api/admin/auth/password/verify", {}, 8 * KB),
    rule("POST", "/api/admin/auth/password/confirm", {}, 8 * KB),
    rule("POST", "/api/admin/auth/password", {}, 8 * KB),
    rule("GET", "/api/admin/itinerary/trips"),
    rule("GET", `/api/admin/trips/${UUID}/itinerary`),
    rule("POST", `/api/admin/trips/${UUID}/itinerary`, {}, 8 * KB),
    rule("PATCH", `/api/admin/trips/${UUID}/itinerary/${UUID}`, {}, 8 * KB),
    // Manage Trip: trip documents (itinerary PDF, insurance, transport) and school logo.
    rule("GET", `/api/admin/trips/${UUID}/documents`),
    rule("POST", `/api/admin/trips/${UUID}/documents`, DOC_UPLOAD, 10 * MB),
    rule("GET", `/api/admin/trips/${UUID}/documents/${UUID}`),
    rule("DELETE", `/api/admin/trips/${UUID}/documents/${UUID}`),
    rule("GET", `/api/admin/trips/${UUID}/school-logo`),
    rule("PUT", `/api/admin/trips/${UUID}/school-logo`, {}, 512 * KB),
  ],
};

export const API_ROLES = Object.freeze(Object.keys(POLICIES));

// A request target is checked as the client SENT it, before any URL parsing could normalise it. An allowed path is only
// letters, digits, hyphens and single slashes: no dot (so no dot segment), no percent sign (so no encoded anything), no
// backslash, semicolon, control or non-ASCII character, no empty segment, no trailing slash. Express routes case-insensitively
// and tolerates a trailing slash, so those spellings are refused here rather than forwarded.
const SAFE_PATH = /^(?:\/[A-Za-z0-9-]+)+$/;
const MAX_TARGET = 700;
// Values may include dots and underscores (file extensions, identifiers), `+` (URLSearchParams-encoded space) and `*` (kept
// as-is by URLSearchParams). Per-key patterns narrow further; this only rejects obviously unsafe characters.
const QUERY_ENTRY = /^([a-z]{1,16})=([A-Za-z0-9._*+-]{1,200})$/;

const DENY = Object.freeze({ ok: false });

/**
 * Is this call allowed for this portal role? `rawTarget` is the request target exactly as received (path and query).
 * Returns { ok: true, target, maxBody } where `target` is the canonical path and query to forward (identical to what was checked)
 * and `maxBody` the most request-body bytes this route may carry, or { ok: false }.
 */
export function checkApiTarget(role, method, rawTarget) {
  const rules = POLICIES[role];
  if (!rules || typeof method !== "string" || typeof rawTarget !== "string" || rawTarget.length === 0 || rawTarget.length > MAX_TARGET) return DENY;

  const q = rawTarget.indexOf("?");
  const path = q === -1 ? rawTarget : rawTarget.slice(0, q);
  const rawQuery = q === -1 ? null : rawTarget.slice(q + 1);
  if (!SAFE_PATH.test(path)) return DENY;

  const matched = rules.find((r) => r.method === method && r.re.test(path));
  if (!matched) return DENY;

  if (rawQuery === null) return { ok: true, target: path, maxBody: matched.maxBody };
  const names = Object.keys(matched.query);
  if (names.length === 0 || rawQuery === "") return DENY;
  const seen = new Set();
  const pairs = [];
  for (const part of rawQuery.split("&")) {
    const m = QUERY_ENTRY.exec(part);
    if (!m || !names.includes(m[1]) || seen.has(m[1]) || !matched.query[m[1]].test(m[2])) return DENY;
    seen.add(m[1]);
    pairs.push(`${m[1]}=${m[2]}`);
  }
  return { ok: true, target: `${path}?${pairs.join("&")}`, maxBody: matched.maxBody };
}

/**
 * Does this request target mean the API, in any spelling a client could use (any case, encoded, backslash, path parameter)?
 * A website path like /apix is not. Used so that nothing that looks like an API call is ever served as a web page or
 * forwarded unchecked.
 */
export function looksLikeApi(rawTarget) {
  if (typeof rawTarget !== "string") return false;
  const test = (s) => /^\/api(?:$|[/?#\\;%])/i.test(s);
  const path = rawTarget.split("?")[0];
  const candidates = [rawTarget];
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  };
  candidates.push(decode(path));
  try {
    // what a URL parser would make of it (it resolves dot segments, encoded ones included), and that decoded
    const normalised = new URL(rawTarget, "http://x").pathname;
    candidates.push(normalised, decode(normalised));
  } catch {
    /* not parseable: judged by the other spellings */
  }
  if (candidates.some((c) => typeof c === "string" && test(c))) return true;
  return /^\/(?:%61|a)(?:%70|p)(?:%69|i)(?:$|[/?#\\;%])/i.test(rawTarget);
}
