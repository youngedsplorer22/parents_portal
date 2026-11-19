import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppRoutes from "./AppRoutes.jsx";
import { createFakeAdmin } from "./test/fakeAdmin.js";
import { createFakeBackend } from "./test/fakeBackend.js";
import { reply, storageIsEmpty } from "./test/helpers.js";

let user;
beforeEach(() => {
  user = userEvent.setup();
});
afterEach(() => vi.unstubAllGlobals());

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
const visit = (path) => render(<MemoryRouter initialEntries={[path]}><AppRoutes /><Where /></MemoryRouter>);
const where = () => screen.getByTestId("where").textContent;

const JAIPUR_ADDR = { school: "greenfield-public-school", branch: "main", trip: "jaipur-2026" };
const SHIMLA_ADDR = { school: "greenfield-public-school", branch: "main", trip: "shimla" };
const JAIPUR = { address: JAIPUR_ADDR, school: "Greenfield Public School", title: "Jaipur 2026", destination: "Jaipur", tourType: "domestic", paymentMode: "payment", academicYear: "2026-27" };
const SHIMLA = { address: SHIMLA_ADDR, school: "Greenfield Public School", title: "Shimla", destination: "Shimla", tourType: "domestic", paymentMode: "none" };
const draft = (data, currentSection, extra = {}) => ({ tourType: "domestic", role: "student", status: "draft", data, currentSection, version: 3, updatedAt: "2026-10-01T00:00:00.000Z", submittedAt: null, ...extra });

/** A signed-in parent with two registrations: the current one (Jaipur) and an earlier one (Shimla). */
function twoRegistrations({ jaipurForm = null, shimlaForm = null } = {}) {
  const be = createFakeBackend({ signedIn: true, join: JAIPUR });
  be.state.currentId = "00000000-0000-4000-9000-000000000001";
  be.state.trip = JAIPUR;
  be.state.form = jaipurForm;
  be.state.others = { "00000000-0000-4000-9000-000000000002": { trip: SHIMLA, form: shimlaForm } };
  return { be, jaipur: be.state.currentId, shimla: "00000000-0000-4000-9000-000000000002" };
}

describe("public registration page addresses", () => {
  const info = (t) => reply(200, { school: { name: t.school }, trip: { title: t.title, destination: t.destination, tourType: t.tourType }, registrationOpen: true });

  it("/join/<school>/<branch>/<trip> asks the server for exactly those words and shows that school and trip", async () => {
    const be = createFakeAdmin({ signedIn: false, joinResponses: { "greenfield-public-school/main/jaipur-2026": info(JAIPUR) } });
    visit("/join/greenfield-public-school/main/jaipur-2026");
    expect(await screen.findByText("Type")).toBeInTheDocument();
    expect(be.calls(/GET \/api\/join\//).map((c) => c.url)).toEqual(["/api/join/greenfield-public-school/main/jaipur-2026"]);
    expect(where()).toBe("/join/greenfield-public-school/main/jaipur-2026"); // the address is left as it is
  });

  it("wrong words are never corrected into another trip: they show 'not available' and no forms", async () => {
    createFakeAdmin({ signedIn: false, joinResponses: { "greenfield-public-school/main/jaipur-2026": info(JAIPUR) } });
    visit("/join/greenfield-public-school/main/jaipur-2025/continue");
    expect(await screen.findByRole("heading", { name: "This page can't be opened" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();
    expect(where()).toBe("/join/greenfield-public-school/main/jaipur-2025/continue");
  });
});

/** A signed-in parent with exactly one trip registration (the normal case). */
function oneRegistration(form) {
  const be = createFakeBackend({ signedIn: true, join: JAIPUR });
  Object.assign(be.state, { currentId: "00000000-0000-4000-9000-000000000001", trip: JAIPUR, form });
  return be;
}
const submittedForm = () =>
  draft({ fullName: "Asha Rao", gender: "Female", classSection: "4 - B", dateOfBirth: "2016-05-04", nomineeName: "B", nomineeRelation: "Mother", mealPreference: "Veg", phone: "9876543210" }, "review", {
    status: "submitted",
    submittedAt: "2026-09-01T10:00:00.000Z",
    acknowledgement: { declarationVersion: "2026-10-v1", acceptedAt: "2026-09-01T10:00:00.000Z", signatureName: "Asha Rao" },
  });

describe("logging in on the parent portal (/parent) opens the right registration by itself", () => {
  it("an incomplete registration reopens with its saved answers at its saved section, with school, trip and destination", async () => {
    const be = oneRegistration(draft({ fullName: "Asha Rao", nomineeName: "B Vijaya" }, "nominee"));
    visit("/parent");
    expect(await screen.findByRole("heading", { level: 2, name: "Nominee" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Nominee name/)).toHaveValue("B Vijaya");
    expect(document.querySelector(".onboarding-context")).toBeNull();
    expect(screen.getByRole("region", { name: "Welcome message" })).toHaveTextContent("upcoming trip to Jaipur");
    expect(be.calls("GET /api/onboarding")[0].url).toBe("/api/onboarding?enrolment=00000000-0000-4000-9000-000000000001");
    expect(be.saves()).toHaveLength(0); // nothing reset or recreated by opening it
  });

  it("a submitted registration opens its dashboard read-only: trip details, answers, signature, declaration and time; no payment information", async () => {
    oneRegistration(submittedForm());
    visit("/parent");
    expect(await screen.findByRole("heading", { name: "Registration submitted" })).toBeInTheDocument();
    const trip = within(screen.getByRole("region", { name: "Trip details" }));
    expect(trip.getByText("Trip").nextSibling).toHaveTextContent("Jaipur 2026");
    expect(trip.getByText("Destination").nextSibling).toHaveTextContent("Jaipur");
    expect(trip.getByText("Trip type").nextSibling).toHaveTextContent("Domestic Tour");
    expect(trip.getByText("Submitted on")).toBeInTheDocument();
    const ack = within(screen.getByRole("region", { name: "Declaration and signature" }));
    expect(ack.getByText("Asha Rao")).toBeInTheDocument();
    expect(ack.getByText(/accurate and complete to the best of my knowledge/)).toBeInTheDocument();
    expect(screen.getByText("Your submitted answers")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Dashboard sections" })).toBeInTheDocument();
    expect(document.querySelectorAll("input, select, textarea")).toHaveLength(0);
    // Payment Status is a sidebar entry whose page is still empty: no amounts, no payment buttons.
    expect(screen.queryByRole("button", { name: /pay/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/₹|\bpaid\b|amount due|transaction/i);
  });

  it("with no registration and no trip, a friendly notice says to open the school's link; no trip is chosen or created", async () => {
    const be = createFakeBackend({ signedIn: true, join: JAIPUR }); // a trip exists, but nothing ties this parent to it
    visit("/parent");
    expect(await screen.findByRole("heading", { name: "Open your school's trip registration link" })).toBeInTheDocument();
    expect(be.calls("GET /api/onboarding")).toHaveLength(0);
    expect(be.calls("POST /api/enrolments")).toHaveLength(0);
    expect(be.saves()).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "Which tour is this for?" })).not.toBeInTheDocument();
  });

  it("several registrations and no trip in the address: a short message only; no list, no Open links, nothing opened or changed", async () => {
    const { be, shimla } = twoRegistrations({ jaipurForm: draft({ fullName: "Asha" }, "personal"), shimlaForm: submittedForm() });
    visit("/parent");
    expect(await screen.findByRole("heading", { name: "Open your school's trip registration link" })).toBeInTheDocument();
    expect(screen.getByText(/more than one trip registration/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open/ })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/registrations"]')).toBeNull();
    expect(screen.queryByText("Jaipur 2026")).not.toBeInTheDocument();
    expect(screen.queryByText("Shimla")).not.toBeInTheDocument();
    expect(be.calls("GET /api/onboarding")).toHaveLength(0); // the newest is NOT opened by default
    expect(be.state.others[shimla].form.status).toBe("submitted"); // and nothing changed
  });

  it("there is no My registrations page or link: /registrations goes to /parent, which opens the registration", async () => {
    oneRegistration(draft({ fullName: "Asha" }, "personal"));
    visit("/registrations");
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    expect(where()).toBe("/parent");
    expect(screen.queryByRole("link", { name: /My registrations/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "My registrations" })).not.toBeInTheDocument();
  });
});

describe("opening one registration (/registrations/:id)", () => {
  it("restores THAT registration's saved answers and resumes at its saved section, with every save tied to it", async () => {
    const { be, shimla } = twoRegistrations({ jaipurForm: draft({ fullName: "For Jaipur" }, "personal"), shimlaForm: draft({ fullName: "For Shimla" }, "meals") });
    visit(`/registrations/${shimla}`);
    expect(await screen.findByRole("region", { name: "Welcome message" })).toBeInTheDocument();
    expect(be.calls("GET /api/onboarding")[0].url).toBe(`/api/onboarding?enrolment=${shimla}`);
    const step = await screen.findByRole("heading", { name: /Meal/i });
    expect(step).toHaveClass("step-heading");
  });

  it("edits on that page are saved to that registration only", async () => {
    const { be, shimla } = twoRegistrations({ jaipurForm: draft({ fullName: "For Jaipur" }, "personal"), shimlaForm: draft({ fullName: "For Shimla" }, "personal") });
    visit(`/registrations/${shimla}`);
    const name = await screen.findByLabelText(/Full name/i);
    expect(name).toHaveValue("For Shimla");
    await user.clear(name);
    await user.type(name, "Edited for Shimla");
    await waitFor(() => expect(be.state.others[shimla].form.data.fullName).toBe("Edited for Shimla"), { timeout: 5000 });
    expect(be.saves().length).toBeGreaterThan(0);
    expect(be.saves().every((c) => c.body.enrolmentId === shimla)).toBe(true);
    expect(be.state.form.data.fullName).toBe("For Jaipur"); // the other registration is untouched
  });

  it("a refresh keeps the same registration", async () => {
    const { be, shimla } = twoRegistrations({ shimlaForm: draft({ fullName: "For Shimla" }, "contact") });
    const first = visit(`/registrations/${shimla}`);
    await screen.findByRole("region", { name: "Welcome message" });
    first.unmount();
    visit(`/registrations/${shimla}`);
    expect(await screen.findByRole("region", { name: "Welcome message" })).toBeInTheDocument();
    expect(be.calls("GET /api/onboarding").map((c) => c.url)).toEqual([`/api/onboarding?enrolment=${shimla}`, `/api/onboarding?enrolment=${shimla}`]);
  });

  it("someone else's (or a made-up) registration id shows 'not found' and no form", async () => {
    twoRegistrations();
    visit("/registrations/00000000-0000-4000-9000-000000000999");
    expect(await screen.findByRole("alert")).toHaveTextContent("That registration wasn't found in your account.");
    expect(screen.queryByRole("region", { name: "Welcome message" })).not.toBeInTheDocument();
  });

  it("a submitted registration opens its dashboard: trip details and status, with no payment panel", async () => {
    const { shimla } = twoRegistrations({ shimlaForm: draft({ fullName: "Asha Rao" }, "review", { status: "submitted", submittedAt: "2026-09-01T00:00:00.000Z" }) });
    visit(`/registrations/${shimla}`);
    expect(await screen.findByRole("heading", { name: "Registration submitted" })).toBeInTheDocument();
    const trip = within(screen.getByRole("region", { name: "Trip details" }));
    expect(trip.getByText("Greenfield Public School")).toBeInTheDocument();
    expect(trip.getByText("Trip").nextSibling).toHaveTextContent("Shimla");
    expect(trip.getByText("Destination").nextSibling).toHaveTextContent("Shimla");
    expect(trip.getByText("Domestic Tour")).toBeInTheDocument();
    expect(trip.getByText("Submitted")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Dashboard sections" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pay/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/₹|\bpaid\b|amount due|transaction/i);
    expect(document.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /registrations/i })).not.toBeInTheDocument();
    expect(storageIsEmpty()).toBe(true);
  });

  it("a paid trip's draft shows no payment information either", async () => {
    twoRegistrations({ jaipurForm: draft({ fullName: "Asha" }, "personal") });
    visit("/registrations/00000000-0000-4000-9000-000000000001");
    await screen.findByRole("progressbar");
    expect(document.body.textContent).not.toMatch(/payment|paid|Itinerary/i);
  });
});

describe("following a trip link when already registered for several trips", () => {
  it("shows the form of the trip whose link was followed, not just the newest registration", async () => {
    const { be, shimla } = twoRegistrations({ jaipurForm: draft({ fullName: "For Jaipur" }, "personal"), shimlaForm: draft({ fullName: "For Shimla" }, "nominee") });
    be.state.join = SHIMLA; // the parent follows Shimla's link
    be.queue("POST /api/enrolments", reply(200, { enrolled: true, created: false, enrolmentId: shimla, trip: { school: SHIMLA.school, title: SHIMLA.title } }));
    vi.stubGlobal("fetch", be.fetchMock);
    const info = reply(200, { school: { name: SHIMLA.school }, trip: { title: SHIMLA.title, destination: SHIMLA.destination, tourType: SHIMLA.tourType }, registrationOpen: true });
    be.queue("GET /api/join/greenfield-public-school/main/shimla", info);
    visit("/join/greenfield-public-school/main/shimla/continue");
    expect(await screen.findByRole("region", { name: "Welcome message" })).toBeInTheDocument();
    expect(be.calls("GET /api/onboarding")[0].url).toBe(`/api/onboarding?enrolment=${shimla}`);
  });
});

describe("arriving from the trip's own page", () => {
  const info = (t) => reply(200, { school: { name: t.school }, trip: { title: t.title, destination: t.destination, tourType: t.tourType }, registrationOpen: true });
  const PASSWORD = "correct-horse-battery";

  it("logging in on the trip page resumes that trip's saved draft at its saved section (no new registration)", async () => {
    const be = createFakeBackend({ signedIn: false, join: JAIPUR, accounts: ["parent@example.com"], passwords: { "parent@example.com": PASSWORD } });
    Object.assign(be.state, { currentId: "00000000-0000-4000-9000-000000000001", trip: JAIPUR, form: draft({ fullName: "Asha", mealPreference: "Veg" }, "meals") });
    be.queue("GET /api/join/greenfield-public-school/main/jaipur-2026", info(JAIPUR));
    visit("/join/greenfield-public-school/main/jaipur-2026/continue");
    await user.click(await screen.findByRole("tab", { name: "Login" }));
    await user.type(screen.getByLabelText(/email address/i), "parent@example.com");
    await user.type(screen.getByLabelText(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /^Log in/ }));
    expect(await screen.findByRole("heading", { level: 2, name: /Meal/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/Meals preference/)).toHaveValue("Veg");
    expect(be.calls("POST /api/enrolments")[0].body).toEqual({ trip: JAIPUR_ADDR });
    expect(be.state.currentId).toBe("00000000-0000-4000-9000-000000000001"); // the same registration, not a new one
    expect(where()).toBe("/join/greenfield-public-school/main/jaipur-2026/continue");
  });

  it("reopening the trip page after submitting shows the read-only confirmation, and creates no duplicate", async () => {
    const be = createFakeBackend({ signedIn: true, join: JAIPUR });
    Object.assign(be.state, { currentId: "00000000-0000-4000-9000-000000000001", trip: JAIPUR, form: draft({ fullName: "Asha" }, "review", { status: "submitted", submittedAt: "2026-09-01T10:00:00.000Z" }) });
    be.queue("GET /api/join/greenfield-public-school/main/jaipur-2026", info(JAIPUR));
    visit("/join/greenfield-public-school/main/jaipur-2026/continue");
    expect(await screen.findByRole("heading", { name: "Registration submitted" })).toBeInTheDocument();
    expect(be.calls("POST /api/enrolments")).toHaveLength(1);
    expect(be.state.currentId).toBe("00000000-0000-4000-9000-000000000001");
    expect(be.state.form.status).toBe("submitted");
    expect(be.saves()).toHaveLength(0);
  });
});

describe("regressions found while trying to break things (parent)", () => {
  it("a network failure while finding the registration says so plainly (not 'changes not saved') and Try again recovers", async () => {
    const be = oneRegistration(draft({ fullName: "Asha" }, "personal"));
    be.queue("GET /api/enrolments/resume", () => { throw new TypeError("Failed to fetch"); });
    visit("/parent");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Can't reach the server. Check your connection and try again.");
    expect(alert.textContent).not.toMatch(/not saved/);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
  });
});

describe("direct addresses can't create an unrelated registration", () => {
  it("/registrations/legacy for a parent with no such form shows the 'open your school's link' message, not a tour picker", async () => {
    const be = createFakeBackend({ signedIn: true });
    visit("/registrations/legacy");
    expect(await screen.findByRole("heading", { name: "Open your school's trip registration link" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Which tour is this for?" })).not.toBeInTheDocument();
    expect(be.saves()).toHaveLength(0);
  });

  it("/registrations/legacy still opens an existing trip-less form", async () => {
    const be = createFakeBackend({ signedIn: true, form: draft({ fullName: "Old form" }, "nominee") });
    visit("/registrations/legacy");
    expect(await screen.findByRole("heading", { level: 2, name: "Nominee" })).toBeInTheDocument();
    expect(be.saves()).toHaveLength(0);
  });

  it("another parent's registration id is 'not found', and shows none of their data", async () => {
    twoRegistrations({ jaipurForm: draft({ fullName: "Someone Else" }, "personal") });
    visit("/registrations/00000000-0000-4000-9000-000000000999");
    expect(await screen.findByRole("alert")).toHaveTextContent("That registration wasn't found in your account.");
    expect(screen.queryByDisplayValue("Someone Else")).not.toBeInTheDocument();
  });
});
