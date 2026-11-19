/**
 * The cookies that carry a sign-in. All are HttpOnly (page scripts can never read them), SameSite=Strict (never sent
 * from another site) and, in production, Secure. The ACCESS cookie goes to every API request of its area; the REFRESH
 * cookie only to the sign-in endpoints (its own path), so it is not sent with ordinary requests. The LEGACY cookie is
 * the single long-lived cookie from before access/refresh tokens; it is only ever read to upgrade it, and then cleared.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function createCookieJar({ access, refresh, legacy }) {
  const attrs = (path, secure) => `Path=${path}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  const set = (c, value, maxAge, secure) => `${c.name}=${value}; Max-Age=${Math.max(0, Math.floor(maxAge))}; ${attrs(c.path, secure)}`;

  /** { access, refresh, legacy } from a Cookie header: each a well-formed token or null. */
  function read(header) {
    const out = { access: null, refresh: null, legacy: null };
    if (typeof header !== "string") return out;
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!TOKEN_SHAPE.test(value)) continue;
      if (name === access.name) out.access = value;
      else if (name === refresh.name) out.refresh = value;
      else if (name === legacy.name) out.legacy = value;
    }
    return out;
  }

  return {
    read,
    /** Set-Cookie values for a newly issued pair (and the old single cookie cleared). */
    issue: (pair, { secure }) => [
      set(access, pair.access.token, pair.access.maxAgeSeconds, secure),
      set(refresh, pair.refresh.token, pair.refresh.maxAgeSeconds, secure),
      set(legacy, "", 0, secure),
    ],
    /** Set-Cookie values that remove every sign-in cookie of this area. */
    clear: ({ secure }) => [set(access, "", 0, secure), set(refresh, "", 0, secure), set(legacy, "", 0, secure)],
  };
}
