import { randomBytes } from "node:crypto";

/**
 * A small client for the parts of the Google Drive v3 API the portal needs, over plain HTTPS (Node's fetch): no extra
 * dependency, and every request has a timeout.
 *
 * Sign-in is OAuth 2.0 *on behalf of the destination Google account*, using a refresh token created once by
 * `npm run drive:authorize` and kept in the git-ignored .env. (A Google *service account* is not used on purpose: it
 * has no Drive storage of its own and can't store files in a personal Gmail account's Drive.) The scope is
 * `drive.file`: the portal can only see and change the folders and files it created itself, never anything else in
 * the account. Nothing is ever shared: no permissions request is made, so files stay private to the account.
 *
 * Failures become a DriveError with a short, fixed code and a fixed message. Response bodies, tokens, secrets and
 * file ids are never put in an error, so they can't reach a log or a client by accident.
 */

const GOOGLE = {
  tokenUrl: "https://oauth2.googleapis.com/token",
  apiBase: "https://www.googleapis.com/drive/v3",
  uploadBase: "https://www.googleapis.com/upload/drive/v3",
};
const FOLDER = "application/vnd.google-apps.folder";

const MESSAGES = {
  NOT_CONFIGURED: "Google Drive storage is not configured.",
  AUTH_REVOKED: "Google refused the saved authorisation (it may have been revoked or expired).",
  AUTH_CONFIG: "Google did not accept the configured client id or secret.",
  ACCOUNT_MISMATCH: "The authorised Google account is not the configured destination account.",
  QUOTA_FULL: "The destination Google Drive has no storage left.",
  RATE_LIMITED: "Google asked us to slow down.",
  PERMISSION: "Google refused permission for this action.",
  NOT_FOUND: "The file was not found in Google Drive.",
  TIMEOUT: "Google Drive did not answer in time.",
  NETWORK: "Google Drive could not be reached.",
  DRIVE_ERROR: "Google Drive returned an unexpected error.",
};

export class DriveError extends Error {
  /** @param {keyof typeof MESSAGES} code */
  constructor(code, { retryable = false } = {}) {
    super(MESSAGES[code] ?? MESSAGES.DRIVE_ERROR);
    this.name = "DriveError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** A search value inside single quotes in a Drive query. */
const quote = (v) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function classify(status, body) {
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? "";
  if (status === 401) return new DriveError("AUTH_REVOKED");
  if (status === 404) return new DriveError("NOT_FOUND");
  if (status === 429) return new DriveError("RATE_LIMITED", { retryable: true });
  if (status === 403) {
    if (/storageQuotaExceeded/i.test(reason)) return new DriveError("QUOTA_FULL");
    if (/rateLimit|dailyLimit|quotaExceeded|backendError/i.test(reason)) return new DriveError("RATE_LIMITED", { retryable: true });
    return new DriveError("PERMISSION");
  }
  if (status >= 500) return new DriveError("DRIVE_ERROR", { retryable: true });
  return new DriveError("DRIVE_ERROR");
}

export function createDriveClient({
  clientId,
  clientSecret,
  refreshToken,
  account,
  timeoutMs = 15_000,
  apiBase = GOOGLE.apiBase,
  uploadBase = GOOGLE.uploadBase,
  tokenUrl = GOOGLE.tokenUrl,
  now = () => Date.now(),
  fetchImpl = fetch,
}) {
  for (const value of [clientId, clientSecret, refreshToken, account]) {
    if (typeof value !== "string" || value.trim() === "") throw new DriveError("NOT_CONFIGURED");
  }
  const destination = account.trim().toLowerCase();

  async function send(url, init) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new DriveError(err?.name === "TimeoutError" || err?.name === "AbortError" ? "TIMEOUT" : "NETWORK", { retryable: true });
    }
    return res;
  }
  async function readJson(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  // --- access token: one at a time, reused until shortly before it expires --------------------------------------
  let token = null; // { value, expiresAt }
  let pendingToken = null;
  async function fetchToken() {
    const res = await send(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const body = await readJson(res);
    if (res.ok && typeof body?.access_token === "string") {
      token = { value: body.access_token, expiresAt: now() + Math.max(60, Number(body.expires_in) || 3600) * 1000 - 60_000 };
      return token.value;
    }
    const code = body?.error;
    if (code === "invalid_grant") throw new DriveError("AUTH_REVOKED");
    if (code === "invalid_client" || code === "unauthorized_client") throw new DriveError("AUTH_CONFIG");
    throw new DriveError("DRIVE_ERROR", { retryable: res.status >= 500 });
  }
  function accessToken() {
    if (token && token.expiresAt > now()) return Promise.resolve(token.value);
    pendingToken ??= fetchToken().finally(() => {
      pendingToken = null;
    });
    return pendingToken;
  }

  /** One authorised API call; a 401 gets exactly one fresh token and one retry. */
  async function call(url, init = {}, { expect = "json" } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const value = await accessToken();
      const res = await send(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${value}` } });
      if (res.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      if (!res.ok) throw classify(res.status, await readJson(res));
      if (expect === "none") return null;
      if (expect === "bytes") return Buffer.from(await res.arrayBuffer());
      const body = await readJson(res);
      if (body === null || typeof body !== "object") throw new DriveError("DRIVE_ERROR");
      return body;
    }
    throw new DriveError("AUTH_REVOKED");
  }

  const filesUrl = (params) => `${apiBase}/files?${new URLSearchParams(params)}`;

  return {
    account: destination,
    hosts: [new URL(tokenUrl).origin, new URL(apiBase).origin].filter((v, i, a) => a.indexOf(v) === i),

    /** Throws ACCOUNT_MISMATCH unless the authorised Google account is the configured destination. */
    async verifyAccount() {
      const about = await call(`${apiBase}/about?${new URLSearchParams({ fields: "user(emailAddress)" })}`);
      if (String(about?.user?.emailAddress ?? "").trim().toLowerCase() !== destination) throw new DriveError("ACCOUNT_MISMATCH");
    },

    /** The id of the portal's own folder with this key under `parentId` (null = My Drive), created if it isn't there. */
    async findOrCreateFolder(name, parentId, key) {
      const q = [`mimeType = ${quote(FOLDER)}`, "trashed = false", `appProperties has { key='ye_key' and value=${quote(key)} }`, ...(parentId ? [`${quote(parentId)} in parents`] : [])].join(" and ");
      const found = await call(filesUrl({ q, fields: "files(id)", pageSize: "10", spaces: "drive" }));
      if (Array.isArray(found.files) && found.files[0]?.id) return found.files[0].id;
      const created = await call(`${apiBase}/files?${new URLSearchParams({ fields: "id" })}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER, ...(parentId ? { parents: [parentId] } : {}), appProperties: { ye_key: key } }),
      });
      if (typeof created.id !== "string") throw new DriveError("DRIVE_ERROR");
      return created.id;
    },

    /** The portal's file in `parentId` carrying appProperties[key] === value, or null. */
    async findFile(parentId, key, value) {
      const q = [`${quote(parentId)} in parents`, "trashed = false", `appProperties has { key=${quote(key)} and value=${quote(value)} }`].join(" and ");
      const found = await call(filesUrl({ q, fields: "files(id,size)", pageSize: "10", spaces: "drive" }));
      const file = Array.isArray(found.files) ? found.files[0] : null;
      return file?.id ? { id: file.id, size: Number(file.size) } : null;
    },

    /** Uploads a PDF into a folder (multipart, one request). Resolves { id, size }. Private: no sharing is requested. */
    async uploadPdf({ name, parentId, bytes, appProperties }) {
      const boundary = `ye-${randomBytes(12).toString("hex")}`;
      const meta = JSON.stringify({ name, mimeType: "application/pdf", parents: [parentId], appProperties });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const file = await call(`${uploadBase}/files?${new URLSearchParams({ uploadType: "multipart", fields: "id,size" })}`, {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body,
      });
      if (typeof file.id !== "string") throw new DriveError("DRIVE_ERROR");
      return { id: file.id, size: Number(file.size) };
    },

    /** The bytes of a file by id. */
    downloadFile(id) {
      return call(`${apiBase}/files/${encodeURIComponent(id)}?${new URLSearchParams({ alt: "media" })}`, {}, { expect: "bytes" });
    },

    /** Uploads a file of any MIME type (multipart, one request). Resolves { id, size }. Private: no sharing is requested. */
    async uploadFile({ name, mimeType, parentId, bytes, appProperties }) {
      const boundary = `ye-${randomBytes(12).toString("hex")}`;
      const meta = JSON.stringify({ name, mimeType, parents: [parentId], appProperties });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const file = await call(`${uploadBase}/files?${new URLSearchParams({ uploadType: "multipart", fields: "id,size" })}`, {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body,
      });
      if (typeof file.id !== "string") throw new DriveError("DRIVE_ERROR");
      return { id: file.id, size: Number(file.size) };
    },

    /** Permanently deletes a file by id. Throws NOT_FOUND if the file does not exist. */
    deleteFile(id) {
      return call(`${apiBase}/files/${encodeURIComponent(id)}`, { method: "DELETE" }, { expect: "none" });
    },
  };
}
