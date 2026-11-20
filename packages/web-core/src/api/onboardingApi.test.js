import { afterEach, describe, expect, it, vi } from "vitest";
import { fieldErrorsFrom, loadOnboarding, onboardingErrorMessage, saveDraft, submitOnboarding } from "./onboardingApi.js";
import { apiError, mockApi, reply } from "../test/helpers.js";

afterEach(() => vi.unstubAllGlobals());
const DEFS = { domestic: { sections: [] }, international: { sections: [] } };
const FORM = { tourType: "domestic", status: "draft", data: {}, version: 2, submittedAt: null };

describe("loadOnboarding", () => {
  it("returns role, definitions and the form (or null)", async () => {
    mockApi({ "/api/onboarding": [reply(200, { role: "student", definitions: DEFS, form: null }), reply(200, { role: "student", definitions: DEFS, form: FORM })] });
    expect((await loadOnboarding()).form).toBeNull();
    expect((await loadOnboarding()).form).toEqual(FORM);
  });
  it("rejects a response without usable definitions or with a malformed form", async () => {
    mockApi({ "/api/onboarding": [reply(200, { role: "student", form: null }), reply(200, { role: "student", definitions: DEFS, form: { version: "x" } })] });
    await expect(loadOnboarding()).rejects.toMatchObject({ code: "SERVER_ERROR" });
    await expect(loadOnboarding()).rejects.toMatchObject({ code: "SERVER_ERROR" });
  });
});

describe("saveDraft", () => {
  it("sends only the tour, answers, section and version, never an owner id", async () => {
    const api = mockApi({ "/api/onboarding": reply(200, { form: FORM }) });
    await saveDraft({ tourType: "domestic", data: { fullName: "A" }, currentSection: "personal", version: 1 });
    expect(api.calls[0]).toMatchObject({ method: "PUT", body: { tourType: "domestic", data: { fullName: "A" }, currentSection: "personal", version: 1 } });
    expect(Object.keys(api.calls[0].body).sort()).toEqual(["currentSection", "data", "tourType", "version"]);
  });
  it("rejects a response that is not a saved draft", async () => {
    mockApi({ "/api/onboarding": reply(200, { form: { ...FORM, status: "submitted" } }) });
    await expect(saveDraft({ tourType: "domestic", data: {}, version: 1 })).rejects.toMatchObject({ code: "SERVER_ERROR" });
  });
});

describe("submitOnboarding", () => {
  it("resolves only when the server reports the form as submitted with a time", async () => {
    mockApi({ "/api/onboarding/submit": [reply(200, { form: { ...FORM, status: "submitted", submittedAt: "2026-10-21T10:00:00Z" } }), reply(200, { form: FORM }), reply(200, { form: { ...FORM, status: "submitted" } })] });
    expect((await submitOnboarding(2)).status).toBe("submitted");
    await expect(submitOnboarding(2)).rejects.toMatchObject({ code: "SERVER_ERROR" });
    await expect(submitOnboarding(2)).rejects.toMatchObject({ code: "SERVER_ERROR" });
  });
  it("surfaces the server's refusal", async () => {
    mockApi({ "/api/onboarding/submit": apiError(422, "FORM_INCOMPLETE", { fields: [{ path: "data.phone", message: "bad" }] }) });
    await expect(submitOnboarding(2)).rejects.toMatchObject({ code: "FORM_INCOMPLETE", status: 422 });
  });
});

describe("final submission body", () => {
  it("carries the accepted declaration's version and the signature, and no date", async () => {
    const api = mockApi({ "/api/onboarding/submit": reply(200, { form: { ...FORM, status: "submitted", submittedAt: "2026-10-21T10:00:00Z" } }) });
    await submitOnboarding(2, { declarationVersion: "2026-10-v1", signatureName: "Asha Rao", enrolmentId: "legacy" });
    expect(api.calls[0].body).toEqual({ version: 2, declarationAccepted: true, declarationVersion: "2026-10-v1", signatureName: "Asha Rao", enrolmentId: "legacy" });
  });
});

describe("helpers", () => {
  it("fieldErrorsFrom strips the data. prefix and keeps the first message per field", () => {
    expect(fieldErrorsFrom({ details: { fields: [{ path: "data.phone", message: "a" }, { path: "data.phone", message: "b" }, { path: "data.fullName", message: "c" }] } })).toEqual({ phone: "a", fullName: "c" });
    expect(fieldErrorsFrom({})).toEqual({});
  });
  it("error messages are fixed text, never the server's", () => {
    for (const code of ["FORM_INCOMPLETE", "VERSION_CONFLICT", "FORM_SUBMITTED", "ALREADY_SUBMITTED", "NETWORK_ERROR", "UNAUTHENTICATED", "WHATEVER"]) {
      expect(onboardingErrorMessage({ code, message: "server text" })).not.toContain("server text");
    }
  });
});
