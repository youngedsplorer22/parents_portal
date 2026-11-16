/* global process */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allFields, getDefinition } from "../../../../backend/src/modules/onboarding/definitions.js";
import { GUIDANCE, guidanceFor } from "../../onboarding/guidance.js";
import { createFakeBackend } from "../../test/fakeBackend.js";
import OnboardingFlow from "./OnboardingFlow.jsx";

afterEach(() => vi.unstubAllGlobals());

const PASSPORT_HINT = "Fill in the form exactly as per passport.";
const AADHAAR_HINT = "Please enter your full name and date of birth exactly as printed on your Aadhaar card. Do not change the order or spelling.";
const draft = (tourType, role = "student") => ({
  tourType, role, status: "draft", data: {}, currentSection: "personal", version: 1, updatedAt: "2026-10-21T10:00:00.000Z", submittedAt: null,
});
const ROLE_NAMES = { student: "Student", teacher: "Teacher", team_leader: "Team Leader" };

async function open(tourType, role = "student") {
  const be = createFakeBackend({
    signedIn: true,
    user: { email: "p@example.com", firstName: "Asha", lastName: "Rao", role: ROLE_NAMES[role] },
    form: draft(tourType, role),
  });
  render(<OnboardingFlow user={be.state.user} onSignedOut={() => {}} autosaveDelayMs={20} enrolmentId="legacy" />);
  await screen.findByRole("progressbar", { name: "Form completion" });
  return be;
}
// The toggle is named "See example" / "Hide example"; aria-describedby ties it to its field's label.
// Only the example images (the page also has the brand logo).
const exampleImages = () => document.querySelectorAll(".example-figure img");
const toggles = () => screen.queryAllByRole("button", { name: /^(See|Hide) example$/ });
const toggleFor = (label) => {
  const match = toggles().find((b) => document.getElementById(b.getAttribute("aria-describedby"))?.textContent.replace(/\*$/, "") === label);
  if (!match) throw new Error(`No example toggle for ${label}`);
  return match;
};

describe("guidance mapping", () => {
  it("covers exactly the three approved mappings and nothing else", () => {
    expect(Object.keys(GUIDANCE).sort()).toEqual(["domestic", "international"]);
    expect(Object.keys(GUIDANCE.international).sort()).toEqual(["firstName", "lastName"]);
    expect(Object.keys(GUIDANCE.domestic).sort()).toEqual(["dateOfBirth", "fullName"]);
  });

  it("uses the approved hint text and the right image for each field", () => {
    expect(guidanceFor("international", "firstName")).toMatchObject({ hint: PASSPORT_HINT, example: { src: "/guides/passport-first-name.jpg" } });
    expect(guidanceFor("international", "lastName")).toMatchObject({ hint: PASSPORT_HINT, example: { src: "/guides/passport-last-name.jpg" } });
    expect(guidanceFor("domestic", "fullName")).toMatchObject({ hint: AADHAAR_HINT, example: { src: "/guides/aadhaar-name-dob.jpg" } });
    expect(guidanceFor("domestic", "dateOfBirth")).toMatchObject({ hint: AADHAAR_HINT, example: { src: "/guides/aadhaar-name-dob.jpg" } });
    expect(guidanceFor("international", "passportNumber")).toBeUndefined();
    expect(guidanceFor("domestic", "phone")).toBeUndefined();
  });

  it("only refers to fields that exist in the server's forms for every role (it adds no fields)", () => {
    for (const [tour, byKey] of Object.entries(GUIDANCE)) {
      for (const role of ["student", "teacher", "team_leader"]) {
        const keys = allFields(getDefinition(tour, role)).map((f) => f.key);
        for (const key of Object.keys(byKey)) expect(keys, `${tour}/${role}/${key}`).toContain(key);
      }
    }
  });

  it("every image file exists in public/guides and is small enough to load quickly", () => {
    const srcs = new Set(Object.values(GUIDANCE).flatMap((o) => Object.values(o).map((g) => g.example.src)));
    expect(srcs.size).toBe(3);
    for (const src of srcs) {
      const file = resolve(process.cwd(), `public${src}`);
      expect(existsSync(file), src).toBe(true);
      expect(statSync(file).size, src).toBeLessThan(500_000);
    }
  });

  it("every image has a meaningful description", () => {
    for (const byKey of Object.values(GUIDANCE)) for (const g of Object.values(byKey)) expect(g.example.alt.length).toBeGreaterThan(60);
  });
});

describe("International: first and last name (passport)", () => {
  it("shows the passport hint under both fields, linked to the input", async () => {
    await open("international");
    for (const label of ["First name", "Last name"]) {
      const input = screen.getByLabelText(new RegExp(`^${label}`));
      const hint = document.getElementById(input.getAttribute("aria-describedby"));
      expect(hint).toHaveTextContent(PASSPORT_HINT);
    }
    expect(screen.getAllByText(PASSPORT_HINT)).toHaveLength(2);
  });

  it("the example is collapsed by default and no image is in the page (so nothing is downloaded)", async () => {
    await open("international");
    for (const label of ["First name", "Last name"]) {
      expect(toggleFor(label)).toHaveAttribute("aria-expanded", "false");
      expect(toggleFor(label)).toHaveTextContent("See example");
    }
    expect(exampleImages()).toHaveLength(0);
  });

  it("opens the FIRST NAME image for First name, and the SURNAME image for Last name", async () => {
    const user = userEvent.setup();
    await open("international");

    await user.click(toggleFor("First name"));
    const first = screen.getByRole("img", { name: /Given Name\(s\) field \(ANANYA\)/ });
    expect(first).toHaveAttribute("src", "/guides/passport-first-name.jpg");
    expect(toggleFor("First name")).toHaveAttribute("aria-expanded", "true");
    expect(toggleFor("First name")).toHaveTextContent("Hide example");
    expect(toggleFor("First name").getAttribute("aria-controls")).toBe(first.closest("figure").id);
    expect(toggleFor("First name")).toHaveAccessibleDescription("First name");
    expect(screen.queryByRole("img", { name: /Surname field/ })).not.toBeInTheDocument();

    await user.click(toggleFor("Last name"));
    expect(screen.getByRole("img", { name: /Surname field \(SHARMA\)/ })).toHaveAttribute("src", "/guides/passport-last-name.jpg");
    expect(exampleImages()).toHaveLength(2);
  });

  it("the toggle collapses again and removes the image", async () => {
    const user = userEvent.setup();
    await open("international");
    await user.click(toggleFor("First name"));
    await user.click(toggleFor("First name"));
    expect(toggleFor("First name")).toHaveAttribute("aria-expanded", "false");
    expect(exampleImages()).toHaveLength(0);
  });

  it("is a real button that works from the keyboard", async () => {
    const user = userEvent.setup();
    await open("international");
    const button = toggleFor("First name");
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    button.focus();
    await user.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("no other International field gets guidance (passport help is not extended)", async () => {
    const user = userEvent.setup();
    await open("international");
    expect(toggles()).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /Passport details/ }));
    expect(toggles()).toHaveLength(0);
    expect(screen.queryByText(PASSPORT_HINT)).not.toBeInTheDocument();
  });

  it("works for teacher and team leader as well, with the fields and order unchanged", async () => {
    for (const role of ["teacher", "team_leader"]) {
      const { unmount } = render(<div />);
      unmount();
      await open("international", role);
      expect(toggleFor("First name")).toBeInTheDocument();
      expect(toggleFor("Last name")).toBeInTheDocument();
      const labels = [...document.querySelectorAll(".field-label")].map((l) => l.textContent.replace(/\*$/, ""));
      expect(labels).toEqual(["First name", "Last name", "Date of birth", "Gender"]);
      document.body.innerHTML = "";
    }
  });
});

describe("Domestic: full name and date of birth (Aadhaar)", () => {
  it("shows the Aadhaar hint under both fields", async () => {
    await open("domestic");
    expect(screen.getAllByText(AADHAAR_HINT)).toHaveLength(2);
    for (const label of ["Full name", "Date of birth"]) {
      const input = screen.getByLabelText(new RegExp(`^${label}`));
      expect(document.getElementById(input.getAttribute("aria-describedby"))).toHaveTextContent(AADHAAR_HINT);
    }
  });

  it("each field has its own collapsed toggle, and both show the same Aadhaar image", async () => {
    const user = userEvent.setup();
    await open("domestic");
    expect(toggleFor("Full name")).toHaveAttribute("aria-expanded", "false");
    expect(toggleFor("Date of birth")).toHaveAttribute("aria-expanded", "false");
    expect(exampleImages()).toHaveLength(0);

    await user.click(toggleFor("Date of birth"));
    const img = screen.getByRole("img", { name: /Aadhaar card.*DOB field \(15\/07\/1995\)/ });
    expect(img).toHaveAttribute("src", "/guides/aadhaar-name-dob.jpg");
    expect(toggleFor("Full name")).toHaveAttribute("aria-expanded", "false"); // independent toggles

    await user.click(toggleFor("Full name"));
    expect(exampleImages()).toHaveLength(2);
    for (const i of exampleImages()) expect(i).toHaveAttribute("src", "/guides/aadhaar-name-dob.jpg");
  });

  it("adds no Aadhaar number field and leaves the other Domestic fields without guidance", async () => {
    const user = userEvent.setup();
    await open("domestic");
    expect(screen.queryByLabelText(/aadhaar/i)).not.toBeInTheDocument();
    expect(toggles()).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /Nominee/ }));
    expect(toggles()).toHaveLength(0);
    const labels = [];
    for (const name of [/Personal details/, /Nominee/, /Meals & health/, /Contact & remarks/]) {
      await user.click(screen.getByRole("button", { name }));
      labels.push(...[...document.querySelectorAll(".field-label")].map((l) => l.textContent.replace(/\*$/, "")));
    }
    expect(labels).toEqual([
      "Full name", "Date of birth", "Gender", "Class & section", "Nominee name", "Nominee relation",
      "Meals preference", "Allergy", "Phone number", "Remark",
    ]);
  });

  it("an error is shown in addition to the hint: validation never hides the hint", async () => {
    const user = userEvent.setup();
    await open("domestic");
    const dob = screen.getByLabelText(/^Date of birth/);
    await user.click(dob);
    await user.tab();
    expect(await screen.findByText("Date of birth is required.")).toBeInTheDocument();
    expect(screen.getAllByText(AADHAAR_HINT)).toHaveLength(2); // both fields still show it
    expect(dob.getAttribute("aria-describedby")).toBe("onb-dateOfBirth-error onb-dateOfBirth-hint");
    expect(toggleFor("Date of birth")).toBeInTheDocument();
  });
});

describe("guidance does not disturb saving", () => {
  it("opening or closing an example makes no request", async () => {
    const user = userEvent.setup();
    const be = await open("international");
    const before = be.calls().length;
    await user.click(toggleFor("First name"));
    await user.click(toggleFor("First name"));
    expect(be.calls()).toHaveLength(before);
  });
});
