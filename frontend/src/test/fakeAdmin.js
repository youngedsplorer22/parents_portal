// A stateful stand-in for the staff API and the public trip page lookup, for UI tests. It follows the real
// API contract (same paths, bodies, error codes and role rules) but keeps everything in memory.
import { vi } from "vitest";
import { apiError, reply } from "./helpers.js";

export const STAFF = { admin: { email: "admin@example.com", name: "Alex Admin", role: "admin" }, sales: { email: "sales@example.com", name: "Sam Sales", role: "sales" } };
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";

// What the real API shows of a staff row: never whether/what the password is, only the status.
const publicStaff = (p) => ({ id: p.id, email: p.email, name: p.name, role: p.role, status: p.status });

let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const TRANSITIONS = {
  draft: { active: ["admin", "sales"], archived: ["admin"] },
  active: { closed: ["admin", "sales"], archived: ["admin"] },
  closed: { active: ["admin"], archived: ["admin"] },
  archived: {},
};

export function createFakeAdmin({ role = "admin", signedIn = true, schools = [], trips = [], joinResponses = {}, team } = {}) {
  const me = { id: id(), ...STAFF[role], status: "active", hasPassword: true };
  const state = {
    staff: STAFF[role], signedIn, schools: [...schools], trips: [...trips], calls: [], queued: {}, joinResponses,
    // everyone on the staff list: the signed-in person (an admin or sales) plus whoever the test adds
    team: team ?? [{ id: id(), ...STAFF.admin, status: "active", hasPassword: true }, ...(role === "sales" ? [me] : [])],
    live: {}, // tripId -> { candidates, teamLeadEnrolmentId, state, location }
    // Like the server's 15-minute access token: when expired, protected requests answer 401 until the page renews.
    accessExpired: false,
    refreshOk: true, // false: the sign-in is over (inactivity/absolute limit, revoked), so renewal is refused
  };
  const adminOnly = (fn) => needStaff((m, b) => (state.staff.role === "admin" ? fn(m, b) : apiError(403, "FORBIDDEN")));
  const school = (sid) => state.schools.find((s) => s.id === sid);
  const mine = (s) => Boolean(s) && (state.staff.role === "admin" || s.createdBy === state.staff.email);
  // Like the server: the address words are fixed when the school and trip are made (never recomputed on a rename).
  const withSchool = (t) => {
    const s = school(t.schoolId);
    const publicPath = `/join/${s?.slug ?? slug(s?.name ?? "school")}/${s?.branchSlug ?? (s?.branch ? slug(s.branch) : "main")}/${t.slug ?? slug(t.title)}`;
    return { ...t, schoolName: s?.name, schoolBranch: s?.branch ?? null, publicRegistration: t.publicRegistration ?? false, publicPath, publicUrl: `https://parents.example.test${publicPath}` };
  };
  const liveOf = (t) => (state.live[t.id] ??= { state: "not_started", location: null, sharingSince: null, teamLeadEnrolmentId: null, candidates: [], policy: { updateIntervalSeconds: 300, staleAfterSeconds: 720 }, serverTime: new Date().toISOString() });
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
    // Like the server: a salesperson manages only schools they created (and those schools' trips); an admin, all.
    ["GET", /^\/api\/admin\/schools(\?includeArchived=true)?$/, needStaff((m) => reply(200, {
      schools: state.schools.filter((s) => (m[1] || s.status === "active") && mine(s)).map((s) => ({ ...s, tripCount: state.trips.filter((t) => t.schoolId === s.id).length })),
    }))],
    ["POST", /^\/api\/admin\/schools$/, needStaff((m, b) => {
      const key = (n, br) => `${String(n).trim().toLowerCase()}|${String(br ?? "").trim().toLowerCase()}`;
      if (state.schools.some((s) => key(s.name, s.branch) === key(b.name, b.branch))) return apiError(409, "SCHOOL_EXISTS");
      const s = { id: id(), name: b.name.trim(), branch: b.branch ? b.branch.trim() : null, status: "active", createdAt: new Date().toISOString(), archivedAt: null, createdBy: state.staff.email };
      state.schools.push(s);
      return reply(201, { school: s });
    })],
    ["PATCH", /^\/api\/admin\/schools\/([^/]+)$/, needStaff((m, b) => {
      if (state.staff.role !== "admin") return apiError(403, "FORBIDDEN");
      const s = school(m[1]);
      if (!s) return apiError(404, "NOT_FOUND");
      Object.assign(s, b.name ? { name: b.name } : {}, b.status ? { status: b.status } : {}, "branch" in b ? { branch: b.branch ? b.branch.trim() : null } : {});
      return reply(200, { school: s });
    })],
    ["GET", /^\/api\/admin\/trips(?:\?schoolId=([^&]+))?$/, needStaff((m) => reply(200, { trips: state.trips.filter((t) => (!m[1] || t.schoolId === m[1]) && mine(school(t.schoolId))).map(withSchool) }))],
    ["GET", /^\/api\/admin\/trips\/([^/]+)$/, needStaff((m) => {
      const t = state.trips.find((x) => x.id === m[1]);
      return t && mine(school(t.schoolId)) ? reply(200, { trip: withSchool(t) }) : apiError(404, "NOT_FOUND");
    })],
    // Live location (like the server): per trip, the Team Leader registrations staff can choose from, and who is chosen.
    ["GET", /^\/api\/admin\/trips\/([^/]+)\/live-location$/, needStaff((m) => {
      const t = state.trips.find((x) => x.id === m[1]);
      return t && mine(school(t.schoolId)) ? reply(200, liveOf(t)) : apiError(404, "NOT_FOUND");
    })],
    ["PUT", /^\/api\/admin\/trips\/([^/]+)\/live-location\/team-lead$/, needStaff((m, b) => {
      const t = state.trips.find((x) => x.id === m[1]);
      if (!t || !mine(school(t.schoolId))) return apiError(404, "NOT_FOUND");
      const l = liveOf(t);
      if (b.enrolmentId && !l.candidates.some((c) => c.enrolmentId === b.enrolmentId)) return apiError(400, "NOT_A_TEAM_LEADER");
      state.live[t.id] = { ...l, teamLeadEnrolmentId: b.enrolmentId, state: b.enrolmentId === l.teamLeadEnrolmentId ? l.state : "not_started", location: null };
      return reply(200, state.live[t.id]);
    })],
    ["POST", /^\/api\/admin\/schools\/([^/]+)\/trips$/, needStaff((m, b) => {
      if (!school(m[1]) || !mine(school(m[1]))) return apiError(404, "NOT_FOUND");
      const t = { id: id(), schoolId: m[1], title: b.title, tourType: b.tourType, destination: b.destination ?? null, academicYear: b.academicYear ?? null, paymentMode: b.paymentMode, status: "draft", templateKey: `${b.tourType}_${b.paymentMode}`, opensAt: b.opensAt ?? null, closesAt: b.closesAt ?? null, createdAt: new Date().toISOString() };
      state.trips.push(t);
      return reply(201, { trip: withSchool(t) });
    })],
    ["PATCH", /^\/api\/admin\/trips\/([^/]+)$/, needStaff((m, b) => {
      const t = state.trips.find((x) => x.id === m[1]);
      if (!t) return apiError(404, "NOT_FOUND");
      if ((b.tourType && b.tourType !== t.tourType || b.paymentMode && b.paymentMode !== t.paymentMode) && t.status !== "draft") return apiError(409, "TRIP_LOCKED");
      Object.assign(t, b);
      t.templateKey = `${t.tourType}_${t.paymentMode}`;
      return reply(200, { trip: withSchool(t) });
    })],
    ["POST", /^\/api\/admin\/trips\/([^/]+)\/status$/, needStaff((m, b) => {
      const t = state.trips.find((x) => x.id === m[1]);
      if (!t) return apiError(404, "NOT_FOUND");
      const roles = TRANSITIONS[t.status][b.status];
      if (!roles) return apiError(409, "INVALID_STATUS_CHANGE");
      if (!roles.includes(state.staff.role)) return apiError(403, "FORBIDDEN");
      t.status = b.status;
      return reply(200, { trip: withSchool(t) });
    })],
    // school logos: admin only, like the server; the "server" checks the real type and size
    ["PUT", /^\/api\/admin\/schools\/([^/]+)\/logo$/, adminOnly((m, file) => {
      const s = school(m[1]);
      if (!s) return apiError(404, "NOT_FOUND");
      if (!["image/png", "image/jpeg", "image/webp"].includes(file?.type)) return apiError(400, "LOGO_INVALID", { message: "Upload a PNG, JPEG or WebP image." });
      s.logoUrl = `/api/school-logos/${slug(s.name)}/${s.branch ? slug(s.branch) : "main"}?v=${++seq}`;
      return reply(200, { school: s });
    })],
    ["DELETE", /^\/api\/admin\/schools\/([^/]+)\/logo$/, adminOnly((m) => {
      const s = school(m[1]);
      if (!s) return apiError(404, "NOT_FOUND");
      s.logoUrl = null;
      return reply(200, { school: s });
    })],
    ["POST", /^\/api\/admin\/trips\/([^/]+)\/public-registration$/, needStaff((m, b) => {
      const t = state.trips.find((x) => x.id === m[1]);
      if (!t) return apiError(404, "NOT_FOUND");
      if (typeof b?.enabled !== "boolean") return apiError(400, "VALIDATION_ERROR");
      if (t.status === "archived") return apiError(409, "INVALID_STATUS_CHANGE");
      t.publicRegistration = b.enabled;
      return reply(200, { trip: withSchool(t) });
    })],
    // staff management (admins only), same rules as the real server: sales accounts only, no password, admins protected
    ["GET", /^\/api\/admin\/staff$/, adminOnly(() => reply(200, { staff: state.team.map((p) => ({ ...publicStaff(p), createdAt: "2026-01-01T00:00:00.000Z" })) }))],
    ["POST", /^\/api\/admin\/staff$/, adminOnly((m, b) => {
      if (b.password !== undefined || b.confirmPassword !== undefined) return apiError(400, "VALIDATION_ERROR", { fields: [{ path: "password", message: "Unrecognized key." }] });
      if (b.role !== undefined && b.role !== "sales") return apiError(400, "VALIDATION_ERROR", { fields: [{ path: "role", message: "Only sales accounts can be created here." }] });
      if (state.team.some((p) => p.email === b.email)) return apiError(409, "STAFF_EXISTS");
      const p = { id: id(), email: b.email, name: b.name, role: "sales", status: "pending", hasPassword: false };
      state.team.push(p);
      return reply(201, { staff: { ...publicStaff(p), createdAt: new Date().toISOString() } });
    })],
    ["PATCH", /^\/api\/admin\/staff\/([^/]+)$/, adminOnly((m, b) => {
      const p = state.team.find((x) => x.id === m[1]);
      if (!p) return apiError(404, "NOT_FOUND");
      if (p.role !== "sales") return apiError(409, "STAFF_PROTECTED");
      p.status = b.active ? (p.hasPassword ? "active" : "pending") : "inactive";
      return reply(200, { staff: { ...publicStaff(p), createdAt: "2026-01-01T00:00:00.000Z" } });
    })],
    // staff passwords: first-time setup / forgot password (public) and change (signed in)
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
    ["GET", /^\/api\/admin\/audit\?limit=(\d+)$/, needStaff(() => {
      if (state.staff.role !== "admin") return apiError(403, "FORBIDDEN");
      return reply(200, { entries: [{ id: 1, staffEmail: "admin@example.com", action: "school.create", entityType: "school", entityId: "x", details: { name: "Greenfield" }, at: new Date().toISOString() }] });
    })],
    // the public trip page lookup (keyed "school/branch/trip") and the parent session check (the portal asks on "/")
    // a page may be looked up more than once (the join page, then the trip's own portal page): hand out a fresh copy each time
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
