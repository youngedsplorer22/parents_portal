import { describe, expect, it } from "vitest";
import { nextPhoneValue } from "./phoneInput.js";

// Typing can't add an 11th character, but nothing is ever cut down: a pasted or auto-filled value is kept exactly as it
// was entered, so the inline error can explain it (shortening "919876543210" to "9198765432" would invent a number).
describe("phone input: typing stops at 10, nothing is shortened", () => {
  it("typing the 11th character is ignored", () => {
    expect(nextPhoneValue("9876543210", "98765432101")).toBe("9876543210");
    expect(nextPhoneValue("9876543210", "9876543210a")).toBe("9876543210");
  });
  it("typing up to 10 characters, and deleting, work normally", () => {
    expect(nextPhoneValue("", "9")).toBe("9");
    expect(nextPhoneValue("987654321", "9876543210")).toBe("9876543210");
    expect(nextPhoneValue("9876543210", "987654321")).toBe("987654321");
  });
  it("a paste or autofill longer than 10 is kept whole (never truncated into a different valid number)", () => {
    expect(nextPhoneValue("", "919876543210")).toBe("919876543210");
    expect(nextPhoneValue("", "+91 98765 43210")).toBe("+91 98765 43210");
    expect(nextPhoneValue("98", "98765432101234")).toBe("98765432101234");
  });
  it("an over-long value (e.g. an older draft) can be shortened by deleting, but not lengthened by typing", () => {
    expect(nextPhoneValue("+91 98765 43210", "+91 98765 4321")).toBe("+91 98765 4321");
    expect(nextPhoneValue("+91 98765 43210", "+91 98765 432109")).toBe("+91 98765 43210");
  });
});
