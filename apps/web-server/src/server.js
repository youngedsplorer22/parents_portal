// Serves one built portal (STATIC_DIR) and forwards /api/* to the shared API (API_URL).
//
// Why a proxy: Railway's generated domains (*.up.railway.app) are on the public-suffix list, so two of them are
// different "sites". The sign-in cookies are SameSite=Strict, so a page on one railway.app host could never send
// them to an API on another. Forwarding /api from the portal's own host keeps everything same-origin: no CORS, the
// cookies stay host-only, and the API's same-origin check on writes keeps working (the original Host is kept).
//
// Environment: PORT (set by Railway), STATIC_DIR (built portal, e.g. apps/portal-staff/dist), API_URL (the API's
// private address, e.g. http://api.railway.internal:8080). PORTAL_ROLE ("public" or "staff"; required in production) and PORTAL_PROXY_SECRET (public registration portals only; 32+ characters,
// different for every portal, and the same value as that portal's PORTAL_PROXY_SECRET_<TEMPLATE> on the API) is a SECRET: it is
// sent to the API with every forwarded call and is never served to a browser. The others are not secrets.
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8",
};
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
// Same policy shape the API sends with helmet, plus images from any https host (the live map tiles).
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data: https:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' https: 'unsafe-inline'; upgrade-insecure-requests",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export function createWebServer({ staticDir, apiUrl, upstreamTimeoutMs = 60_000, portalSecret = null }) {
  const dir = path.resolve(staticDir);
  const indexFile = path.join(dir, "index.html");
  if (!existsSync(indexFile)) throw new Error(`built portal not found (index.html missing in ${dir}): run its build first.`);
  const api = new URL(apiUrl);
  if (!/^https?:$/.test(api.protocol)) throw new Error("API_URL must be an http(s) address.");
  const client = api.protocol === "https:" ? https : http;

  const send = (res, status, headers, body) => {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  };
  const sendFile = (req, res, file, cache) => {
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": cache, "Content-Length": statSync(file).size });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).pipe(res);
  };

  function proxy(req, res) {
    const headers = {};
    // x-portal-* is how this portal proves to the API WHICH portal it is. Anything a browser sent under those names is dropped, so a
    // browser can never claim to be a portal; only this server adds the real key (from its own environment, never from a page).
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && !k.startsWith("x-portal-")) headers[k] = v;
    if (portalSecret) headers["x-portal-key"] = portalSecret;
    // Keep the browser's own Host: the API compares it with the Origin header on every write.
    headers.host = req.headers.host;
    // Append who connected to us; the API counts this hop (TRUST_PROXY_HOPS) and ignores anything a caller wrote.
    const peer = req.socket.remoteAddress ?? "";
    headers["x-forwarded-for"] = req.headers["x-forwarded-for"] ? `${req.headers["x-forwarded-for"]}, ${peer}` : peer;
    delete headers["x-real-ip"];
    const up = client.request({
      protocol: api.protocol, hostname: api.hostname, port: api.port || undefined, method: req.method, path: req.url, headers, timeout: upstreamTimeoutMs,
    }, (upRes) => {
      const out = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
      res.writeHead(upRes.statusCode ?? 502, out);
      upRes.pipe(res);
    });
    const fail = () => {
      if (res.headersSent) return res.destroy();
      send(res, 502, { "Content-Type": "application/json", "Cache-Control": "no-store" },
        JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "The service is temporarily unavailable. Please try again." } }));
    };
    up.on("timeout", () => up.destroy());
    up.on("error", fail);
    req.pipe(up);
  }

  return http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(res, 400, {}, "Bad request"); }
    if (pathname === "/healthz") return send(res, 200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }, "ok");
    if (pathname === "/api" || pathname.startsWith("/api/")) return proxy(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { Allow: "GET, HEAD" }, "Method not allowed");

    const file = path.resolve(dir, "." + path.sep + pathname);
    const inside = file === dir || file.startsWith(dir + path.sep);
    const hidden = path.relative(dir, file).split(path.sep).some((p) => p.startsWith("."));
    if (inside && !hidden && existsSync(file) && statSync(file).isFile()) {
      const rel = path.relative(dir, file).split(path.sep);
      const cache = rel[0] === "assets" ? "public, max-age=31536000, immutable" : rel[0] === "index.html" ? "no-cache" : "public, max-age=3600";
      return sendFile(req, res, file, cache);
    }
    // A missing script, image or source map is a plain 404. Any other page address is the app shell (deep links reload).
    if (/^\/assets\//i.test(pathname) || path.extname(pathname) !== "") return send(res, 404, { "Content-Type": "text/plain" }, "Not found");
    return sendFile(req, res, indexFile, "no-cache");
  });
}

// Variables Railway puts in every deployment: a web server running there is production even if NODE_ENV was never set.
const RAILWAY_VARS = ["RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID", "RAILWAY_DEPLOYMENT_ID"];
export const isProduction = (env) => env.NODE_ENV === "production" || RAILWAY_VARS.some((k) => Boolean(env[k]));

/**
 * What this process is, decided from its environment before it listens. Returns { ok: true, portalSecret, role } or
 * { ok: false, error } (an error message that never contains a secret value).
 *
 *  PORTAL_ROLE=public   a public registration portal. In production it MUST have PORTAL_PROXY_SECRET (32+ characters): without
 *                       it the API could not tell this portal from any caller, and registrations would be refused or, worse, unchecked.
 *  PORTAL_ROLE=staff    the Sales portal. It must NOT carry a portal secret: it is not a registration portal and must never
 *                       prove itself to the API as one.
 *  In production PORTAL_ROLE is required, and it must agree with the folder being served (apps/portal-staff = staff, any other
 *  portal = public), so a Sales build can never run as a public portal or the other way round.
 *  Outside production the role is optional and a missing secret is allowed (local development, as before).
 */
export function resolvePortalStartup(env) {
  const { STATIC_DIR, PORTAL_PROXY_SECRET, PORTAL_ROLE } = env;
  const secret = PORTAL_PROXY_SECRET ?? "";
  const production = isProduction(env);
  if (PORTAL_ROLE !== undefined && PORTAL_ROLE !== "" && !["public", "staff"].includes(PORTAL_ROLE)) {
    return { ok: false, error: 'PORTAL_ROLE must be "public" or "staff".' };
  }
  const role = PORTAL_ROLE || null;
  if (secret !== "" && secret.length < 32) return { ok: false, error: "PORTAL_PROXY_SECRET must be at least 32 characters." };
  if (role === "staff" && secret !== "") return { ok: false, error: "PORTAL_ROLE=staff must not have a PORTAL_PROXY_SECRET: the Sales portal is not a registration portal." };
  if (production) {
    if (!role) return { ok: false, error: 'PORTAL_ROLE is required in production: set it to "public" (a registration portal) or "staff" (the Sales portal).' };
    const servesStaff = /(^|[\\/])portal-staff([\\/]|$)/.test(String(STATIC_DIR ?? ""));
    if (role === "public" && servesStaff) return { ok: false, error: 'PORTAL_ROLE=public but STATIC_DIR is the Sales portal. A Sales portal must run with PORTAL_ROLE=staff.' };
    if (role === "staff" && !servesStaff) return { ok: false, error: 'PORTAL_ROLE=staff but STATIC_DIR is not the Sales portal. A registration portal must run with PORTAL_ROLE=public.' };
    if (role === "public" && secret === "") return { ok: false, error: "PORTAL_PROXY_SECRET is required for a public portal in production (it must equal this portal's PORTAL_PROXY_SECRET_<TEMPLATE> on the API)." };
  }
  return { ok: true, role, portalSecret: role === "staff" ? null : secret || null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { PORT = "3000", STATIC_DIR, API_URL } = process.env;
  if (!STATIC_DIR || !API_URL) {
    console.error("STATIC_DIR and API_URL are required.");
    process.exit(1);
  }
  const startup = resolvePortalStartup(process.env);
  if (!startup.ok) {
    console.error(startup.error);
    process.exit(1);
  }
  const server = createWebServer({ staticDir: STATIC_DIR, apiUrl: API_URL, portalSecret: startup.portalSecret });
  server.listen(Number(PORT), "0.0.0.0", () => console.log(`Portal web server on :${PORT}, serving ${STATIC_DIR}, /api -> ${new URL(API_URL).origin}${startup.role ? ` (role ${startup.role})` : ""}${startup.portalSecret ? " (portal key set)" : " (no portal key)"}`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
