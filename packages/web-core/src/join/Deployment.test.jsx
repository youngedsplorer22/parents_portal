import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import AppRoutes from "../AppRoutes.jsx";
import { createFakeAdmin } from "../test/fakeAdmin.js";
import { createFakeBackend } from "../test/fakeBackend.js";
import { reply } from "../test/helpers.js";
import { preloadRouteChunks } from "../test/routeChunks.js";

// Load the lazy route chunks outside the timed assertions (see test/routeChunks.js).
beforeAll(preloadRouteChunks, 60_000);

// A public portal is customised for ONE school and trip (its deployment configuration). Its link for any other school's trip,
// an old school's included, must say "closed or unavailable" and show nothing of either school, whatever the server knows.
afterEach(() => vi.unstubAllGlobals());

const DEPLOYMENT = { school: "abc-school", branch: "main", trip: "jaipur-2027", schoolName: "ABC School", tripTitle: "Jaipur Heritage Tour", destination: "Jaipur", logo: null };
const KEY = "abc-school/main/jaipur-2027";
const OLD_KEY = "old-school/main/goa-2026"; // the school this template served before
const info = (name, title, over = {}) => ({ school: { name }, trip: { title, destination: "Goa", tourType: "domestic" }, registrationOpen: true, ...over });
const at = (path, deployment = DEPLOYMENT, target = "domestic-free") =>
  render(<MemoryRouter initialEntries={[path]}><AppRoutes target={target} deployment={deployment} /></MemoryRouter>);
const CLOSED = /closed or no longer available/i;

describe("the trip this portal was customised for", () => {
  it("shows the developer's school name and trip title, with registration as the server says", async () => {
    createFakeAdmin({ joinResponses: { [KEY]: reply(200, info("ABC School (from the database)", "DB title")) } });
    at(`/join/${KEY}`);
    expect(await screen.findByRole("link", { name: "Register or log in" })).toBeInTheDocument();
    expect(screen.getByText("Jaipur Heritage Tour")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /in partnership with ABC School/ })).toBeInTheDocument();
    expect(screen.queryByText(/from the database/)).not.toBeInTheDocument();
  });

  it("the server still decides: closed there means closed here", async () => {
    createFakeAdmin({ joinResponses: { [KEY]: reply(200, info("ABC School", "Jaipur", { registrationOpen: false })) } });
    at(`/join/${KEY}`);
    expect(await screen.findByText(/isn't open for this trip right now/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Register or log in" })).not.toBeInTheDocument();
  });

  it("the root of the portal goes to its own trip page", async () => {
    createFakeAdmin({ joinResponses: { [KEY]: reply(200, info("ABC School", "Jaipur")) } });
    at("/");
    expect(await screen.findByRole("link", { name: "Register or log in" })).toBeInTheDocument();
    expect(screen.getByText("Jaipur Heritage Tour")).toBeInTheDocument();
  });
});

describe("an old school's link on a portal that now serves another school", () => {
  it("says it is closed or unavailable, names neither school, offers no form, and doesn't even ask the server", async () => {
    const be = createFakeAdmin({ joinResponses: { [OLD_KEY]: reply(200, info("Old School", "Goa 2026")) } });
    at(`/join/${OLD_KEY}`);
    expect(await screen.findByText(CLOSED)).toBeInTheDocument();
    for (const text of [/ABC School/, /Old School/, /Jaipur/, /Goa/]) expect(screen.queryByText(text)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Register or log in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();
    expect(be.calls(/\/api\/join/)).toHaveLength(0);
  });

  it("the continue page (register or log in for that trip) is refused the same way", async () => {
    createFakeAdmin({ joinResponses: { [OLD_KEY]: reply(200, info("Old School", "Goa 2026")) } });
    at(`/join/${OLD_KEY}/continue`);
    expect(await screen.findByText(CLOSED)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Email address/)).not.toBeInTheDocument();
  });

  it("near misses are refused: another trip of the same school, another branch, other letters", async () => {
    createFakeAdmin({});
    for (const path of ["abc-school/main/jaipur-2028", "abc-school/north/jaipur-2027", "abc-school/main/jaipur-2027-2", "abcschool/main/jaipur-2027"]) {
      const v = at(`/join/${path}`);
      expect(await screen.findByText(CLOSED), path).toBeInTheDocument();
      v.unmount();
    }
  });
});

describe("a portal nobody has customised yet", () => {
  it("shows 'not set up' and no form, on its root and on any trip address", async () => {
    const be = createFakeAdmin({ joinResponses: { [KEY]: reply(200, info("ABC School", "Jaipur")) } });
    for (const path of ["/", `/join/${KEY}`, `/join/${KEY}/continue`]) {
      const v = at(path, null);
      expect(await screen.findByText(/isn't set up yet/i), path).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Register or log in" })).not.toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();
      v.unmount();
    }
    expect(be.calls(/\/api\/join/)).toHaveLength(0);
  });

  it("an incomplete configuration counts as not set up", async () => {
    createFakeAdmin({});
    at("/", { ...DEPLOYMENT, schoolName: "" });
    expect(await screen.findByText(/isn't set up yet/i)).toBeInTheDocument();
  });
});

describe("returning parents keep their own records, branded by their own registration", () => {
  it("/parent/login still works on any customised portal", async () => {
    createFakeAdmin({});
    at("/parent/login");
    expect(await screen.findByRole("tab", { name: "Login" })).toBeInTheDocument();
  });

  it("a parent registered for the OLD school opens their own dashboard, with the old school's and trip's details, not the portal's", async () => {
    const OLD = { address: { school: "old-school", branch: "main", trip: "goa-2026" }, school: "Old School", title: "Goa 2026", destination: "Goa", tourType: "domestic", paymentMode: "none" };
    const be = createFakeBackend({ signedIn: true, join: OLD });
    be.state.trip = OLD;
    be.state.form = { tourType: "domestic", role: "student", status: "submitted", data: { fullName: "Asha Rao" }, currentSection: "review", version: 3, updatedAt: "2026-10-01T00:00:00.000Z", submittedAt: "2026-10-02T00:00:00.000Z" };
    be.state.currentId = "11111111-1111-4111-8111-111111111111";
    at("/parent", DEPLOYMENT);
    expect(await screen.findByRole("heading", { name: "Registration submitted" })).toBeInTheDocument();
    const trip = within(screen.getByRole("region", { name: "Trip details" }));
    expect(trip.getByText("Old School")).toBeInTheDocument();
    expect(trip.getByText("Trip").nextSibling).toHaveTextContent("Goa 2026");
    expect(document.body.textContent).not.toMatch(/ABC School|Jaipur Heritage/);
  });
});

describe("school logos across a portal's life: school A registers, then the portal is customised for school B", () => {
  const A_LOGO = "/assets/old-school-1a2b3c.png";
  const B_LOGO = "/assets/abc-school-4d5e6f.png";
  const OLD = { address: { school: "old-school", branch: "main", trip: "goa-2026" }, school: "Old School", title: "Goa 2026", destination: "Goa", tourType: "domestic", paymentMode: "none" };
  const NEW = { address: { school: "abc-school", branch: "main", trip: "jaipur-2027" }, school: "ABC School", title: "Jaipur Heritage Tour", destination: "Jaipur", tourType: "domestic", paymentMode: "none" };
  // The portal now built for school B. Its map keeps school A's logo as well, because the repository keeps every school's logo.
  const WITH_BOTH = { ...DEPLOYMENT, schoolLogos: { "old-school/main": A_LOGO, "abc-school/main": B_LOGO } };
  const ONLY_NEW = { ...DEPLOYMENT, schoolLogos: { "abc-school/main": B_LOGO } };

  const signedIn = (trip) => {
    const be = createFakeBackend({ signedIn: true, join: trip });
    be.state.trip = trip;
    be.state.form = { tourType: "domestic", role: "student", status: "submitted", data: { fullName: "Asha Rao" }, currentSection: "review", version: 3, updatedAt: "2026-10-01T00:00:00.000Z", submittedAt: "2026-10-02T00:00:00.000Z" };
    be.state.currentId = "11111111-1111-4111-8111-111111111111";
    return be;
  };
  const header = async () => {
    await screen.findByRole("heading", { name: "Registration submitted" });
    return document.querySelector(".portal-header, header") ?? document.body;
  };
  const logoSources = () => [...document.querySelectorAll(".school-logo img")].map((i) => i.getAttribute("src"));

  it("school A's participant still sees school A's logo and name, and school B's logo appears nowhere on their record", async () => {
    signedIn(OLD);
    at("/parent", WITH_BOTH);
    await header();
    expect(logoSources()).toEqual([A_LOGO]);
    expect(screen.getByRole("img", { name: "Old School logo" })).toHaveAttribute("src", A_LOGO);
    expect(document.body.innerHTML).not.toContain(B_LOGO);
    expect(document.body.textContent).not.toMatch(/ABC School/);
  });

  it("school B's participant sees school B's logo, and not school A's", async () => {
    signedIn(NEW);
    at("/parent", WITH_BOTH);
    await header();
    expect(logoSources()).toEqual([B_LOGO]);
    expect(document.body.innerHTML).not.toContain(A_LOGO);
  });

  it("if school A's logo were missing from the map, school A's participant gets the neutral placeholder, never school B's logo", async () => {
    signedIn(OLD);
    at("/parent", ONLY_NEW);
    await header();
    expect(logoSources()).toEqual([]);
    expect(screen.getByRole("img", { name: /Old School logo \(not available yet\)/ })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(B_LOGO);
  });

  it("a logo the server still holds for school A is used when the portal's map has none, and the map wins when it has one", async () => {
    signedIn({ ...OLD, schoolLogo: "/api/school-logos/old-school/main?v=7" });
    at("/parent", ONLY_NEW);
    await header();
    expect(logoSources()).toEqual(["/api/school-logos/old-school/main?v=7"]);
  });

  it("the registration page of the current school shows that school's logo from the map, never another school's", async () => {
    createFakeAdmin({ joinResponses: { [KEY]: reply(200, info("ABC School", "Jaipur Heritage Tour")) } });
    at(`/join/${KEY}`, WITH_BOTH);
    expect(await screen.findByRole("link", { name: "Register or log in" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "ABC School logo" })).toHaveAttribute("src", B_LOGO);
    expect(document.body.innerHTML).not.toContain(A_LOGO);
  });
});
