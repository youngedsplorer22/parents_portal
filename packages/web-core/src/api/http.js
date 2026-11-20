// Shared JSON-over-fetch helper for the backend API clients.
// Never logs or stores request or response bodies (they can contain tokens and personal data).
export class ApiError extends Error {
  constructor(code, { status = 0, details = {} } = {}) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// ---- Automatic renewal of the short-lived access token --------------------------------------------------------------
// The sign-in is two HttpOnly cookies this code never sees: a 15-minute access token and a refresh token. When a
// protected request is answered 401 UNAUTHENTICATED (the access token has expired), the sign-in is renewed ONCE and the
// request repeated ONCE. That 401 comes from the server's sign-in check, which runs before anything else, so the first
// request did nothing: repeating it can never submit twice. Anything else (a wrong password, another 401 code, a second
// 401) is passed straight back, so there is no loop.
const REFRESH_URL = { parent: "/api/auth/refresh", staff: "/api/admin/auth/refresh" };
const areaOf = (url) => (url.startsWith("/api/admin/") ? "staff" : "parent");
// A 401 from these means "not signed in yet" or "wrong credentials", never "access token expired".
const NEVER_RENEW = [
  /^\/api\/auth\/(login|logout|refresh|password-reset)(\/|$|\?)/,
  /^\/api\/admin\/auth\/(login|logout|refresh|password\/)/,
  /^\/api\/email-otp\//,
  /^\/api\/registrations/,
  /^\/api\/join\//,
];
const renewing = { parent: null, staff: null };
// Once renewal has been refused, the sign-in is over: later 401s are not renewed again until a request in that area
// succeeds (the person signs in again), so a page full of requests doesn't keep knocking on the refresh endpoint.
const ended = { parent: false, staff: false };
/** Forgets the above, as reloading the page does. For tests, which share one page between them. */
export function resetSessionRenewal() {
  ended.parent = ended.staff = false;
}

/** Renews the sign-in once for everyone waiting (and, where the browser supports it, one tab at a time). */
function renew(area) {
  const attempt = async () => {
    let res;
    try {
      res = await fetch(REFRESH_URL[area], {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: "{}",
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      return "network";
    }
    // 409: another request or tab renewed it a moment ago; the browser already holds the new cookies.
    return res.ok || res.status === 409 ? "renewed" : "ended";
  };
  renewing[area] ??= (globalThis.navigator?.locks?.request ? navigator.locks.request(`pp-renew-${area}`, attempt) : attempt()).finally(() => {
    renewing[area] = null;
  });
  return renewing[area];
}

// The session check also says `renewable: false` when the browser holds nothing to renew with (a visitor who never
// signed in, or after logout), so the page doesn't call the refresh endpoint in vain.
async function isExpiredAccess(response) {
  if (response.status !== 401) return false;
  try {
    const error = (await response.clone().json())?.error;
    return error?.code === "UNAUTHENTICATED" && error.renewable !== false;
  } catch {
    return false;
  }
}

/** fetch for this API: renews an expired access token once and repeats the request once. Same arguments as fetch. */
export async function apiFetch(url, init = {}) {
  const area = areaOf(url);
  const response = await fetch(url, init);
  if (response.ok) ended[area] = false;
  if (ended[area] || init.signal?.aborted || NEVER_RENEW.some((re) => re.test(url)) || !(await isExpiredAccess(response))) return response;
  const outcome = await renew(area);
  if (outcome === "network") throw new TypeError("network error while renewing the sign-in");
  if (outcome !== "renewed") {
    ended[area] = true;
    return response; // the sign-in is over: the caller handles UNAUTHENTICATED as before
  }
  return fetch(url, init);
}

/**
 * Sends a JSON request; resolves to the parsed 2xx body, or throws ApiError / AbortError.
 * Same-origin requests carry the HttpOnly session cookie automatically; this code never sees it.
 */
export async function request(method, url, { body, signal } = {}) {
  let response;
  try {
    response = await apiFetch(url, {
      method,
      headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ApiError("NETWORK_ERROR");
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body (e.g. a proxy error page): handled below.
  }

  if (!response.ok) {
    const error = data?.error;
    throw new ApiError(error?.code ?? "SERVER_ERROR", { status: response.status, details: error ?? {} });
  }
  if (data === null || typeof data !== "object") throw new ApiError("SERVER_ERROR", { status: response.status });
  return data;
}

/** 503 SERVER_BUSY: too many sign-ins at once. Nothing was checked or counted, so the user just tries again shortly. */
export function serverBusyMessage(err) {
  const seconds = Number(err?.details?.retryAfterSeconds);
  const when = Number.isInteger(seconds) && seconds > 5 ? `about ${seconds} seconds` : "a few seconds";
  return `Lots of people are signing in right now. Please try again in ${when}.`;
}

export const postJson = (url, body, signal) => request("POST", url, { body, signal });
export const getJson = (url, signal) => request("GET", url, { signal });
export const putJson = (url, body, signal) => request("PUT", url, { body, signal });
export const patchJson = (url, body, signal) => request("PATCH", url, { body, signal });
export const deleteJson = (url, signal) => request("DELETE", url, { signal });
