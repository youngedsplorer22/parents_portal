import { unauthenticatedError } from "./errors.js";
import { parentCookies } from "./session-cookie.js";

/**
 * Sets req.auth = { registrationId, email, firstName, lastName, role, sessionId } from a CURRENT access token (the
 * pp_access cookie), or answers 401 (the browser then renews it with its refresh token and repeats the request once).
 * This is the ONLY source of user identity for protected routes: nothing in a request body or URL is ever trusted for
 * it, and every route still checks that what is asked for belongs to req.auth.
 *
 * `sessionCheck`: for GET /api/auth/session only, which the refresh cookie (Path=/api/auth) is also sent to. Its 401 then
 * says whether there is anything to renew with, so a visitor who never signed in doesn't make the page try.
 */
export function requireSession(authService, { sessionCheck = false } = {}) {
  return async (req, res, next) => {
    try {
      const cookies = parentCookies.read(req.headers.cookie);
      const user = await authService.authenticate(cookies.access);
      if (!user) throw unauthenticatedError(sessionCheck ? { renewable: Boolean(cookies.refresh || cookies.legacy) } : undefined);
      req.auth = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}
