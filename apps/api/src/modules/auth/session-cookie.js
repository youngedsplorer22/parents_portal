import { createCookieJar } from "../sessions/cookies.js";

// Parent sign-in cookies. pp_access goes to every /api request; pp_refresh only to /api/auth (refresh, logout, login),
// so the long-lived credential is not sent with ordinary requests. pp_session is the single cookie used before
// access/refresh tokens: read only to upgrade it once, then cleared.
export const parentCookies = createCookieJar({
  access: { name: "pp_access", path: "/api" },
  refresh: { name: "pp_refresh", path: "/api/auth" },
  legacy: { name: "pp_session", path: "/api" },
});
