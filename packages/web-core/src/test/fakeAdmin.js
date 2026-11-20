// A stateful stand-in for the Sales staff API (sign-in, password, itinerary) and the public trip page lookup, for UI tests. It follows the real
// API contract (same paths, bodies, error codes and role rules) but keeps everything in memory.
import { vi } from "vitest";
import { apiError, reply } from "./helpers.js";

export const STAFF = { sales: { email: "sales@example.com", name: "Sam Sales", role: "sales" } };
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";


let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;


// `hosts`: template key -> that portal's origin, like the server's per-template link hosts (a null value means none is configured).
export function createFakeAdmin({ role = "sales", signedIn = true, schools = [], trips = [], joinResponses = {}, team, hosts } = {}) {
  const me = { id: id(), ...STAFF[role], status: "active", hasPassword: true };
  const state = {
    staff: STAFF[role], signedIn, schools: [...schools], trips: [...trips], calls: [], queued: {}, joinResponses, hosts,
    // everyone on the staff list: the signed-in person (an admin or sales) plus whoever the test adds
    team: team ?? [{ id: id(), ...STAFF.admin, status: "active", hasPassword: true }, ...(role === "sales" ? [me] : [])],
    live: {}, // tripId -> { candidates, teamLeadEnrolmentId, state, location }
    itinerary: {}, // tripId -> items
    assignments: [], // { staffId, tripId }: which Sales accounts may keep which trip's itinerary
    deployments: {}, // templateKey -> tripId
    // Like the server's 15-minute access token: when expired, protected requests answer 401 until the page renews.
    accessExpired: false,
    refreshOk: true, // false: the sign-in is over (inactivity/absolute limit, revoked), so renewal is refused
  };
  const school = (sid) => state.schools.find((s) => s.id === sid);
  // Like the server: the address words are fixed when the school and trip are made (never recomputed on a rename).
  const hostOf = (t) => (state.hosts && Object.hasOwn(state.hosts, t.templateKey) ? state.hosts[t.templateKey] : "https://parents.example.test");
  const withSchool = (t) => {
    const s = school(t.schoolId);
    const publicPath = `/join/${s?.slug ?? slug(s?.name ?? "school")}/${s?.branchSlug ?? (s?.branch ? slug(s.branch) : "main")}/${t.slug ?? slug(t.title)}`;
    return { ...t, schoolName: s?.name, schoolBranch: s?.branch ?? null, publicRegistration: t.publicRegistration ?? false, publicPath, publicUrl: hostOf(t) ? `${hostOf(t)}${publicPath}` : null };
  };
  // Like the server: admins reach every trip's itinerary; Sales only trips an admin assigned to them.
  const canItinerary = (tripId) => state.staff.role === "admin" || state.assignments.some((a) => a.staffId === me.id && a.tripId === tripId);
  const needStaff = (fn) => (m, body) => (state.signedIn ? fn(m, body) : apiError(401, "UNAUTHENTICATED"));

  const routes = [
    ["GET", /^\/api\/admin\/auth\/session$/, () => (state.signedIn ? reply(200, { authenticated: true, staff: state.staff }) : apiError(401, "UNAUTHENTICATED", { renewable: false }))],
    ["POST", /^\/api\/admin\/auth\/login$/, (m, b) => {
      if (b.email !== state.staff.email || b.password !== "right-staff-password") return apiError(401, "INVALID_CREDENTIALS");
      state.signedIn = true;
      return reply(200, { authenticated: true, staff: state.staff });
    }],
    ["POST", /^\/api\/admin\/auth\/refresh$/, () => {
      if (!state.signedIn || !state.refreshOk) {
        state.signedIn = false;
        return apiError(401, "UNAUTHENTICATED");
      }
      state.accessExpired = false;
      return reply(200, { authenticated: true, staff: state.staff });
    }],
    ["POST", /^\/api\/admin\/auth\/logout$/, () => {
      state.signedIn = false;
      return reply(200, { authenticated: false });
    }],
    ["GET", /^\/api\/admin\/itinerary\/trips$/, needStaff(() => reply(200, {
      trips: state.trips.filter((t) => t.status !== "archived" && canItinerary(t.id)).map((t) => {
        const w = withSchool(t);
        return { id: t.id, title: t.title, destination: t.destination ?? null, academicYear: t.academicYear ?? null, tourType: t.tourType, status: t.status, schoolName: w.schoolName, schoolBranch: w.schoolBranch, itineraryCount: (state.itinerary[t.id] ?? []).length };
      }),
    }))],
    ["GET", /^\/api\/admin\/trips\/([^/]+)\/itinerary$/, needStaff((m) => {
      if (!canItinerary(m[1])) return apiError(state.staff.role === "admin" ? 404 : 403, state.staff.role === "admin" ? "NOT_FOUND" : "FORBIDDEN");
      return reply(200, { items: [...(state.itinerary[m[1]] ?? [])].sort((a, b) => a.dayNumber - b.dayNumber) });
    })],
    ["POST", /^\/api\/admin\/trips\/([^/]+)\/itinerary$/, needStaff((m, b) => {
      if (!canItinerary(m[1])) return apiError(state.staff.role === "admin" ? 404 : 403, state.staff.role === "admin" ? "NOT_FOUND" : "FORBIDDEN");
      if (!Number.isInteger(b.dayNumber) || b.dayNumber < 1 || b.dayNumber > 366 || typeof b.title !== "string" || !b.title.trim()) return apiError(400, "VALIDATION_ERROR", { fields: [{ path: "title", message: "Title is required." }] });
      const item = { id: id(), tripId: m[1], dayNumber: b.dayNumber, position: 0, title: b.title.trim(), details: b.details ?? null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      (state.itinerary[m[1]] ??= []).push(item);
      return reply(201, { item });
    })],
    ["PATCH", /^\/api\/admin\/trips\/([^/]+)\/itinerary\/([^/]+)$/, needStaff((m, b) => {
      if (!canItinerary(m[1])) return apiError(state.staff.role === "admin" ? 404 : 403, state.staff.role === "admin" ? "NOT_FOUND" : "FORBIDDEN");
      const item = (state.itinerary[m[1]] ?? []).find((x) => x.id === m[2]);
      if (!item) return apiError(404, "NOT_FOUND");
      Object.assign(item, b, { updatedAt: new Date().toISOString() });
      return reply(200, { item });
    })],
    ["POST", /^\/api\/admin\/auth\/password\/(request|resend)$/, () => reply(200, { expiresInSeconds: 900, resendAvailableInSeconds: 30, delivery: "smtp", alreadySent: false })],
    ["POST", /^\/api\/admin\/auth\/password\/verify$/, (m, b) =>
      b.code === "123456" ? reply(200, { verified: true, verificationToken: "STAFFVERIFYTOKEN", verificationTokenExpiresInSeconds: 900 }) : apiError(400, "INVALID_CODE", { attemptsRemaining: 4 })],
    ["POST", /^\/api\/admin\/auth\/password\/confirm$/, (m, b) => {
      if (b.verificationToken !== "STAFFVERIFYTOKEN") return apiError(403, "VERIFICATION_REQUIRED");
      if (typeof b.password !== "string" || b.password.length < 10 || b.password !== b.confirmPassword) return apiError(400, "VALIDATION_ERROR", { fields: [{ path: "password", message: "Password must be at least 10 characters." }] });
      const p = state.team.find((x) => x.email === b.email);
      const firstTime = Boolean(p && !p.hasPassword);
      if (p) {
        p.hasPassword = true;
        if (p.status === "pending") p.status = "active";
      }
      return reply(200, { passwordSet: true, firstTime });
    }],
    ["POST", /^\/api\/admin\/auth\/password$/, needStaff((m, b) =>
      b.currentPassword === "right-staff-password" ? reply(200, { passwordChanged: true }) : apiError(400, "CURRENT_PASSWORD_INCORRECT"))],
    ["GET", /^\/api\/join\/([^/]+\/[^/]+\/[^/]+)$/, (m) => {
      const r = state.joinResponses[decodeURIComponent(m[1])];
      return r ? (typeof r === "function" ? r() : r.clone()) : apiError(404, "TRIP_NOT_FOUND");
    }],
    ["GET", /^\/api\/auth\/session$/, () => apiError(401, "UNAUTHENTICATED")],

  ];

  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body; // a logo upload sends the raw file
    state.calls.push({ method, url, body, key: `${method} ${url}`, headers: init.headers });
    const queued = state.queued[`${method} ${url}`]?.shift();
    if (queued !== undefined) return typeof queued === "function" ? queued(body) : queued;
    // Like the server: a Sales account reaches the itinerary routes and its own sign-in routes, and nothing else under /api/admin.
    if (state.signedIn && state.staff.role === "sales" && url.startsWith("/api/admin/") && !/^\/api\/admin\/(auth\/|itinerary\/trips$|trips\/[^/]+\/itinerary(\/[^/]+)?$)/.test(url)) return apiError(403, "FORBIDDEN");
    if (state.accessExpired && url.startsWith("/api/admin/") && !/^\/api\/admin\/auth\/(login|logout|refresh|password\/)/.test(url)) return apiError(401, "UNAUTHENTICATED");
    for (const [m, pattern, fn] of routes) {
      const match = m === method && pattern.exec(url);
      if (match) return fn(match, body);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    state,
    fetchMock,
    queue: (key, ...responses) => {
      state.queued[key] = [...(state.queued[key] ?? []), ...responses];
    },
    calls: (re) => state.calls.filter((c) => !re || re.test(c.key)),
    /** Assigns the signed-in Sales account (or the given staff id) to a trip, as an admin would. */
    assign: (tripId, staffId = me.id) => state.assignments.push({ staffId, tripId }),
    me,
    addSchool: (over = {}) => {
      // made by whoever is signed in, unless the test says otherwise (createdBy: "someone@else")
      const s = { id: id(), name: "Greenfield Public School", status: "active", createdAt: new Date().toISOString(), archivedAt: null, logoUrl: null, createdBy: state.staff.email, ...over };
      state.schools.push(s);
      return s;
    },
    addTrip: (schoolId, over = {}) => {
      const t = { id: id(), schoolId, title: "Winter Trip", tourType: "domestic", destination: "Manali", paymentMode: "none", status: "draft", templateKey: "domestic_none", opensAt: null, closesAt: null, createdAt: new Date().toISOString(), ...over };
      state.trips.push(t);
      return t;
    },
  };
}
