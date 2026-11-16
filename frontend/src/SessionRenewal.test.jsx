import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import AppRoutes from "./AppRoutes.jsx";
import OnboardingFlow from "./components/onboarding/OnboardingFlow.jsx";
import { downloads } from "./test/downloads.js";
import { createFakeAdmin } from "./test/fakeAdmin.js";
import { FAKE_PDF, FAKE_REFERENCE, createFakeBackend } from "./test/fakeBackend.js";
import { storageIsEmpty } from "./test/helpers.js";

// The access token lives 15 minutes; the fakes imitate it running out (`accessExpired`: protected requests answer 401
// UNAUTHENTICATED until the page renews). These tests check what a parent or staff member actually experiences then.

let user;
beforeEach(() => {
  user = userEvent.setup();
  downloads.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

const REFRESH = "POST /api/auth/refresh";
const STAFF_REFRESH = /POST \/api\/admin\/auth\/refresh$/;
const ENROLMENT = "00000000-0000-4000-9000-000000000001";
const TRIP = { school: "GV School", branch: "Kolkata", title: "Jaipur 2027", destination: "Jaipur", tourType: "domestic", academicYear: "2026-27", paymentMode: "payment" };
const ANSWERS = { fullName: "Asha Rao", gender: "Female", classSection: "4 - B", dateOfBirth: "2016-05-04", nomineeName: "B Vijaya", nomineeRelation: "Mother", mealPreference: "Veg", allergy: "Peanuts", phone: "9876543210", remark: "Window seat please" };
const form = (over = {}) => ({ tourType: "domestic", role: "student", status: "draft", data: {}, currentSection: "personal", version: 1, updatedAt: "2026-10-21T10:00:00.000Z", submittedAt: null, ...over });

function parent(over = {}) {
  const be = createFakeBackend({ signedIn: true });
  Object.assign(be.state, { trip: TRIP, currentId: ENROLMENT, ...over });
  return be;
}
function openForm(be) {
  const onSignedOut = vi.fn();
  render(<OnboardingFlow user={be.state.user} onSignedOut={onSignedOut} autosaveDelayMs={20} enrolmentId={ENROLMENT} />);
  return { onSignedOut };
}
const renewals = (be) => be.calls().filter((c) => c.key === REFRESH).length;

describe("parents: an expired access token is renewed without the parent noticing", () => {
  it("a returning parent whose access token ran out is still signed in (one renewal), not sent to Login", async () => {
    const be = createFakeBackend({ signedIn: true });
    be.state.accessExpired = true;
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Open your school's trip registration link" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Login" })).not.toBeInTheDocument();
    expect(renewals(be)).toBe(1);
    expect(storageIsEmpty()).toBe(true);
  });

  it("typing after the token ran out: the autosave renews, then saves exactly what was typed; nothing is lost", async () => {
    const be = parent({ form: form({ data: { fullName: "Asha" }, version: 2 }) });
    const { onSignedOut } = openForm(be);
    await screen.findByRole("progressbar", { name: "Form completion" });
    be.state.accessExpired = true; // 15 minutes pass while the parent reads the form
    await user.type(screen.getByLabelText(/Full name/), " Rao");
    await waitFor(() => expect(be.state.form.data.fullName).toBe("Asha Rao"));
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
    expect(screen.getByLabelText(/Full name/)).toHaveValue("Asha Rao");
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(renewals(be)).toBe(1);
    expect(storageIsEmpty()).toBe(true); // no copy of the answers or of any token is kept in the browser
  });

  it("submitting after the token ran out submits exactly once and shows the dashboard", async () => {
    const be = parent({ form: form({ data: ANSWERS, currentSection: "review", version: 3 }) });
    openForm(be);
    await user.click(await screen.findByRole("checkbox", { name: /I confirm that the information provided/ }));
    await user.type(screen.getByLabelText(/Full name \(Digital Signature\)/), "Meera Rao");
    be.state.accessExpired = true;
    await user.click(screen.getByRole("button", { name: "Submit registration" }));
    expect(await screen.findByRole("navigation", { name: "Dashboard sections" })).toBeInTheDocument();
    expect(be.state.submissions).toBe(1);
    expect(be.calls().filter((c) => c.key === "POST /api/onboarding/submit")).toHaveLength(2); // refused unprocessed, then sent once
    expect(be.state.form.acknowledgement.signatureName).toBe("Meera Rao");
    expect(renewals(be)).toBe(1);
  });

  it("downloading the PDF after the token ran out renews and downloads it", async () => {
    const now = "2026-10-26T08:35:00.000Z";
    const be = parent({ form: form({ data: ANSWERS, status: "submitted", currentSection: "review", version: 6, submittedAt: now, reference: FAKE_REFERENCE, acknowledgement: { declarationVersion: "2026-10-v1", acceptedAt: now, signatureName: "Meera Rao" } }) });
    openForm(be);
    const button = await screen.findByRole("button", { name: /Download PDF/ });
    be.state.accessExpired = true;
    await user.click(button);
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(await downloads[0].blob.text()).toBe(FAKE_PDF);
    expect(renewals(be)).toBe(1);
  });

  it("when the sign-in itself is over (renewal refused), the parent is told; it does not happen silently", async () => {
    const be = parent({ form: form({ data: { fullName: "Asha" }, version: 2 }) });
    const { onSignedOut } = openForm(be);
    await screen.findByRole("progressbar", { name: "Form completion" });
    Object.assign(be.state, { accessExpired: true, refreshOk: false }); // e.g. the 3-day inactivity limit, or logged out elsewhere
    await user.type(screen.getByLabelText(/Full name/), " Rao");
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledWith("Your session has ended. Please log in again."));
    expect(renewals(be)).toBe(1); // tried once, no loop
  });

  it("several requests failing together share one renewal (returning parent, form and status load at once)", async () => {
    const be = parent({ form: form({ data: { fullName: "Asha" }, version: 2 }) });
    be.state.accessExpired = true;
    render(<App />);
    await screen.findByRole("progressbar", { name: "Form completion" }, { timeout: 5000 });
    expect(renewals(be)).toBe(1);
  });
});

describe("staff: the panel renews too", () => {
  const at = (path) => render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>);

  it("opening the dashboard after the access token ran out renews (once) and shows it", async () => {
    const be = createFakeAdmin();
    be.addSchool();
    be.state.accessExpired = true;
    at("/admin/schools");
    expect(await screen.findByRole("heading", { name: "Schools" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Admin log in" })).not.toBeInTheDocument();
    expect(be.calls(STAFF_REFRESH)).toHaveLength(1);
    expect(be.calls(/POST \/api\/auth\/refresh/)).toHaveLength(0);
    expect(storageIsEmpty()).toBe(true);
  });

  it("a logo uploaded after the token ran out is stored once", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool();
    at(`/admin/schools/${s.id}`);
    const section = await screen.findByRole("region", { name: "School logo" });
    be.state.accessExpired = true;
    await user.upload(within(section).getByLabelText("Upload logo"), new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])], "logo.png", { type: "image/png" }));
    expect(await within(section).findByAltText("Greenfield Public School logo")).toBeInTheDocument();
    expect(be.calls(STAFF_REFRESH)).toHaveLength(1);
    const puts = be.calls(/PUT .*\/logo$/);
    expect(puts).toHaveLength(2); // the refused attempt (never processed) and the one that was stored
    expect(puts[1].body).toBeInstanceOf(File);
  });

  it("when the staff sign-in is over, the login comes back with a notice", async () => {
    const be = createFakeAdmin();
    be.addSchool();
    at("/admin/schools");
    await screen.findByRole("heading", { name: "Schools" });
    Object.assign(be.state, { accessExpired: true, refreshOk: false });
    await user.click(screen.getByLabelText("Show archived"));
    expect(await screen.findByRole("heading", { name: "Admin log in" })).toBeInTheDocument();
    expect(screen.getByText("Your session has ended. Please log in again.")).toBeInTheDocument();
    expect(be.calls(STAFF_REFRESH)).toHaveLength(1);
  });
});

describe("visitors who were never signed in", () => {
  it("opening the portal signed out makes no renewal attempt (the server says there is nothing to renew)", async () => {
    const be = createFakeBackend();
    render(<App />);
    expect(await screen.findByRole("tab", { name: "Login" }, { timeout: 5000 })).toBeInTheDocument();
    expect(renewals(be)).toBe(0);
  });
});
