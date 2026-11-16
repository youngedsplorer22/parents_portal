import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppRoutes from "./AppRoutes.jsx";
import { createFakeAdmin } from "./test/fakeAdmin.js";
import { PASSWORD, createFakeBackend } from "./test/fakeBackend.js";
import { apiError, deferred, reply, storageIsEmpty, watchConsole } from "./test/helpers.js";

let user;
beforeEach(() => {
  user = userEvent.setup();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const at = (path) => render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>);
const JOIN_KEY = "greenfield-public-school/main/winter-trip"; // a trip page's address words (no secret)
const JOIN_PATH = `/join/${JOIN_KEY}`;
const info = (over = {}) => ({
  school: { name: "Greenfield Public School" },
  trip: { title: "Winter Trip", destination: "Manali", tourType: "domestic" },
  registrationOpen: true,
  ...over,
});

describe("routing", () => {
  it("'/' is the Sales portal (its log in when signed out); the parent portal is at /parent", async () => {
    createFakeAdmin({ signedIn: false });
    const v = at("/");
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
    v.unmount();
    at("/parent");
    expect(await screen.findByRole("tab", { name: "Register" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Login" })).toBeInTheDocument();
  });

  it("unknown addresses show 'Page not found', not the parent portal", async () => {
    createFakeAdmin({ signedIn: false });
    at("/something/else");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();
  });

  it("/admin never shows the parent portal, and the parent portal never makes staff calls", async () => {
    const be = createFakeAdmin({ signedIn: false });
    at("/parent");
    await screen.findByRole("tab", { name: "Register" });
    expect(be.calls(/\/api\/admin/)).toHaveLength(0);
  });
});

describe("/join/:school/:branch/:trip: a trip's public registration page", () => {
  it("shows the logo, with no school name, city or 'Parent registration' text", async () => {
    createFakeAdmin({ joinResponses: { [JOIN_KEY]: reply(200, info()) } });
    at(JOIN_PATH);
    await screen.findByRole("link", { name: "Register or log in" });
    expect(screen.getByAltText("Young Edsplorer")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText("Greenfield Public School")).not.toBeInTheDocument();
    expect(screen.queryByText("Parent registration")).not.toBeInTheDocument();
  });

  it("shows the trip facts and that registration is open, with a way on", async () => {
    createFakeAdmin({ joinResponses: { [JOIN_KEY]: reply(200, info({ trip: { title: "Japan Trip", destination: "Tokyo", tourType: "international" } })) } });
    at(JOIN_PATH);
    await screen.findByText("Type");
    expect(screen.getByText("Japan Trip")).toBeInTheDocument();
    expect(screen.getByText("Tokyo")).toBeInTheDocument();
    expect(screen.getByText("International tour")).toBeInTheDocument();
    expect(screen.getByText("Registration is open for this trip.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Register or log in" })).toHaveAttribute("href", `${JOIN_PATH}/continue`);
  });

  it("offers no school or trip fields: nothing the parent can type or pick", async () => {
    createFakeAdmin({ joinResponses: { [JOIN_KEY]: reply(200, info()) } });
    at(JOIN_PATH);
    await screen.findByText("Type");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("a trip that isn't open says so and offers no way to register", async () => {
    createFakeAdmin({ joinResponses: { [JOIN_KEY]: reply(200, info({ registrationOpen: false })) } });
    at(JOIN_PATH);
    await screen.findByText("Type");
    expect(screen.getByText(/Registration isn't open for this trip right now/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Register or log in/ })).not.toBeInTheDocument();
  });

  it("omits the destination row when there is none", async () => {
    createFakeAdmin({ joinResponses: { [JOIN_KEY]: reply(200, info({ trip: { title: "Trip", destination: null, tourType: "domestic" } })) } });
    at(JOIN_PATH);
    await screen.findByText("Type");
    expect(screen.queryByText("Destination")).not.toBeInTheDocument();
  });

  it("shows a loading state first", async () => {
    const pending = deferred();
    const be = createFakeAdmin();
    be.queue(`GET /api/join/${JOIN_KEY}`, () => pending.promise);
    at(JOIN_PATH);
    expect(screen.getByRole("status")).toHaveTextContent("Opening the registration page…");
    await act(async () => pending.resolve(reply(200, info())));
    await screen.findByText("Type");
  });

  it("an unknown, private or archived trip (all the same to the server) gets one clear message, and a way to log in to an existing registration", async () => {
    createFakeAdmin();
    at(JOIN_PATH);
    expect(await screen.findByRole("alert")).toHaveTextContent("This registration page isn't available. Please check the address with your school.");
    expect(screen.getByRole("heading", { name: "This page can't be opened" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Register or log in/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Log in to continue" })).toHaveAttribute("href", "/parent/login");
  });

  it("malformed address words are refused without asking the server", async () => {
    const be = createFakeAdmin();
    at("/join/Greenfield School/main/winter-trip");
    expect(await screen.findByRole("alert")).toHaveTextContent("This registration page isn't available.");
    expect(be.calls(/\/api\/join/)).toHaveLength(0);
  });

  it.each([
    [429, "RATE_LIMITED", /Too many requests/],
  ])("%s %s is explained", async (status, code, message) => {
    const be = createFakeAdmin();
    be.queue(`GET /api/join/${JOIN_KEY}`, apiError(status, code));
    at(JOIN_PATH);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("a network failure is explained", async () => {
    const be = createFakeAdmin();
    be.queue(`GET /api/join/${JOIN_KEY}`, () => {
      throw new TypeError("Failed to fetch");
    });
    at(JOIN_PATH);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Can't reach the server/);
  });

  it("makes exactly one request, for those three words, stores nothing and logs nothing", async () => {
    const logged = watchConsole();
    const be = createFakeAdmin({ joinResponses: { [JOIN_KEY]: reply(200, info()) } });
    at(JOIN_PATH);
    await screen.findByText("Type");
    expect(be.calls()).toHaveLength(1);
    expect(be.calls()[0].url).toBe(`/api/join/${JOIN_KEY}`);
    expect(storageIsEmpty()).toBe(true);
    expect(logged("winter-trip")).toBe(false);
  });
});

describe("/admin: protected screens and deep links", () => {
  it("a signed-out visitor to a deep admin link lands on the staff login and sees no data", async () => {
    const be = createFakeAdmin({ signedIn: false });
    at("/admin/trips/00000000-0000-4000-8000-000000000001");
    expect(await screen.findByRole("heading", { name: "Admin log in" })).toBeInTheDocument();
    expect(be.calls(/GET \/api\/admin\/(trips|schools)/)).toHaveLength(0);
  });

  it.each(["/admin", "/admin/dashboard", "/admin/staff", "/admin/schools/x"])("%s needs a login", async (path) => {
    createFakeAdmin({ signedIn: false });
    at(path);
    expect(await screen.findByRole("heading", { name: "Admin log in" })).toBeInTheDocument();
  });

  it("a signed-in admin opening the login address goes straight to the Admin dashboard", async () => {
    createFakeAdmin();
    at("/admin/login");
    expect(await screen.findByRole("heading", { name: "Admin dashboard" })).toBeInTheDocument();
  });

  it("logs in, shows who is signed in, and logs out (server called, back to the login)", async () => {
    const be = createFakeAdmin({ signedIn: false });
    at("/admin");
    await screen.findByRole("heading", { name: "Admin log in" });
    await user.type(screen.getByLabelText("Email address"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "right-staff-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("heading", { name: "Admin dashboard" })).toBeInTheDocument();
    expect(screen.getAllByText(/Alex Admin/).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /Log out/ }));
    expect(await screen.findByRole("heading", { name: "Admin log in" })).toBeInTheDocument();
    expect(be.calls(/POST \/api\/admin\/auth\/logout/)).toHaveLength(1);
    expect(be.state.signedIn).toBe(false);
  });

  it("a wrong password gets one generic message and empties the password", async () => {
    createFakeAdmin({ signedIn: false });
    at("/admin/login");
    await user.type(await screen.findByLabelText("Email address"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password-xx");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The email or password is incorrect.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByLabelText("Email address")).toHaveValue("admin@example.com");
  });

  it("empty fields are checked before any request; rate limiting is explained", async () => {
    const be = createFakeAdmin({ signedIn: false });
    at("/admin/login");
    await user.click(await screen.findByRole("button", { name: "Log in" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your email and password.");
    expect(be.calls(/auth\/login/)).toHaveLength(0);
    be.queue("POST /api/admin/auth/login", apiError(429, "RATE_LIMITED"));
    await user.type(screen.getByLabelText("Email address"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "whatever-it-is");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many attempts/);
  });

  it("the password is kept out of storage, the console and the page", async () => {
    const logged = watchConsole();
    createFakeAdmin({ signedIn: false });
    at("/admin/login");
    await user.type(await screen.findByLabelText("Email address"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "right-staff-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    await screen.findByRole("heading", { name: "Admin dashboard" });
    expect(storageIsEmpty()).toBe(true);
    expect(logged("right-staff-password")).toBe(false);
    expect(document.body.innerHTML).not.toContain("right-staff-password");
  });

  it("a session that ends while working (401) sends the user back to the login with a notice", async () => {
    const be = createFakeAdmin();
    be.addSchool();
    at("/admin/schools");
    await screen.findByRole("heading", { name: "Schools" });
    be.state.refreshOk = false; // the sign-in itself is over, so the page's one renewal attempt is refused
    be.queue("GET /api/admin/schools?includeArchived=true", apiError(401, "UNAUTHENTICATED"));
    await user.click(screen.getByLabelText("Show archived"));
    expect(await screen.findByRole("heading", { name: "Admin log in" })).toBeInTheDocument();
    expect(screen.getByText("Your session has ended. Please log in again.")).toBeInTheDocument();
  });

  it("there is no Audit log page or link in either portal (the audit records and their admin API are kept on the server)", async () => {
    const be = createFakeAdmin({ role: "admin" });
    const v = at("/admin/audit");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Audit log/ })).not.toBeInTheDocument();
    expect(be.calls(/\/api\/admin\/audit/)).toHaveLength(0);
    v.unmount();
    createFakeAdmin({ role: "sales" });
    at("/sales/audit");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Audit log/ })).not.toBeInTheDocument();
  });
});

describe("/admin: schools and trips", () => {
  it("lists schools with their trip counts and adds one", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool();
    be.addTrip(s.id);
    at("/admin/schools");
    const table = await screen.findByRole("table", { name: "Schools" });
    expect(within(table).getByRole("link", { name: "Greenfield Public School" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: /Add a school/ }));
    await user.type(await screen.findByLabelText("School name"), "  Hilltop School ");
    await user.click(screen.getByRole("button", { name: "Add school" }));
    expect(await screen.findByRole("heading", { name: /Hilltop School/ })).toBeInTheDocument(); // the new school's page opens
    expect(be.calls(/POST \/api\/admin\/schools$/)[0].body).toEqual({ name: "  Hilltop School " });
  });

  it("checks an empty name and shows a duplicate-name error", async () => {
    const be = createFakeAdmin();
    be.addSchool();
    at("/admin/schools/new");
    await screen.findByRole("heading", { name: "Add a school" });
    await user.click(screen.getByRole("button", { name: "Add school" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the school's name.");
    await user.type(screen.getByLabelText("School name"), "greenfield public school");
    await user.click(screen.getByRole("button", { name: "Add school" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A school with that name and branch already exists.");
  });

  it("creates a trip with the chosen values only: no status, template or school in the body", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool();
    at(`/admin/schools/${s.id}`);
    await screen.findByRole("heading", { name: /Greenfield Public School/ });
    await user.click(screen.getByRole("link", { name: "Create a trip" }));
    await screen.findByRole("heading", { name: "Create a trip" });
    await user.click(screen.getByRole("button", { name: "Create trip" }));
    expect(screen.getByText("Enter a trip title.")).toBeInTheDocument();
    expect(screen.getByText("Choose domestic or international.")).toBeInTheDocument();
    expect(screen.getByText("Choose a payment mode.")).toBeInTheDocument();
    expect(be.calls(/POST .*trips$/)).toHaveLength(0);

    await user.type(screen.getByLabelText("Trip title"), "Japan Trip");
    await user.selectOptions(screen.getByLabelText("Tour type"), "international");
    await user.type(screen.getByLabelText("Destination (optional)"), "Tokyo");
    await user.selectOptions(screen.getByLabelText("Payment mode"), "payment");
    await user.click(screen.getByRole("button", { name: "Create trip" }));
    expect(await screen.findByRole("heading", { name: /Japan Trip/ })).toBeInTheDocument(); // the new trip's page opens
    expect(be.calls(/POST .*trips$/)[0].body).toEqual({ title: "Japan Trip", tourType: "international", destination: "Tokyo", paymentMode: "payment", opensAt: null, closesAt: null });
  });

  it("checks that closing is after opening", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool();
    at(`/admin/schools/${s.id}/trips/new`);
    await screen.findByRole("heading", { name: "Create a trip" });
    await user.type(screen.getByLabelText("Trip title"), "T");
    await user.selectOptions(screen.getByLabelText("Tour type"), "domestic");
    await user.selectOptions(screen.getByLabelText("Payment mode"), "none");
    await user.type(screen.getByLabelText("Registration opens (optional)"), "2030-02-01T10:00");
    await user.type(screen.getByLabelText("Registration closes (optional)"), "2030-01-01T10:00");
    await user.click(screen.getByRole("button", { name: "Create trip" }));
    expect(screen.getByText("Registration must close after it opens.")).toBeInTheDocument();
    expect(be.calls(/POST .*trips$/)).toHaveLength(0);
  });

  it("rename and archive are shown to admins only", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const s = be.addSchool();
    at(`/sales/schools/${s.id}`);
    await screen.findByRole("heading", { name: /Greenfield Public School/ });
    expect(screen.queryByRole("button", { name: "Edit name and branch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive school" })).not.toBeInTheDocument();
  });

  it("an admin can rename and archive; an archived school takes no new trips", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool();
    at(`/admin/schools/${s.id}`);
    await screen.findByRole("heading", { name: /Greenfield Public School/ });
    await user.click(screen.getByRole("button", { name: "Edit name and branch" }));
    await user.clear(screen.getByLabelText("School name"));
    await user.type(screen.getByLabelText("School name"), "Greenfield High");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(be.calls(/PATCH .*schools/)[0].body).toEqual({ name: "Greenfield High" }); // the unchanged branch is not sent
    expect(await screen.findByRole("heading", { name: /Greenfield High/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Archive school" }));
    expect(await screen.findByText("archived")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Create a trip" })).not.toBeInTheDocument();
  });
});

describe("/admin: trip, status and links", () => {
  const trip = (be, over = {}) => be.addTrip(be.state.schools[0]?.id ?? be.addSchool().id, over);
  // each role in its own portal
  const portalOf = (be) => (be.state.staff.role === "sales" ? "/sales" : "/admin");
  const open = async (be, t) => {
    at(`${portalOf(be)}/trips/${t.id}`);
    await screen.findByRole("heading", { name: new RegExp(t.title) });
  };
  const openLinks = async (be, t) => {
    at(`${portalOf(be)}/trips/${t.id}/links`);
    await screen.findByRole("heading", { level: 1, name: "Registration link" });
  };

  it("the trip page summarises the registration link and leads to its own page (the link controls live there)", async () => {
    const be = createFakeAdmin();
    const t = trip(be, { status: "active", publicRegistration: true });
    await open(be, t);
    const card = within(screen.getByRole("region", { name: "Registration link" }));
    expect(card.getByText("On")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Copy link/ })).not.toBeInTheDocument();
    await user.click(card.getByRole("link", { name: /Registration link/ }));
    expect(await screen.findByLabelText("Registration page address")).toHaveValue("https://parents.example.test/join/greenfield-public-school/main/winter-trip");
  });

  it("shows the details, including the template derived from tour type and payment", async () => {
    const be = createFakeAdmin();
    const t = trip(be, { tourType: "international", paymentMode: "payment", templateKey: "international_payment", destination: "Tokyo" });
    await open(be, t);
    expect(screen.getByText("international_payment")).toBeInTheDocument();
    expect(screen.getByText("Tokyo")).toBeInTheDocument();
    expect(screen.getByText("Payment")).toBeInTheDocument();
  });

  it("sales sees only the status buttons it may use; admin sees all", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const t = trip(be);
    await open(be, t);
    expect(screen.getByRole("button", { name: "Activate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("activates and closes, then sales gets no Reopen; the server's refusal would be shown if it were tried", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const t = trip(be);
    await open(be, t);
    await user.click(screen.getByRole("button", { name: "Activate" }));
    await user.click(await screen.findByRole("button", { name: "Close trip" }));
    expect(await screen.findByText(/Closed: no new registrations/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reopen" })).not.toBeInTheDocument();
    expect(screen.getByText("Only an admin can make further status changes.")).toBeInTheDocument();
  });

  it("archiving needs a second, confirming click and then makes the trip read-only", async () => {
    const be = createFakeAdmin();
    const t = trip(be, { status: "closed" });
    await open(be, t);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(be.calls(/status$/)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: /Confirm: archive/ }));
    expect(await screen.findByText(/Archived: read-only/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit details" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: /Registration link/ }));
    expect(await screen.findByText("An archived trip's public page can't be changed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /public registration/ })).not.toBeInTheDocument();
  });

  it("shows the server's message if a forbidden change is attempted", async () => {
    const be = createFakeAdmin();
    const t = trip(be);
    await open(be, t);
    be.queue(`POST /api/admin/trips/${t.id}/status`, apiError(403, "FORBIDDEN"));
    await user.click(screen.getByRole("button", { name: "Activate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to do that.");
  });

  it("edits the details; tour type and payment are locked once the trip is no longer a draft", async () => {
    const be = createFakeAdmin();
    const t = trip(be, { status: "active" });
    await open(be, t);
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    expect(screen.getByLabelText("Tour type")).toBeDisabled();
    expect(screen.getByLabelText("Payment mode")).toBeDisabled();
    await user.clear(screen.getByLabelText("Trip title"));
    await user.type(screen.getByLabelText("Trip title"), "Renamed Trip");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("heading", { name: /Renamed Trip/ })).toBeInTheDocument();
    const body = be.calls(/PATCH .*trips/)[0].body;
    expect(body).toEqual({ title: "Renamed Trip", destination: "Manali", opensAt: null, closesAt: null });
  });

  describe("public registration page", () => {
    const ADDRESS = "https://parents.example.test/join/greenfield-public-school/main/winter-trip";
    const mockClipboard = (impl) => {
      const writeText = vi.fn(impl ?? (async () => {}));
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      return writeText;
    };

    it("shows the token-free address, Off by default, and a warning that the page is public", async () => {
      const be = createFakeAdmin();
      const t = trip(be, { status: "active" });
      await openLinks(be, t);
      const section = screen.getByRole("region", { name: "Public registration page" });
      expect(within(section).getByLabelText("Registration page address")).toHaveValue(ADDRESS);
      expect(within(section).getByText("Off")).toBeInTheDocument();
      expect(within(section).getByText(/no one can register from it/)).toBeInTheDocument();
      expect(within(section).getByText(/This page is public/)).toBeInTheDocument();
      expect(within(section).getByText(/Parents still need to register or log in/)).toBeInTheDocument();
      expect(screen.queryByText(/Generate link/)).not.toBeInTheDocument();
      expect(screen.queryByText(/only time the full link is shown/)).not.toBeInTheDocument();
    });

    it("sales can turn it on and off; the request carries only on/off", async () => {
      const be = createFakeAdmin({ role: "sales" });
      const t = trip(be, { status: "active" });
      await openLinks(be, t);
      await user.click(screen.getByRole("button", { name: "Turn on public registration" }));
      expect(await screen.findByText(/parents can open this page and register/)).toBeInTheDocument();
      expect(be.calls(/public-registration$/)[0].body).toEqual({ enabled: true });
      await user.click(screen.getByRole("button", { name: "Turn off public registration" }));
      expect(await screen.findByText(/no one can register from it/)).toBeInTheDocument();
      expect(be.calls(/public-registration$/)[1].body).toEqual({ enabled: false });
    });

    it("explains a draft or closed trip with the page switched on", async () => {
      const be = createFakeAdmin();
      const d = trip(be, { status: "draft", publicRegistration: true });
      await openLinks(be, d);
      expect(screen.getByText(/will take registrations once the trip is activated/)).toBeInTheDocument();
    });

    it("copies the complete address, which can be copied again at any time", async () => {
      const writeText = mockClipboard();
      const be = createFakeAdmin();
      const t = trip(be, { status: "active", publicRegistration: true });
      await openLinks(be, t);
      await user.click(screen.getByRole("button", { name: /Copy link/ }));
      expect(writeText).toHaveBeenCalledWith(ADDRESS);
      expect(await screen.findByText("Copied.")).toBeInTheDocument();
      expect(ADDRESS).not.toMatch(/[A-Za-z0-9_-]{43}/);
    });

    it("says so plainly when the browser refuses to copy", async () => {
      mockClipboard(async () => { throw new Error("denied"); });
      const be = createFakeAdmin();
      const t = trip(be, { status: "active" });
      await openLinks(be, t);
      await user.click(screen.getByRole("button", { name: /Copy link/ }));
      expect(await screen.findByText("Couldn't copy automatically. Select the address above and copy it.")).toBeInTheDocument();
    });

    it("shows the server's refusal", async () => {
      const be = createFakeAdmin();
      const t = trip(be, { status: "active" });
      await openLinks(be, t);
      be.queue(`POST /api/admin/trips/${t.id}/public-registration`, apiError(403, "FORBIDDEN"));
      await user.click(screen.getByRole("button", { name: "Turn on public registration" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to do that.");
    });

    it("makes no link-management requests at all", async () => {
      const be = createFakeAdmin();
      const t = trip(be, { status: "active" });
      await openLinks(be, t);
      expect(be.calls(/links/)).toHaveLength(0);
    });
  });
});

describe("from the public page into registration", () => {
  it("'Register or log in' opens the portal still knowing the school, and sends nothing extra before that", async () => {
    const be = createFakeAdmin({ signedIn: false, joinResponses: { [JOIN_KEY]: reply(200, info()) } });
    at(JOIN_PATH);
    await screen.findByText("Type");
    expect(storageIsEmpty()).toBe(true); // just viewing the link stores nothing

    await user.click(screen.getByRole("link", { name: "Register or log in" }));
    expect(await screen.findByRole("tab", { name: "Register" })).toBeInTheDocument();
    expect(screen.queryByText(/Registering for|Logging in for/)).not.toBeInTheDocument();
    expect(be.calls(/\/api\/admin/)).toHaveLength(0);
  });
});

describe("academic year on a trip", () => {
  it("is optional: left empty, the request carries no year at all", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool();
    at(`/admin/schools/${s.id}/trips/new`);
    await screen.findByRole("heading", { name: "Create a trip" });
    await user.type(screen.getByLabelText("Trip title"), "Plain Trip");
    await user.selectOptions(screen.getByLabelText("Tour type"), "domestic");
    await user.selectOptions(screen.getByLabelText("Payment mode"), "none");
    await user.click(screen.getByRole("button", { name: "Create trip" }));
    await screen.findByRole("heading", { name: /Plain Trip/ });
    expect(be.calls(/POST .*trips$/)[0].body).not.toHaveProperty("academicYear");
  });

  it("is checked before anything is sent, and sent when valid", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool();
    at(`/admin/schools/${s.id}/trips/new`);
    await screen.findByRole("heading", { name: "Create a trip" });
    await user.type(screen.getByLabelText("Trip title"), "Year Trip");
    await user.selectOptions(screen.getByLabelText("Tour type"), "domestic");
    await user.selectOptions(screen.getByLabelText("Payment mode"), "none");
    await user.type(screen.getByLabelText("Academic year (optional)"), "2026-28");
    await user.click(screen.getByRole("button", { name: "Create trip" }));
    expect(screen.getByText("The two years must follow each other, like 2026-27.")).toBeInTheDocument();
    expect(be.calls(/POST .*trips$/)).toHaveLength(0);
    await user.clear(screen.getByLabelText("Academic year (optional)"));
    await user.type(screen.getByLabelText("Academic year (optional)"), "2026-27");
    await user.click(screen.getByRole("button", { name: "Create trip" }));
    await screen.findByRole("heading", { name: /Year Trip/ });
    expect(be.calls(/POST .*trips$/)[0].body.academicYear).toBe("2026-27");
  });
});

describe("registration window wording", () => {
  const HELP = "These dates control when parents can register. They are not the trip travel dates.";
  const openTrip = async (be) => {
    const t = be.addTrip(be.addSchool().id, {});
    at(`/admin/trips/${t.id}`);
    await screen.findByRole("heading", { name: new RegExp(t.title) });
    return t;
  };

  it("the trip details call them Registration opens / closes, with the explanation, and never plain Opens / Closes", async () => {
    const be = createFakeAdmin();
    await openTrip(be);
    expect(screen.getByText("Registration opens")).toBeInTheDocument();
    expect(screen.getByText("Registration closes")).toBeInTheDocument();
    expect(screen.getByText(HELP)).toBeInTheDocument();
    expect(screen.queryByText("Opens")).not.toBeInTheDocument();
    expect(screen.queryByText("Closes")).not.toBeInTheDocument();
    expect(screen.queryByText(/travel (start|end)/i)).not.toBeInTheDocument(); // no invented travel dates
  });

  it("editing uses the same labels and explanation, and the explanation is attached to both fields", async () => {
    const be = createFakeAdmin();
    await openTrip(be);
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    const opens = screen.getByLabelText("Registration opens");
    const closes = screen.getByLabelText("Registration closes");
    expect(screen.getByText(HELP)).toBeInTheDocument();
    expect(opens).toHaveAccessibleDescription(HELP);
    expect(closes).toHaveAccessibleDescription(HELP);
    expect(screen.queryByLabelText("Opens")).not.toBeInTheDocument();
  });

  it("the window check still applies when editing, and the request still uses opensAt / closesAt", async () => {
    const be = createFakeAdmin();
    const t = await openTrip(be);
    await user.click(screen.getByRole("button", { name: "Edit details" }));
    await user.type(screen.getByLabelText("Registration opens"), "2030-02-01T10:00");
    await user.type(screen.getByLabelText("Registration closes"), "2030-01-01T10:00");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Registration must close after it opens.")).toBeInTheDocument();
    expect(be.calls(/PATCH .*trips/)).toHaveLength(0);

    await user.clear(screen.getByLabelText("Registration closes"));
    await user.type(screen.getByLabelText("Registration closes"), "2030-03-01T10:00");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("heading", { name: new RegExp(t.title) });
    const body = be.calls(/PATCH .*trips/)[0].body;
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["opensAt", "closesAt"]));
    expect(body).not.toHaveProperty("registrationOpens");
  });

  it("the create form uses the same labels and explanation", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool();
    at(`/admin/schools/${s.id}/trips/new`);
    await screen.findByRole("heading", { name: "Create a trip" });
    expect(screen.getByLabelText("Registration opens (optional)")).toHaveAccessibleDescription(HELP);
    expect(screen.getByLabelText("Registration closes (optional)")).toHaveAccessibleDescription(HELP);
    expect(screen.queryByLabelText("Opens (optional)")).not.toBeInTheDocument();
  });
});

describe("admin panel scrolling", () => {
  const css = readFileSync("src/index.css", "utf8"); // vitest runs from frontend/; CSS imports are stubbed in tests

  it("staff screens need no special body class: the document scrolls on every page (nothing locks <body>)", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool();
    for (const path of ["/admin", `/admin/schools/${s.id}`]) {
      const view = at(path);
      await screen.findByRole("navigation", { name: "Admin portal sections" });
      expect(document.body.className).toBe("");
      view.unmount();
    }
  });

  it("the stylesheet never locks the document, and no admin rule creates a second scroller", () => {
    expect(css).not.toMatch(/\nbody\s*\{[^}]*overflow(-y)?:\s*hidden/); // every page scrolls naturally (see LayoutScroll.test.js)
    // No admin rule may lock the page or create a second scroller around the content.
    const adminRules = css.slice(css.indexOf("ADMIN PANEL"));
    expect(adminRules).not.toMatch(/\.admin(-main)?\s*\{[^}]*overflow(-y)?:\s*(hidden|auto|scroll)/);
    expect(adminRules).not.toMatch(/\.admin(-main)?\s*\{[^}]*[{;]\s*height:\s*100/);
  });
});

describe("/admin: top bar", () => {
  const nav = () => screen.getByRole("navigation", { name: /portal sections/ });

  it("shows the brand, the sections and the signed-in person with their role and a Log out button", async () => {
    createFakeAdmin();
    at("/admin");
    await screen.findByRole("heading", { name: "Admin dashboard" });
    const brand = screen.getByRole("link", { name: /Young Edsplorer/ });
    expect(brand).toHaveAttribute("href", "/admin/dashboard");
    expect(within(brand).getByText("Admin portal")).toBeInTheDocument();
    expect(within(nav()).getAllByRole("link").map((a) => a.textContent.trim())).toEqual(["Dashboard", "Schools", "Trips", "Manage staff"]);
    expect(screen.getByText("Alex Admin")).toBeInTheDocument();
    expect(screen.getByText("admin", { selector: ".admin-role" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Log out/ })).toBeInTheDocument();
  });

  it("marks the current section with aria-current, including pages inside it", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool();
    const t = be.addTrip(s.id, {});
    const current = () => within(nav()).queryAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent.trim());
    for (const [path, expected, heading] of [
      ["/admin/dashboard", ["Dashboard"], "Admin dashboard"],
      ["/admin/schools", ["Schools"], "Schools"],
      [`/admin/schools/${s.id}`, ["Schools"], /Greenfield Public School/],
      ["/admin/trips", ["Trips"], "Trips"],
      [`/admin/trips/${t.id}`, ["Trips"], new RegExp(t.title)],
      [`/admin/trips/${t.id}/links`, ["Trips"], "Registration link"],
      ["/admin/staff", ["Manage staff"], "Manage staff"],
    ]) {
      const view = at(path);
      await screen.findByRole("heading", { name: heading });
      expect(current(), path).toEqual(expected);
      view.unmount();
    }
  });

  it("the Sales portal has its own top bar: Dashboard, My schools, My trips; no Manage staff, no Audit log", async () => {
    createFakeAdmin({ role: "sales" });
    at("/sales");
    await screen.findByRole("heading", { name: "Sales dashboard" });
    expect(within(screen.getByRole("link", { name: /Young Edsplorer/ })).getByText("Sales portal")).toBeInTheDocument();
    expect(within(nav()).getAllByRole("link").map((a) => a.textContent.trim())).toEqual(["Dashboard", "My schools", "My trips"]);
    expect(screen.getByText("sales", { selector: ".admin-role" })).toBeInTheDocument();
  });

  it("navigates between sections with the links, keeping the same top bar", async () => {
    createFakeAdmin();
    at("/admin");
    await screen.findByRole("heading", { name: "Admin dashboard" });
    await user.click(within(nav()).getByRole("link", { name: /Manage staff/ }));
    expect(await screen.findByRole("heading", { name: "Manage staff" })).toBeInTheDocument();
    await user.click(within(nav()).getByRole("link", { name: /Trips/ }));
    expect(await screen.findByRole("heading", { name: "Trips" })).toBeInTheDocument();
    await user.click(within(nav()).getByRole("link", { name: /Schools/ }));
    expect(await screen.findByRole("heading", { name: "Schools" })).toBeInTheDocument();
    expect(screen.getAllByRole("banner")).toHaveLength(1);
  });

  it("the brand, the sections and the account are three separate groups, so none can sit inside another", async () => {
    createFakeAdmin();
    const view = at("/admin");
    await screen.findByRole("heading", { name: "Admin dashboard" });
    const bar = view.container.querySelector(".admin-header-bar");
    expect([...bar.children].map((c) => c.className.split(" ")[0])).toEqual(["admin-brand", "admin-nav", "admin-account"]);
    const account = screen.getByRole("group", { name: "Your account" });
    expect(account.parentElement).toBe(bar);
    // who you are, Change password and Log out live in the account group, and ONLY there
    expect(within(account).getByText("Alex Admin", { selector: ".admin-name" })).toBeInTheDocument();
    expect(within(account).getByText("admin", { selector: ".admin-role" })).toBeInTheDocument();
    expect(within(account).getByRole("link", { name: /Change password/ })).toBeInTheDocument();
    expect(within(account).getByRole("button", { name: /Log out/ })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Admin portal sections" });
    expect(within(nav).queryByText("Alex Admin")).not.toBeInTheDocument();
    expect(within(nav).queryByRole("button")).not.toBeInTheDocument();
    expect(within(nav).getAllByRole("link").map((a) => a.textContent.trim())).toEqual(["Dashboard", "Schools", "Trips", "Manage staff"]);
  });

  it("a very long name stays in the account group and is shortened by CSS, never wrapped into the sections", async () => {
    const be = createFakeAdmin();
    be.state.staff = { email: "a@example.com", name: "Alexandria Montgomery-Livingstone the Third", role: "admin" };
    at("/admin/schools");
    await screen.findByRole("heading", { name: "Schools" });
    const name = screen.getByText("Alexandria Montgomery-Livingstone the Third");
    expect(name.closest(".admin-account")).not.toBeNull();
    expect(name).toHaveAttribute("title", "Alexandria Montgomery-Livingstone the Third"); // the full name is still available
    expect(within(screen.getByRole("navigation", { name: "Admin portal sections" })).getAllByRole("link")).toHaveLength(4); // every section is still there
  });

  it("the stylesheet gives each group its own place at every width, and never hides a section", () => {
    const css = readFileSync("src/index.css", "utf8");
    const block = (selector) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    // two rows at every width: brand | account on top (the brand column may shrink), the sections on their own row
    expect(block(".admin-header-bar")).toMatch(/grid-template-areas:\s*"brand account" "nav nav"/);
    expect(block(".admin-header-bar")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/);
    // the account group may wrap instead of growing into the brand
    expect(block(".admin-account")).toMatch(/flex-wrap:\s*wrap/);
    expect(block(".admin-account")).toMatch(/min-width:\s*0/);
    expect(block(".admin-name")).toMatch(/text-overflow:\s*ellipsis/);
    // phones: logo + Log out, then who is signed in + Change password, then the sections
    expect(css).toMatch(/@media \(max-width: 640px\)\s*\{[^@]*"brand out" "who pw" "nav nav"/);
    // nothing in the header is ever hidden to make room (only the small "Admin panel" caption on phones)
    const headerRules = css.slice(css.indexOf(".admin-header {"), css.indexOf("/* Manage staff */"));
    // (only the decorative icons beside the section names are dropped on small phones; every name stays)
    expect(headerRules).not.toMatch(/\.admin-nav(?![^{]*svg)[^{]*\{[^}]*display:\s*none/);
    expect(headerRules).not.toMatch(/\.admin-account[^{]*\{[^}]*display:\s*none/);
    expect(headerRules).not.toMatch(/\.admin-nav\s*\{[^}]*(position:\s*absolute|overflow:\s*hidden)/);
  });

  it("every link is reachable with the keyboard, in reading order", async () => {
    createFakeAdmin();
    at("/admin");
    await screen.findByRole("heading", { name: "Admin dashboard" });
    const order = [];
    for (let i = 0; i < 7; i++) {
      await user.tab();
      order.push(document.activeElement.textContent.trim().replace(/\s+/g, " "));
    }
    expect(document.querySelector(".admin-brand")).toHaveAccessibleName(/Young Edsplorer/); // the logo's alt text
    expect(order[0]).toMatch(/Admin portal/); // the brand link (its visible text beside the logo)
    expect(order.slice(1, 5)).toEqual(["Dashboard", "Schools", "Trips", "Manage staff"]);
    expect(order[5]).toMatch(/Change password/);
    expect(order[6]).toMatch(/Log out/);
  });
});

describe("/admin/staff: manage staff", () => {
  const fill = async (over = {}) => {
    const v = { name: "Priya Sharma", email: "Priya@Example.com", ...over };
    if (v.name) await user.type(screen.getByLabelText("Full name"), v.name);
    if (v.email) await user.type(screen.getByLabelText("Email address"), v.email);
  };
  const submit = () => user.click(screen.getByRole("button", { name: "Add sales account" }));

  it("lists the team; admins are marked as managed by the command-line tool and have no buttons", async () => {
    createFakeAdmin();
    at("/admin/staff");
    const table = await screen.findByRole("table", { name: "Staff accounts" });
    const row = within(table).getByRole("row", { name: /Alex Admin/ });
    expect(within(row).getByText("Command-line tool")).toBeInTheDocument();
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
  });

  it("is not available to sales staff: /sales/staff doesn't exist, /admin/staff says it isn't their portal, and no staff request is made", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const v = at("/sales/staff");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    v.unmount();
    at("/admin/staff");
    expect(await screen.findByRole("heading", { name: "This isn't your portal" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the Sales portal" })).toHaveAttribute("href", "/sales/dashboard");
    expect(screen.queryByRole("heading", { name: "Manage staff" })).not.toBeInTheDocument();
    expect(be.calls(/api\/admin\/staff/)).toHaveLength(0);
  });

  it("the server's refusal is shown if a sales session ever reaches the call", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const { listStaff } = await import("./admin/adminApi.js");
    await expect(listStaff()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(be.calls(/GET .*staff/)).toHaveLength(1);
  });

  it("has NO password fields: only name and email (the role is Sales)", async () => {
    createFakeAdmin();
    at("/admin/staff");
    await screen.findByRole("table", { name: "Staff accounts" });
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/make.*admin/i)).not.toBeInTheDocument();
    expect(screen.getByText(/You don't set a password/)).toBeInTheDocument();
  });

  it("checks name and email before sending, with an error next to each field", async () => {
    const be = createFakeAdmin();
    at("/admin/staff");
    await screen.findByRole("table", { name: "Staff accounts" });
    await submit();
    expect(screen.getByText("Enter the person's name.")).toBeInTheDocument();
    expect(screen.getByText("Enter an email address.")).toBeInTheDocument();
    await fill({ email: "nope" });
    await submit();
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(be.calls(/POST .*staff/)).toHaveLength(0);
  });

  it("adds a PENDING sales account: sends name, email and role only, and explains how the owner sets the password", async () => {
    const be = createFakeAdmin();
    at("/admin/staff");
    await screen.findByRole("table", { name: "Staff accounts" });
    await fill();
    await submit();
    expect(await screen.findByText(/Added priya@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/Pending setup until they set a password/)).toBeInTheDocument();
    expect(be.calls(/POST .*staff/)[0].body).toEqual({ name: "Priya Sharma", email: "priya@example.com", role: "sales" });
    const row = await screen.findByRole("row", { name: /Priya Sharma/ });
    expect(within(row).getByText("Pending setup")).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toHaveValue("");
    expect(storageIsEmpty()).toBe(true);
  });

  it("explains a duplicate email and keeps what was typed", async () => {
    const be = createFakeAdmin();
    be.queue("POST /api/admin/staff", apiError(409, "STAFF_EXISTS"));
    at("/admin/staff");
    await screen.findByRole("table", { name: "Staff accounts" });
    await fill();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("A staff account with that email already exists.");
    expect(screen.getByLabelText("Full name")).toHaveValue("Priya Sharma");
  });

  it("deactivates only after a second confirming click; Activate returns a no-password account to Pending", async () => {
    const be = createFakeAdmin();
    at("/admin/staff");
    await screen.findByRole("table", { name: "Staff accounts" });
    await fill();
    await submit();
    await screen.findByRole("row", { name: /Priya Sharma/ });

    await user.click(screen.getByRole("button", { name: "Deactivate Priya Sharma" }));
    expect(be.calls(/PATCH .*staff/)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(be.calls(/PATCH .*staff/)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Deactivate Priya Sharma" }));
    await user.click(screen.getByRole("button", { name: "Confirm deactivating Priya Sharma" }));
    const row = await screen.findByRole("row", { name: /Priya Sharma.*Deactivated/ });
    expect(be.calls(/PATCH .*staff/)[0].body).toEqual({ active: false });

    await user.click(within(row).getByRole("button", { name: "Activate Priya Sharma" }));
    expect(await screen.findByRole("row", { name: /Priya Sharma.*Pending setup/ })).toBeInTheDocument();
    expect(be.calls(/PATCH .*staff/)[1].body).toEqual({ active: true });
  });

  it("a refused change shows the server's reason", async () => {
    const be = createFakeAdmin();
    at("/admin/staff");
    await screen.findByRole("table", { name: "Staff accounts" });
    await fill();
    await submit();
    await screen.findByRole("row", { name: /Priya Sharma/ });
    be.queue(`PATCH /api/admin/staff/${be.state.team.at(-1).id}`, apiError(409, "STAFF_PROTECTED"));
    await user.click(screen.getByRole("button", { name: "Deactivate Priya Sharma" }));
    await user.click(screen.getByRole("button", { name: "Confirm deactivating Priya Sharma" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Admin accounts can't be changed here/);
  });
});

describe("/admin/login: first-time setup and forgot password", () => {
  const GOOD = "a-strong-pass-123";
  const openFlow = async (be) => {
    at("/admin");
    await screen.findByRole("heading", { name: "Admin log in" });
    await user.click(screen.getByRole("button", { name: "First time or forgot your password?" }));
    return be;
  };
  const sendCode = async (email) => {
    await user.type(screen.getByLabelText("Work email address"), email);
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByRole("heading", { name: "Enter verification code" });
  };
  const enterCode = async (code = "123456") => {
    await user.click(screen.getByLabelText("Digit 1 of 6"));
    await user.paste(code);
    await user.click(screen.getByRole("button", { name: /Verify OTP/ }));
  };
  const toPasswordStep = async (email = "New.Hire@Example.com") => {
    await sendCode(email);
    await enterCode();
    await screen.findByRole("heading", { name: "Choose your password" });
  };

  it("is reachable from the login page and explains both situations", async () => {
    await openFlow(createFakeAdmin({ signedIn: false }));
    expect(screen.getByRole("heading", { name: "Set up or reset your password" })).toBeInTheDocument();
    expect(screen.getByText(/First time\? We'll email you a code/)).toBeInTheDocument();
    expect(screen.getByText(/Forgot it\? The same steps let you reset it/)).toBeInTheDocument();
  });

  it("walks email -> code -> password, never claiming whether the address is staff", async () => {
    const be = await openFlow(createFakeAdmin({ signedIn: false, team: [{ id: "t1", email: "new.hire@example.com", name: "New Hire", role: "sales", status: "pending", hasPassword: false }] }));
    await toPasswordStep();
    expect(be.calls(/password\/request/)[0].body).toEqual({ email: "new.hire@example.com" });
    expect(be.calls(/password\/verify/)[0].body).toEqual({ email: "new.hire@example.com", code: "123456" });
    await user.type(screen.getByLabelText("New password"), GOOD);
    await user.type(screen.getByLabelText("Confirm new password"), GOOD);
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByRole("heading", { name: "Password set" })).toBeInTheDocument();
    expect(be.calls(/password\/confirm/)[0].body).toEqual({ email: "new.hire@example.com", verificationToken: "STAFFVERIFYTOKEN", password: GOOD, confirmPassword: GOOD });
    expect(document.body.textContent).not.toContain(GOOD);
    expect(document.body.textContent).not.toContain("STAFFVERIFYTOKEN");
    expect(storageIsEmpty()).toBe(true);
  });

  it("the code screen says 'If an account exists ...' (it never confirms an account exists)", async () => {
    await openFlow(createFakeAdmin({ signedIn: false }));
    await sendCode("stranger@example.com");
    const line = screen.getByText((_, el) => el?.tagName === "P" && /^If an account exists for stranger@example\.com, we've sent it a 6-digit code/.test(el.textContent));
    expect(line).toBeInTheDocument();
    expect(line.textContent).not.toMatch(/we sent a|your account|is registered/i);
  });

  it("for an account that already has a password the final screen says it was RESET and that all devices were signed out", async () => {
    await openFlow(createFakeAdmin({ signedIn: false, team: [{ id: "t1", email: "sam@example.com", name: "Sam", role: "sales", status: "active", hasPassword: true }] }));
    await toPasswordStep("sam@example.com");
    await user.type(screen.getByLabelText("New password"), GOOD);
    await user.type(screen.getByLabelText("Confirm new password"), GOOD);
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByRole("heading", { name: "Password reset" })).toBeInTheDocument();
    expect(screen.getByText(/signed out everywhere/)).toBeInTheDocument();
  });

  it("does not sign anyone in: 'Go to log in' returns to the login form with the typed email filled and no password", async () => {
    const be = await openFlow(createFakeAdmin({ signedIn: false }));
    await toPasswordStep("sam@example.com");
    await user.type(screen.getByLabelText("New password"), GOOD);
    await user.type(screen.getByLabelText("Confirm new password"), GOOD);
    await user.click(screen.getByRole("button", { name: "Save password" }));
    await user.click(await screen.findByRole("button", { name: /Go to log in/ }));
    expect(await screen.findByRole("heading", { name: "Admin log in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveValue("sam@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(be.calls(/auth\/session/).every((c) => c.method === "GET")).toBe(true);
  });

  it("checks the email, the code and the password before asking the server", async () => {
    const be = await openFlow(createFakeAdmin({ signedIn: false }));
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(screen.getByText("Enter your work email address.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Work email address"), "nope");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(be.calls(/password\/request/)).toHaveLength(0);

    await user.clear(screen.getByLabelText("Work email address"));
    await sendCode("sam@example.com");
    await user.click(screen.getByLabelText("Digit 1 of 6"));
    await user.paste("12");
    await user.click(screen.getByRole("button", { name: /Verify OTP/ }));
    expect(screen.getByText("Enter the 6-digit verification code.")).toBeInTheDocument();
    expect(be.calls(/password\/verify/)).toHaveLength(0);
  });

  it("a wrong code shows how many attempts remain and stays on the code step", async () => {
    await openFlow(createFakeAdmin({ signedIn: false }));
    await sendCode("sam@example.com");
    await enterCode("000000");
    expect(await screen.findByRole("alert")).toHaveTextContent(/incorrect.*4 attempts left/);
    expect(screen.getByRole("heading", { name: "Enter verification code" })).toBeInTheDocument();
  });

  it("an expired verification at the last step returns to the email step with a clear message", async () => {
    const be = await openFlow(createFakeAdmin({ signedIn: false }));
    await toPasswordStep("sam@example.com");
    be.queue("POST /api/admin/auth/password/confirm", apiError(403, "VERIFICATION_REQUIRED"));
    await user.type(screen.getByLabelText("New password"), GOOD);
    await user.type(screen.getByLabelText("Confirm new password"), GOOD);
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByText(/expired or was already used/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Set up or reset your password" })).toBeInTheDocument();
  });

  it("applies the password rules in the browser (the server is still the authority)", async () => {
    const be = await openFlow(createFakeAdmin({ signedIn: false }));
    await toPasswordStep("sam@example.com");
    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm new password"), "different");
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(screen.getByText(/at least 10 characters/)).toBeInTheDocument();
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(be.calls(/password\/confirm/)).toHaveLength(0);
  });

  it("'Back to log in' abandons the flow without sending anything", async () => {
    const be = await openFlow(createFakeAdmin({ signedIn: false }));
    await user.click(screen.getByRole("button", { name: "Back to log in" }));
    expect(await screen.findByRole("heading", { name: "Admin log in" })).toBeInTheDocument();
    expect(be.calls(/password\//)).toHaveLength(0);
  });

  it("'Change email' on the code step goes back to the email step without losing safety", async () => {
    await openFlow(createFakeAdmin({ signedIn: false }));
    await sendCode("sam@example.com");
    await user.click(screen.getByRole("button", { name: /Change email/ }));
    expect(await screen.findByRole("heading", { name: "Set up or reset your password" })).toBeInTheDocument();
  });
});

describe("the frosted card has no stray line across its content", () => {
  const css = readFileSync("src/index.css", "utf8");

  it("the card's inner highlight is an inset shadow, not a pseudo-element", () => {
    // A pseudo-element once drew a stray line across the Verify OTP button. The highlight must not be one.
    expect(css).not.toMatch(/\.glass-card::(after|before)/);
    const card = css.match(/\.glass-card\s*\{([^}]*)\}/)[1];
    expect(card).not.toMatch(/overflow(-y)?:\s*(auto|scroll|hidden)/); // the PAGE scrolls; the card never clips its form
    expect(card).toMatch(/box-shadow:[^;]*inset 0 0 0 1px rgba\(255, 255, 255, 0\.5\)/);
  });

  it("no pseudo-element in the stylesheet is absolutely positioned over a scrolling card", () => {
    for (const m of css.matchAll(/([^{}]*\.(?:glass-card|auth-content|auth-form|otp-form)[^{}]*::(?:after|before)[^{}]*)\{([^}]*)\}/g)) {
      assert.fail(`pseudo-element on the card or its form: ${m[1].trim()}`);
    }
  });
});

describe("staff sign-in screens use the portal's authentication design", () => {
  const inside = (el, selector) => Boolean(el.closest(selector));

  it("the login screen is the portal's frosted card with the logo, and is NOT inside the .admin wrapper", async () => {
    createFakeAdmin({ signedIn: false });
    const view = at("/admin");
    const heading = await screen.findByRole("heading", { name: "Admin log in" });
    expect(inside(heading, "main.parent-portal > section.glass-card > .auth-content")).toBe(true);
    expect(inside(heading, ".admin")).toBe(false);
    expect(screen.getByAltText("Young Edsplorer")).toHaveClass("brand-logo");
    expect(view.container.querySelector(".admin")).toBeNull();
    expect(screen.getByLabelText("Email address").closest(".input-wrap")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Log in/ })).toHaveClass("primary-button");
    expect(screen.getByText("Young Edsplorer administrators only")).toHaveClass("staff-caption");
  });

  it("every setup screen (email, code, password, done) is in the same card and outside .admin", async () => {
    const be = createFakeAdmin({ signedIn: false });
    at("/admin");
    await screen.findByRole("heading", { name: "Admin log in" });
    await user.click(screen.getByRole("button", { name: "First time or forgot your password?" }));
    const check = (name) => {
      const h = screen.getByRole("heading", { name });
      expect(inside(h, ".glass-card .auth-content"), name).toBe(true);
      expect(inside(h, ".admin"), name).toBe(false);
      expect(screen.getByAltText("Young Edsplorer"), name).toBeInTheDocument();
    };
    check("Set up or reset your password");
    await user.type(screen.getByLabelText("Work email address"), "sam@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByRole("heading", { name: "Enter verification code" });
    check("Enter verification code");
    await user.click(screen.getByLabelText("Digit 1 of 6"));
    await user.paste("123456");
    await user.click(screen.getByRole("button", { name: /Verify OTP/ }));
    await screen.findByRole("heading", { name: "Choose your password" });
    check("Choose your password");
    await user.type(screen.getByLabelText("New password"), "a-strong-pass-123");
    await user.type(screen.getByLabelText("Confirm new password"), "a-strong-pass-123");
    await user.click(screen.getByRole("button", { name: "Save password" }));
    await screen.findByRole("heading", { name: "Password reset" });
    check("Password reset");
    expect(be.calls(/password\/request/)).toHaveLength(1);
  });

  it("the code step is the portal's six-box component, wired to the STAFF endpoints with the server's timers", async () => {
    const be = createFakeAdmin({ signedIn: false });
    at("/admin");
    await screen.findByRole("heading", { name: "Admin log in" });
    await user.click(screen.getByRole("button", { name: "First time or forgot your password?" }));
    await user.type(screen.getByLabelText("Work email address"), "sam@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByRole("heading", { name: "Enter verification code" });
    expect(screen.getAllByLabelText(/Digit \d of 6/)).toHaveLength(6);
    expect(screen.getByText(/Code expires in 15:00/)).toBeInTheDocument(); // the server's 900 seconds (15 minutes)
    expect(screen.getByRole("button", { name: /Resend OTP in \d+s/ })).toBeDisabled(); // the server's 30 second cooldown
    expect(be.calls().every((c) => !c.url.startsWith("/api/email-otp"))).toBe(true); // never the generic code routes
  });

  it("the work email box starts EMPTY, even if the login form had an address, and is not auto-fillable", async () => {
    createFakeAdmin({ signedIn: false });
    at("/admin");
    await user.type(await screen.findByLabelText("Email address"), "saved.login@example.com");
    await user.click(screen.getByRole("button", { name: "First time or forgot your password?" }));
    const box = screen.getByLabelText("Work email address");
    expect(box).toHaveValue("");
    expect(box).toHaveAttribute("autocomplete", "off");
    expect(box).toHaveAttribute("data-1p-ignore", "true");
    expect(box).toHaveAttribute("data-lpignore", "true");
    expect(box).not.toHaveAttribute("autocomplete", "username");
    // the normal login box is still a normal login field
    await user.click(screen.getByRole("button", { name: "Back to log in" }));
    expect(await screen.findByLabelText("Email address")).toHaveAttribute("autocomplete", "username");
  });

  it("the countdown follows the server's time and counts down accurately", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      createFakeAdmin({ signedIn: false });
      at("/admin");
      await screen.findByRole("heading", { name: "Admin log in" });
      await user.click(screen.getByRole("button", { name: "First time or forgot your password?" }));
      await user.type(screen.getByLabelText("Work email address"), "sam@example.com");
      await user.click(screen.getByRole("button", { name: "Send code" }));
      await screen.findByText(/Code expires in 15:00/);
      await act(async () => { vi.advanceTimersByTime(61_000); });
      expect(await screen.findByText(/Code expires in 13:59/)).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(14 * 60_000); });
      expect(await screen.findByText("This code has expired. Request a new code.")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the setup email box shows who the code will go to as you type, and going back empties it", async () => {
    createFakeAdmin({ signedIn: false });
    at("/admin");
    await screen.findByRole("heading", { name: "Admin log in" });
    await user.click(screen.getByRole("button", { name: "First time or forgot your password?" }));
    expect(screen.getByText("Type the address yourself; it is never filled in for you.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Work email address"), "Sandbox.Admin@Example.test");
    expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "A code will be sent to sandbox.admin@example.test. Check that this is the address you mean.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByRole("heading", { name: "Enter verification code" });
    await user.click(screen.getByRole("button", { name: /Change email/ }));
    expect(await screen.findByLabelText("Work email address")).toHaveValue("");
  });

  it("the signed-in admin pages and navbar are unchanged: still inside .admin with the same header", async () => {
    createFakeAdmin();
    const view = at("/admin");
    await screen.findByRole("heading", { name: "Admin dashboard" });
    expect(view.container.querySelector(".admin > .admin-header")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Admin portal sections" })).toBeInTheDocument();
    expect(document.querySelector(".parent-portal")).toBeNull();
  });
});

describe("/admin/password: change your own password", () => {
  const GOOD = "changed-pass-4321";
  const open = async (be) => {
    at("/admin/password");
    await screen.findByRole("heading", { name: "Change password" });
    return be;
  };
  const fill = async ({ current = "right-staff-password", next = GOOD, confirm = next } = {}) => {
    if (current) await user.type(screen.getByLabelText("Current password"), current);
    if (next) await user.type(screen.getByLabelText("New password"), next);
    if (confirm) await user.type(screen.getByLabelText("Confirm new password"), confirm);
    await user.click(screen.getByRole("button", { name: "Change password" }));
  };

  it("is linked from the top bar for admins and sales alike", async () => {
    for (const role of ["admin", "sales"]) {
      createFakeAdmin({ role });
      const view = at(`/${role}`);
      await screen.findByRole("heading", { name: role === "admin" ? "Admin dashboard" : "Sales dashboard" });
      expect(screen.getByRole("link", { name: /Change password/ })).toHaveAttribute("href", `/${role}/password`);
      view.unmount();
    }
  });

  it("changes the password with the current one, clears the fields, and says so", async () => {
    const be = await open(createFakeAdmin());
    await fill();
    expect(await screen.findByText("Your password was changed.")).toBeInTheDocument();
    expect(be.calls(/POST .*auth\/password$/)[0].body).toEqual({ currentPassword: "right-staff-password", password: GOOD, confirmPassword: GOOD });
    expect(screen.getByLabelText("Current password")).toHaveValue("");
    expect(screen.getByLabelText("New password")).toHaveValue("");
    expect(document.body.textContent).not.toContain(GOOD);
    expect(storageIsEmpty()).toBe(true);
  });

  it("a wrong current password is explained and keeps the user on the page", async () => {
    await open(createFakeAdmin());
    await fill({ current: "not-my-password" });
    expect(await screen.findByRole("alert")).toHaveTextContent("The current password is incorrect.");
    expect(screen.queryByText("Your password was changed.")).not.toBeInTheDocument();
  });

  it("checks everything before sending: all fields, length, match, and a different new password", async () => {
    const be = await open(createFakeAdmin());
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByText("Enter your current password.")).toBeInTheDocument();
    expect(screen.getByText("Create a password.")).toBeInTheDocument();
    await fill({ current: "right-staff-password", next: "right-staff-password", confirm: "right-staff-password" });
    expect(screen.getByText("Choose a password different from your current one.")).toBeInTheDocument();
    expect(be.calls(/POST .*auth\/password$/)).toHaveLength(0);
  });

  it("an ended session sends the user back to log in", async () => {
    const be = await open(createFakeAdmin());
    be.state.refreshOk = false; // the sign-in itself is over, so the page's one renewal attempt is refused
    be.queue("POST /api/admin/auth/password", apiError(401, "UNAUTHENTICATED"));
    await fill();
    expect(await screen.findByRole("heading", { name: "Admin log in" })).toBeInTheDocument();
  });
});

describe("back navigation in the staff sign-in and password screens", () => {
  const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
  const visit = (entries, index) =>
    render(<MemoryRouter initialEntries={entries} initialIndex={index ?? entries.length - 1}><AppRoutes /><Where /></MemoryRouter>);
  const where = () => screen.getByTestId("where").textContent;
  const GOOD = "a-strong-pass-123";
  const toCode = async (email = "sam@example.com") => {
    await user.type(screen.getByLabelText("Work email address"), email);
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByRole("heading", { name: "Enter verification code" });
  };
  const toPassword = async () => {
    await toCode();
    await user.click(screen.getByLabelText("Digit 1 of 6"));
    await user.paste("123456");
    await user.click(screen.getByRole("button", { name: /Verify OTP/ }));
    await screen.findByRole("heading", { name: "Choose your password" });
  };

  it("the setup flow has its own address, and the login page's link goes there", async () => {
    createFakeAdmin({ signedIn: false });
    visit(["/admin"]);
    await user.click(await screen.findByRole("button", { name: "First time or forgot your password?" }));
    expect(where()).toBe("/admin/login/setup");
    expect(await screen.findByRole("heading", { name: "Set up or reset your password" })).toBeInTheDocument();
  });

  it("opening or refreshing the setup address starts at the email step with nothing carried over", async () => {
    createFakeAdmin({ signedIn: false });
    visit(["/admin/login/setup"]);
    expect(await screen.findByRole("heading", { name: "Set up or reset your password" })).toBeInTheDocument();
    expect(screen.getByLabelText("Work email address")).toHaveValue("");
    expect(storageIsEmpty()).toBe(true);
  });

  it("the browser's Back from the setup screen returns to the login screen (it is a real history step)", async () => {
    createFakeAdmin({ signedIn: false });
    visit(["/admin/login", "/admin/login/setup"]);
    await screen.findByRole("heading", { name: "Set up or reset your password" });
    // the history entry before it is the login page: this is what the Back button goes to
    await user.click(screen.getByRole("button", { name: "Back to log in" }));
    expect(await screen.findByRole("heading", { name: "Admin log in" })).toBeInTheDocument();
    expect(where()).toBe("/admin/login");
  });

  it("email step: a visible back arrow returns to log in without sending anything", async () => {
    const be = createFakeAdmin({ signedIn: false });
    visit(["/admin/login/setup"]);
    const back = await screen.findByRole("button", { name: "Back to log in" });
    expect(back.querySelector("svg")).not.toBeNull();
    await user.click(back);
    expect(await screen.findByRole("heading", { name: "Admin log in" })).toBeInTheDocument();
    expect(be.calls(/password\//)).toHaveLength(0);
  });

  it("code step: 'Change email' goes back to an EMPTY email step, so the next code goes to whatever is typed fresh", async () => {
    visit(["/admin/login/setup"]);
    createFakeAdmin({ signedIn: false });
    await screen.findByRole("heading", { name: "Set up or reset your password" });
    await toCode("first@example.com");
    expect(screen.getByText("first@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Change email/ }));
    expect(await screen.findByLabelText("Work email address")).toHaveValue("");
    await user.type(screen.getByLabelText("Work email address"), "second@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByText("second@example.com")).toBeInTheDocument();
    expect(screen.queryByText("first@example.com")).not.toBeInTheDocument();
  });

  it("password step: Back asks first, 'Stay here' keeps what was typed, 'Go back' returns to an empty email step", async () => {
    const be = createFakeAdmin({ signedIn: false });
    visit(["/admin/login/setup"]);
    await screen.findByRole("heading", { name: "Set up or reset your password" });
    await toPassword();
    await user.type(screen.getByLabelText("New password"), GOOD);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("alertdialog", { name: "Go back?" })).toHaveTextContent(/new code/);
    await user.click(screen.getByRole("button", { name: "Stay here" }));
    expect(screen.getByLabelText("New password")).toHaveValue(GOOD);

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(await screen.findByRole("heading", { name: "Set up or reset your password" })).toBeInTheDocument();
    expect(screen.getByLabelText("Work email address")).toHaveValue("");
    expect(be.calls(/password\/confirm/)).toHaveLength(0); // nothing was saved by going back
    expect(document.body.textContent).not.toContain(GOOD);
  });

  it("finishing returns to log in with the typed address filled and no password", async () => {
    createFakeAdmin({ signedIn: false });
    visit(["/admin/login/setup"]);
    await screen.findByRole("heading", { name: "Set up or reset your password" });
    await toPassword();
    await user.type(screen.getByLabelText("New password"), GOOD);
    await user.type(screen.getByLabelText("Confirm new password"), GOOD);
    await user.click(screen.getByRole("button", { name: "Save password" }));
    await user.click(await screen.findByRole("button", { name: /Go to log in/ }));
    expect(where()).toBe("/admin/login");
    expect(await screen.findByLabelText("Email address")).toHaveValue("sam@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("a signed-in person who opens the login or setup address is sent to the panel (no loop), and signed-out visitors cannot see protected pages", async () => {
    const inBe = createFakeAdmin();
    const view = visit(["/admin/login/setup"]);
    expect(await screen.findByRole("heading", { name: "Admin dashboard" })).toBeInTheDocument();
    expect(where()).toBe("/admin/dashboard");
    view.unmount();
    expect(inBe.calls(/auth\/session/).length).toBeGreaterThan(0);

    const outBe = createFakeAdmin({ signedIn: false });
    for (const path of ["/admin/staff", "/admin/dashboard", "/admin/password", "/admin/schools/x", "/admin/trips/x"]) {
      const v = visit([path]);
      expect(await screen.findByRole("heading", { name: "Admin log in" }), path).toBeInTheDocument();
      expect(where(), path).toBe("/admin/login");
      v.unmount();
    }
    // protected data was never requested without a session
    expect(outBe.calls(/api\/admin\/(staff|audit|schools|trips)/)).toHaveLength(0);
  });

  describe("change password page", () => {
    it("opened directly it says 'Back to schools'; opened from inside the panel it simply says 'Back'", async () => {
      createFakeAdmin();
      const direct = visit(["/admin/password"]);
      expect(await screen.findByRole("button", { name: "Back to dashboard" })).toBeInTheDocument();
      direct.unmount();

      createFakeAdmin();
      visit(["/admin/schools"]);
      await user.click(await screen.findByRole("link", { name: /Change password/ }));
      expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(where()).toBe("/admin/schools");
      expect(await screen.findByRole("heading", { name: "Schools" })).toBeInTheDocument();
    });

    it("leaves immediately when nothing was typed, and asks first when something was", async () => {
      createFakeAdmin();
      visit(["/admin/password"]);
      await user.type(await screen.findByLabelText("Current password"), "right-staff-password");
      await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
      expect(screen.getByRole("alertdialog", { name: "Leave this page?" })).toBeInTheDocument();
      expect(where()).toBe("/admin/password");
      await user.click(screen.getByRole("button", { name: "Stay" }));
      expect(screen.getByLabelText("Current password")).toHaveValue("right-staff-password");
      await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
      await user.click(screen.getByRole("button", { name: "Leave" }));
      expect(await screen.findByRole("heading", { name: "Admin dashboard" })).toBeInTheDocument();
      expect(where()).toBe("/admin/dashboard");
    });

    it("a clean form goes back without any question", async () => {
      createFakeAdmin();
      visit(["/admin/password"]);
      await user.click(await screen.findByRole("button", { name: "Back to dashboard" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: "Admin dashboard" })).toBeInTheDocument();
    });
  });
});

describe("the Sales workflow in the panel", () => {
  const Here = () => <p data-testid="where">{useLocation().pathname}</p>;
  const visit = (entries) => render(<MemoryRouter initialEntries={entries}><AppRoutes /><Here /></MemoryRouter>);
  const where = () => screen.getByTestId("where").textContent;
  it("Trips lists the trips this person manages with school, type, payment, year, status and public page, in each portal", async () => {
    for (const role of ["sales", "admin"]) {
      const be = createFakeAdmin({ role });
      const a = be.addSchool({ name: "Alpha School" });
      const b = be.addSchool({ name: "Beta School" });
      be.addTrip(a.id, { title: "Jaipur", tourType: "domestic", paymentMode: "payment", academicYear: "2026-27", status: "active" });
      be.addTrip(b.id, { title: "Japan", tourType: "international", paymentMode: "none", status: "draft" });
      be.addTrip(b.id, { title: "Old trip", status: "archived" });
      const view = at(`/${role}/trips`);
      const table = await screen.findByRole("table", { name: "All trips" });
      const jaipur = within(table).getByRole("row", { name: /Jaipur/ });
      expect(within(jaipur).getByRole("link", { name: "Alpha School" })).toBeInTheDocument();
      expect(jaipur).toHaveTextContent(/Domestic.*Payment.*2026-27.*active.*Off/);
      expect(within(table).getByRole("row", { name: /Japan/ })).toHaveTextContent(/International.*No payment.*draft/);
      expect(within(table).queryByText("Old trip")).not.toBeInTheDocument();
      await user.click(screen.getByLabelText("Show archived"));
      expect(within(table).getByText("Old trip")).toBeInTheDocument();
      expect(be.calls(/GET \/api\/admin\/trips$/)).toHaveLength(1);
      view.unmount();
    }
  });

  it("from Trips a salesperson opens a trip, turns on its public page and copies the token-free address", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const be = createFakeAdmin({ role: "sales" });
    const s = be.addSchool();
    be.addTrip(s.id, { title: "Shimla", status: "active" });
    at("/sales/trips");
    await user.click(await screen.findByRole("link", { name: "Shimla" }));
    await screen.findByRole("heading", { name: /Shimla/ });
    await user.click(screen.getByRole("link", { name: /Registration link/ }));
    await user.click(await screen.findByRole("button", { name: "Turn on public registration" }));
    await screen.findByRole("button", { name: "Turn off public registration" });
    await user.click(screen.getByRole("button", { name: /Copy link/ }));
    expect(writeText).toHaveBeenCalledWith("https://parents.example.test/join/greenfield-public-school/main/shimla");
  });

  it("the whole Sales journey: log in -> Sales dashboard -> add school -> create trip -> registration link -> copy", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const be = createFakeAdmin({ role: "sales", signedIn: false });
    visit(["/sales/login"]);
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email address"), "sales@example.com");
    await user.type(screen.getByLabelText("Password"), "right-staff-password");
    await user.click(screen.getByRole("button", { name: /^Log in/ }));
    expect(await screen.findByRole("heading", { name: "Sales dashboard" })).toBeInTheDocument();
    expect(where()).toBe("/sales/dashboard");
    expect(screen.queryByText("Open your school's trip registration link")).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("link", { name: /Add a school/ })[0]);
    expect(where()).toBe("/sales/schools/new");
    await user.type(await screen.findByLabelText("School name"), "Sunrise Academy");
    await user.click(screen.getByRole("button", { name: "Add school" }));
    expect(await screen.findByRole("heading", { name: /Sunrise Academy/ })).toBeInTheDocument();
    expect(where()).toMatch(/^\/sales\/schools\/[0-9a-f-]+$/);

    await user.click(screen.getByRole("link", { name: "Create a trip" }));
    expect(where()).toMatch(/^\/sales\/schools\/[0-9a-f-]+\/trips\/new$/);
    await user.type(await screen.findByLabelText("Trip title"), "Shimla");
    await user.selectOptions(screen.getByLabelText("Tour type"), "domestic");
    await user.selectOptions(screen.getByLabelText("Payment mode"), "none");
    await user.click(screen.getByRole("button", { name: "Create trip" }));
    expect(await screen.findByRole("heading", { name: /Shimla/ })).toBeInTheDocument();
    expect(where()).toMatch(/^\/sales\/trips\/[0-9a-f-]+$/);
    await user.click(screen.getByRole("button", { name: "Activate" }));
    await screen.findByRole("button", { name: "Close trip" });

    await user.click(screen.getByRole("link", { name: /Registration link/ }));
    expect(where()).toMatch(/^\/sales\/trips\/[0-9a-f-]+\/links$/);
    await user.click(await screen.findByRole("button", { name: "Turn on public registration" }));
    await screen.findByRole("button", { name: "Turn off public registration" });
    await user.click(screen.getByRole("button", { name: /Copy link/ }));
    expect(writeText).toHaveBeenCalledWith("https://parents.example.test/join/sunrise-academy/main/shimla");
    expect(be.calls(/\/api\/admin\/(staff|audit)/)).toHaveLength(0);
  });

  it("a salesperson creates a trip of each of the four kinds, with the exact values sent", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const school = be.addSchool({ name: "Sunrise Academy" });
    const kinds = [["domestic", "payment"], ["domestic", "none"], ["international", "payment"], ["international", "none"]];
    for (const [tourType, paymentMode] of kinds) {
      const view = at(`/sales/schools/${school.id}/trips/new`);
      await user.type(await screen.findByLabelText("Trip title"), `${tourType} ${paymentMode}`);
      await user.selectOptions(screen.getByLabelText("Tour type"), tourType);
      await user.selectOptions(screen.getByLabelText("Payment mode"), paymentMode);
      await user.click(screen.getByRole("button", { name: "Create trip" }));
      await screen.findByRole("heading", { name: new RegExp(`${tourType} ${paymentMode}`) });
      view.unmount();
    }
    const sent = be.calls(/POST .*trips$/).map((c) => [c.body.tourType, c.body.paymentMode]);
    expect(sent).toEqual(kinds);
    expect(be.state.trips.map((t) => t.templateKey)).toEqual(["domestic_payment", "domestic_none", "international_payment", "international_none"]);
  });

  it("on a trip a salesperson gets Activate and Close but not Archive or Reopen; an admin gets all of them", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const t = be.addTrip(be.addSchool().id, { status: "draft" });
    const view = at(`/sales/trips/${t.id}`);
    await screen.findByRole("heading", { name: /Winter Trip/ });
    expect(screen.getByRole("button", { name: "Activate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Activate" }));
    expect(await screen.findByRole("button", { name: "Close trip" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close trip" }));
    await screen.findByText("Only an admin can make further status changes.");
    expect(screen.queryByRole("button", { name: "Reopen" })).not.toBeInTheDocument();
    view.unmount();

    const adminBe = createFakeAdmin();
    const t2 = adminBe.addTrip(adminBe.addSchool().id, { status: "closed" });
    at(`/admin/trips/${t2.id}`);
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    expect(be.calls(/POST .*status$/).map((c) => c.body.status)).toEqual(["active", "closed"]);
  });

  it("a salesperson sees no Rename/Archive for schools", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const s = be.addSchool();
    at(`/sales/schools/${s.id}`);
    await screen.findByRole("heading", { name: /Greenfield Public School/ });
    expect(screen.queryByRole("button", { name: /Edit name and branch/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archive school/ })).not.toBeInTheDocument();
  });
});

describe("each trip keeps its own identity through the whole parent journey (/join/:school/:branch/:trip/continue)", () => {
  const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
  const visit = (path) => render(<MemoryRouter initialEntries={[path]}><AppRoutes /><Where /></MemoryRouter>);
  const where = () => screen.getByTestId("where").textContent;
  const A = { school: "alpha-school", branch: "main", trip: "jaipur-2026" };
  const B = { school: "beta-school", branch: "main", trip: "japan-2027" };
  const key = (a) => `${a.school}/${a.branch}/${a.trip}`;
  const TRIP_A = { address: A, school: "Alpha School", title: "Jaipur 2026", destination: "Jaipur", tourType: "domestic" };
  const TRIP_B = { address: B, school: "Beta School", title: "Japan 2027", destination: "Tokyo", tourType: "international" };
  const infoFor = (t, open = true) => reply(200, { school: { name: t.school }, trip: { title: t.title, destination: t.destination, tourType: t.tourType }, registrationOpen: open });

  it("two different pages resolve to their own school and trip, on the page and after 'Register or log in'", async () => {
    for (const t of [TRIP_A, TRIP_B]) {
      createFakeAdmin({ signedIn: false, joinResponses: { [key(A)]: infoFor(TRIP_A), [key(B)]: infoFor(TRIP_B) } });
      const view = visit(`/join/${key(t.address)}`);
      await screen.findByRole("link", { name: "Register or log in" });
      await user.click(screen.getByRole("link", { name: "Register or log in" }));
      expect(where()).toBe(`/join/${key(t.address)}/continue`); // no token anywhere in the address
      await screen.findByRole("tab", { name: "Register" });
      expect(screen.queryByText(/Registering for|Logging in for/)).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("a refresh (or a new tab) on the continue address shows the same trip, with nothing kept in browser storage", async () => {
    const be = createFakeAdmin({ signedIn: false, joinResponses: { [key(B)]: infoFor(TRIP_B) } });
    const first = visit(`/join/${key(B)}/continue`);
    await screen.findByRole("tab", { name: "Register" });
    first.unmount();
    visit(`/join/${key(B)}/continue`); // reloaded
    await screen.findByRole("tab", { name: "Register" });
    expect(screen.queryByText(/Registering for|Logging in for/)).not.toBeInTheDocument();
    expect(be.calls(new RegExp(`GET /api/join/${key(B)}`))).toHaveLength(2);
    expect(storageIsEmpty()).toBe(true);
  });

  it("a new parent registers from the trip's page and lands in that trip's form", async () => {
    const be = createFakeBackend({ join: TRIP_B });
    visit(`/join/${key(B)}`);
    await user.click(await screen.findByRole("link", { name: "Register or log in" }));
    await screen.findByRole("tab", { name: "Register" });
    expect(screen.queryByText(/Registering for|Logging in for/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/first name/i), "Asha");
    await user.type(screen.getByLabelText(/last name/i), "Rao");
    await user.selectOptions(screen.getByLabelText(/role/i), "Student");
    await user.type(screen.getByLabelText(/phone/i), "9876543210");
    await user.type(screen.getByLabelText(/email address/i), "new.parent@example.com");
    await user.type(screen.getByLabelText(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /Verify email|Continue/ }));
    await screen.findByRole("heading", { name: "Enter verification code" });
    await user.click(screen.getAllByLabelText(/Digit \d of 6/)[0]);
    await user.paste("482913");
    await user.click(screen.getByRole("button", { name: /Verify OTP/ }));
    const group = await screen.findByRole("group", { name: "Your school's trip" });
    expect(within(group).getByText("Japan 2027")).toBeInTheDocument();
    expect(be.calls("POST /api/registrations")[0].body.publicTrip).toEqual(B);
    expect(be.calls("POST /api/registrations")[0].body).not.toHaveProperty("joinToken");
    expect(where()).toBe(`/join/${key(B)}/continue`);
  });

  it("an existing parent logs in from the trip's page and is joined to that trip", async () => {
    const be = createFakeBackend({ join: TRIP_A, accounts: ["parent@example.com"], passwords: { "parent@example.com": PASSWORD } });
    visit(`/join/${key(A)}/continue`);
    await user.click(await screen.findByRole("tab", { name: "Login" }));
    expect(screen.queryByText(/Registering for|Logging in for/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/email address/i), "parent@example.com");
    await user.type(screen.getByLabelText(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /^Log in/ }));
    await screen.findByRole("group", { name: "Your school's trip" });
    expect(be.calls("POST /api/enrolments")[0].body).toEqual({ trip: A });
    expect(document.querySelector(".onboarding-context")).toBeNull();
  });

  it("an unknown, private or archived trip shows a clear message and NO registration or login form", async () => {
    const be = createFakeAdmin({ signedIn: false, joinResponses: {} }); // the server answers TRIP_NOT_FOUND for every one
    for (const path of [key(A), "alpha-school/delhi/jaipur-2026", "Bad Words/main/x"]) {
      const view = visit(`/join/${path}/continue`);
      expect(await screen.findByRole("heading", { name: "This page can't be opened" })).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(/isn't available/);
      expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: "Login" })).not.toBeInTheDocument();
      view.unmount();
    }
    expect(be.calls(/POST/)).toHaveLength(0);
  });

  it("a trip that isn't taking registrations says so and shows no forms", async () => {
    createFakeAdmin({ signedIn: false, joinResponses: { [key(A)]: infoFor(TRIP_A, false) } });
    visit(`/join/${key(A)}/continue`);
    expect(await screen.findByText(/Registration isn't open for this trip right now/)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();
  });

  it("the parent portal's own page still works with no trip at all", async () => {
    const be = createFakeAdmin({ signedIn: false });
    visit("/parent");
    expect(await screen.findByRole("tab", { name: "Register" })).toBeInTheDocument();
    expect(screen.queryByText(/Registering for/)).not.toBeInTheDocument();
    expect(be.calls(/\/api\/join\//)).toHaveLength(0);
  });
});

describe("retired secret-token links", () => {
  const OLD = "Ab3_dEf-".repeat(5) + "xYz"; // 43 base64url characters, like the old tokens
  it.each([
    [`/join/${OLD}`],
    [`/join/${OLD}/continue`],
    [`/join/greenfield-public-school/winter-trip/${OLD}`],
    [`/join/greenfield-public-school/winter-trip/${OLD}/continue`],
  ])("%s explains the link no longer works, offers to log in, and never sends the token anywhere", async (path) => {
    const be = createFakeAdmin({ signedIn: false });
    at(path);
    expect(await screen.findByRole("heading", { name: "This older link no longer works" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Log in to continue" })).toHaveAttribute("href", "/parent/login");
    expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();
    expect(be.calls()).toHaveLength(0);
  });
});

describe("school branch in the panel", () => {
  it("adds a school with a branch, sending the branch, and lists the branch (or 'No branch recorded')", async () => {
    const be = createFakeAdmin();
    be.addSchool({ name: "Old School" });
    const v = at("/admin/schools/new");
    await screen.findByRole("heading", { name: "Add a school" });
    expect(screen.getByLabelText("Branch")).toHaveAttribute("placeholder", "e.g. Kolkata Branch");
    await user.type(screen.getByLabelText("School name"), "Greenfield Public School");
    await user.type(screen.getByLabelText("Branch"), "Kolkata Branch");
    await user.click(screen.getByRole("button", { name: "Add school" }));
    expect(await screen.findByText("Branch: Kolkata Branch")).toBeInTheDocument();
    expect(be.calls(/POST \/api\/admin\/schools$/)[0].body).toEqual({ name: "Greenfield Public School", branch: "Kolkata Branch" });
    v.unmount();
    at("/admin/schools");
    const row = (await screen.findByRole("link", { name: "Greenfield Public School" })).closest("tr");
    expect(row).toHaveTextContent("Kolkata Branch");
    expect(screen.getByRole("link", { name: "Old School" }).closest("tr")).toHaveTextContent("No branch recorded");
  });

  it("the same school can be added for another branch; the same school and branch again is refused", async () => {
    const be = createFakeAdmin();
    be.addSchool({ name: "Greenfield", branch: "Kolkata" });
    const v = at("/admin/schools/new");
    await screen.findByRole("heading", { name: "Add a school" });
    await user.type(screen.getByLabelText("School name"), "Greenfield");
    await user.type(screen.getByLabelText("Branch"), "Delhi");
    await user.click(screen.getByRole("button", { name: "Add school" }));
    await waitFor(() => expect(be.state.schools).toHaveLength(2));
    v.unmount();
    at("/admin/schools/new");
    await screen.findByRole("heading", { name: "Add a school" });
    await user.type(screen.getByLabelText("School name"), "greenfield");
    await user.type(screen.getByLabelText("Branch"), "kolkata");
    await user.click(screen.getByRole("button", { name: "Add school" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A school with that name and branch already exists.");
  });

  it("an admin edits the branch on the school page; only the changed field is sent, and emptying it clears it", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool({ name: "Greenfield Public School" });
    at(`/admin/schools/${s.id}`);
    await screen.findByRole("heading", { name: /Greenfield Public School/ });
    expect(screen.getByText("No branch recorded.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit name and branch" }));
    await user.type(screen.getByLabelText("Branch"), "Salt Lake Branch");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Branch: Salt Lake Branch")).toBeInTheDocument();
    expect(be.calls(/PATCH .*schools/)[0].body).toEqual({ branch: "Salt Lake Branch" });
    await user.click(screen.getByRole("button", { name: "Edit name and branch" }));
    await user.clear(screen.getByLabelText("Branch"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("No branch recorded.")).toBeInTheDocument();
    expect(be.calls(/PATCH .*schools/)[1].body).toEqual({ branch: null });
  });

  it("the parents' public page does not show the branch, and its address has the branch as its own word", async () => {
    const KEY = "greenfield-public-school/kolkata-branch/winter-trip";
    const be = createFakeAdmin({ signedIn: false, joinResponses: { [KEY]: reply(200, info({ school: { name: "Greenfield Public School", branch: "Kolkata Branch" } })) } });
    at(`/join/${KEY}`);
    await screen.findByRole("link", { name: "Register or log in" });
    expect(screen.queryByText("Kolkata Branch")).not.toBeInTheDocument();
    expect(be.calls(/GET \/api\/join\//).map((c) => c.url)).toEqual([`/api/join/${KEY}`]);
  });

  it("the trip page's address uses the branch word", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool({ name: "Greenfield", branch: "Delhi" });
    const t = be.addTrip(s.id, { title: "Shimla" });
    at(`/admin/trips/${t.id}/links`);
    expect(await screen.findByLabelText("Registration page address")).toHaveValue("https://parents.example.test/join/greenfield/delhi/shimla");
  });

  it("the all-trips list and a trip's details name the school's branch", async () => {
    const be = createFakeAdmin();
    const s = be.addSchool({ name: "Greenfield", branch: "Delhi" });
    const t = be.addTrip(s.id, { title: "Shimla" });
    const v = at("/admin/trips");
    const row = (await screen.findByRole("link", { name: "Shimla" })).closest("tr");
    expect(row).toHaveTextContent("Greenfield · Delhi");
    v.unmount();
    at(`/admin/trips/${t.id}`);
    expect(await screen.findByText("Greenfield · Delhi")).toBeInTheDocument();
  });
});

describe("show / hide password on every staff password field", () => {
  const toggle = (name) => screen.getByRole("button", { name });

  it("staff login: masked by default, can be shown, and signing in works while shown", async () => {
    const be = createFakeAdmin({ signedIn: false });
    at("/admin");
    await screen.findByRole("heading", { name: "Admin log in" });
    const pw = screen.getByLabelText("Password");
    expect(pw).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("Email address"), "admin@example.com");
    await user.type(pw, "right-staff-password");
    await user.click(toggle("Show password"));
    expect(pw).toHaveAttribute("type", "text");
    expect(pw).toHaveAttribute("autocomplete", "current-password");
    await user.click(screen.getByRole("button", { name: /^Log in/ }));
    expect(await screen.findByRole("heading", { name: "Admin dashboard" })).toBeInTheDocument();
    expect(be.calls(/POST \/api\/admin\/auth\/login/)[0].body.password).toBe("right-staff-password");
  });

  it("first-time setup: new and confirm fields have independent toggles", async () => {
    createFakeAdmin({ signedIn: false });
    at("/admin");
    await screen.findByRole("heading", { name: "Admin log in" });
    await user.click(screen.getByRole("button", { name: "First time or forgot your password?" }));
    await user.type(screen.getByLabelText("Work email address"), "new.hire@example.com");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByRole("heading", { name: "Enter verification code" });
    await user.click(screen.getByLabelText("Digit 1 of 6"));
    await user.paste("123456");
    await user.click(screen.getByRole("button", { name: /Verify OTP/ }));
    await screen.findByRole("heading", { name: "Choose your password" });
    expect(screen.getByLabelText("New password")).toHaveAttribute("type", "password");
    await user.click(toggle("Show new password"));
    expect(screen.getByLabelText("New password")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Confirm new password")).toHaveAttribute("type", "password");
    await user.click(toggle("Show password confirmation"));
    expect(screen.getByLabelText("Confirm new password")).toHaveAttribute("type", "text");
  });

  it("change password: three independent toggles, and the change works with fields shown", async () => {
    const be = createFakeAdmin();
    at("/admin/password");
    await screen.findByRole("heading", { name: "Change password" });
    for (const label of ["Current password", "New password", "Confirm new password"]) expect(screen.getByLabelText(label)).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("Current password"), "right-staff-password");
    await user.type(screen.getByLabelText("New password"), "changed-pass-4321");
    await user.type(screen.getByLabelText("Confirm new password"), "changed-pass-4321");
    await user.click(toggle("Show current password"));
    expect(screen.getByLabelText("Current password")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("New password")).toHaveAttribute("type", "password");
    await user.click(toggle("Show new password"));
    await user.click(toggle("Show password confirmation"));
    expect(screen.getByLabelText("Confirm new password")).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(be.calls(/POST .*\/auth\/password$/)).toHaveLength(1));
    expect(be.calls(/POST .*\/auth\/password$/)[0].body).toEqual({ currentPassword: "right-staff-password", password: "changed-pass-4321", confirmPassword: "changed-pass-4321" });
  });
});

describe("regressions found while trying to break things", () => {
  it("after a successful password change the cleared fields are masked again, even if they were shown", async () => {
    createFakeAdmin();
    at("/admin/password");
    await screen.findByRole("heading", { name: "Change password" });
    await user.type(screen.getByLabelText("Current password"), "right-staff-password");
    await user.type(screen.getByLabelText("New password"), "changed-pass-4321");
    await user.type(screen.getByLabelText("Confirm new password"), "changed-pass-4321");
    await user.click(screen.getByRole("button", { name: "Show new password" }));
    expect(screen.getByLabelText("New password")).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Your password was changed.")).toBeInTheDocument();
    for (const label of ["Current password", "New password", "Confirm new password"]) {
      expect(screen.getByLabelText(label)).toHaveValue("");
      expect(screen.getByLabelText(label)).toHaveAttribute("type", "password");
    }
  });
});

describe("three separate experiences: role-aware sign-in and redirects", () => {
  const Here = () => <p data-testid="where">{useLocation().pathname}</p>;
  const visit = (path) => render(<MemoryRouter initialEntries={[path]}><AppRoutes /><Here /></MemoryRouter>);
  const where = () => screen.getByTestId("where").textContent;
  const signIn = async (email) => {
    await user.type(await screen.findByLabelText("Email address"), email);
    await user.type(screen.getByLabelText("Password"), "right-staff-password");
    await user.click(screen.getByRole("button", { name: /^Log in/ }));
  };

  it("a Sales account that signs in on the Admin log in page lands on the Sales dashboard", async () => {
    createFakeAdmin({ role: "sales", signedIn: false });
    visit("/admin/login");
    await screen.findByRole("heading", { name: "Admin log in" });
    await signIn("sales@example.com");
    expect(await screen.findByRole("heading", { name: "Sales dashboard" })).toBeInTheDocument();
    expect(where()).toBe("/sales/dashboard");
  });

  it("an Admin account that signs in on the Sales log in page lands on the Admin dashboard", async () => {
    createFakeAdmin({ role: "admin", signedIn: false });
    visit("/sales/login");
    await screen.findByRole("heading", { name: "Sales log in" });
    await signIn("admin@example.com");
    expect(await screen.findByRole("heading", { name: "Admin dashboard" })).toBeInTheDocument();
    expect(where()).toBe("/admin/dashboard");
  });

  it("an admin opening a Sales page sees 'This isn't your portal' and no sales data is requested", async () => {
    const be = createFakeAdmin({ role: "admin" });
    visit("/sales/schools");
    expect(await screen.findByRole("heading", { name: "This isn't your portal" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the Admin portal" })).toHaveAttribute("href", "/admin/dashboard");
    expect(be.calls(/GET \/api\/admin\/(schools|trips)/)).toHaveLength(0);
  });

  it("a salesperson opening an Admin page sees 'This isn't your portal' and no admin data is requested", async () => {
    const be = createFakeAdmin({ role: "sales" });
    visit("/admin/schools");
    expect(await screen.findByRole("heading", { name: "This isn't your portal" })).toBeInTheDocument();
    expect(be.calls(/GET \/api\/admin\/(schools|trips|staff)/)).toHaveLength(0);
  });

  it.each(["/sales", "/sales/dashboard", "/sales/schools/new", "/sales/trips/x/links"])("signed out, %s goes to the Sales log in", async (path) => {
    const be = createFakeAdmin({ signedIn: false });
    visit(path);
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
    expect(where()).toBe("/sales/login");
    expect(be.calls(/GET \/api\/admin\/(schools|trips)/)).toHaveLength(0);
  });

  it("a salesperson opening another salesperson's school or trip sees 'not found' and none of its data", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const theirs = be.addSchool({ name: "Not Yours School", createdBy: "someone.else@example.com" });
    const t = be.addTrip(theirs.id, { title: "Not Yours Trip" });
    const v = visit(`/sales/schools/${theirs.id}`);
    expect(await screen.findByRole("heading", { name: "School not found" })).toBeInTheDocument();
    expect(screen.queryByText("Not Yours School")).not.toBeInTheDocument();
    v.unmount();
    visit(`/sales/trips/${t.id}/links`);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/Not Yours Trip/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Registration page address")).not.toBeInTheDocument();
  });

  it("the Sales dashboard counts only the salesperson's own schools and trips and shows the workflow", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const mine = be.addSchool({ name: "Mine" });
    be.addTrip(mine.id, { status: "active", publicRegistration: true });
    be.addSchool({ name: "Theirs", createdBy: "someone.else@example.com" });
    visit("/sales/dashboard");
    await screen.findByRole("heading", { name: "Sales dashboard" });
    expect(await screen.findByText("Your schools")).toBeInTheDocument();
    const stat = (label) => screen.getByText(label).closest(".admin-stat").querySelector(".admin-stat-value").textContent;
    await waitFor(() => expect(stat("Your schools")).toBe("1"));
    expect(stat("Your trips")).toBe("1");
    expect(stat("Registration links live")).toBe("1");
    expect(screen.getByRole("heading", { name: "Set up a trip registration link" })).toBeInTheDocument();
  });

  it("parents have their own sign-in at /parent/login, with links to the staff portals for anyone who landed there by mistake", async () => {
    createFakeAdmin({ signedIn: false });
    visit("/parent/login");
    expect(await screen.findByRole("tab", { name: "Login", selected: true })).toBeInTheDocument();
    expect(screen.getByText(/Parent portal\. Young Edsplorer staff\?/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sales log in" })).toHaveAttribute("href", "/sales/login");
    expect(screen.getByRole("link", { name: "Admin log in" })).toHaveAttribute("href", "/admin/login");
    expect(screen.queryByRole("navigation", { name: /portal sections/ })).not.toBeInTheDocument();
  });

  it("the staff log in pages link to each other, and offer no parent log in (parents arrive through their trip link)", async () => {
    createFakeAdmin({ signedIn: false });
    const v = visit("/sales/login");
    await screen.findByRole("heading", { name: "Sales log in" });
    expect(screen.getByRole("link", { name: "Admin log in" })).toHaveAttribute("href", "/admin/login");
    expect(screen.queryByRole("link", { name: /Parent/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Parent\?/)).not.toBeInTheDocument();
    v.unmount();
    visit("/admin/login");
    await screen.findByRole("heading", { name: "Admin log in" });
    expect(screen.getByRole("link", { name: "Sales log in" })).toHaveAttribute("href", "/sales/login");
    expect(screen.queryByRole("link", { name: /Parent/ })).not.toBeInTheDocument();
  });

  it("an old /registrations/<id> address moves to /parent/registrations/<id>", async () => {
    createFakeBackend({ signedIn: false });
    visit("/registrations/00000000-0000-4000-9000-000000000001");
    await screen.findByRole("tab", { name: "Register" });
    expect(where()).toBe("/parent/registrations/00000000-0000-4000-9000-000000000001");
  });
});


describe("entry points: / is the Sales portal, /admin the Admin portal, parents only via their own routes and trip links", () => {
  const Here = () => <p data-testid="where">{useLocation().pathname}</p>;
  const visit = (path) => render(<MemoryRouter initialEntries={[path]}><AppRoutes /><Here /></MemoryRouter>);
  const where = () => screen.getByTestId("where").textContent;
  const SUBMITTED = { tourType: "domestic", role: "student", status: "submitted", data: { fullName: "Asha Rao" }, currentSection: "review", version: 4, updatedAt: "2026-10-01T00:00:00.000Z", submittedAt: "2026-10-01T00:00:00.000Z" };
  const TRIP = { address: { school: "sunrise-academy", branch: "main", trip: "shimla" }, school: "Sunrise Academy", title: "Shimla", destination: "Himachal Pradesh", tourType: "domestic" };

  it("1. / in a fresh browser shows the Sales log in, never the parent form", async () => {
    const be = createFakeAdmin({ signedIn: false });
    visit("/");
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
    expect(where()).toBe("/sales/login");
    expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();
    expect(be.calls(/\/api\/(auth\/session|onboarding|enrolments)/)).toHaveLength(0); // the parent session is not even looked at
  });

  it("2. / with a Sales session shows the Sales dashboard", async () => {
    createFakeAdmin({ role: "sales" });
    visit("/");
    expect(await screen.findByRole("heading", { name: "Sales dashboard" })).toBeInTheDocument();
    expect(where()).toBe("/sales/dashboard");
  });

  it("3. / with a parent session (and a submitted registration) shows the Sales log in, never the parent's registration", async () => {
    const be = createFakeBackend({ signedIn: true, form: SUBMITTED });
    be.queue("GET /api/admin/auth/session", apiError(401, "UNAUTHENTICATED")); // no staff session
    visit("/");
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Registration submitted" })).not.toBeInTheDocument();
    expect(screen.queryByText("Asha Rao")).not.toBeInTheDocument();
    expect(be.calls("GET /api/onboarding")).toHaveLength(0);
    expect(be.calls("GET /api/enrolments/resume")).toHaveLength(0);
    // and no general parent entry point on the staff log in (parents use their trip link)
    expect(screen.queryByRole("link", { name: /Parent/ })).not.toBeInTheDocument();
  });

  it("4. /admin signed out shows the Admin log in", async () => {
    createFakeAdmin({ signedIn: false });
    visit("/admin");
    expect(await screen.findByRole("heading", { name: "Admin log in" })).toBeInTheDocument();
    expect(where()).toBe("/admin/login");
  });

  it("5. /admin signed in as Admin shows the Admin dashboard", async () => {
    createFakeAdmin({ role: "admin" });
    visit("/admin");
    expect(await screen.findByRole("heading", { name: "Admin dashboard" })).toBeInTheDocument();
    expect(where()).toBe("/admin/dashboard");
  });

  it("6. /sales/login shows the Sales log in", async () => {
    createFakeAdmin({ signedIn: false });
    visit("/sales/login");
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
  });

  it("7. a trip registration link opens that school's and trip's parent registration", async () => {
    const be = createFakeBackend({ join: TRIP });
    visit("/join/sunrise-academy/main/shimla");
    await screen.findByRole("link", { name: "Register or log in" });
    expect(screen.getByText("Shimla", { selector: "dd" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Register or log in" }));
    await screen.findByRole("tab", { name: "Register" });
    expect(screen.queryByText(/Registering for|Logging in for/)).not.toBeInTheDocument();
    expect(where()).toBe("/join/sunrise-academy/main/shimla/continue");
    expect(be.calls(/\/api\/admin\//)).toHaveLength(0);
  });

  it("8. signing in as a parent from a trip link stays on that trip and joins THAT trip", async () => {
    const be = createFakeBackend({ join: TRIP, accounts: ["parent@example.com"], passwords: { "parent@example.com": PASSWORD } });
    visit("/join/sunrise-academy/main/shimla/continue");
    await user.click(await screen.findByRole("tab", { name: "Login" }));
    await user.type(screen.getByLabelText(/email address/i), "parent@example.com");
    await user.type(screen.getByLabelText(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /^Log in/ }));
    await screen.findByRole("group", { name: "Your school's trip" });
    expect(be.calls("POST /api/enrolments")[0].body).toEqual({ trip: TRIP.address });
    expect(where()).toBe("/join/sunrise-academy/main/shimla/continue");
  });

  it("parents have their own portal at /parent and /parent/login (where a signed-in parent's registration opens)", async () => {
    const be = createFakeBackend({ signedIn: true, form: SUBMITTED });
    const v = visit("/parent");
    expect(await screen.findByRole("heading", { name: "Registration submitted" })).toBeInTheDocument();
    v.unmount();
    createFakeBackend({ signedIn: false });
    visit("/parent/login");
    expect(await screen.findByRole("tab", { name: "Login", selected: true })).toBeInTheDocument();
    expect(be.calls(/\/api\/admin\//)).toHaveLength(0);
  });

  it("links for parents never point at the Sales homepage: 'Log in to continue' and old /registrations go to the parent portal", async () => {
    createFakeAdmin({ signedIn: false });
    const v = visit("/join/no-such-school/main/no-trip");
    expect(await screen.findByRole("link", { name: "Log in to continue" })).toHaveAttribute("href", "/parent/login");
    v.unmount();
    const v2 = visit("/join/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAa_");
    expect(await screen.findByRole("link", { name: "Log in to continue" })).toHaveAttribute("href", "/parent/login");
    v2.unmount();
    createFakeBackend({ signedIn: false });
    visit("/registrations");
    await screen.findByRole("tab", { name: "Register" });
    expect(where()).toBe("/parent");
  });

  it("an unknown address shows 'Page not found' (not the parent portal) with links to each portal", async () => {
    createFakeAdmin({ signedIn: false });
    visit("/something/else");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sales portal" })).toHaveAttribute("href", "/sales");
    expect(screen.getByRole("link", { name: "Admin portal" })).toHaveAttribute("href", "/admin");
    expect(screen.getByRole("link", { name: "Parent log in" })).toHaveAttribute("href", "/parent/login");
  });
});

describe("presentation clean-up (Sales and Admin)", () => {
  it("Sales 'My schools' has no Show archived control and asks only for its active schools (nothing is changed)", async () => {
    const be = createFakeAdmin({ role: "sales" });
    be.addSchool();
    at("/sales/schools");
    expect(await screen.findByRole("heading", { name: "My schools" })).toBeInTheDocument();
    await screen.findByRole("link", { name: "Greenfield Public School" });
    expect(screen.queryByLabelText("Show archived")).not.toBeInTheDocument();
    expect(be.calls(/GET \/api\/admin\/schools/).map((c) => c.url)).toEqual(["/api/admin/schools"]);
    expect(be.calls(/(PATCH|DELETE|POST) \/api\/admin\/schools/)).toHaveLength(0);
  });

  it("Admin 'Schools' keeps Show archived", async () => {
    const be = createFakeAdmin({ role: "admin" });
    be.addSchool();
    at("/admin/schools");
    await screen.findByRole("heading", { name: "Schools" });
    expect(screen.getByLabelText("Show archived")).toBeInTheDocument();
  });

  it("the dashboard has no 'Signed in as' line; who is signed in stays in the header", async () => {
    createFakeAdmin({ role: "sales" });
    at("/sales/dashboard");
    await screen.findByRole("heading", { name: "Sales dashboard" });
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Your account" })).getByText("Sam Sales")).toBeInTheDocument();
  });

  it("the staff header shows the official Young Edsplorer logo file (the same one as the sign-in screens)", async () => {
    createFakeAdmin({ role: "sales" });
    at("/sales/dashboard");
    await screen.findByRole("heading", { name: "Sales dashboard" });
    const logo = within(screen.getByRole("banner")).getByAltText("Young Edsplorer");
    expect(logo).toHaveAttribute("src", "/company_logo.png");
    expect(logo).toHaveAttribute("width", "1487"); // its real proportions, so the browser never distorts it
    expect(logo).toHaveAttribute("height", "455");
  });
});

describe("trip page: choosing the live-location team lead", () => {
  const CANDIDATES = [
    { enrolmentId: "00000000-0000-4000-9000-0000000000a1", name: "Tara Lead", email: "tara@example.com" },
    { enrolmentId: "00000000-0000-4000-9000-0000000000a2", name: "Ravi Lead", email: "ravi@example.com" },
  ];

  it("Sales sees the trip's Team Leader registrations, chooses one and saves (only that trip, only a Team Leader)", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const s = be.addSchool();
    const t = be.addTrip(s.id, { status: "active" });
    be.state.live[t.id] = { state: "not_started", location: null, teamLeadEnrolmentId: null, candidates: CANDIDATES, policy: { updateIntervalSeconds: 300, staleAfterSeconds: 720 } };
    at(`/sales/trips/${t.id}`);
    const card = await screen.findByRole("region", { name: "Live location" });
    expect(await within(card).findByText(/Not sharing/)).toBeInTheDocument();
    await user.selectOptions(within(card).getByLabelText("Team lead"), "00000000-0000-4000-9000-0000000000a2");
    await user.click(within(card).getByRole("button", { name: "Save team lead" }));
    expect(await within(card).findByText("Team lead saved.")).toBeInTheDocument();
    const put = be.calls(/PUT .*live-location\/team-lead$/);
    expect(put).toHaveLength(1);
    expect(put[0].body).toEqual({ enrolmentId: "00000000-0000-4000-9000-0000000000a2" });
    expect(within(card).getByText(/team lead Ravi Lead/)).toBeInTheDocument();
  });

  it("with no Team Leader registered yet, it says how to get one (and offers no choice)", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const s = be.addSchool();
    const t = be.addTrip(s.id, { status: "active" });
    at(`/sales/trips/${t.id}`);
    const card = await screen.findByRole("region", { name: "Live location" });
    expect(await within(card).findByText(/Nobody has registered for this trip as a Team Leader yet/)).toBeInTheDocument();
    expect(within(card).queryByLabelText("Team lead")).not.toBeInTheDocument();
  });
});
