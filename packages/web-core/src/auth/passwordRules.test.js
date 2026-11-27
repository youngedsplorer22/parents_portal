import { describe, expect, it } from "vitest";
import { confirmProblem, passwordProblem } from "./passwordRules.js";

describe("passwordProblem", () => {
  it("accepts a long enough password and counts characters, not UTF-16 units", () => {
    expect(passwordProblem("0123456789")).toBe("");
    expect(passwordProblem("😀".repeat(10))).toBe("");
    expect(passwordProblem("😀".repeat(9))).toBe("Password must be at least 10 characters.");
  });
  it("explains each problem", () => {
    expect(passwordProblem("")).toBe("Create a password.");
    expect(passwordProblem("short")).toBe("Password must be at least 10 characters.");
    expect(passwordProblem("a".repeat(129))).toBe("Password must be 128 characters or fewer.");
    expect(passwordProblem(" ".repeat(12))).toBe("Password can't be only spaces.");
    expect(passwordProblem("a".repeat(128))).toBe("");
  });
});

describe("confirmProblem", () => {
  it("requires the confirmation to be present and identical", () => {
    expect(confirmProblem("x", "")).toBe("Confirm your password.");
    expect(confirmProblem("abc", "abd")).toBe("Passwords do not match.");
    expect(confirmProblem("abc", "abc")).toBe("");
  });
});
