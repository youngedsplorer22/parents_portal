import { createCookieJar } from "../sessions/cookies.js";

// Staff sign-in cookies: separate names from the parents', scoped to /api/admin so the browser never sends them to
// parent endpoints. pp_staff_refresh only goes to /api/admin/auth. pp_staff_session is the old single cookie (upgrade only).
export const staffCookies = createCookieJar({
  access: { name: "pp_staff_access", path: "/api/admin" },
  refresh: { name: "pp_staff_refresh", path: "/api/admin/auth" },
  legacy: { name: "pp_staff_session", path: "/api/admin" },
});
