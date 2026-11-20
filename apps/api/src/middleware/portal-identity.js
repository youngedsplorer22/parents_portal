import { createHash, timingSafeEqual } from "node:crypto";

const digest = (v) => createHash("sha256").update(String(v)).digest();

/**
 * Which public portal sent this request, decided by the SERVER from a secret, never from anything a browser can choose.
 *
 * Each public portal's own web server (apps/web-server) adds the header `x-portal-key` to every /api call it forwards,
 * with that portal's secret, and removes any such header the browser sent. Here the header is compared (in constant time)
 * with the four configured secrets (config.portalSecrets). A match sets `req.portal = { templateKey }`; anything else,
 * including a missing, wrong or repeated header, leaves `req.portal = null`. A browser that talks to the API directly has
 * no secret, so it is never a portal.
 */
export function createPortalIdentity({ secrets = {} } = {}) {
  const known = Object.entries(secrets).filter(([, v]) => typeof v === "string" && v).map(([templateKey, v]) => [templateKey, digest(v)]);
  return function portalIdentity(req, res, next) {
    req.portal = null;
    const header = req.headers["x-portal-key"];
    if (typeof header === "string" && header.length > 0 && header.length <= 300 && known.length > 0) {
      const got = digest(header);
      let found = null;
      for (const [templateKey, d] of known) if (timingSafeEqual(got, d)) found = templateKey; // no early exit: same time for every key
      if (found) req.portal = { templateKey: found };
    }
    next();
  };
}
