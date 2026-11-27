import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression: the sign-in / registration card was cut off on short windows (e.g. a laptop browser ~650-780 px tall).
// The page could not scroll (body overflow: hidden above 700 px) and the card scrolled inside itself instead, with no
// visible scrollbar on macOS, so the email/password fields and the submit button below the fold looked missing and
// scrolling over the background did nothing. jsdom has no layout, so this checks the stylesheet rules that caused it;
// the real reachability check runs in a browser (see the report for the viewport walkthrough).
const css = readFileSync("src/index.css", "utf8");
/** Every rule body for an exact selector, including inside media queries. */
const blocks = (selector) => [...css.matchAll(new RegExp(`(?:^|[}\\s,])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);

describe("the sign-in and registration pages scroll as a normal page", () => {
  it("the document is never prevented from scrolling", () => {
    for (const body of blocks("body")) expect(body).not.toMatch(/overflow(-y)?\s*:\s*hidden/);
    for (const body of blocks("html")) expect(body).not.toMatch(/overflow(-y)?\s*:\s*hidden/);
  });

  it("the card has no height limit and no scrollbar of its own, at any width", () => {
    const card = blocks(".glass-card");
    expect(card.length).toBeGreaterThan(0);
    for (const b of card) {
      expect(b).not.toMatch(/max-height\s*:\s*(?!none)/);
      expect(b).not.toMatch(/overflow(-y)?\s*:\s*(auto|scroll|hidden)/);
      expect(b).not.toMatch(/(^|[^-])height\s*:/);
    }
  });

  it("the page around it grows with the card (a minimum height only, never a fixed or clipped one)", () => {
    for (const b of blocks(".parent-portal")) {
      expect(b).not.toMatch(/(^|[^-])height\s*:/);
      expect(b).not.toMatch(/max-height/);
      expect(b).not.toMatch(/overflow(-y)?\s*:\s*(auto|scroll|hidden)/);
    }
    expect(blocks(".parent-portal").join("")).toMatch(/min-height\s*:\s*100svh/);
  });
});

// Regression: in the registration form, Last Name sat 18 px lower than First Name (and every row gap was 34 px instead
// of 16). A rule meant for stacked sign-in fields, `.auth-form .field + .field { margin-top }`, also matched the fields
// inside the registration's two-column grid, where only the SECOND field of the first pair follows another field.
describe("paired registration fields line up", () => {
  it("the stacked-field spacing only applies to fields directly in a sign-in form, never inside a grid", () => {
    expect(css).not.toMatch(/\.auth-form\s+\.field\s*\+\s*\.field/); // descendant form: would reach .form-grid fields
    expect(css).toMatch(/\.auth-form\s*>\s*\.field\s*\+\s*\.field/);
    for (const b of blocks(".form-grid .field")) expect(b).not.toMatch(/margin(-top)?\s*:/);
  });

  it("the grid aligns every field to the top of its row, with the row gap as the only space between rows", () => {
    const grid = blocks(".form-grid")[0];
    expect(grid).toMatch(/display\s*:\s*grid/);
    expect(grid).toMatch(/align-items\s*:\s*start/);
    expect(grid).toMatch(/grid-template-columns\s*:\s*1fr 1fr/);
  });
});

// Regression: on a 320 px phone the registration form panel was 362 px wide (inside a 304 px column), so the inputs ran
// off the right edge. A bare `1fr` grid column can never be narrower than its content (here the row of seven step
// markers); `minmax(0, 1fr)` lets the column shrink, and the step markers share the row instead of keeping 44 px each.
describe("the registration form fits a 320 px phone", () => {
  const mediaBlock = (query) => {
    const start = css.indexOf(`@media (${query})`);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
    }
    return "";
  };

  it("the single column can shrink below its content", () => {
    expect(mediaBlock("max-width: 860px")).toMatch(/\.onboarding-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("on very narrow screens the step markers share the row instead of each keeping 44 px", () => {
    const narrow = mediaBlock("max-width: 400px");
    expect(narrow).toMatch(/\.step-nav li\s*\{[^}]*flex:\s*1 1 0/);
    expect(narrow).toMatch(/min-width:\s*0/);
  });
});
