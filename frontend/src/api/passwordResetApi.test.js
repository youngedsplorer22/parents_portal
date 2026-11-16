import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKEN, apiError, mockApi, reply, watchConsole } from "../test/helpers.js";
import { confirmPasswordReset, requestPasswordReset, resendPasswordReset, resetErrorMessage, verifyPasswordResetCode } from "./passwordResetApi.js";

afterEach(() => vi.unstubAllGlobals());
const CHALLENGE = { expiresInSeconds: 300, resendAvailableInSeconds: 30, delivery: "smtp", alreadySent: false };
const URL = "/api/auth/password-reset";

describe("requestPasswordReset / resendPasswordReset", () => {
  it("post the normalised email to the dedicated endpoints (never the generic email-otp ones)", async () => {
    const api = mockApi({ [`${URL}/request`]: reply(200, CHALLENGE), [`${URL}/resend`]: reply(200, CHALLENGE) });
    expect(await requestPasswordReset("  Parent@Example.COM ")).toEqual(CHALLENGE);
    expect(await resendPasswordReset("parent@example.com")).toEqual(CHALLENGE);
    expect(api.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", `${URL}/request`, { email: "parent@example.com" }],
      ["POST", `${URL}/resend`, { email: "parent@example.com" }],
    ]);
  });
  it("rejects a response that isn't a challenge", async () => {
    mockApi({ [`${URL}/request`]: reply(200, {}) });
    await expect(requestPasswordReset("a@b.co")).rejects.toMatchObject({ code: "SERVER_ERROR" });
  });
  it("surfaces the server's error codes", async () => {
    mockApi({ [`${URL}/request`]: [apiError(429, "RATE_LIMITED"), apiError(429, "RESEND_COOLDOWN", { retryAfterSeconds: 9 })] });
    await expect(requestPasswordReset("a@b.co")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(requestPasswordReset("a@b.co")).rejects.toMatchObject({ code: "RESEND_COOLDOWN", details: { retryAfterSeconds: 9 } });
  });
});

describe("verifyPasswordResetCode", () => {
  it("posts email and code, and resolves with the token only if the server verified it", async () => {
    const api = mockApi({ [`${URL}/verify`]: [reply(200, { verified: true, verificationToken: TOKEN, verificationTokenExpiresInSeconds: 900 }), reply(200, { verified: false })] });
    expect(await verifyPasswordResetCode("A@B.co", "123456")).toEqual({ verificationToken: TOKEN, verificationTokenExpiresInSeconds: 900 });
    expect(api.calls[0].body).toEqual({ email: "a@b.co", code: "123456" });
    await expect(verifyPasswordResetCode("a@b.co", "123456")).rejects.toMatchObject({ code: "SERVER_ERROR" });
  });
});

describe("confirmPasswordReset", () => {
  const details = { email: " Parent@Example.com ", verificationToken: TOKEN, password: "  new pass phrase  ", confirmPassword: "  new pass phrase  " };

  it("sends the token and the password exactly as typed, only in the body", async () => {
    const api = mockApi({ [`${URL}/confirm`]: reply(200, { passwordChanged: true }) });
    await expect(confirmPasswordReset(details)).resolves.toBeUndefined();
    expect(api.calls[0].body).toEqual({ email: "parent@example.com", verificationToken: TOKEN, password: "  new pass phrase  ", confirmPassword: "  new pass phrase  " });
    const url = api.fetchMock.mock.calls[0][0];
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("pass phrase");
  });

  it("resolves only when the server confirms the change", async () => {
    mockApi({ [`${URL}/confirm`]: [reply(200, {}), reply(200, { passwordChanged: false })] });
    await expect(confirmPasswordReset(details)).rejects.toMatchObject({ code: "SERVER_ERROR" });
    await expect(confirmPasswordReset(details)).rejects.toMatchObject({ code: "SERVER_ERROR" });
  });

  it("surfaces error codes, and network failures become typed errors", async () => {
    mockApi({ [`${URL}/confirm`]: [apiError(403, "VERIFICATION_REQUIRED"), apiError(400, "VALIDATION_ERROR")] });
    await expect(confirmPasswordReset(details)).rejects.toMatchObject({ code: "VERIFICATION_REQUIRED" });
    await expect(confirmPasswordReset(details)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(confirmPasswordReset(details)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("never logs the password or token", async () => {
    const logged = watchConsole();
    mockApi({ [`${URL}/confirm`]: apiError(500, "INTERNAL_ERROR") });
    await confirmPasswordReset(details).catch(() => {});
    expect(logged("pass phrase")).toBe(false);
    expect(logged(TOKEN)).toBe(false);
  });
});

describe("resetErrorMessage", () => {
  it("is friendly, never contains server text, and explains each situation", () => {
    for (const code of ["VERIFICATION_REQUIRED", "VALIDATION_ERROR", "NETWORK_ERROR", "OTHER"]) {
      expect(resetErrorMessage({ code, message: "server text" })).not.toContain("server text");
    }
    expect(resetErrorMessage({ code: "VERIFICATION_REQUIRED" })).toMatch(/start again/);
    expect(resetErrorMessage({ code: "NETWORK_ERROR" })).toMatch(/Can't reach the server/);
  });
});
