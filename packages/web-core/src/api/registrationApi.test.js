import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, mockApi, reply, TOKEN, watchConsole } from "../test/helpers.js";
import { ApiError } from "./http.js";
import { fieldErrorsFrom, registerParent, registrationErrorMessage } from "./registrationApi.js";

afterEach(() => vi.unstubAllGlobals());

const details = {
  firstName: "  Asha ",
  lastName: " Rao",
  role: "Teacher",
  phone: " 9876543210 ",
  email: "  Parent@Example.COM ",
  password: "  correct horse  ",
  verificationToken: TOKEN,
};
const created = { registered: true, registrationId: "8f0c2d3e-1111-4222-8333-444455556666", email: "parent@example.com" };
const code = (p) => p.then(() => "no error", (e) => e.code);

describe("registerParent", () => {
  it("POSTs trimmed, normalised details and the token to /api/registrations", async () => {
    const api = mockApi({ "/api/registrations": reply(201, created) });
    const result = await registerParent(details);

    expect(result).toEqual({ registrationId: created.registrationId, email: "parent@example.com" });
    expect(api.calls[0]).toMatchObject({ url: "/api/registrations", method: "POST" });
    expect(api.calls[0].body).toEqual({
      firstName: "Asha",
      lastName: "Rao",
      role: "Teacher",
      phone: "9876543210",
      email: "parent@example.com",
      password: "  correct horse  ", // never trimmed
      verificationToken: TOKEN,
    });
    expect(api.fetchMock.mock.calls[0][0]).not.toContain(TOKEN);
    expect(api.fetchMock.mock.calls[0][1].cache).toBe("no-store");
  });

  it("only resolves when the backend confirms the insert", async () => {
    for (const body of [{}, { registered: false, registrationId: "x" }, { registered: true }, { registered: true, registrationId: "" }]) {
      mockApi({ "/api/registrations": reply(200, body) });
      expect(await code(registerParent(details))).toBe("SERVER_ERROR");
    }
  });

  it("surfaces each backend error code", async () => {
    for (const [status, errCode] of [[400, "VALIDATION_ERROR"], [403, "VERIFICATION_REQUIRED"], [409, "EMAIL_ALREADY_REGISTERED"], [500, "INTERNAL_ERROR"]]) {
      mockApi({ "/api/registrations": apiError(status, errCode) });
      expect(await code(registerParent(details))).toBe(errCode);
    }
  });

  it("network failures and proxy error pages become typed errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await code(registerParent(details))).toBe("NETWORK_ERROR");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 })));
    expect(await code(registerParent(details))).toBe("SERVER_ERROR");
  });

  it("passes the AbortSignal and rethrows aborts untouched", async () => {
    const api = mockApi({ "/api/registrations": reply(201, created) });
    const controller = new AbortController();
    await registerParent(details, { signal: controller.signal });
    expect(api.calls[0].signal).toBe(controller.signal);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    expect((await registerParent(details).catch((e) => e)).name).toBe("AbortError");
  });

  it("never writes the token to the console, even when the request fails", async () => {
    const logged = watchConsole();
    mockApi({ "/api/registrations": [reply(201, created), apiError(500, "INTERNAL_ERROR")] });
    await registerParent(details);
    const err = await registerParent(details).catch((e) => e);
    expect(logged(TOKEN)).toBe(false);
    expect(JSON.stringify([err.message, err.code, err.details])).not.toContain(TOKEN);
  });
});

describe("fieldErrorsFrom: password fields", () => {
  it("keeps password and confirmation errors, and drops a school error (there is no school field)", () => {
    const err = new ApiError("VALIDATION_ERROR", {
      details: { fields: [
        { path: "password", message: "Password must be at least 10 characters." },
        { path: "school", message: "ignored" },
      ] },
    });
    expect(fieldErrorsFrom(err)).toEqual({ password: "Password must be at least 10 characters." });
  });
});

describe("fieldErrorsFrom", () => {
  it("maps backend field errors to form fields and ignores unknown paths", () => {
    const err = new ApiError("VALIDATION_ERROR", {
      details: { fields: [
        { path: "phone", message: "Enter a valid phone number." },
        { path: "phone", message: "second message is ignored" },
        { path: "firstName", message: "First name is required." },
        { path: "verificationToken", message: "not a form field" },
        { path: "__proto__", message: "nope" },
      ] },
    });
    expect(fieldErrorsFrom(err)).toEqual({ phone: "Enter a valid phone number.", firstName: "First name is required." });
  });

  it("tolerates missing or malformed details", () => {
    expect(fieldErrorsFrom(new ApiError("VALIDATION_ERROR"))).toEqual({});
    expect(fieldErrorsFrom(undefined)).toEqual({});
    expect(fieldErrorsFrom(new ApiError("X", { details: { fields: "oops" } }))).toEqual({});
  });
});

describe("registrationErrorMessage", () => {
  const msg = (c) => registrationErrorMessage(new ApiError(c));

  it("gives a clear message per failure", () => {
    expect(msg("VERIFICATION_REQUIRED")).toMatch(/expired or was already used.*verify your email again/i);
    expect(msg("EMAIL_ALREADY_REGISTERED")).toMatch(/already registered/i);
    expect(msg("VALIDATION_ERROR")).toMatch(/check the highlighted details/i);
    expect(msg("NETWORK_ERROR")).toMatch(/couldn't confirm your registration/i);
  });

  it("falls back to a generic message and never shows raw server text", () => {
    expect(msg("INTERNAL_ERROR")).toBe("We couldn't complete your registration. Please try again.");
    expect(registrationErrorMessage(new ApiError("X", { details: { message: "stack trace" } }))).not.toContain("stack");
  });
});
