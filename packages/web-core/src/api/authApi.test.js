import { afterEach, describe, expect, it, vi } from "vitest";
import { getSession, loginErrorMessage, loginWithPassword, loginWithToken, logout } from "./authApi.js";
import { TOKEN, apiError, mockApi, reply } from "../test/helpers.js";

afterEach(() => vi.unstubAllGlobals());
const USER = { email: "parent@example.com", firstName: "Asha", lastName: "Rao", role: "Student" };

describe("getSession", () => {
  it("returns the user for a valid session, sending the cookie same-origin and never caching", async () => {
    const api = mockApi({ "/api/auth/session": reply(200, { authenticated: true, user: USER }) });
    expect(await getSession()).toEqual(USER);
    expect(api.fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });
  it("returns null on 401, and throws on anything else", async () => {
    // not signed in: the server says there is nothing to renew with, so no renewal is attempted
    mockApi({ "/api/auth/session": [apiError(401, "UNAUTHENTICATED", { renewable: false }), apiError(500, "INTERNAL_ERROR"), reply(200, { authenticated: true })] });
    expect(await getSession()).toBeNull();
    await expect(getSession()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    await expect(getSession()).rejects.toMatchObject({ code: "SERVER_ERROR" }); // 200 without a user is not a session
  });
  it("returns null when the access token expired and renewing it is refused (the sign-in is over)", async () => {
    const api = mockApi({ "/api/auth/session": apiError(401, "UNAUTHENTICATED"), "/api/auth/refresh": apiError(401, "UNAUTHENTICATED") });
    expect(await getSession()).toBeNull();
    expect(api.urls()).toEqual(["/api/auth/session", "/api/auth/refresh"]);
  });
});

describe("loginWithToken", () => {
  it("posts the normalised email and the token, and resolves only on the server's confirmation", async () => {
    const api = mockApi({ "/api/auth/login": reply(200, { authenticated: true, user: USER }) });
    expect(await loginWithToken(" Parent@Example.com ", TOKEN)).toEqual(USER);
    expect(api.calls[0].body).toEqual({ email: "parent@example.com", verificationToken: TOKEN });
  });
  it("rejects an unconfirmed or failed login", async () => {
    mockApi({ "/api/auth/login": [reply(200, { authenticated: false }), apiError(404, "ACCOUNT_NOT_FOUND")] });
    await expect(loginWithToken("a@b.co", TOKEN)).rejects.toMatchObject({ code: "SERVER_ERROR" });
    await expect(loginWithToken("a@b.co", TOKEN)).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });
  it("friendly messages never contain server text or the token", () => {
    for (const code of ["ACCOUNT_NOT_FOUND", "VERIFICATION_REQUIRED", "NETWORK_ERROR", "SOMETHING_ELSE"]) {
      const text = loginErrorMessage({ code, message: "server text", details: { x: TOKEN } });
      expect(text).not.toContain("server text");
      expect(text).not.toContain(TOKEN);
    }
  });
});

describe("loginWithPassword", () => {
  it("posts the normalised email and the password as typed, and resolves only on the server's confirmation", async () => {
    const api = mockApi({ "/api/auth/login/password": reply(200, { authenticated: true, user: USER }) });
    expect(await loginWithPassword(" Parent@Example.com ", "  pass phrase  ")).toEqual(USER);
    expect(api.calls[0]).toMatchObject({ method: "POST", url: "/api/auth/login/password" });
    expect(api.calls[0].body).toEqual({ email: "parent@example.com", password: "  pass phrase  " });
    expect(api.fetchMock.mock.calls[0][0]).not.toContain("pass phrase"); // never in the URL
  });
  it("rejects an unconfirmed login and surfaces the server's code", async () => {
    mockApi({ "/api/auth/login/password": [reply(200, { authenticated: false }), apiError(401, "INVALID_CREDENTIALS"), apiError(429, "RATE_LIMITED", { retryAfterSeconds: 60 })] });
    await expect(loginWithPassword("a@b.co", "x")).rejects.toMatchObject({ code: "SERVER_ERROR" });
    await expect(loginWithPassword("a@b.co", "x")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(loginWithPassword("a@b.co", "x")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
  it("friendly messages are generic and never contain server text", () => {
    expect(loginErrorMessage({ code: "INVALID_CREDENTIALS", message: "server text" })).toBe("The email or password is incorrect. You can also sign in with an email code.");
    expect(loginErrorMessage({ code: "RATE_LIMITED", details: { retryAfterSeconds: 61 } })).toMatch(/about 2 minutes/);
    expect(loginErrorMessage({ code: "RATE_LIMITED", details: {} })).not.toMatch(/NaN|undefined/);
    expect(loginErrorMessage({ code: "RATE_LIMITED", message: "server text" })).not.toContain("server text");
  });
});

describe("logout", () => {
  it("posts to the server", async () => {
    const api = mockApi({ "/api/auth/logout": reply(200, { authenticated: false }) });
    await logout();
    expect(api.calls[0].method).toBe("POST");
  });
});
