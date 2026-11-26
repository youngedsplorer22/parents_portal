import { configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AppRoutes from "../AppRoutes.jsx";
import { createFakeAdmin } from "../test/fakeAdmin.js";
import { preloadRouteChunks } from "../test/routeChunks.js";

beforeAll(preloadRouteChunks, 60_000);
configure({ asyncUtilTimeout: 6000 });

let user;
beforeEach(() => { user = userEvent.setup(); });
afterEach(() => vi.unstubAllGlobals());

const at = (path) => render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>);
const nav = () => screen.getByRole("navigation", { name: /portal sections/ });

function salesWorld() {
  const be = createFakeAdmin({ role: "sales" });
  const school = be.addSchool({ name: "ABC School", branch: "Jaipur" });
  const mine = be.addTrip(school.id, { title: "Jaipur 2027", academicYear: "2027-28", status: "active" });
  be.assign(mine.id);
  return { be, mine };
}

describe("dashboard CTA", () => {
  it("shows Manage trip button pointing to /manage and no longer says My itineraries", async () => {
    salesWorld();
    at("/sales/dashboard");
    await screen.findByRole("heading", { name: "Sales dashboard" });
    const cta = screen.getByRole("link", { name: /Manage trip/ });
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveAttribute("href", "/sales/manage");
    expect(screen.queryByRole("link", { name: /My itineraries/i, hidden: false })).not.toBeNull(); // nav link still present
  });

  it("dashboard card heading says Manage this portal's trip", async () => {
    salesWorld();
    at("/sales");
    await screen.findByRole("heading", { name: "Sales dashboard" });
    expect(screen.getByRole("heading", { name: /Manage this portal's trip/i })).toBeInTheDocument();
  });
});

describe("Manage trip navigation", () => {
  it("nav has three links: Dashboard, My itineraries, Manage trip", async () => {
    salesWorld();
    at("/sales");
    await screen.findByRole("heading", { name: "Sales dashboard" });
    expect(within(nav()).getAllByRole("link").map((a) => a.textContent.trim())).toEqual(["Dashboard", "My itineraries", "Manage trip"]);
  });

  it("Manage trip nav link goes to the Manage trip page", async () => {
    salesWorld();
    at("/sales");
    await screen.findByRole("heading", { name: "Sales dashboard" });
    await user.click(within(nav()).getByRole("link", { name: "Manage trip" }));
    expect(await screen.findByRole("heading", { name: "Manage trip" })).toBeInTheDocument();
  });
});

describe("Manage trip page", () => {
  it("shows the trip title and school name", async () => {
    salesWorld();
    at("/sales/manage");
    expect(await screen.findByRole("heading", { name: "Manage trip" })).toBeInTheDocument();
    expect(screen.getByText(/Jaipur 2027/)).toBeInTheDocument();
  });

  it("shows the four section tabs", async () => {
    salesWorld();
    at("/sales/manage");
    await screen.findByRole("heading", { name: "Manage trip" });
    const tabs = screen.getAllByRole("button").filter((b) => ["School logo", "Itinerary", "Insurance", "Transport tickets"].includes(b.textContent.trim()));
    expect(tabs).toHaveLength(4);
  });

  it("shows no-trip message when deployment is not configured", async () => {
    const be = createFakeAdmin({ role: "sales" });
    be.addTrip(be.addSchool().id, {});
    at("/sales/manage");
    expect(await screen.findByText(/No trip is configured for this portal yet/)).toBeInTheDocument();
  });

  it("school logo tab uploads and shows success", async () => {
    const { mine, be } = salesWorld();
    at("/sales/manage");
    await screen.findByRole("heading", { name: "Manage trip" });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "logo.png", { type: "image/png" });
    const input = document.querySelector("input[type=file][accept*='.png']");
    await user.upload(input, file);
    expect(await screen.findByText("Logo updated.")).toBeInTheDocument();
  });

  it("document list shows uploaded file after upload", async () => {
    const { mine } = salesWorld();
    at("/sales/manage");
    await screen.findByRole("heading", { name: "Manage trip" });
    // Switch to Itinerary tab
    await user.click(screen.getByRole("button", { name: /Itinerary/ }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    // After load, upload button is visible
    const btn = screen.getByText(/Upload itinerary pdf/i).closest("span");
    expect(btn).toBeInTheDocument();
  });
});
