import { crossSiteError, forbiddenError, staffUnauthenticatedError } from "./errors.js";
import { staffCookies } from "./cookie.js";

/**
 * Sets req.staff = { id, email, name, role, sessionId } from a CURRENT staff access token (pp_staff_access) only, or
 * answers 401 (the panel then renews it with its refresh token and repeats the request once).
 * `sessionCheck`: for GET /api/admin/auth/session only (see auth/middleware.js): its 401 says whether renewal could work.
 */
export function requireStaff(authService, { sessionCheck = false } = {}) {
  return async (req, res, next) => {
    try {
      const cookies = staffCookies.read(req.headers.cookie);
      const staff = await authService.authenticate(cookies.access);
      if (!staff) throw staffUnauthenticatedError(sessionCheck ? { renewable: Boolean(cookies.refresh || cookies.legacy) } : undefined);
      req.staff = staff;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** After requireStaff: only the listed roles pass; everyone else gets 403. */
export const requireRole =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.staff?.role) ? next() : next(forbiddenError());

/**
 * Defence in depth on top of SameSite=Strict: a state-changing request that carries an Origin
 * header must come from this same host. Requests without an Origin (non-browser clients) pass.
 */
export function sameOriginForWrites(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin === undefined) return next();
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch {
    /* malformed Origin: refuse below */
  }
  return next(crossSiteError());
}
