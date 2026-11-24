import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AppRoutes from "../AppRoutes.jsx";
import { createFakeAdmin } from "../test/fakeAdmin.js";
import { preloadRouteChunks } from "../test/routeChunks.js";

// Load the lazy route chunks outside the timed assertions (see test/routeChunks.js).
beforeAll(preloadRouteChunks, 60_000);

// Sales are itinerary-only: they see the single trip the deployment is configured for and add and edit itinerary items. There is no
// admin portal. The server enforces all of it (see the API tests); these tests are about what a Sales person sees and sends.
// The staff app is a lazy chunk: the first render in a file can take longer than the 1 s default on a busy machine.
configure({ asyncUtilTimeout: 6000 });

let user;
beforeEach(() => {
  user = userEvent.setup();
});
afterEach(() => vi.unstubAllGlobals());

const at = (path) => render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>);
const nav = () => screen.getByRole("navigation", { name: /portal sections/ });
const post = (be) => be.calls(/POST \/api\/admin\/trips\/[^/]+\/itinerary$/);

function salesWorld() {
  const be = createFakeAdmin({ role: "sales" });
  const school = be.addSchool({ name: "ABC School", branch: "Jaipur" });
  const mine = be.addTrip(school.id, { title: "Jaipur 2027", academicYear: "2027-28", status: "active" });
  const other = be.addTrip(school.id, { title: "Goa 2027" });
  be.assign(mine.id);
  return { be, mine, other };
}

describe("the Sales portal is itinerary only", () => {
  it("its top bar has Dashboard and My itineraries, nothing to create or configure", async () => {
    salesWorld();
    at("/sales");
    await screen.findByRole("heading", { name: "Sales dashboard" });
    expect(within(nav()).getAllByRole("link").map((a) => a.textContent.trim())).toEqual(["Dashboard", "My itineraries"]);
    expect(screen.queryByRole("link", { name: /Create a tour/ })).not.toBeInTheDocument();
  });

  it("its dashboard counts the deployment-configured trip", async () => {
    salesWorld();
    at("/sales/dashboard");
    await screen.findByRole("heading", { name: "Sales dashboard" });
    const stat = screen.getByText("Configured trips").closest(".admin-stat").querySelector(".admin-stat-value");
    await waitFor(() => expect(stat.textContent).toBe("1"));
  });

  it("schools, trips, Create a tour and live location have no screen in the Sales portal, and nothing is asked of the server", async () => {
    const { be, mine } = salesWorld();
    for (const path of ["/sales/schools", "/sales/schools/new", "/sales/trips", `/sales/trips/${mine.id}`, `/sales/trips/${mine.id}/links`, "/sales/tours/new", "/sales/staff"]) {
      const view = at(path);
      expect(await screen.findByRole("heading", { name: "Page not found" }), path).toBeInTheDocument();
      view.unmount();
    }
    expect(be.calls(/\/api\/admin\/(schools|trips)(\/|\?|$)(?!.*itinerary)/).filter((c) => !/itinerary/.test(c.url))).toHaveLength(0);
  });
});

describe("My itineraries", () => {
  it("lists only the deployment-configured trip, with school, year and status, and links to its itinerary", async () => {
    const { mine } = salesWorld();
    at("/sales/itineraries");
    const table = await screen.findByRole("table", { name: "Trips with an itinerary" });
    const row = within(table).getByRole("row", { name: /Jaipur 2027/ });
    expect(row).toHaveTextContent(/ABC School.*Jaipur.*2027-28.*active/);
    expect(within(row).getByRole("link", { name: "Jaipur 2027" })).toHaveAttribute("href", `/sales/itineraries/${mine.id}`);
    expect(within(table).queryByText("Goa 2027")).not.toBeInTheDocument();
  });

  it("says so, and offers nothing else, when no trip is configured for this portal", async () => {
    const be = createFakeAdmin({ role: "sales" });
    be.addTrip(be.addSchool().id, {});
    at("/sales/itineraries");
    expect(await screen.findByText(/No trip is configured for this portal yet/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("an itinerary", () => {
  it("shows its items by day, and adding one sends exactly the day, title and details", async () => {
    const { be, mine } = salesWorld();
    at(`/sales/itineraries/${mine.id}`);
    expect(await screen.findByText(/Nothing added yet/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Day"), "2");
    await user.type(screen.getByLabelText("Title"), "Amer Fort");
    await user.type(screen.getByLabelText("Details (optional)"), "Morning visit.");
    await user.click(screen.getByRole("button", { name: "Add to itinerary" }));
    expect(await screen.findByText("Day 2: Amer Fort")).toBeInTheDocument();
    expect(screen.getByText("Morning visit.")).toBeInTheDocument();
    expect(post(be)).toHaveLength(1);
    expect(post(be)[0].body).toEqual({ dayNumber: 2, title: "Amer Fort", details: "Morning visit." });
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });

  it("refuses a missing or bad day and an empty title on the screen, with a message each, and sends nothing", async () => {
    const { be, mine } = salesWorld();
    at(`/sales/itineraries/${mine.id}`);
    await screen.findByText(/Nothing added yet/);
    await user.click(screen.getByRole("button", { name: "Add to itinerary" }));
    expect(screen.getByText("Enter the day as a whole number from 1 to 366.")).toBeInTheDocument();
    expect(screen.getByText("Enter a title for this item.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Day"), "400");
    await user.type(screen.getByLabelText("Title"), "x");
    await user.click(screen.getByRole("button", { name: "Add to itinerary" }));
    expect(screen.getByText("Enter the day as a whole number from 1 to 366.")).toBeInTheDocument();
    expect(post(be)).toHaveLength(0);
  });

  it("editing an item keeps what was typed when the server refuses, and saves with PATCH when it accepts", async () => {
    const { be, mine } = salesWorld();
    be.state.itinerary[mine.id] = [{ id: "00000000-0000-4000-8000-0000000000b1", tripId: mine.id, dayNumber: 1, position: 0, title: "Arrive", details: null, createdAt: "x", updatedAt: "x" }];
    at(`/sales/itineraries/${mine.id}`);
    await user.click(await screen.findByRole("button", { name: "Edit day 1: Arrive" }));
    const title = screen.getByLabelText("Title", { selector: "[id^=edit-title]" });
    await user.clear(title);
    await user.type(title, "Arrive and check in");
    be.queue(`PATCH /api/admin/trips/${mine.id}/itinerary/00000000-0000-4000-8000-0000000000b1`, new Response(JSON.stringify({ error: { code: "SERVER_ERROR" } }), { status: 500, headers: { "content-type": "application/json" } }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(title).toHaveValue("Arrive and check in");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Day 1: Arrive and check in")).toBeInTheDocument();
    const patch = be.calls(/PATCH .*itinerary\//);
    expect(patch[patch.length - 1].body).toEqual({ dayNumber: 1, title: "Arrive and check in", details: null });
    expect(post(be)).toHaveLength(0);
  });

  it("a trip that is not assigned shows the server's refusal and none of the form", async () => {
    const { other } = salesWorld();
    at(`/sales/itineraries/${other.id}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to do that.");
    expect(screen.queryByRole("button", { name: "Add to itinerary" })).not.toBeInTheDocument();
    expect(screen.queryByText("Goa 2027")).not.toBeInTheDocument();
  });
});
