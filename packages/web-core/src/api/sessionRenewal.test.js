import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, getJson, postJson, putJson } from "./http.js";
import { apiError, reply, storageIsEmpty } from "../test/helpers.js";

// Automatic renewal: the access token lives 15 minutes. When a protected request is answered 401 UNAUTHENTICATED, the
// page renews the sign-in ONCE (POST /api/auth/refresh, or /api/admin/auth/refresh for the staff panel) and repeats the
// request ONCE. Tokens are HttpOnly cookies the page never sees; it only ever sends credentials: "same-origin".

afterEach(() => vi.unstubAllGlobals());

/** A scripted server: `script(method, url, call)` returns a Response; every call is recorded. */
function server(script) {
  const calls = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    const call = { method: init.method ?? "GET", url: String(url), init, n: calls.length };
    calls.push(call);
    return script(call.method, call.url, calls.filter((c) => c.url === call.url && c.method === call.method).length);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, count: (method, url) => calls.filter((c) => c.method === method && c.url === url).length };
}
const unauth = () => apiError(401, "UNAUTHENTICATED");

describe("renewing an expired access token", () => {
  it("a 401 UNAUTHENTICATED is followed by ONE renewal and ONE repeat of the request, which then succeeds", async () => {
    let renewed = false;
    const s = server((m, url) => {
      if (url === "/api/auth/refresh") return (renewed = true), reply(200, { authenticated: true });
      return renewed ? reply(200, { ok: 1 }) : unauth();
    });
    expect(await getJson("/api/onboarding")).toEqual({ ok: 1 });
    expect(s.count("POST", "/api/auth/refresh")).toBe(1);
    expect(s.count("GET", "/api/onboarding")).toBe(2);
    const refresh = s.calls.find((c) => c.url === "/api/auth/refresh");
    expect(refresh.init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: "{}" });
    expect(refresh.init.headers["Content-Type"]).toBe("application/json");
  });

  it("several requests that fail at once share ONE renewal, then each is repeated once", async () => {
    let renewed = false;
    const s = server((m, url) => {
      if (url === "/api/auth/refresh") return new Promise((r) => setTimeout(() => r((renewed = true, reply(200, {}))), 20));
      return renewed ? reply(200, { url }) : unauth();
    });
    const out = await Promise.all([getJson("/api/onboarding"), getJson("/api/enrolments/resume"), getJson("/api/auth/session")]);
    expect(out.map((o) => o.url)).toEqual(["/api/onboarding", "/api/enrolments/resume", "/api/auth/session"]);
    expect(s.count("POST", "/api/auth/refresh")).toBe(1);
  });

  it("if the sign-in is over (renewal refused), the original 401 stands, exactly once: no loop", async () => {
    const s = server((m, url) => (url === "/api/auth/refresh" ? apiError(401, "UNAUTHENTICATED") : unauth()));
    await expect(getJson("/api/onboarding")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(s.count("POST", "/api/auth/refresh")).toBe(1);
    expect(s.count("GET", "/api/onboarding")).toBe(1);
  });

  it("if the repeated request is refused again, it is not renewed a second time (no loop)", async () => {
    const s = server((m, url) => (url === "/api/auth/refresh" ? reply(200, {}) : unauth()));
    await expect(getJson("/api/onboarding")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(s.count("POST", "/api/auth/refresh")).toBe(1);
    expect(s.count("GET", "/api/onboarding")).toBe(2);
  });

  it("'renewed by another request a moment ago' (409) means the cookies are already new: just repeat the request", async () => {
    let first = true;
    const s = server((m, url) => {
      if (url === "/api/auth/refresh") return apiError(409, "REFRESH_RACE");
      if (first) return (first = false), unauth();
      return reply(200, { ok: 1 });
    });
    expect(await getJson("/api/onboarding")).toEqual({ ok: 1 });
    expect(s.count("POST", "/api/auth/refresh")).toBe(1);
  });

  it("a network failure while renewing is reported as a network problem (the parent is NOT signed out)", async () => {
    server((m, url) => {
      if (url === "/api/auth/refresh") throw new TypeError("Failed to fetch");
      return unauth();
    });
    await expect(getJson("/api/onboarding")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("the staff panel renews with its own endpoint", async () => {
    let renewed = false;
    const s = server((m, url) => {
      if (url === "/api/admin/auth/refresh") return (renewed = true), reply(200, {});
      return renewed ? reply(200, { schools: [] }) : unauth();
    });
    expect(await getJson("/api/admin/schools")).toEqual({ schools: [] });
    expect(s.count("POST", "/api/admin/auth/refresh")).toBe(1);
    expect(s.count("POST", "/api/auth/refresh")).toBe(0);
  });
});

describe("what is never renewed or repeated", () => {
  it("a 401 that is not about the access token (wrong password, wrong current password) is passed straight through", async () => {
    const s = server(() => apiError(401, "INVALID_CREDENTIALS"));
    await expect(postJson("/api/admin/auth/password", { currentPassword: "x" })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(s.calls).toHaveLength(1);
  });

  it("sign-in, sign-out, renewal itself, email codes, registration and public pages are never renewed", async () => {
    for (const url of ["/api/auth/login", "/api/auth/login/password", "/api/auth/logout", "/api/auth/refresh", "/api/auth/password-reset/confirm", "/api/admin/auth/login", "/api/admin/auth/logout", "/api/admin/auth/refresh", "/api/admin/auth/password/confirm", "/api/email-otp/verify", "/api/registrations", "/api/join/a/b/c"]) {
      const s = server(() => unauth());
      await expect(postJson(url, {})).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(s.calls.map((c) => c.url), url).toEqual([url]);
    }
  });

  it("a submission refused because the access token expired is sent again exactly once after renewal (it was never processed)", async () => {
    let renewed = false;
    let processed = 0;
    server((m, url) => {
      if (url === "/api/auth/refresh") return (renewed = true), reply(200, {});
      if (!renewed) return unauth(); // the auth check answers before any handler runs: nothing was submitted
      processed++;
      return reply(200, { form: { status: "submitted" } });
    });
    await postJson("/api/onboarding/submit", { version: 3 });
    expect(processed).toBe(1);
  });

  it("an autosave refused for an expired token is saved after renewal, with the same answers (no data lost)", async () => {
    let renewed = false;
    const saved = [];
    server((m, url, n) => {
      if (url === "/api/auth/refresh") return (renewed = true), reply(200, {});
      if (!renewed) return unauth();
      return reply(200, { form: { version: n } });
    });
    const body = { tourType: "domestic", data: { fullName: "Asha Rao", remark: "typed just now" }, currentSection: "contact", version: 4 };
    await putJson("/api/onboarding", body);
    const puts = vi.mocked(fetch).mock.calls.filter(([u, i]) => u === "/api/onboarding" && i.method === "PUT");
    for (const [, init] of puts) saved.push(JSON.parse(init.body));
    expect(saved).toEqual([body, body]);
  });

  it("an aborted request is not renewed", async () => {
    const s = server(() => unauth());
    const c = new AbortController();
    c.abort();
    await apiFetch("/api/onboarding", { signal: c.signal }).catch(() => {});
    expect(s.count("POST", "/api/auth/refresh")).toBe(0);
  });
});

describe("tokens stay out of reach of the page", () => {
  it("requests carry no Authorization header or token, only the browser's cookies (same-origin); nothing is stored", async () => {
    let renewed = false;
    const s = server((m, url) => (url === "/api/auth/refresh" ? ((renewed = true), reply(200, {})) : renewed ? reply(200, {}) : unauth()));
    await getJson("/api/onboarding");
    for (const c of s.calls) {
      expect(c.init.credentials).toBe("same-origin");
      expect(JSON.stringify(c.init.headers ?? {})).not.toMatch(/authorization|bearer|token/i);
    }
    expect(storageIsEmpty()).toBe(true);
  });
});

describe("after renewal is refused", () => {
  it("later 401s are not renewed again until a request succeeds (signing in again), then renewal works as before", async () => {
    let refreshOk = false;
    let renewed = false;
    const s = server((m, url) => {
      if (url === "/api/auth/refresh") return refreshOk ? ((renewed = true), reply(200, {})) : apiError(401, "UNAUTHENTICATED");
      if (url === "/api/auth/login") return reply(200, { authenticated: true });
      return renewed ? reply(200, {}) : unauth();
    });
    await expect(getJson("/api/onboarding")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(getJson("/api/onboarding")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(putJson("/api/onboarding", {})).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(s.count("POST", "/api/auth/refresh")).toBe(1);
    // the staff panel is a separate sign-in and is not affected
    await expect(getJson("/api/admin/schools")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(s.count("POST", "/api/admin/auth/refresh")).toBe(1);
    await postJson("/api/auth/login", {}); // signs in again
    refreshOk = true;
    expect(await getJson("/api/onboarding")).toEqual({});
    expect(s.count("POST", "/api/auth/refresh")).toBe(2);
  });
});

describe("nothing to renew with", () => {
  it("a session check that says renewable: false (a visitor, or after logout) is not followed by a renewal", async () => {
    const s = server(() => apiError(401, "UNAUTHENTICATED", { renewable: false }));
    await expect(getJson("/api/auth/session")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(getJson("/api/admin/auth/session")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(s.calls.map((c) => c.url)).toEqual(["/api/auth/session", "/api/admin/auth/session"]);
  });
});
