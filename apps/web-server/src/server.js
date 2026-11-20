// Serves one built portal (STATIC_DIR) and forwards /api/* to the shared API (API_URL).
//
// Why a proxy: Railway's generated domains (*.up.railway.app) are on the public-suffix list, so two of them are
// different "sites". The sign-in cookies are SameSite=Strict, so a page on one railway.app host could never send
// them to an API on another. Forwarding /api from the portal's own host keeps everything same-origin: no CORS, the
// cookies stay host-only, and the API's same-origin check on writes keeps working (the original Host is kept).
//
// Environment: PORT (set by Railway), STATIC_DIR (built portal, e.g. apps/portal-staff/dist), API_URL (the API's
// private address, e.g. http://api.railway.internal:8080). PORTAL_ROLE ("public" or "staff"; required in production), CLIENT_IP_SOURCE (required in production: see client-ip.js) and PORTAL_PROXY_SECRET (public registration portals only; 32+ characters,
// different for every portal, and the same value as that portal's PORTAL_PROXY_SECRET_<TEMPLATE> on the API) is a SECRET: it is
// sent to the API with every forwarded call and is never served to a browser. The others are not secrets.
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { checkApiTarget, looksLikeApi } from "./api-policy.js";
import { buildUpstreamHeaders, parseClientIpSource, selectClientAddress } from "./client-ip.js";

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

// The Host header: exactly one, and a plain host name (or IPv4 address, or bracketed IPv6 address) with an optional port. Node keeps
// only the FIRST of several Host headers in req.headers.host and says nothing, so a second one (which another server in the chain
// might prefer) is visible only in req.rawHeaders; a comma, a space or any other character a host name cannot hold is refused
// outright. The API compares Host with Origin on every write, so a Host that two parties read differently is a way round that check.
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const HOST = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[([0-9A-Fa-f:.]{2,45})\\])(?::([0-9]{1,5}))?$`);
export function validHostHeader(req) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "host") count++;
  const value = req.headers.host;
  if (count !== 1 || typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  const m = HOST.exec(value);
  if (!m) return false;
  if (m[1] !== undefined && isIP(m[1]) !== 6) return false;
  return m[2] === undefined || (Number(m[2]) >= 1 && Number(m[2]) <= 65535);
}

const NOT_FOUND_JSON = JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found." } });

/**
 * role: "public" | "staff" | null. With a role the server forwards ONLY that portal's own API calls (see api-policy.js); with
 * none (local development, never production: resolvePortalStartup requires a role there) it forwards every /api path.
 * clientIpSource: how to pick the visitor's address from what the edge reported (see client-ip.js). Either way the API gets
 * exactly one validated X-Forwarded-For address.
 */
export function createWebServer({
  staticDir, apiUrl, upstreamTimeoutMs = 60_000, portalSecret = null, role = null, clientIpSource = { mode: "peer" },
  // How long a client may take to send its headers and then the whole request, body included. These are Node's own defaults, set
  // explicitly so a Node upgrade cannot change them and nobody can switch them off with 0. A real call here is a small JSON body (the
  // biggest the API takes is 64 KB), so five minutes is far more than any legitimate upload needs and a stalled one is cut off.
  // checkIntervalMs is how often Node looks for requests past their limit (its default is 30 s); only tests change it.
  requestTimeoutMs = 300_000, headersTimeoutMs = 60_000, checkIntervalMs = 30_000,
}) {
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

  // These answers close the connection: a request that is refused is not read any further, so a client cannot keep uploading
  // into a request that was already turned away.
  const refuse = (res, status, code, message) =>
    send(res, status, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" }, JSON.stringify({ error: { code, message } }));
  const blocked = (res) => refuse(res, 404, "NOT_FOUND", "Not found.");
  const tooLarge = (res) => refuse(res, 413, "PAYLOAD_TOO_LARGE", "Request body is too large.");

  /**
   * `target` is the path and query to forward: the validated canonical one when there is a role, the raw one otherwise.
   * `maxBody` is the most request-body bytes this call may carry (the API's own limit for the route), or null for no limit.
   */
  function proxy(req, res, target, maxBody = null) {
    // A declared length over the limit is refused before the API is contacted; a body with no declared length is counted below.
    if (maxBody !== null && req.headers["content-length"] !== undefined) {
      const declared = Number(req.headers["content-length"]);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBody) return tooLarge(res);
    }
    // The API trusts exactly one hop (this server), so it gets exactly one address: the one chosen from what the edge reported
    // (never anything a browser merely claims), and none of the other forwarding or portal headers a browser could set. The
    // portal key is this server's own. Keep the browser's own Host: the API compares it with the Origin header on every write.
    const { address } = selectClientAddress(clientIpSource, req.headers, req.socket.remoteAddress);
    const headers = buildUpstreamHeaders(req.headers, { hopByHop: HOP_BY_HOP, portalSecret, address });
    headers.host = req.headers.host;
    let answered = false;
    const fail = () => {
      if (answered) return;
      if (res.headersSent) return res.destroy();
      send(res, 502, { "Content-Type": "application/json", "Cache-Control": "no-store" },
        JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: "The service is temporarily unavailable. Please try again." } }));
    };
    let up;
    try {
      up = client.request({
        protocol: api.protocol, hostname: api.hostname, port: api.port || undefined, method: req.method, path: target, headers, timeout: upstreamTimeoutMs,
      }, (upRes) => {
        const out = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
        res.writeHead(upRes.statusCode ?? 502, out);
        upRes.pipe(res);
      });
    } catch {
      return fail(); // never let a request that cannot be built take the whole server down
    }
    up.on("timeout", () => up.destroy());
    up.on("error", fail);
    // If the client goes away before the answer is finished (an abandoned upload, a closed tab), drop the API request now instead
    // of leaving it open until the upstream timeout.
    res.on("close", () => {
      if (!res.writableEnded) up.destroy();
    });
    if (maxBody === null) {
      req.pipe(up);
      return;
    }
    // Streamed straight through, never held in memory (backpressure applies), and counted: the moment more than the limit has
    // arrived the API request is dropped, the client is told 413 and the connection is closed.
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        if (received > maxBody) return done(new Error("body too large"));
        done(null, chunk);
      },
    });
    limiter.on("error", () => {
      if (answered) return;
      answered = true;
      req.unpipe(limiter);
      up.destroy();
      tooLarge(res);
    });
    req.pipe(limiter).pipe(up);
  }

  return http.createServer({ requestTimeout: requestTimeoutMs, headersTimeout: headersTimeoutMs, connectionsCheckingInterval: checkIntervalMs }, (req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return send(res, 400, {}, "Bad request"); }
    if (pathname === "/healthz") return send(res, 200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }, "ok");
    // Before anything is served or forwarded: exactly one well-formed Host (see validHostHeader). /healthz above is exempt so a
    // platform health probe that sends no Host still passes; it serves a fixed answer and forwards nothing.
    if (!validHostHeader(req)) return refuse(res, 400, "BAD_REQUEST", "Bad request.");
    if (role) {
      // Only an ordinary path is ever served or forwarded. "//host/path" (which a URL parser reads as another host), an absolute
      // URL or "*" are answered 404 like any other blocked request.
      if (!req.url.startsWith("/") || req.url.startsWith("//")) return blocked(res);
      // The request target is judged exactly as the client sent it, before any normalisation, and the SAME canonical string is
      // forwarded. Anything that looks like an API call in any spelling is either allowed here or answered 404: never a web page.
      if (looksLikeApi(req.url)) {
        const checked = checkApiTarget(role, req.method, req.url);
        return checked.ok ? proxy(req, res, checked.target, checked.maxBody) : blocked(res);
      }
    } else if (pathname === "/api" || pathname.startsWith("/api/")) {
      return proxy(req, res, req.url);
    }
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
  const { STATIC_DIR, PORTAL_PROXY_SECRET, PORTAL_ROLE, CLIENT_IP_SOURCE } = env;
  const secret = PORTAL_PROXY_SECRET ?? "";
  const production = isProduction(env);
  if (PORTAL_ROLE !== undefined && PORTAL_ROLE !== "" && !["public", "staff"].includes(PORTAL_ROLE)) {
    return { ok: false, error: 'PORTAL_ROLE must be "public" or "staff".' };
  }
  const role = PORTAL_ROLE || null;
  // How the visitor's address is read from what Railway's edge reports. Nothing in the repository says what the edge does, so
  // production must be told (from the staging check) and never guesses; locally the connecting address is used.
  const given = CLIENT_IP_SOURCE !== undefined && CLIENT_IP_SOURCE !== "";
  const clientIpSource = given ? parseClientIpSource(CLIENT_IP_SOURCE) : production ? null : { mode: "peer" };
  if (!clientIpSource) {
    return {
      ok: false,
      error: given
        ? 'CLIENT_IP_SOURCE must be "xff:<n>" (n from 1 to 8), "x-real-ip" or "peer".'
        : 'CLIENT_IP_SOURCE is required in production: set it to "xff:<n>", "x-real-ip" or "peer". It is decided by the staging verification in docs/CLIENT-IP-STAGING-VERIFICATION.md and is not guessed.',
    };
  }
  if (secret !== "" && secret.length < 32) return { ok: false, error: "PORTAL_PROXY_SECRET must be at least 32 characters." };
  if (role === "staff" && secret !== "") return { ok: false, error: "PORTAL_ROLE=staff must not have a PORTAL_PROXY_SECRET: the Sales portal is not a registration portal." };
  if (production) {
    if (!role) return { ok: false, error: 'PORTAL_ROLE is required in production: set it to "public" (a registration portal) or "staff" (the Sales portal).' };
    const servesStaff = /(^|[\\/])portal-staff([\\/]|$)/.test(String(STATIC_DIR ?? ""));
    if (role === "public" && servesStaff) return { ok: false, error: 'PORTAL_ROLE=public but STATIC_DIR is the Sales portal. A Sales portal must run with PORTAL_ROLE=staff.' };
    if (role === "staff" && !servesStaff) return { ok: false, error: 'PORTAL_ROLE=staff but STATIC_DIR is not the Sales portal. A registration portal must run with PORTAL_ROLE=public.' };
    if (role === "public" && secret === "") return { ok: false, error: "PORTAL_PROXY_SECRET is required for a public portal in production (it must equal this portal's PORTAL_PROXY_SECRET_<TEMPLATE> on the API)." };
  }
  return { ok: true, role, portalSecret: role === "staff" ? null : secret || null, clientIpSource };
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
  const server = createWebServer({ staticDir: STATIC_DIR, apiUrl: API_URL, portalSecret: startup.portalSecret, role: startup.role, clientIpSource: startup.clientIpSource });
  const { mode, hops } = startup.clientIpSource;
  // No host: Node listens on every interface it has, IPv4 and IPv6 where the machine supports both (the same as the API), so this
  // does not assume which kind of address Railway's network uses to reach the service.
  server.listen(Number(PORT), () => {
    console.log(`Portal web server on :${server.address().port} (listening on all interfaces), serving ${STATIC_DIR}, /api -> ${new URL(API_URL).origin}${startup.role ? ` (role ${startup.role})` : ""}${startup.portalSecret ? " (portal key set)" : " (no portal key)"} (client address: ${mode === "xff" ? `xff:${hops}` : mode})`);
    if (mode === "peer" && isProduction(process.env)) console.warn("CLIENT_IP_SOURCE=peer: every visitor shares one address for the API's per-IP limits.");
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
