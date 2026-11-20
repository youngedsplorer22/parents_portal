import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import AppRoutes from "./AppRoutes.jsx";
import PortalHeader from "./components/PortalHeader.jsx";
import { safeLogo } from "./api/onboardingApi.js";
import { createFakeAdmin } from "./test/fakeAdmin.js";
import { createFakeBackend } from "./test/fakeBackend.js";
import { reply } from "./test/helpers.js";
import { preloadRouteChunks } from "./test/routeChunks.js";

// Load the lazy route chunks outside the timed assertions (see test/routeChunks.js).
beforeAll(preloadRouteChunks, 60_000);

afterEach(() => vi.unstubAllGlobals());
const at = (path) => render(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>);
const LOGO = "/api/school-logos/greenfield-public-school/kolkata?v=1730000000000";

describe("co-branded header: Young Edsplorer × school", () => {
  it("shows the Young Edsplorer logo, a subtle × and the school's logo, announced as a partnership", () => {
    render(<PortalHeader schoolName="Greenfield Public School" schoolLogo={LOGO} />);
    const brands = screen.getByRole("group", { name: "Young Edsplorer in partnership with Greenfield Public School" });
    const imgs = within(brands).getAllByRole("img");
    expect(imgs.map((i) => i.getAttribute("alt") ?? i.getAttribute("aria-label"))).toEqual(["Young Edsplorer", "Greenfield Public School logo"]);
    expect(imgs[1]).toHaveAttribute("src", LOGO);
    const cross = brands.querySelector(".portal-cross");
    expect(cross).toHaveTextContent("×");
    expect(cross).toHaveAttribute("aria-hidden", "true");
    expect(cross.tagName).not.toBe("BUTTON"); // a separator, never something that looks clickable
  });

  it("without an ERP logo yet, shows a neutral empty placeholder (no image, no fake logo)", () => {
    render(<PortalHeader schoolName="Greenfield Public School" schoolLogo={null} />);
    const slot = screen.getByRole("img", { name: "Greenfield Public School logo (not available yet)" });
    expect(slot.tagName).toBe("SPAN");
    expect(slot).toHaveClass("school-logo", "is-empty");
    expect(slot.querySelector("img")).toBeNull();
    expect(slot).toHaveTextContent("School logo");
    expect(document.querySelector(".portal-cross")).toHaveTextContent("×");
  });

  it("a school logo that fails to load turns into the placeholder, never a broken image", () => {
    render(<PortalHeader schoolName="Greenfield" schoolLogo={LOGO} />);
    fireEvent.error(screen.getByAltText("Greenfield logo"));
    expect(screen.queryByAltText("Greenfield logo")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Greenfield logo (not available yet)" })).toHaveClass("is-empty");
  });

  it("with no school at all (e.g. a staff page), only the Young Edsplorer logo and no ×", () => {
    render(<PortalHeader />);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(document.querySelector(".portal-cross")).toBeNull();
  });

  it("the stylesheet sizes both slots from one height, keeps aspect ratios, and scales down on small screens", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { cwd } = await import("node:process");
    const css = readFileSync(resolve(cwd(), "src/index.css"), "utf8");
    const rule = (sel) => (css.match(new RegExp(`\\n${sel.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`)) ?? [])[1] ?? "";
    expect(rule(".portal-brands")).toMatch(/--brand-h:/);
    expect(rule(".portal-logo")).toMatch(/height:\s*var\(--brand-h\)/);
    expect(rule(".portal-logo")).toMatch(/object-fit:\s*contain/);
    expect(rule(".school-logo")).toMatch(/height:\s*var\(--brand-h\)/);
    expect(rule(".school-logo img")).toMatch(/object-fit:\s*contain/);
    expect(rule(".school-logo img")).toMatch(/max-width:\s*100%/);
    expect(css).toMatch(/@media \(max-width: 480px\) \{[^}]*\.portal-brands \{[^}]*--brand-h:/);
    // The placeholder's words wrap inside their frame instead of being cut off on phones (found in a real browser).
    expect(rule(".school-logo.is-empty")).not.toMatch(/white-space:\s*nowrap/);
    expect(rule(".school-logo.is-empty")).toMatch(/text-align:\s*center/);
  });

  it("only the server's own logo address is ever used as an image source", () => {
    expect(safeLogo(LOGO)).toBe(LOGO);
    for (const bad of ["https://evil.example/x.png", "javascript:alert(1)", "/api/school-logos/../../x", "data:image/png;base64,AAAA", 42, null]) {
      expect(safeLogo(bad)).toBeNull();
    }
  });
});

describe("the school logo for parents", () => {
  it("the registration form header shows the school's logo from the server", async () => {
    const trip = { address: { school: "greenfield-public-school", branch: "kolkata", trip: "winter" }, school: "Greenfield Public School", title: "Winter", destination: "Manali", tourType: "domestic" };
    const be = createFakeBackend({ signedIn: true, join: trip });
    Object.assign(be.state, { trip, currentId: "00000000-0000-4000-9000-000000000001", form: { tourType: "domestic", role: "student", status: "draft", data: {}, currentSection: "personal", version: 1, updatedAt: "2026-10-21T10:00:00.000Z", submittedAt: null } });
    const original = be.fetchMock.getMockImplementation();
    be.fetchMock.mockImplementation(async (url, init) => {
      const res = await original(url, init);
      if (!String(url).startsWith("/api/onboarding")) return res;
      const data = await res.clone().json();
      return reply(200, { ...data, trip: { ...data.trip, schoolLogo: LOGO } });
    });
    at("/registrations/00000000-0000-4000-9000-000000000001");
    const header = (await screen.findByRole("progressbar")) && document.querySelector(".portal-header");
    expect(within(header).getByAltText("Greenfield Public School logo")).toHaveAttribute("src", LOGO);
    expect(within(header).getByText("×")).toBeInTheDocument();
  });

  it("the public trip page shows both logos", async () => {
    createFakeAdmin({ signedIn: false, joinResponses: { "greenfield-public-school/kolkata/winter": reply(200, { school: { name: "Greenfield Public School", branch: "Kolkata", logo: LOGO }, trip: { title: "Winter", destination: "Manali", tourType: "domestic" }, registrationOpen: true }) } });
    at("/join/greenfield-public-school/kolkata/winter");
    expect(await screen.findByAltText("Greenfield Public School logo")).toHaveAttribute("src", LOGO);
    expect(screen.getByAltText("Young Edsplorer")).toBeInTheDocument();
  });
});

describe("school logo in the Sales portal", () => {
  it("Sales have no school page at all, so no logo slot: the address is 'Page not found' and the logo routes are never called", async () => {
    const be = createFakeAdmin({ role: "sales" });
    const s = be.addSchool({ logoUrl: LOGO });
    at(`/sales/schools/${s.id}`);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "School logo" })).not.toBeInTheDocument();
    expect(be.calls(/\/api\/admin\/schools/)).toHaveLength(0);
  });
});

describe("responsive and accessible hooks", () => {
  it("the stylesheet keeps logos within the header, stacks the form on small screens and respects reduced motion", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { cwd } = await import("node:process");
    const css = readFileSync(resolve(cwd(), "src/index.css"), "utf8");
    expect(css).toMatch(/\.school-logo img \{[^}]*object-fit: contain/);
    expect(css).toMatch(/\.school-logo \{[^}]*max-width: calc\(var\(--brand-h\) \* 2\.4\)/);
    expect(css).toMatch(/@media \(max-width: 700px\) \{[\s\S]*?\.form-grid \{\s*grid-template-columns: 1fr;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
