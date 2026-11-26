import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

// A small imitation of the parts of Google's OAuth token endpoint and Drive v3 API that the portal uses, run on a random
// local port. It keeps files in memory and can be told to misbehave (errors, slowness, dropped connections), so the
// storage code is tested against realistic HTTP, never against real Google and never with real credentials.
//
//   const drive = await startFakeDrive({ account: "dest@example.com" });
//   drive.fail(/upload/, { status: 403, reason: "storageQuotaExceeded" });   // the next matching request fails once
//   drive.files  // Map id -> { name, mimeType, parents, appProperties, bytes, trashed }
//   drive.requests  // [{ method, path, query }] in order, secrets removed

export async function startFakeDrive({ account = "dest@example.com", refreshToken = "good-refresh-token", clientId = "test-client", clientSecret = "test-secret" } = {}) {
  const files = new Map();
  const requests = [];
  const faults = [];
  const state = { account, refreshToken, tokens: new Set(), tokenIssued: 0, codes: new Map() };

  const newId = () => randomBytes(12).toString("hex");
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const apiError = (res, status, reason, message = "error") => json(res, status, { error: { code: status, message, errors: [{ reason, message }] } });

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });

  // The query forms the portal sends: name = '..', '<id>' in parents, mimeType = '..', trashed = false,
  // appProperties has { key='..' and value='..' }.
  const unq = (s) => s.replace(/\\(['\\])/g, "$1");
  function matches(file, q) {
    const must = [];
    for (const m of q.matchAll(/name = '((?:[^'\\]|\\.)*)'/g)) must.push(file.name === unq(m[1]));
    for (const m of q.matchAll(/'((?:[^'\\]|\\.)*)' in parents/g)) must.push((file.parents ?? []).includes(unq(m[1])));
    for (const m of q.matchAll(/mimeType = '((?:[^'\\]|\\.)*)'/g)) must.push(file.mimeType === unq(m[1]));
    if (/trashed = false/.test(q)) must.push(!file.trashed);
    for (const m of q.matchAll(/appProperties has \{ key='((?:[^'\\]|\\.)*)' and value='((?:[^'\\]|\\.)*)' \}/g)) must.push(file.appProperties?.[unq(m[1])] === unq(m[2]));
    return must.every(Boolean);
  }
  const view = (id, f) => ({ id, name: f.name, mimeType: f.mimeType, parents: f.parents, appProperties: f.appProperties, size: f.bytes ? String(f.bytes.length) : undefined });

  function parseMultipart(body, contentType) {
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.[1] ?? /boundary=([^;]+)/.exec(contentType)?.[1];
    const sep = Buffer.from(`--${boundary}`);
    const parts = [];
    let pos = body.indexOf(sep);
    while (pos !== -1) {
      const next = body.indexOf(sep, pos + sep.length);
      if (next === -1) break;
      const part = body.subarray(pos + sep.length + 2, next - 2); // skip CRLF before, CRLF after
      const split = part.indexOf("\r\n\r\n");
      parts.push({ headers: part.subarray(0, split).toString(), body: part.subarray(split + 4) });
      pos = next;
    }
    return parts;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const path = url.pathname;
    const entry = { method: req.method, path, query: Object.fromEntries(url.searchParams) };
    delete entry.query.client_secret;
    requests.push(entry);
    const body = await readBody(req);

    const fault = faults.findIndex((f) => f.pattern.test(`${req.method} ${path}`));
    if (fault !== -1) {
      const f = faults.splice(fault, 1)[0];
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      if (f.drop) return req.socket.destroy();
      if (f.status) return f.rawBody !== undefined ? (res.writeHead(f.status, { "content-type": "application/json" }), res.end(f.rawBody)) : f.token ? json(res, f.status, { error: f.reason, error_description: "fake" }) : apiError(res, f.status, f.reason);
    }

    if (path === "/token") {
      const form = new URLSearchParams(body.toString());
      if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) return json(res, 401, { error: "invalid_client", error_description: "fake" });
      if (form.get("grant_type") === "authorization_code") {
        // The one-time sign-in: a code (registered by the test, which plays the browser) plus the PKCE verifier.
        const entry = state.codes.get(form.get("code"));
        state.codes.delete(form.get("code")); // a code works once
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!entry || entry.challenge !== challenge || entry.redirectUri !== form.get("redirect_uri")) return json(res, 400, { error: "invalid_grant", error_description: "fake" });
        const token = `at-${newId()}`;
        state.tokens.add(token);
        return json(res, 200, { access_token: token, expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/drive.file", ...(entry.withRefresh === false ? {} : { refresh_token: state.refreshToken }) });
      }
      if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== state.refreshToken) return json(res, 400, { error: "invalid_grant", error_description: "fake" });
      const token = `at-${newId()}`;
      state.tokens.add(token);
      state.tokenIssued++;
      return json(res, 200, { access_token: token, expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/drive.file" });
    }

    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer || !state.tokens.has(bearer)) return apiError(res, 401, "authError", "Invalid Credentials");

    if (path === "/drive/v3/about" && req.method === "GET") return json(res, 200, { user: { emailAddress: state.account } });

    if (path === "/drive/v3/files" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const found = [...files].filter(([, f]) => matches(f, q)).map(([id, f]) => view(id, f));
      return json(res, 200, { files: found });
    }
    if (path === "/drive/v3/files" && req.method === "POST") {
      const meta = JSON.parse(body.toString() || "{}");
      const id = newId();
      files.set(id, { name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? ["root"], appProperties: meta.appProperties ?? {}, bytes: null, trashed: false });
      return json(res, 200, view(id, files.get(id)));
    }
    if (path === "/upload/drive/v3/files" && req.method === "POST") {
      if (url.searchParams.get("uploadType") !== "multipart") return apiError(res, 400, "badRequest");
      const parts = parseMultipart(body, req.headers["content-type"] ?? "");
      if (parts.length !== 2) return apiError(res, 400, "badRequest");
      const meta = JSON.parse(parts[0].body.toString());
      const id = newId();
      files.set(id, { name: meta.name, mimeType: meta.mimeType ?? "application/pdf", parents: meta.parents ?? ["root"], appProperties: meta.appProperties ?? {}, bytes: parts[1].body, trashed: false });
      return json(res, 200, view(id, files.get(id)));
    }
    const one = /^\/drive\/v3\/files\/([a-z0-9]+)$/.exec(path);
    if (one && req.method === "GET") {
      const f = files.get(one[1]);
      if (!f || f.trashed) return apiError(res, 404, "notFound", "File not found");
      if (url.searchParams.get("alt") === "media") {
        res.writeHead(200, { "content-type": f.mimeType });
        return res.end(f.bytes ?? Buffer.alloc(0));
      }
      return json(res, 200, view(one[1], f));
    }
    if (one && req.method === "DELETE") {
      if (!files.has(one[1])) return apiError(res, 404, "notFound", "File not found");
      files.delete(one[1]);
      res.writeHead(204);
      return res.end();
    }
    return apiError(res, 404, "notFound", "No such fake endpoint");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    options: { apiBase: `${base}/drive/v3`, uploadBase: `${base}/upload/drive/v3`, tokenUrl: `${base}/token`, clientId, clientSecret, refreshToken, account },
    files,
    requests,
    state,
    uploads: () => [...files.values()].filter((f) => f.bytes),
    folders: () => [...files.entries()].filter(([, f]) => f.mimeType === "application/vnd.google-apps.folder"),
    /** The next request whose "METHOD /path" matches `pattern` fails once. Options: status, reason, delayMs, drop, token (OAuth-style body). */
    fail: (pattern, fault) => faults.push({ pattern, ...fault }),
    /** The test plays the user's browser: it registers the code Google would hand back for this sign-in request. */
    registerCode: (code, { challenge, redirectUri, withRefresh = true }) => state.codes.set(code, { challenge, redirectUri, withRefresh }),
    /** Every access token stops working (as if revoked): the next API call gets 401 and must refresh. */
    expireTokens: () => state.tokens.clear(),
    revoke: () => { state.refreshToken = `revoked-${newId()}`; state.tokens.clear(); },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
