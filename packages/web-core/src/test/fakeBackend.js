// A stateful stand-in for the backend, for UI tests. It follows the real API contract and
// reuses the REAL validation and progress code from the backend (so the UI is tested against
// the server's own rules), but keeps everything in memory.
import { vi } from "vitest";
import { definitionsFor, getDefinition } from "../../../../apps/api/src/modules/onboarding/definitions.js";
import { resetConfirmSchema } from "../../../../apps/api/src/modules/auth/routes.js";
import { registrationSchema } from "../../../../apps/api/src/modules/registrations/validation.js";
import { submitSchema } from "../../../../apps/api/src/modules/onboarding/routes.js";
import { CURRENT_DECLARATION } from "../../../../apps/api/src/modules/onboarding/declaration.js";
import { applyComputed, checkDraft, computeProgress, validateForm } from "../../../../apps/api/src/modules/onboarding/engine.js";
import { CHALLENGE, TOKEN, VERIFIED, apiError, reply } from "./helpers.js";

export const USER = { email: "parent@example.com", firstName: "Asha", lastName: "Rao", role: "Student" };
const ROLE_KEYS = { Student: "student", Teacher: "teacher", "Team Leader": "team_leader" };

export const PASSWORD = "correct-horse-battery";

/** The one public trip page the fake server knows: { address: { school, branch, trip }, school, title, destination, tourType, open }. */
export const FAKE_REFERENCE = "YE-ABCDEF12";
export const FAKE_PDF = "%PDF-1.3 fake registration";

export function createFakeBackend({ user = USER, signedIn = false, form = null, accounts = [], passwords = {}, join = null } = {}) {
  const state = {
    user,
    signedIn,
    form, // the single stored form row for this user, or null
    accounts: new Set(accounts),
    passwords: new Map(Object.entries(passwords)), // email -> password, for the password sign-in
    calls: [],
    queued: {}, // "METHOD /url" -> responses (or functions) consumed before normal handling
    saveDelayMs: 0,
    join, // the one public trip page this fake server accepts at registration
    trip: null, // the trip the signed-in account is currently enrolled in
    pastForms: [], // forms from earlier enrolments
    currentId: null, // the current trip enrolment's id (like the real trip_enrolments.id)
    others: {}, // earlier enrolments: id -> { trip, form }
    seq: 0,
    // Where the submitted registration's PDF stands, like the server: "stored" | "pending" | "failed" | "not_configured".
    // `pdfAfterSubmit` is what a fresh submission starts as; `pdfPollsUntilStored` makes "pending" turn into "stored"
    // after that many status checks (the background upload finishing).
    pdfStatus: "stored",
    // Like the server's 15-minute access token: when expired, protected requests answer 401 until the page renews.
    accessExpired: false,
    refreshOk: true, // false: the sign-in is over, so renewal is refused
    submissions: 0, // how many submissions the "server" actually processed
    pdfAfterSubmit: "stored",
    // Live location, like the server (one trip, the current enrolment): `live.teamLead` is null for a parent, or
    // { canShare } for the team lead staff chose; `liveSends` records every position the "server" stored.
    live: { state: "not_started", location: null, sharingSince: null, teamLead: null, tripActive: true },
    liveSends: [],
    pdfPollsUntilStored: 0,
    // The itinerary Sales keep for the current trip, as the server returns it (read-only for the participant).
    itinerary: [],
  };
  /** Live location answers only for the caller's own current enrolment, like the server (anything else: 404). */
  const liveScope = (id, fn) => (id && id === state.currentId ? fn() : apiError(404, "NOT_FOUND"));
  const liveView = () => ({
    trip: state.trip && { title: state.trip.title, destination: state.trip.destination ?? null, school: state.trip.school, branch: state.trip.branch ?? null, status: state.live.tripActive ? "active" : "closed" },
    state: state.live.tripActive ? state.live.state : "ended",
    location: state.live.tripActive ? state.live.location : null,
    sharingSince: state.live.sharingSince,
    teamLead: state.live.teamLead ? { canShare: state.live.tripActive, sharingHere: Boolean(state.live.sharingHere) } : null,
    policy: { updateIntervalSeconds: 300, staleAfterSeconds: 720 },
    serverTime: new Date().toISOString(),
  });
  const newId = () => `00000000-0000-4000-9000-${String(++state.seq).padStart(12, "0")}`;
  const payment = (t) => (t?.paymentMode === "payment" ? { required: true, status: "not_configured" } : { required: false, status: "not_required" });
  const isJoin = (a) => Boolean(state.join && a && ["school", "branch", "trip"].every((k) => a[k] === state.join.address[k]));
  // Like the real server's trip view: the school's own address words and (when the server still holds one) its logo address.
  const tripBody = (t) => t && { school: t.school, branch: t.branch ?? null, schoolLogo: t.schoolLogo ?? null, address: t.address ?? null, title: t.title, destination: t.destination ?? null, academicYear: t.academicYear ?? null, tourType: t.tourType, payment: payment(t) };
  /** Like the real server: run a handler against ONE of the caller's registrations; anyone else's id is not found. */
  const inScope = (id, fn) => {
    // "legacy" is the trip-less form, which this fake keeps as the current form when there is no trip enrolment
    if (!id || id === state.currentId || (id === "legacy" && !state.currentId)) return fn();
    const other = state.others[id];
    if (!other) return apiError(404, "REGISTRATION_NOT_FOUND");
    const saved = { form: state.form, trip: state.trip };
    state.form = other.form;
    state.trip = other.trip;
    try {
      return fn();
    } finally {
      other.form = state.form;
      state.form = saved.form;
      state.trip = saved.trip;
    }
  };
  const role = () => ROLE_KEYS[state.user.role];
  const row = (f) => ({ ...f, progress: computeProgress(getDefinition(f.tourType, f.role), f.data) });

  const handlers = {
    "GET /api/auth/session": () =>
      state.signedIn ? reply(200, { authenticated: true, user: state.user }) : apiError(401, "UNAUTHENTICATED", { renewable: false }),
    "POST /api/email-otp/send": () => reply(200, CHALLENGE),
    "POST /api/email-otp/resend": () => reply(200, CHALLENGE),
    "POST /api/email-otp/verify": () => reply(200, VERIFIED),
    "POST /api/registrations": (raw) => {
      // The REAL server-side rules: a sent school, a short password or a mismatch is a 400 here too.
      const parsed = registrationSchema.safeParse(raw);
      if (!parsed.success) {
        return apiError(400, "VALIDATION_ERROR", { fields: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      }
      const body = parsed.data;
      // Like the real server: a trip that was sent must be public and open, or nothing is created.
      if (body.publicTrip !== undefined) {
        if (!isJoin(body.publicTrip)) return apiError(404, "TRIP_NOT_FOUND");
        if (state.join.open === false) return apiError(409, "TRIP_NOT_OPEN");
      }
      if (state.accounts.has(body.email)) return apiError(409, "EMAIL_ALREADY_REGISTERED");
      state.trip = body.publicTrip !== undefined ? state.join : null;
      state.currentId = state.trip ? newId() : null;
      state.accounts.add(body.email);
      state.passwords.set(body.email, body.password);
      state.user = { email: body.email, firstName: body.firstName, lastName: body.lastName, role: body.role };
      state.signedIn = true;
      return reply(201, { registered: true, registrationId: "8f0c2d3e-1111-4222-8333-444455556666", email: body.email });
    },
    "POST /api/auth/login": (body) => {
      if (!state.accounts.has(body.email) && body.email !== state.user.email) return apiError(404, "ACCOUNT_NOT_FOUND");
      state.signedIn = true;
      return reply(200, { authenticated: true, user: state.user });
    },
    "POST /api/auth/login/password": (body) => {
      const known = state.passwords.get(body.email);
      if (known === undefined || known !== body.password) return apiError(401, "INVALID_CREDENTIALS");
      state.signedIn = true;
      return reply(200, { authenticated: true, user: state.user });
    },
    "POST /api/auth/password-reset/request": () => reply(200, CHALLENGE),
    "POST /api/auth/password-reset/resend": () => reply(200, CHALLENGE),
    "POST /api/auth/password-reset/verify": () => reply(200, VERIFIED),
    "POST /api/auth/password-reset/confirm": (raw) => {
      // The REAL server-side rules for the new password.
      const parsed = resetConfirmSchema.safeParse(raw);
      if (!parsed.success) {
        return apiError(400, "VALIDATION_ERROR", { fields: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      }
      const body = parsed.data;
      if (!state.accounts.has(body.email) && body.email !== state.user.email) return apiError(403, "VERIFICATION_REQUIRED");
      state.passwords.set(body.email, body.password);
      state.signedIn = false; // every session is revoked; no new one is created
      return reply(200, { passwordChanged: true });
    },
    // Like the real server: the trip must be public and open, then the person has a new (empty) form for that trip.
    "POST /api/enrolments": (body) => {
      if (!body || Object.keys(body).join() !== "trip" || !isJoin(body.trip)) return body?.trip ? apiError(404, "TRIP_NOT_FOUND") : apiError(400, "VALIDATION_ERROR");
      if (state.join.open === false) return apiError(409, "TRIP_NOT_OPEN");
      const created = state.trip !== state.join;
      if (created) {
        if (state.form) state.pastForms.push(state.form); // earlier years are kept, never replaced
        if (state.currentId) state.others[state.currentId] = { trip: state.trip, form: state.form };
        state.form = null;
        state.trip = state.join;
        state.currentId = newId();
      }
      return reply(created ? 201 : 200, { enrolled: true, created, enrolmentId: state.currentId, trip: { school: state.join.school, title: state.join.title } });
    },
    "GET /api/enrolments": () => {
      const item = (id, trip, f) => ({ id, ...tripBody(trip), form: f ? { status: f.status, progress: row(f).progress.percent, submittedAt: f.submittedAt } : null });
      const list = state.currentId ? [item(state.currentId, state.trip, state.form)] : [];
      for (const [id, o] of Object.entries(state.others).reverse()) list.push(item(id, o.trip, o.form));
      return reply(200, { enrolments: list, legacy: null });
    },
    // Like the real server (enrolments service.resume): none / one / several, never "the newest".
    "GET /api/enrolments/resume": () => {
      const status = (f) => (f ? f.status : "not_started");
      const all = [];
      if (state.currentId) all.push({ id: state.currentId, ...tripBody(state.trip), status: status(state.form) });
      for (const [id, o] of Object.entries(state.others).reverse()) all.push({ id, ...tripBody(o.trip), status: status(o.form) });
      if (!state.currentId && state.form) all.push({ id: "legacy", school: null, branch: null, title: null, status: state.form.status });
      if (all.length === 0) return reply(200, { status: "none" });
      if (all.length === 1) return reply(200, { status: "one", enrolmentId: all[0].id });
      return reply(200, { status: "several" });
    },
    "POST /api/auth/refresh": () => {
      if (!state.signedIn || !state.refreshOk) {
        state.signedIn = false;
        return apiError(401, "UNAUTHENTICATED");
      }
      state.accessExpired = false;
      return reply(200, { authenticated: true, user: state.user });
    },
    "POST /api/auth/logout": () => {
      state.signedIn = false;
      return reply(200, { authenticated: false });
    },
    "GET /api/onboarding": (body, query) => inScope(query.get("enrolment"), () =>
      reply(200, {
        role: role(),
        definitions: definitionsFor(role()),
        form: state.form && row(state.form),
        // Only once submitted, like the server: the account holder's own details and where the PDF stands.
        ...(state.form?.status === "submitted"
          ? { account: { name: `${state.user.firstName} ${state.user.lastName}`, role: state.user.role, email: state.user.email, phone: "9876543210" }, pdf: { status: state.pdfStatus } }
          : {}),
        trip: tripBody(state.trip),
        declaration: { version: CURRENT_DECLARATION.version, text: CURRENT_DECLARATION.text },
        enrolmentId: state.trip ? (query.get("enrolment") ?? state.currentId) : null,
      })),
    "PUT /api/onboarding": (body) => inScope(body.enrolmentId, () => {
      if (state.trip && state.trip.tourType !== body.tourType) return apiError(409, "TOUR_FIXED_BY_TRIP", { tourType: state.trip.tourType });
      const def = getDefinition(body.tourType, role());
      let data;
      try {
        data = applyComputed(def, checkDraft(def, body.data)); // like the server: the age is worked out from the DOB
      } catch (err) {
        return apiError(400, err.code, err.details);
      }
      if (!state.form) {
        if (body.version !== null) return apiError(409, "VERSION_CONFLICT", { currentVersion: 0 });
        state.form = { tourType: body.tourType, role: role(), status: "draft", data, currentSection: body.currentSection ?? null, version: 1, updatedAt: new Date().toISOString(), submittedAt: null };
      } else {
        if (state.form.status === "submitted") return apiError(409, "FORM_SUBMITTED");
        if (body.version !== state.form.version) return apiError(409, "VERSION_CONFLICT", { currentVersion: state.form.version });
        state.form = { ...state.form, data, currentSection: body.currentSection ?? null, version: state.form.version + 1, updatedAt: new Date().toISOString() };
      }
      return reply(200, { form: row(state.form) });
    }),
    "POST /api/onboarding/submit": (raw) => inScope(raw.enrolmentId, () => {
      // The REAL server-side rules: the declaration must be accepted and a signature typed.
      const parsed = submitSchema.safeParse(raw);
      if (!parsed.success) {
        return apiError(400, "VALIDATION_ERROR", { fields: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      }
      const body = parsed.data;
      if (!state.form) return apiError(404, "NO_DRAFT");
      if (state.form.status === "submitted") return apiError(409, "ALREADY_SUBMITTED");
      if (body.version !== state.form.version) return apiError(409, "VERSION_CONFLICT", { currentVersion: state.form.version });
      const errors = validateForm(getDefinition(state.form.tourType, state.form.role), state.form.data);
      if (Object.keys(errors).length) {
        return apiError(422, "FORM_INCOMPLETE", { fields: Object.entries(errors).map(([path, message]) => ({ path: `data.${path}`, message })) });
      }
      const now = new Date().toISOString(); // the "server's" time, never the client's
      state.form = {
        ...state.form, status: "submitted", version: state.form.version + 1, submittedAt: now, currentSection: "review",
        acknowledgement: { declarationVersion: body.declarationVersion, acceptedAt: now, signatureName: body.signatureName },
        reference: FAKE_REFERENCE,
      };
      state.pdfStatus = state.pdfAfterSubmit;
      state.submissions++;
      return reply(200, { form: row(state.form), pdf: { status: state.pdfStatus } });
    }),
    // The PDF, like the server: a draft has none (409); a stored copy downloads; a pending or failed one does not.
    "GET /api/onboarding/pdf": (body, query) => inScope(query.get("enrolment"), () => {
      if (state.form?.status !== "submitted") return apiError(409, "FORM_NOT_SUBMITTED");
      if (state.pdfStatus === "pending" || state.pdfStatus === "failed") return apiError(409, "PDF_NOT_READY", { status: state.pdfStatus });
      return new Response(FAKE_PDF, {
        status: 200,
        headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="young-edsplorer-registration-${FAKE_REFERENCE}.pdf"` },
      });
    }),
    "GET /api/onboarding/pdf/status": (body, query) => inScope(query.get("enrolment"), () => {
      if (state.form?.status !== "submitted") return apiError(409, "FORM_NOT_SUBMITTED");
      if (state.pdfStatus === "pending" && state.pdfPollsUntilStored > 0 && --state.pdfPollsUntilStored === 0) state.pdfStatus = "stored";
      return reply(200, { pdf: { status: state.pdfStatus } });
    }),
    "POST /api/onboarding/pdf/retry": (raw) => inScope(raw.enrolmentId, () => {
      if (state.form?.status !== "submitted") return apiError(409, "FORM_NOT_SUBMITTED");
      if (state.pdfStatus === "failed") state.pdfStatus = "pending";
      return reply(state.pdfStatus === "pending" ? 202 : 200, { pdf: { status: state.pdfStatus } });
    }),
    "GET /api/live-location": (body, query) => liveScope(query.get("enrolment"), () => reply(200, liveView())),
    "POST /api/live-location/start": (body) => liveScope(body.enrolmentId, () => {
      if (!state.live.teamLead) return apiError(403, "NOT_TEAM_LEAD");
      if (!state.live.tripActive) return apiError(409, "TRIP_NOT_ACTIVE");
      if (!state.live.sharingHere) Object.assign(state.live, { state: "waiting", location: null, sharingSince: new Date().toISOString(), sharingHere: true });
      return reply(200, liveView());
    }),
    "POST /api/live-location/location": (body) => liveScope(body.enrolmentId, () => {
      if (!state.live.teamLead) return apiError(403, "NOT_TEAM_LEAD");
      if (!state.live.tripActive) return apiError(409, "TRIP_NOT_ACTIVE");
      if (!state.live.sharingHere) return apiError(409, "NOT_SHARING");
      state.liveSends.push(body);
      Object.assign(state.live, { state: "live", location: { latitude: body.latitude, longitude: body.longitude, accuracyM: body.accuracy ?? null, capturedAt: body.capturedAt, receivedAt: new Date().toISOString() } });
      return reply(200, liveView());
    }),
    "POST /api/live-location/stop": (body) => liveScope(body.enrolmentId, () => {
      if (!state.live.teamLead) return apiError(403, "NOT_TEAM_LEAD");
      Object.assign(state.live, { state: "stopped", location: null, sharingSince: null, sharingHere: false });
      return reply(200, liveView());
    }),
    "DELETE /api/onboarding": (body, query) => inScope(query.get("enrolment"), () => {
      if (state.form?.status === "submitted") return apiError(409, "FORM_SUBMITTED");
      state.form = null;
      return reply(200, { form: null });
    }),
  };

  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = init.method ?? "GET";
    const [path, qs = ""] = String(url).split("?");
    const key = `${method} ${path}`;
    const query = new URLSearchParams(qs);
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ method, url, body, key, init });
    const queued = state.queued[key]?.shift();
    if (queued !== undefined) return typeof queued === "function" ? queued(body) : queued;
    const open = /^\/api\/(auth\/(login|logout|refresh|password-reset)|email-otp\/|registrations|join\/)/.test(path);
    if (state.accessExpired && !open) return apiError(401, "UNAUTHENTICATED");
    // the public page lookup, like the real server: only the one trip page this fake knows resolves
    if (method === "GET" && url.startsWith("/api/join/")) {
      const [school, branch, trip, extra] = url.slice("/api/join/".length).split("/").map(decodeURIComponent);
      const j = state.join;
      return extra === undefined && isJoin({ school, branch, trip })
        ? reply(200, { school: { name: j.school }, trip: { title: j.title, destination: j.destination ?? null, tourType: j.tourType }, registrationOpen: j.open !== false })
        : apiError(404, "TRIP_NOT_FOUND");
    }
    // The participant's itinerary: only for the caller's OWN current enrolment, like the server (anyone else's id: 404).
    const itin = method === "GET" && /^\/api\/enrolments\/([^/]+)\/itinerary$/.exec(path);
    if (itin) {
      return decodeURIComponent(itin[1]) === state.currentId && state.trip
        ? reply(200, { trip: { title: state.trip.title, destination: state.trip.destination ?? null }, items: state.itinerary })
        : apiError(404, "NOT_FOUND");
    }
    const handler = handlers[key];
    if (!handler) throw new Error(`Unexpected fetch: ${key}`);
    if (state.saveDelayMs && key === "PUT /api/onboarding") await new Promise((r) => setTimeout(r, state.saveDelayMs));
    return handler(body, query);
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    state,
    fetchMock,
    /** Responses to return (once each, in order) for a request, ahead of normal handling. */
    queue: (key, ...responses) => {
      state.queued[key] = [...(state.queued[key] ?? []), ...responses];
    },
    calls: (key) => state.calls.filter((c) => !key || c.key === key),
    saves: () => state.calls.filter((c) => c.key === "PUT /api/onboarding"),
    TOKEN,
  };
}
