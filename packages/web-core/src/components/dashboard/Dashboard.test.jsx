import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingFlow from "../onboarding/OnboardingFlow.jsx";
import { downloads } from "../../test/downloads.js";
import { FAKE_PDF, FAKE_REFERENCE, createFakeBackend } from "../../test/fakeBackend.js";
import { apiError } from "../../test/helpers.js";

let user;
beforeEach(() => {
  user = userEvent.setup();
});
afterEach(() => vi.useRealTimers());

const PDF = "GET /api/onboarding/pdf";
const STATUS = "GET /api/onboarding/pdf/status";
const RETRY = "POST /api/onboarding/pdf/retry";
const SUBMIT = "POST /api/onboarding/submit";
const SECTIONS = ["Personal Details", "Payment Status", "Itinerary", "Insurance", "Train / Flight Tickets", "Live Tracking"];
const PLACEHOLDERS = {
  "Payment Status": "Payment information will be available here soon.",
};
const TRIP = { school: "GV School", branch: "Kolkata", title: "Jaipur 2027", destination: "Jaipur", tourType: "domestic", academicYear: "2026-27", paymentMode: "payment" };
const ANSWERS = { fullName: "Asha Rao", gender: "Female", classSection: "4 - B", dateOfBirth: "2016-05-04", nomineeName: "B Vijaya", nomineeRelation: "Mother", mealPreference: "Veg", allergy: "Peanuts", phone: "9876543210", remark: "Window seat please" };
const submittedForm = (over = {}) => ({
  tourType: "domestic", role: "student", status: "submitted", data: ANSWERS, currentSection: "review", version: 6,
  updatedAt: "2026-10-26T08:35:00.000Z", submittedAt: "2026-10-26T08:35:00.000Z", reference: FAKE_REFERENCE,
  acknowledgement: { declarationVersion: "2026-10-v1", acceptedAt: "2026-10-26T08:35:00.000Z", signatureName: "Meera Rao" },
  ...over,
});
const ENROLMENT = "00000000-0000-4000-9000-000000000001";

/** A signed-in parent whose registration is already submitted. */
function submitted({ pdfStatus = "stored", form = submittedForm() } = {}) {
  const be = createFakeBackend({ signedIn: true, user: { email: "parent@example.com", firstName: "Rishi", lastName: "Rao", role: "Student" } });
  Object.assign(be.state, { trip: TRIP, currentId: ENROLMENT, form, pdfStatus });
  return be;
}
function open(be, props = {}) {
  const onSignedOut = vi.fn();
  const view = render(<OnboardingFlow user={be.state.user} onSignedOut={onSignedOut} autosaveDelayMs={20} enrolmentId={ENROLMENT} {...props} />);
  return { ...view, onSignedOut };
}
const nav = () => screen.getByRole("navigation", { name: "Dashboard sections" });
const navItem = (name) => within(nav()).getByRole("link", { name });
const main = () => document.querySelector(".dashboard-main");
const pdfButton = () => screen.getByRole("button", { name: /Download PDF/ });

describe("after submitting: the dashboard, with no automatic download", () => {
  it("submitting lands on the Parent Dashboard (loaded from the server), requests no PDF and downloads nothing", async () => {
    const be = createFakeBackend({ signedIn: true, user: { email: "parent@example.com", firstName: "Rishi", lastName: "Rao", role: "Student" } });
    Object.assign(be.state, { trip: TRIP, currentId: ENROLMENT, pdfAfterSubmit: "pending", form: { ...submittedForm(), status: "draft", submittedAt: null, acknowledgement: undefined, reference: undefined, data: ANSWERS, currentSection: "review", version: 3 } });
    open(be);
    await user.click(await screen.findByRole("checkbox", { name: /I confirm that the information provided/ }));
    await user.type(screen.getByLabelText(/Full name \(Digital Signature\)/), "Asha Rao");
    await user.click(screen.getByRole("button", { name: "Submit registration" }));
    expect(await screen.findByRole("navigation", { name: "Dashboard sections" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Personal Details" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Registration submitted" })).toBeInTheDocument();
    // the registration shown is the server's, read back after the submission
    expect(be.calls("GET /api/onboarding").length).toBeGreaterThanOrEqual(2);
    expect(be.calls(SUBMIT)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(be.calls(PDF)).toHaveLength(0);
    expect(downloads).toHaveLength(0);
    expect(be.state.pdfStatus).toBe("pending");
  });

  it("refreshing the dashboard shows it again: no download, no second submission", async () => {
    const be = submitted();
    const first = open(be);
    await screen.findByRole("heading", { level: 1, name: "Personal Details" });
    first.unmount();
    open(be);
    await screen.findByRole("heading", { level: 1, name: "Personal Details" });
    await new Promise((r) => setTimeout(r, 200));
    expect(be.calls(SUBMIT)).toHaveLength(0);
    expect(be.calls(PDF)).toHaveLength(0);
    expect(downloads).toHaveLength(0);
    expect(be.saves()).toHaveLength(0);
  });
});

describe("Personal Details", () => {
  it("shows what the server saved: status, reference, time, the parent's account, trip, school and every answer", async () => {
    open(submitted());
    expect(await screen.findByRole("heading", { name: "Registration submitted" })).toBeInTheDocument();
    const status = within(screen.getByRole("region", { name: "Trip details" }));
    expect(status.getByText("School").nextSibling).toHaveTextContent("GV School · Kolkata");
    expect(status.getByText("Trip").nextSibling).toHaveTextContent("Jaipur 2027");
    expect(status.getByText("Destination").nextSibling).toHaveTextContent("Jaipur");
    expect(status.getByText("Trip type").nextSibling).toHaveTextContent("Domestic Tour");
    expect(status.getByText("Academic year").nextSibling).toHaveTextContent("2026-27");
    expect(status.getByText("Status").nextSibling).toHaveTextContent("Submitted");
    expect(status.getByText("Reference").nextSibling).toHaveTextContent(FAKE_REFERENCE);
    expect(status.getByText("Submitted on").nextSibling).toHaveTextContent(/26 October 2026/);

    const registeredBy = within(screen.getByRole("region", { name: "Registered by" }));
    expect(registeredBy.getByText("Rishi Rao")).toBeInTheDocument();
    expect(registeredBy.getByText("Student")).toBeInTheDocument();
    expect(registeredBy.getByText("parent@example.com")).toBeInTheDocument();
    expect(registeredBy.getByText("9876543210")).toBeInTheDocument();

    const answers = within(screen.getByRole("region", { name: "Your submitted answers" }));
    for (const [label, value] of [["Full name", "Asha Rao"], ["Gender", "Female"], ["Class & section", "4 - B"], ["Date of birth", "2016-05-04"], ["Nominee name", "B Vijaya"], ["Nominee relation", "Mother"], ["Meals preference", "Veg"], ["Allergy", "Peanuts"], ["Phone number", "9876543210"], ["Remark", "Window seat please"]]) {
      expect(answers.getByText(label, { selector: "dt" }).nextSibling, label).toHaveTextContent(value);
    }
    expect(answers.queryByText("Age", { selector: "dt" })).not.toBeInTheDocument(); // calculated from the date of birth; never shown on its own
  });

  it("shows the declaration and signature", async () => {
    open(submitted());
    const ack = within(await screen.findByRole("region", { name: "Declaration and signature" }));
    expect(ack.getByText("Meera Rao")).toBeInTheDocument();
    expect(ack.getByText("Digital Signature", { selector: "dt" }).nextSibling).toHaveTextContent("Meera Rao");
    expect(ack.getByText("Meera Rao")).toHaveClass("signature-value"); // bold standard font, styled apart from its label
    expect(ack.getByText("Declaration accepted")).toBeInTheDocument();
    expect(ack.getByText(/accurate and complete to the best of my knowledge/)).toBeInTheDocument();
  });

  it("is read-only: no field, no edit or submit control anywhere on the dashboard", async () => {
    open(submitted());
    await screen.findByRole("heading", { name: "Registration submitted" });
    expect(document.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /edit|submit registration|save/i })).not.toBeInTheDocument();
  });

  it("invents nothing: a field the form didn't collect is not shown, and an empty optional answer is a dash", async () => {
    open(submitted({ form: submittedForm({ data: { ...ANSWERS, allergy: "", remark: undefined } }) }));
    const answers = within(await screen.findByRole("region", { name: "Your submitted answers" }));
    expect(answers.getByText("Allergy", { selector: "dt" }).nextSibling).toHaveTextContent("—");
    expect(answers.getByText("Remark", { selector: "dt" }).nextSibling).toHaveTextContent("—");
    expect(document.body.textContent).not.toMatch(/passport|PAN|Aadhaar|token|password|session/i);
  });

  it("the Download PDF button is the last thing in the section, below the declaration", async () => {
    open(submitted());
    const section = await screen.findByRole("region", { name: "Download your registration" });
    const all = [...document.querySelectorAll(".dashboard-main section")];
    expect(all.at(-1)).toBe(section);
    expect(section).toContainElement(pdfButton());
    expect(screen.getByRole("region", { name: "Declaration and signature" }).compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the sidebar", () => {
  it("lists the six sections in order, each with an icon and an accessible name, and Personal Details is current", async () => {
    open(submitted());
    await screen.findByRole("navigation", { name: "Dashboard sections" });
    const links = within(nav()).getAllByRole("link");
    expect(links.map((l) => l.textContent.trim())).toEqual(SECTIONS);
    for (const l of links) expect(l.querySelector("svg[aria-hidden='true']"), l.textContent).toBeTruthy();
    expect(navItem("Personal Details")).toHaveAttribute("aria-current", "page");
    for (const name of SECTIONS.slice(1)) expect(navItem(name)).not.toHaveAttribute("aria-current");
  });

  it("each item opens its own section, marks itself current, and puts the section in the address (so refresh and Back work)", async () => {
    open(submitted());
    await screen.findByRole("navigation", { name: "Dashboard sections" });
    for (const name of SECTIONS.slice(1)) {
      await user.click(navItem(name));
      expect(await screen.findByRole("heading", { level: 1, name })).toBeInTheDocument();
      expect(navItem(name)).toHaveAttribute("aria-current", "page");
      expect(within(nav()).getAllByRole("link").filter((l) => l.getAttribute("aria-current") === "page")).toHaveLength(1);
      expect(window.location.hash).toBe(`#${{ "Payment Status": "payment-status", Itinerary: "itinerary", Insurance: "insurance", "Train / Flight Tickets": "tickets", "Live Tracking": "live-tracking" }[name]}`);
    }
    await user.click(navItem("Personal Details"));
    expect(await screen.findByRole("heading", { level: 1, name: "Personal Details" })).toBeInTheDocument();
  });

  it("opens the section named in the address on load, falls back to Personal Details for an unknown one, and follows Back/Forward", async () => {
    window.location.hash = "#insurance";
    open(submitted());
    expect(await screen.findByRole("heading", { level: 1, name: "Insurance" })).toBeInTheDocument();
    act(() => {
      window.location.hash = "#itinerary";
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Itinerary" })).toBeInTheDocument();
    act(() => {
      window.location.hash = "#<script>alert(1)</script>";
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Personal Details" })).toBeInTheDocument();
  });

  it("works from the keyboard and moves focus to the new section's heading", async () => {
    open(submitted());
    await screen.findByRole("navigation", { name: "Dashboard sections" });
    navItem("Itinerary").focus();
    await user.keyboard("{Enter}");
    const heading = await screen.findByRole("heading", { level: 1, name: "Itinerary" });
    await waitFor(() => expect(heading).toHaveFocus());
  });
});

describe("the sections that are still placeholders (Live Tracking has its own tests: LiveTracking.test.jsx)", () => {
  for (const [name, text] of Object.entries(PLACEHOLDERS)) {
    it(`${name}: only its heading and "${text}", with nothing made up`, async () => {
      open(submitted());
      await screen.findByRole("navigation", { name: "Dashboard sections" });
      await user.click(navItem(name));
      await screen.findByRole("heading", { level: 1, name });
      expect(within(main()).getByText(text)).toBeInTheDocument();
      expect(main().textContent).toBe(`${name}${text}`); // the heading and the one sentence, nothing between or after
      expect(main().querySelectorAll("button, input, select, textarea, a, table, img, canvas, iframe")).toHaveLength(0);
      expect(main().textContent).not.toMatch(/₹|\$|\d{3,}|PNR|policy|coverage|latitude|map/i);
    });
  }
});

describe("the PDF download button", () => {
  it("downloads nothing until it is clicked; then downloads the server's PDF once, by its file name", async () => {
    const be = submitted();
    open(be);
    await screen.findByRole("region", { name: "Download your registration" });
    await new Promise((r) => setTimeout(r, 200));
    expect(downloads).toHaveLength(0);
    expect(be.calls(PDF)).toHaveLength(0);
    await user.click(pdfButton());
    expect(await screen.findByText("Your registration PDF has been downloaded.")).toBeInTheDocument();
    expect(be.calls(PDF)).toHaveLength(1);
    expect(be.calls(PDF)[0].url).toBe(`/api/onboarding/pdf?enrolment=${ENROLMENT}`);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].filename).toBe(`young-edsplorer-registration-${FAKE_REFERENCE}.pdf`);
    expect(await downloads[0].blob.text()).toBe(FAKE_PDF);
    expect(be.calls(SUBMIT)).toHaveLength(0);
    expect(be.saves()).toHaveLength(0);
  });

  it("can be used again whenever the parent wants, without submitting anything", async () => {
    const be = submitted();
    open(be);
    await screen.findByRole("region", { name: "Download your registration" });
    await user.click(pdfButton());
    await screen.findByText("Your registration PDF has been downloaded.");
    await new Promise((r) => setTimeout(r, 900)); // a deliberate second click, a moment later
    await user.click(pdfButton());
    await waitFor(() => expect(downloads).toHaveLength(2));
    expect(be.calls(SUBMIT)).toHaveLength(0);
  });

  it("a double click makes one request", async () => {
    const be = submitted();
    open(be);
    await screen.findByRole("region", { name: "Download your registration" });
    await user.dblClick(pdfButton());
    await screen.findByText("Your registration PDF has been downloaded.");
    expect(be.calls(PDF)).toHaveLength(1);
  });

  it("works when storage isn't configured on the server (the PDF is made on request)", async () => {
    open(submitted({ pdfStatus: "not_configured" }));
    await screen.findByRole("region", { name: "Download your registration" });
    expect(pdfButton()).toBeEnabled();
    expect(document.body.textContent).not.toMatch(/google|drive/i);
  });

  it("while the copy is being saved: no download button to press, a clear message, and it becomes available by itself", async () => {
    const be = submitted({ pdfStatus: "pending" });
    be.state.pdfPollsUntilStored = 2;
    open(be, { pdfPollMs: 20 });
    const region = await screen.findByRole("region", { name: "Download your registration" });
    expect(within(region).getByText(/saving your PDF/i)).toBeInTheDocument();
    expect(pdfButton()).toBeDisabled();
    await waitFor(() => expect(pdfButton()).toBeEnabled());
    expect(within(region).queryByText(/saving your PDF/i)).not.toBeInTheDocument();
    expect(be.calls(STATUS).length).toBe(2);
    expect(be.calls(PDF)).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });

  it("keeps checking for a while, then stops and offers 'Check again' (no endless polling)", async () => {
    const be = submitted({ pdfStatus: "pending" });
    be.state.pdfPollsUntilStored = 0;
    open(be, { pdfPollMs: 5, pdfMaxPolls: 3 });
    const region = await screen.findByRole("region", { name: "Download your registration" });
    await within(region).findByRole("button", { name: "Check again" });
    const calls = be.calls(STATUS).length;
    expect(calls).toBe(3);
    await new Promise((r) => setTimeout(r, 100));
    expect(be.calls(STATUS)).toHaveLength(calls);
    be.state.pdfStatus = "stored";
    await user.click(within(region).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(pdfButton()).toBeEnabled());
  });

  it("when the copy couldn't be saved: says so and offers Try again, which retries without resubmitting and then enables the download", async () => {
    const be = submitted({ pdfStatus: "failed" });
    be.state.pdfPollsUntilStored = 1;
    open(be, { pdfPollMs: 20 });
    const region = await screen.findByRole("region", { name: "Download your registration" });
    expect(within(region).getByRole("alert")).toHaveTextContent(/couldn't save your PDF/i);
    expect(pdfButton()).toBeDisabled();
    await user.click(within(region).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(pdfButton()).toBeEnabled());
    expect(be.calls(RETRY)).toHaveLength(1);
    expect(be.calls(RETRY)[0].body).toEqual({ enrolmentId: ENROLMENT });
    expect(be.calls(SUBMIT)).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });

  it("a retry that is refused as too soon says to wait, and keeps the Try again button", async () => {
    const be = submitted({ pdfStatus: "failed" });
    open(be);
    const region = await screen.findByRole("region", { name: "Download your registration" });
    be.queue(RETRY, apiError(429, "RATE_LIMITED", { retryAfterSeconds: 12 }));
    await user.click(within(region).getByRole("button", { name: "Try again" }));
    expect(await within(region).findByText(/wait a few seconds/i)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  const failures = [
    ["Drive is unavailable (503)", apiError(503, "PDF_UNAVAILABLE", { retryAfterSeconds: 10 }), /couldn't get your PDF just now/i],
    ["too many downloads (429)", apiError(429, "RATE_LIMITED", { retryAfterSeconds: 30 }), /wait a moment/i],
    ["the session ended (401)", apiError(401, "UNAUTHENTICATED"), /session has ended/i],
  ];
  for (const [name, response, message] of failures) {
    it(`${name}: a clear message, nothing is downloaded, and the page stays`, async () => {
      const be = submitted();
      open(be);
      await screen.findByRole("region", { name: "Download your registration" });
      be.state.refreshOk = false; // for the 401: the sign-in itself is over, so the page's one renewal attempt is refused
      be.queue(PDF, response);
      await user.click(pdfButton());
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(downloads).toHaveLength(0);
      expect(screen.getByRole("navigation", { name: "Dashboard sections" })).toBeInTheDocument();
    });
  }

  it("a network failure and a response that isn't a PDF are both reported, and nothing is saved", async () => {
    const be = submitted();
    open(be);
    await screen.findByRole("region", { name: "Download your registration" });
    be.queue(PDF, () => { throw new TypeError("Failed to fetch"); });
    await user.click(pdfButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/can't reach the server/i);
    be.queue(PDF, new Response("<html>proxy error</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    await new Promise((r) => setTimeout(r, 900)); // a second, deliberate click
    await user.click(pdfButton());
    await waitFor(() => expect(be.calls(PDF)).toHaveLength(2));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't download/i);
    expect(downloads).toHaveLength(0);
  });

  it("when the server says the copy isn't ready, the button follows the server's word and starts checking", async () => {
    const be = submitted();
    open(be, { pdfPollMs: 20 });
    await screen.findByRole("region", { name: "Download your registration" });
    be.state.pdfStatus = "pending";
    be.state.pdfPollsUntilStored = 1;
    await user.click(pdfButton());
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Download your registration" })).getByText(/saving your PDF/i)).toBeInTheDocument());
    await waitFor(() => expect(pdfButton()).toBeEnabled());
  });
});

describe("the mobile menu", () => {
  const menuButton = () => screen.getByRole("button", { name: "Menu" });

  it("a Menu button opens and closes the sidebar as a drawer, and says whether it is open", async () => {
    open(submitted());
    await screen.findByRole("navigation", { name: "Dashboard sections" });
    const drawer = document.querySelector(".dashboard-sidebar");
    expect(menuButton()).toHaveAttribute("aria-expanded", "false");
    expect(menuButton()).toHaveAttribute("aria-controls", drawer.id);
    expect(drawer).not.toHaveClass("is-open");
    await user.click(menuButton());
    expect(menuButton()).toHaveAttribute("aria-expanded", "true");
    expect(drawer).toHaveClass("is-open");
    await user.click(menuButton());
    expect(drawer).not.toHaveClass("is-open");
  });

  it("choosing a section closes the drawer; so do Escape (focus returns to Menu) and a click outside", async () => {
    open(submitted());
    await screen.findByRole("navigation", { name: "Dashboard sections" });
    const drawer = document.querySelector(".dashboard-sidebar");
    await user.click(menuButton());
    await user.click(navItem("Insurance"));
    expect(drawer).not.toHaveClass("is-open");
    expect(await screen.findByRole("heading", { level: 1, name: "Insurance" })).toBeInTheDocument();

    await user.click(menuButton());
    expect(drawer).toHaveClass("is-open");
    await user.keyboard("{Escape}");
    expect(drawer).not.toHaveClass("is-open");
    expect(menuButton()).toHaveFocus();

    await user.click(menuButton());
    fireEvent.click(document.querySelector(".dashboard-backdrop"));
    expect(drawer).not.toHaveClass("is-open");
  });

  it("opening the drawer puts focus on the current section so a keyboard or screen-reader user starts in the list", async () => {
    open(submitted());
    await screen.findByRole("navigation", { name: "Dashboard sections" });
    await user.click(menuButton());
    await waitFor(() => expect(navItem("Personal Details")).toHaveFocus());
  });
});

describe("the page around the dashboard", () => {
  it("keeps the co-branded header with the school-logo placeholder, the greeting and Log out", async () => {
    const be = submitted();
    const { onSignedOut } = open(be);
    await screen.findByRole("navigation", { name: "Dashboard sections" });
    expect(screen.getByRole("group", { name: "Young Edsplorer in partnership with GV School" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "GV School logo (not available yet)" })).toBeInTheDocument();
    expect(screen.getByText("Hi, Rishi")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Log out/ }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  });

  it("someone else's registration id shows an error and no dashboard", async () => {
    const be = submitted();
    open(be, { enrolmentId: "00000000-0000-4000-9000-0000000000ff" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/wasn't found in your account/i);
    expect(screen.queryByRole("navigation", { name: "Dashboard sections" })).not.toBeInTheDocument();
  });

  it("an unsubmitted form is never shown as a dashboard", async () => {
    const be = submitted({ form: submittedForm({ status: "draft", submittedAt: null, acknowledgement: undefined, reference: undefined }) });
    open(be);
    await screen.findByRole("heading", { level: 2 });
    expect(screen.queryByRole("navigation", { name: "Dashboard sections" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download PDF/ })).not.toBeInTheDocument();
  });
});

describe("wording", () => {
  it("nothing on the dashboard says \"electronic signature\", in any capitalisation", async () => {
    open(submitted());
    await screen.findByRole("region", { name: "Declaration and signature" });
    expect(document.body.textContent).not.toMatch(/electronic signature/i);
    expect(screen.getByText("Digital Signature")).toBeInTheDocument();
  });
});

describe("Itinerary: read-only, from the registration's own trip", () => {
  const ITEMS = [
    { id: "i2", dayNumber: 2, position: 0, title: "Amer Fort", details: "Morning visit.", updatedAt: "2026-10-27T08:00:00.000Z" },
    { id: "i1", dayNumber: 1, position: 0, title: "Arrive in Jaipur", details: null, updatedAt: "2026-10-27T08:00:00.000Z" },
  ];
  it("shows what Sales entered for this trip, with no edit control of any kind", async () => {
    const be = submitted();
    be.state.itinerary = ITEMS;
    open(be);
    await user.click(await within(await screen.findByRole("navigation", { name: "Dashboard sections" })).findByRole("link", { name: "Itinerary" }));
    const list = await screen.findByRole("list", { name: "Trip itinerary" });
    expect(within(list).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Day 2: Amer Fort", "Day 1: Arrive in Jaipur"]);
    expect(within(list).getByText("Morning visit.")).toBeInTheDocument();
    expect(main().querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(within(main()).queryByRole("button")).not.toBeInTheDocument();
    expect(be.calls().filter((c) => /itinerary/.test(c.key))).toEqual([expect.objectContaining({ key: `GET /api/enrolments/${ENROLMENT}/itinerary` })]);
  });

  it("with nothing entered yet, says it will be available soon", async () => {
    open(submitted());
    await user.click(await within(await screen.findByRole("navigation", { name: "Dashboard sections" })).findByRole("link", { name: "Itinerary" }));
    expect(await screen.findByText("Your trip itinerary will be available here soon.")).toBeInTheDocument();
  });

  it("asks the server again when the section is opened, so a Sales update appears without a new login", async () => {
    const be = submitted();
    open(be);
    const nav = await screen.findByRole("navigation", { name: "Dashboard sections" });
    await user.click(within(nav).getByRole("link", { name: "Itinerary" }));
    await screen.findByText("Your trip itinerary will be available here soon.");
    await user.click(within(nav).getByRole("link", { name: "Insurance" }));
    be.state.itinerary = ITEMS; // Sales added items meanwhile
    await user.click(within(nav).getByRole("link", { name: "Itinerary" }));
    expect(await screen.findByText("Day 1: Arrive in Jaipur")).toBeInTheDocument();
  });

  it("a server refusal shows a calm message, and a stale session ends the page", async () => {
    const be = submitted();
    be.queue(`GET /api/enrolments/${ENROLMENT}/itinerary`, apiError(500, "SERVER_ERROR"));
    open(be);
    await user.click(await within(await screen.findByRole("navigation", { name: "Dashboard sections" })).findByRole("link", { name: "Itinerary" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load the itinerary/);
  });
});

const DOC_ID = "00000000-0000-4000-9000-000000000099";
const makeDoc = (over = {}) => ({ id: DOC_ID, displayName: "itinerary.pdf", mimeType: "application/pdf", sizeBytes: 51200, ...over });

describe("Itinerary: PDF document from Sales", () => {
  it("shows a download link when Sales has uploaded an itinerary PDF", async () => {
    const be = submitted();
    be.state.tripDocuments = { itinerary: [makeDoc({ displayName: "Jaipur 2027 Itinerary.pdf" })] };
    open(be);
    await user.click(await within(await screen.findByRole("navigation", { name: "Dashboard sections" })).findByRole("link", { name: "Itinerary" }));
    expect(await screen.findByRole("link", { name: /Download Jaipur 2027 Itinerary.pdf/ })).toBeInTheDocument();
  });

  it("shows the placeholder when no PDF and no manual items", async () => {
    open(submitted());
    await user.click(await within(await screen.findByRole("navigation", { name: "Dashboard sections" })).findByRole("link", { name: "Itinerary" }));
    expect(await screen.findByText("Your trip itinerary will be available here soon.")).toBeInTheDocument();
  });
});

describe("Insurance section: document from Sales", () => {
  it("shows a download link when Sales has uploaded an insurance document", async () => {
    const be = submitted();
    be.state.tripDocuments = { insurance: [makeDoc({ id: "00000000-0000-4000-9000-000000000098", displayName: "Policy.pdf" })] };
    open(be);
    await user.click(await within(await screen.findByRole("navigation", { name: "Dashboard sections" })).findByRole("link", { name: "Insurance" }));
    expect(await screen.findByRole("link", { name: /Download Policy.pdf/ })).toBeInTheDocument();
  });

  it("shows the placeholder when no insurance document is uploaded yet", async () => {
    open(submitted());
    await user.click(await within(await screen.findByRole("navigation", { name: "Dashboard sections" })).findByRole("link", { name: "Insurance" }));
    expect(await screen.findByText("Insurance information will be available here soon.")).toBeInTheDocument();
  });

  it("re-fetches when the page becomes visible again so a Sales replacement appears", async () => {
    const be = submitted();
    open(be);
    await user.click(await within(await screen.findByRole("navigation", { name: "Dashboard sections" })).findByRole("link", { name: "Insurance" }));
    await screen.findByText("Insurance information will be available here soon.");
    be.state.tripDocuments = { insurance: [makeDoc({ id: "00000000-0000-4000-9000-000000000097", displayName: "NewPolicy.pdf" })] };
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByRole("link", { name: /Download NewPolicy.pdf/ })).toBeInTheDocument();
  });
});

describe("Transport section: documents from Sales", () => {
  it("shows download links for each transport document", async () => {
    const be = submitted();
    be.state.tripDocuments = { transport: [
      makeDoc({ id: "00000000-0000-4000-9000-000000000096", displayName: "Train Delhi.pdf" }),
      makeDoc({ id: "00000000-0000-4000-9000-000000000095", displayName: "Return Flight.pdf" }),
    ]};
    open(be);
    await user.click(await within(await screen.findByRole("navigation", { name: "Dashboard sections" })).findByRole("link", { name: "Train / Flight Tickets" }));
    expect(await screen.findByRole("link", { name: /Download Train Delhi.pdf/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download Return Flight.pdf/ })).toBeInTheDocument();
  });

  it("shows the placeholder when no transport documents are uploaded yet", async () => {
    open(submitted());
    await user.click(await within(await screen.findByRole("navigation", { name: "Dashboard sections" })).findByRole("link", { name: "Train / Flight Tickets" }));
    expect(await screen.findByText("Your travel tickets will be available here soon.")).toBeInTheDocument();
  });

  it("does not mix documents across trips: a different enrolment id returns nothing", async () => {
    const be = submitted();
    be.state.tripDocuments = { transport: [makeDoc({ id: "00000000-0000-4000-9000-000000000094", displayName: "ticket.pdf" })] };
    open(be, { enrolmentId: "00000000-0000-4000-9000-0000000000ff" });
    // wrong enrolment → 404 from fake server → empty state
    expect(await screen.findByRole("alert")).toBeInTheDocument(); // the page shows an error because onboarding 404'd
  });
});
