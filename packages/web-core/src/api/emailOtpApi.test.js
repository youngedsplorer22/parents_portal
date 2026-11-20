import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, mockApi, reply, TOKEN, VERIFIED, watchConsole } from "../test/helpers.js";
import { OtpApiError, normalizeEmail, otpErrorMessage, resendEmailOtp, sendEmailOtp, verifyEmailOtp } from "./emailOtpApi.js";

afterEach(() => vi.unstubAllGlobals());

const challenge = { expiresInSeconds: 300, resendAvailableInSeconds: 30, delivery: "smtp", alreadySent: false };
const code = (promise) => promise.then(() => "no error", (e) => e.code);

describe("requests", () => {
  it("send POSTs the normalised email and the registration purpose as JSON", async () => {
    const api = mockApi({ "/api/email-otp/send": reply(200, challenge) });
    const res = await sendEmailOtp("  Parent@Example.COM ");
    expect(res).toEqual(challenge);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ url: "/api/email-otp/send", method: "POST", body: { email: "parent@example.com", purpose: "registration" } });
    expect(api.fetchMock.mock.calls[0][1].headers["Content-Type"]).toBe("application/json");
    expect(api.fetchMock.mock.calls[0][1].cache).toBe("no-store");
  });

  it("resend uses the existing /resend endpoint", async () => {
    const api = mockApi({ "/api/email-otp/resend": reply(200, challenge) });
    await resendEmailOtp("a@b.co");
    expect(api.urls()).toEqual(["/api/email-otp/resend"]);
  });

  it("verify sends the code and returns the token", async () => {
    const api = mockApi({ "/api/email-otp/verify": reply(200, VERIFIED) });
    const res = await verifyEmailOtp("a@b.co", "482913");
    expect(api.calls[0].body).toEqual({ email: "a@b.co", purpose: "registration", code: "482913" });
    expect(res).toEqual({ verificationToken: TOKEN, verificationTokenExpiresInSeconds: 900 });
  });

  it("passes an AbortSignal through to fetch", async () => {
    const api = mockApi({ "/api/email-otp/send": reply(200, challenge) });
    const controller = new AbortController();
    await sendEmailOtp("a@b.co", { signal: controller.signal });
    expect(api.calls[0].signal).toBe(controller.signal);
  });

  it("normalizeEmail trims and lowercases", () => {
    expect(normalizeEmail("  A@B.Co ")).toBe("a@b.co");
  });
});

describe("errors", () => {
  it("turns the backend error body into an OtpApiError with code, status and details", async () => {
    mockApi({ "/api/email-otp/verify": apiError(400, "INVALID_CODE", { attemptsRemaining: 4 }) });
    const err = await verifyEmailOtp("a@b.co", "000000").catch((e) => e);
    expect(err).toBeInstanceOf(OtpApiError);
    expect(err).toMatchObject({ code: "INVALID_CODE", status: 400 });
    expect(err.details.attemptsRemaining).toBe(4);
  });

  it("maps every backend status the OTP endpoints return", async () => {
    for (const [status, errCode] of [[404, "OTP_NOT_FOUND"], [410, "OTP_EXPIRED"], [429, "TOO_MANY_ATTEMPTS"], [502, "DELIVERY_FAILED"]]) {
      mockApi({ "/api/email-otp/verify": apiError(status, errCode) });
      expect(await code(verifyEmailOtp("a@b.co", "123456"))).toBe(errCode);
    }
  });

  it("a network failure becomes NETWORK_ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await code(sendEmailOtp("a@b.co"))).toBe("NETWORK_ERROR");
  });

  it("an aborted request is rethrown as AbortError, not shown as an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    const err = await sendEmailOtp("a@b.co").catch((e) => e);
    expect(err.name).toBe("AbortError");
  });

  it("a non-JSON error page (e.g. proxy down) becomes SERVER_ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 })));
    expect(await code(sendEmailOtp("a@b.co"))).toBe("SERVER_ERROR");
  });

  it("rejects malformed success responses instead of trusting them", async () => {
    mockApi({ "/api/email-otp/send": reply(200, { hello: "world" }) });
    expect(await code(sendEmailOtp("a@b.co"))).toBe("SERVER_ERROR");
    mockApi({ "/api/email-otp/verify": reply(200, { verified: true }) });
    expect(await code(verifyEmailOtp("a@b.co", "123456"))).toBe("SERVER_ERROR");
    mockApi({ "/api/email-otp/verify": reply(200, { verified: false, verificationToken: "x" }) });
    expect(await code(verifyEmailOtp("a@b.co", "123456"))).toBe("SERVER_ERROR");
  });

  it("never puts the token or code in console output, thrown errors or error messages", async () => {
    const logged = watchConsole();
    mockApi({ "/api/email-otp/verify": [reply(200, VERIFIED), apiError(400, "INVALID_CODE", { attemptsRemaining: 2 })] });
    await verifyEmailOtp("a@b.co", "482913");
    const err = await verifyEmailOtp("a@b.co", "482913").catch((e) => e);
    expect(logged(TOKEN)).toBe(false);
    expect(logged("482913")).toBe(false);
    expect(JSON.stringify([err.message, err.code, err.details])).not.toContain("482913");
  });
});

describe("otpErrorMessage", () => {
  const msg = (code, details) => otpErrorMessage(new OtpApiError(code, { details }));

  it("explains each failure in user terms", () => {
    expect(msg("INVALID_CODE", { attemptsRemaining: 4 })).toBe("That code is incorrect. 4 attempts left.");
    expect(msg("INVALID_CODE", { attemptsRemaining: 1 })).toBe("That code is incorrect. 1 attempt left.");
    expect(msg("OTP_EXPIRED")).toMatch(/expired/);
    expect(msg("TOO_MANY_ATTEMPTS")).toMatch(/Too many incorrect attempts/);
    expect(msg("RESEND_COOLDOWN", { retryAfterSeconds: 12 })).toBe("Please wait 12s before requesting a new code.");
    expect(msg("RATE_LIMITED")).toMatch(/try again later/);
    expect(msg("DELIVERY_FAILED")).toMatch(/couldn't send the email/);
    expect(msg("NETWORK_ERROR")).toMatch(/Can't reach the server/);
    expect(msg("OTP_NOT_FOUND")).toMatch(/Request a new code/);
  });

  it("falls back to a generic message and never shows raw server text", () => {
    const text = otpErrorMessage(new OtpApiError("SOMETHING_NEW", { details: { message: "stack trace here" } }));
    expect(text).toBe("Something went wrong. Please try again.");
    expect(otpErrorMessage(new Error("boom"))).toBe("Something went wrong. Please try again.");
  });
});
