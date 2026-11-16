/* global process */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../App.jsx";
import { greetingFor } from "../../onboarding/greetings.js";
import { createFakeBackend } from "../../test/fakeBackend.js";
import OnboardingFlow from "./OnboardingFlow.jsx";

afterEach(() => vi.unstubAllGlobals());

const AADHAAR_HINT = "Please enter your full name and date of birth exactly as printed on your Aadhaar card. Do not change the order or spelling.";
const PASSPORT_HINT = "Fill in the form exactly as per passport.";
const ROLE_NAMES = { student: "Student", teacher: "Teacher", team_leader: "Team Leader" };
const draft = (tourType, role = "student", data = {}) => ({
  tourType, role, status: "draft", data, currentSection: "personal", version: 1, updatedAt: "2026-10-21T10:00:00.000Z", submittedAt: null,
});
const backend = (tourType, role = "student", data = {}) =>
  createFakeBackend({
    signedIn: true,
    user: { email: "p@example.com", firstName: "Asha", lastName: "Rao", role: ROLE_NAMES[role] },
    form: tourType ? draft(tourType, role, data) : null,
  });
async function open(tourType, role = "student", data = {}) {
  const be = backend(tourType, role, data);
  render(<OnboardingFlow user={be.state.user} onSignedOut={() => {}} autosaveDelayMs={20} enrolmentId="legacy" />);
  await screen.findByRole("progressbar", { name: "Form completion" });
  return be;
}
const field = (label) => screen.getByLabelText(label);
const step = (name) => within(screen.getByRole("navigation", { name: "Form sections" })).getByRole("button", { name });
const exampleImages = () => document.querySelectorAll(".example-figure img");
const toggles = () => screen.queryAllByRole("button", { name: /^(See|Hide) example$/ });
const toggleFor = (label) =>
  toggles().find((b) => document.getElementById(b.getAttribute("aria-describedby"))?.textContent.replace(/\*$/, "") === label);
const setDate = (label, value) => fireEvent.change(field(label), { target: { value } });

const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
const ruleBody = (selector) => {
  const at = css.indexOf(`\n${selector} {`);
  if (at === -1) return null;
  return css.slice(at, css.indexOf("}", at));
};

describe("layout: onboarding is full-screen; login and registration keep their look", () => {
  it("onboarding renders in a full-screen container, with no scenic page and no rounded translucent card", async () => {
    const be = backend("domestic");
    render(<App />);
    await screen.findByRole("progressbar", { name: "Form completion" });
    expect(be.state.signedIn).toBe(true);
    expect(document.querySelector(".onboarding-screen")).toBeTruthy();
    expect(document.querySelector(".parent-portal")).toBeNull();
    expect(document.querySelector(".glass-card")).toBeNull();
    expect(document.querySelector(".auth-content")).toBeNull();
  });

  it("keeps the logo and the log out action visible in the compact header", async () => {
    backend("international");
    render(<App />);
    await screen.findByRole("progressbar", { name: "Form completion" });
    const header = document.querySelector(".portal-header");
    expect(within(header).getByAltText("Young Edsplorer")).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: /Log out/ })).toBeInTheDocument();
    expect(within(header).getByText("Hi, Asha")).toBeInTheDocument();
  });

  it("keeps the section navigation, progress indicator and form panel", async () => {
    backend("domestic");
    render(<App />);
    await screen.findByRole("progressbar", { name: "Form completion" });
    expect(screen.getByRole("navigation", { name: "Form sections" })).toBeInTheDocument();
    expect(document.querySelector(".onboarding-body > .step-panel")).toBeTruthy();
  });

  it("login and registration still use the scenic page and the glass card", async () => {
    createFakeBackend(); // signed out
    render(<App />);
    await screen.findByRole("tab", { name: "Register" });
    expect(document.querySelector(".parent-portal .glass-card .auth-content")).toBeTruthy();
    expect(document.querySelector(".onboarding-screen")).toBeNull();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Login" }));
    expect(document.querySelector(".parent-portal .glass-card .auth-content")).toBeTruthy();
  });

  it("the stylesheet gives the onboarding screen no background image, and still gives login its scenic one", () => {
    const screenRule = ruleBody(".onboarding-screen");
    expect(screenRule).toContain("position: fixed");
    expect(screenRule).toContain("inset: 0");
    expect(screenRule).not.toMatch(/url\(|background-image/);
    expect(ruleBody(".parent-portal")).toContain('url("/try.png")');
    expect(ruleBody(".glass-card")).toContain("border-radius: 22px"); // the refined, less rounded card
  });

  it("onboarding CSS is scoped: nothing after the onboarding banner restyles the login or registration layout", () => {
    const onboardingCss = css.slice(css.indexOf("ONBOARDING (after sign-in)"));
    const selectors = [...onboardingCss.matchAll(/([^{}@]+)\{/g)].map((m) => m[1]).join(" ");
    for (const shared of [".parent-portal", ".glass-card", ".auth-content", ".auth-tabs", ".auth-form-area", ".auth-tab "]) {
      expect(selectors, shared).not.toContain(shared);
    }
  });

  it("has a mobile layout for the full-screen header and shell", () => {
    expect(css).toMatch(/@media \(max-width: 700px\) \{\s*\.onboarding-shell/);
  });
});

describe("greeting width", () => {
  const rule = ruleBody(".greeting");

  it("the card spans the full content width: no max-width cap, width 100%", () => {
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).not.toMatch(/max-width/);
    expect(rule).toMatch(/text-align:\s*left/);
  });

  it("only the text lines are capped for readability; the card itself is not", () => {
    expect(ruleBody(".greeting p")).toMatch(/max-width:\s*120ch/);
  });

  it("sits in the same content column as the progress bar and the form (shared parent, in order)", async () => {
    for (const tour of ["domestic", "international"]) {
      await open(tour);
      const greeting = screen.getByRole("region", { name: "Welcome message" });
      const progress = document.querySelector(".progress");
      const body = document.querySelector(".onboarding-body");
      expect(greeting.parentElement).toBe(progress.parentElement);
      expect(greeting.parentElement).toBe(body.parentElement);
      expect(greeting.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(progress.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      document.body.innerHTML = "";
    }
  });
});

describe("greeting", () => {
  it("is the company's wording, before the sections, with no placeholder when there is no destination", async () => {
    await open("domestic");
    const greeting = screen.getByRole("region", { name: "Welcome message" });
    const paragraphs = [...greeting.querySelectorAll("p")].map((p) => p.textContent);
    expect(paragraphs).toEqual([
      "Dear Parents,",
      "Greetings from Young Edsplorer!",
      "Thank you for your interest in the upcoming trip. Please complete the required information below to proceed with the registration.",
      "Regards,Young Edsplorer",
    ]);
    expect(greeting.querySelector(".greeting-signoff").innerHTML).toBe("Regards,<br>Young Edsplorer");
    const body = document.querySelector(".onboarding-body");
    expect(greeting.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows one greeting, for every tour and role, on every section, and never the old placeholders", async () => {
    const user = userEvent.setup();
    for (const tour of ["domestic", "international"]) {
      for (const role of ["student", "teacher", "team_leader"]) {
        await open(tour, role);
        expect(screen.getAllByRole("region", { name: "Welcome message" })).toHaveLength(1);
        expect(document.body.textContent).not.toMatch(/PLACE trip|\[DESTINATION\]/);
        await user.click(step(/Review & submit/));
        expect(screen.getAllByRole("region", { name: "Welcome message" })).toHaveLength(1);
        document.body.innerHTML = "";
      }
    }
  });

  it("is not shown before a tour has been chosen", async () => {
    const be = backend(null);
    render(<OnboardingFlow user={be.state.user} onSignedOut={() => {}} enrolmentId="legacy" />);
    await screen.findByRole("group", { name: "Which tour is this for?" });
    expect(screen.queryByRole("region", { name: "Welcome message" })).not.toBeInTheDocument();
  });

  it("uses the trip's real destination as text, trimmed, and invents none", () => {
    expect(greetingFor("Bali").paragraphs[1]).toBe("Thank you for your interest in the upcoming trip to Bali. Please complete the required information below to proceed with the registration.");
    expect(greetingFor("  Jaipur ").paragraphs[1]).toContain("trip to Jaipur.");
    for (const none of ["", "   ", null, undefined]) expect(greetingFor(none).paragraphs[1]).toContain("the upcoming trip. Please");
    // markup in a destination is just text (React escapes it when rendering)
    expect(greetingFor("<b>X</b>").paragraphs[1]).toContain("<b>X</b>");
  });
});

describe("guidance hint shows and hides with its own example", () => {
  it("Domestic: opening Full name's example hides only Full name's hint; closing restores it", async () => {
    const user = userEvent.setup();
    await open("domestic");
    expect(screen.getAllByText(AADHAAR_HINT)).toHaveLength(2);
    const full = toggleFor("Full name");
    const dob = toggleFor("Date of birth");
    expect(full).toHaveTextContent("See example");

    await user.click(full);
    expect(full).toHaveTextContent("Hide example");
    expect(full).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText(AADHAAR_HINT)).toHaveLength(1);
    expect(document.getElementById("onb-fullName-hint")).toBeNull();
    expect(document.getElementById("onb-dateOfBirth-hint")).toHaveTextContent(AADHAAR_HINT); // the other field is untouched
    expect(dob).toHaveAttribute("aria-expanded", "false");
    expect(exampleImages()).toHaveLength(1);

    await user.click(full);
    expect(full).toHaveTextContent("See example");
    expect(full).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByText(AADHAAR_HINT)).toHaveLength(2);
    expect(exampleImages()).toHaveLength(0);
  });

  it("Domestic: each toggle controls only its own image and hint", async () => {
    const user = userEvent.setup();
    await open("domestic");
    await user.click(toggleFor("Date of birth"));
    expect(document.getElementById("onb-dateOfBirth-hint")).toBeNull();
    expect(document.getElementById("onb-fullName-hint")).not.toBeNull();
    expect(toggleFor("Date of birth").getAttribute("aria-controls")).toBe("onb-dateOfBirth-example");
    expect(document.getElementById("onb-dateOfBirth-example")).not.toBeNull();
    expect(document.getElementById("onb-fullName-example")).toBeNull();

    await user.click(toggleFor("Full name"));
    expect(screen.queryByText(AADHAAR_HINT)).not.toBeInTheDocument(); // both open: both hints hidden
    expect(exampleImages()).toHaveLength(2);
    await user.click(toggleFor("Date of birth"));
    expect(screen.getAllByText(AADHAAR_HINT)).toHaveLength(1);
    expect(document.getElementById("onb-dateOfBirth-hint")).not.toBeNull();
    expect(document.getElementById("onb-fullName-hint")).toBeNull();
  });

  it("International: first name and last name toggles work independently and show the right images", async () => {
    const user = userEvent.setup();
    await open("international");
    expect(screen.getAllByText(PASSPORT_HINT)).toHaveLength(2);

    await user.click(toggleFor("First name"));
    expect(screen.getAllByText(PASSPORT_HINT)).toHaveLength(1);
    expect(document.getElementById("onb-firstName-hint")).toBeNull();
    expect(document.getElementById("onb-lastName-hint")).not.toBeNull();
    expect(screen.getByRole("img", { name: /Given Name\(s\) field \(ANANYA\)/ })).toHaveAttribute("src", "/guides/passport-first-name.jpg");

    await user.click(toggleFor("Last name"));
    expect(screen.queryByText(PASSPORT_HINT)).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Surname field \(SHARMA\)/ })).toHaveAttribute("src", "/guides/passport-last-name.jpg");

    await user.click(toggleFor("First name"));
    expect(document.getElementById("onb-firstName-hint")).toHaveTextContent(PASSPORT_HINT);
    expect(document.getElementById("onb-lastName-hint")).toBeNull();
    expect(exampleImages()).toHaveLength(1);
  });

  it("keeps the accessibility wiring right in both states", async () => {
    const user = userEvent.setup();
    await open("international");
    const input = field(/^First name/);
    const button = toggleFor("First name");
    // collapsed
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(input.getAttribute("aria-describedby")).toBe("onb-firstName-hint");
    expect(document.getElementById("onb-firstName-hint")).toHaveTextContent(PASSPORT_HINT);
    expect(document.getElementById(button.getAttribute("aria-controls"))).toBeNull(); // nothing to control yet

    await user.click(button);
    // expanded
    expect(button).toHaveAttribute("aria-expanded", "true");
    const figure = document.getElementById(button.getAttribute("aria-controls"));
    expect(figure).not.toBeNull();
    expect(figure.querySelector("img").getAttribute("alt")).toMatch(/Given Name\(s\)/);
    expect(input.hasAttribute("aria-describedby")).toBe(false); // no dangling reference to the hidden hint
    expect(button).toHaveAccessibleDescription("First name");
  });

  it("the hint does not disappear because of focus, typing, validation errors or edits elsewhere", async () => {
    const user = userEvent.setup();
    await open("domestic");
    const hints = () => screen.getAllByText(AADHAAR_HINT).length;
    expect(hints()).toBe(2);

    await user.click(field(/^Full name/)); // focus
    expect(hints()).toBe(2);
    await user.type(field(/^Full name/), "Asha Rao"); // change
    expect(hints()).toBe(2);
    await user.clear(field(/^Full name/));
    await user.tab(); // blur on an empty required field: an error appears
    expect(await screen.findByText("Full name is required.")).toBeInTheDocument();
    expect(hints()).toBe(2);
    expect(document.getElementById("onb-fullName-hint")).not.toBeNull();

    await user.type(field(/Class & section/), "4 - B"); // unrelated field
    setDate(/^Date of birth/, "2016-05-04"); // the other guided field changes
    await user.selectOptions(field(/Gender/), "Female");
    expect(hints()).toBe(2);
    await waitFor(() => expect(document.querySelector(".save-status.saved, .save-status.idle, .save-status")).toBeTruthy());
    expect(hints()).toBe(2);
  });

  it("an open example stays hidden-hint while typing, and an error appears without bringing it back", async () => {
    const user = userEvent.setup();
    await open("domestic");
    await user.click(toggleFor("Full name"));
    await user.type(field(/^Full name/), "A");
    await user.clear(field(/^Full name/));
    await user.tab();
    expect(await screen.findByText("Full name is required.")).toBeInTheDocument();
    expect(document.getElementById("onb-fullName-hint")).toBeNull();
    expect(field(/^Full name/).getAttribute("aria-describedby")).toBe("onb-fullName-error");
  });

  it("no other field gets a hint or a toggle, and the guidance text itself is unchanged", async () => {
    const user = userEvent.setup();
    await open("domestic");
    expect(toggles()).toHaveLength(2);
    await user.click(step(/Nominee/));
    expect(toggles()).toHaveLength(0);
    expect(document.querySelectorAll(".field-hint")).toHaveLength(0);
  });
});

describe("age is calculated, never typed", () => {
  it("there is no Age input for any tour or role; Date of birth stays editable", async () => {
    for (const [tour, role] of [["domestic", "student"], ["domestic", "team_leader"], ["international", "teacher"]]) {
      await open(tour, role);
      expect(screen.queryByLabelText(/^Age/)).not.toBeInTheDocument();
      expect(screen.getByLabelText(/^Date of birth/)).not.toBeDisabled();
      document.body.innerHTML = "";
    }
  });

  it("typing a date of birth sends only the date; the server stores the age it calculates", async () => {
    const be = await open("domestic", "student");
    fireEvent.change(screen.getByLabelText(/^Date of birth/), { target: { value: "2016-05-04" } });
    await waitFor(() => expect(be.state.form.data.dateOfBirth).toBe("2016-05-04"));
    expect(be.saves().every((c) => !("age" in c.body.data))).toBe(true);
    expect(be.state.form.data.age).toMatch(/^\d+$/); // filled in by the (fake) server, exactly like the real one
  });

  it("the review shows the date of birth but no separate age", async () => {
    const user = userEvent.setup();
    await open("domestic", "student", { fullName: "Asha", dateOfBirth: "2016-05-04", age: "10" });
    await user.click(step(/Review & submit/));
    const personal = within(screen.getByLabelText("Personal details answers"));
    expect(personal.getByText("Date of birth")).toBeInTheDocument();
    expect(personal.queryByText("Age")).not.toBeInTheDocument();
  });
});
