import { describe, expect, it } from "vitest";
import { adminErrorMessage } from "../admin/adminApi.js";
import { loginErrorMessage } from "./authApi.js";
import { ApiError, serverBusyMessage } from "./http.js";
import { resetErrorMessage } from "./passwordResetApi.js";
import { registrationErrorMessage } from "./registrationApi.js";

// The server answers 503 SERVER_BUSY (with retryAfterSeconds) when a burst of sign-ins has taken every place for
// password checks. Nothing was checked or counted, so the honest message is simply "try again shortly".
const busy = (retryAfterSeconds) => new ApiError("SERVER_BUSY", { status: 503, details: { message: "server text", retryAfterSeconds } });

describe("busy server (503 SERVER_BUSY)", () => {
  it("says it's busy and when to try again, never showing the server's own text", () => {
    expect(serverBusyMessage(busy(2))).toBe("Lots of people are signing in right now. Please try again in a few seconds.");
    expect(serverBusyMessage(busy(12))).toBe("Lots of people are signing in right now. Please try again in about 12 seconds.");
    expect(serverBusyMessage(busy(undefined))).toBe("Lots of people are signing in right now. Please try again in a few seconds.");
    expect(serverBusyMessage(busy("<b>9</b>"))).toBe("Lots of people are signing in right now. Please try again in a few seconds.");
  });

  it("is used by parent sign-in, registration, password reset and the staff portals", () => {
    for (const fn of [loginErrorMessage, registrationErrorMessage, resetErrorMessage, adminErrorMessage]) {
      const text = fn(busy(12));
      expect(text).toBe(serverBusyMessage(busy(12)));
      expect(text).not.toContain("server text");
    }
  });

  it("is not mistaken for a rate limit or a wrong password", () => {
    expect(loginErrorMessage(busy(3))).not.toMatch(/too many|incorrect/i);
    expect(adminErrorMessage(busy(3))).not.toMatch(/too many|incorrect/i);
  });
});
