import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { definitionsFor } from "../../../../backend/src/modules/onboarding/definitions.js";
import { createFakeBackend } from "../../test/fakeBackend.js";
import { apiError, deferred, reply, storageIsEmpty, watchConsole } from "../../test/helpers.js";
import { todayIso } from "../../onboarding/formEngine.js";
import { layoutFields } from "../../onboarding/greetings.js";
import OnboardingFlow from "./OnboardingFlow.jsx";

const PUT = "PUT /api/onboarding";
const GET = "GET /api/onboarding";
const SUBMIT = "POST /api/onboarding/submit";
const DELETE = "DELETE /api/onboarding";
const FAST = 20; // autosave debounce in tests (the app default is 800 ms)

const ROLES = { Student: "student", Teacher: "teacher", "Team Leader": "team_leader" };
const U = (role = "Student") => ({ email: "parent@example.com", firstName: "Asha", lastName: "Rao", role });

let user;
beforeEach(() => {
  user = userEvent.setup();
});
afterEach(() => vi.unstubAllGlobals());

const draftForm = (over = {}) => ({
  tourType: "domestic",
  role: "student",
  status: "draft",
  data: {},
  currentSection: "personal",
  version: 1,
  updatedAt: "2026-10-21T10:00:00.000Z",
  submittedAt: null,
  ...over,
});

function mount(be, { onSignedOut = vi.fn(), delay = FAST } = {}) {
  // These tests exercise the form itself, so without a trip they open the trip-less form directly (as /registrations/legacy
  // does). Choosing which registration to open after login is tested in Resume.test.jsx.
  const view = render(<OnboardingFlow user={be.state.user} onSignedOut={onSignedOut} autosaveDelayMs={delay} enrolmentId={be.state.currentId ? null : "legacy"} />);
  return { ...view, onSignedOut };
}
const field = (label) => screen.getByLabelText(label);
const percent = () => Number(screen.getByRole("progressbar", { name: "Form completion" }).getAttribute("aria-valuenow"));
// Section buttons live in the navigation list (the review page also has "Edit <section>" buttons).
const step = (name) => within(screen.getByRole("navigation", { name: "Form sections" })).getByRole("button", { name });
const heading = () => screen.getByRole("heading", { level: 2 });
const labelsOnScreen = () => [...document.querySelectorAll(".field-label")].map((l) => l.textContent.replace(/\*$/, ""));
const next = () => user.click(screen.getByRole("button", { name: "Next section" }));
const back = () => user.click(screen.getByRole("button", { name: "Previous section" }));
const submitButton = () => screen.getByRole("button", { name: "Submit registration" });
/** Accept the declaration and type the signature, as a parent must before the final submission. */
async function sign(name = "Asha Rao") {
  await user.click(screen.getByRole("checkbox", { name: /I confirm that the information provided/ }));
  await user.type(screen.getByLabelText(/Full name \(Digital Signature\)/), name);
}

async function pickTour(be, tour, role = "Student") {
  be.state.user = U(role);
  mount(be);
  await screen.findByRole("group", { name: "Which tour is this for?" });
  await user.click(screen.getByRole("radio", { name: new RegExp(tour === "domestic" ? "Domestic" : "International") }));
  await user.click(screen.getByRole("button", { name: /Continue/ }));
  await screen.findByRole("progressbar", { name: "Form completion" });
}
const setDate = (label, value) => fireEvent.change(field(label), { target: { value } });

async function fillDomestic({ withClass = true } = {}) {
  await user.type(field(/Full name/), "Asha Rao");
  await user.selectOptions(field(/Gender/), "Female");
  if (withClass) await user.type(field(/Class & section/), "4 - B");
  setDate(/Date of birth/, "2016-05-04");
  await next();
  await user.type(field(/Nominee name/), "B Vijaya");
  await user.type(field(/Nominee relation/), "Mother");
  await next();
  await user.selectOptions(field(/Meals preference/), "Non-veg");
  await next();
  await user.type(field(/Phone number/), "9876543210");
}

describe("choosing the tour", () => {
  it("offers Domestic Tours and International Tours, and explains which columns the user's role gets", async () => {
    const be = createFakeBackend({ signedIn: true, user: U("Teacher") });
    mount(be);
    await screen.findByRole("group", { name: "Which tour is this for?" });
    expect(screen.getByRole("radio", { name: /Domestic Tours/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /International Tours/ })).toBeInTheDocument();
    expect(screen.getByText(/registered as/)).toHaveTextContent("Teacher");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("will not continue without a choice", async () => {
    const be = createFakeBackend({ signedIn: true });
    mount(be);
    await screen.findByRole("group", { name: "Which tour is this for?" });
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Choose Domestic Tours or International Tours/);
    expect(be.saves()).toHaveLength(0);
  });

  it("saves the choice right away as a new draft, so it survives a reload", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "international");
    expect(be.saves()).toHaveLength(1);
    expect(be.saves()[0].body).toEqual({ tourType: "international", data: {}, currentSection: "personal", version: null, enrolmentId: "legacy" });
    expect(be.state.form).toMatchObject({ tourType: "international", status: "draft" });
    expect(heading()).toHaveTextContent("Personal details");
  });

  it("shows an error and stays on the picker when the draft cannot be created", async () => {
    const be = createFakeBackend({ signedIn: true });
    be.queue(PUT, apiError(500, "INTERNAL_ERROR"));
    mount(be);
    await screen.findByRole("group", { name: "Which tour is this for?" });
    await user.click(screen.getByRole("radio", { name: /Domestic/ }));
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Something went wrong/);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeEnabled();
  });
});

describe("the forms follow the spreadsheets", () => {
  // Labels per section, in order, for every tour and role: taken from the definitions the server sends.
  const expectedLabels = (tour, role) =>
    definitionsFor(ROLES[role])[tour].sections.map((s) => [s.title, layoutFields(s).map((f) => f.label)]);

  for (const tour of ["domestic", "international"]) {
    for (const role of Object.keys(ROLES)) {
      it(`${tour} / ${role}: every column of the sheet is on the form, section by section`, async () => {
        const be = createFakeBackend({ signedIn: true });
        await pickTour(be, tour, role);
        for (const [title, labels] of expectedLabels(tour, role)) {
          await user.click(step(new RegExp(title)));
          expect(heading()).toHaveTextContent(title);
          expect(labelsOnScreen()).toEqual(labels);
        }
      });
    }
  }

  it("Domestic student: FULL NAME (one field), DOB, GENDER, CLASS & SECTION, nominee, meals, allergy, phone, remark (AGE is calculated)", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    const all = [];
    for (const name of [/Personal details/, /Nominee/, /Meals & health/, /Contact & remarks/]) {
      await user.click(step(name));
      all.push(...labelsOnScreen());
    }
    expect(all).toEqual([
      "Full name", "Date of birth", "Gender", "Class & section",
      "Nominee name", "Nominee relation",
      "Meals preference", "Allergy",
      "Phone number", "Remark",
    ]);
  });

  it("Domestic team leader has no class & section; International team leader has no branch and nominee 'with teacher'", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic", "Team Leader");
    expect(screen.queryByLabelText(/Class & section/)).not.toBeInTheDocument();
  });

  it("International student: first/last name, passport block, branch, two meal preferences, nominee 'with student', PAN with relation", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "international");
    await user.click(step(/Passport details/));
    expect(labelsOnScreen()).toEqual(["Passport number", "Place of birth", "Issue date", "Expiry date", "Passport validity", "Place of issue", "Nationality"]);
    await user.click(step(/Address & branch/));
    expect(labelsOnScreen()).toEqual(["Address", "Branch (if different branches are travelling of same school)"]);
    await user.click(step(/Meals & health/));
    expect(labelsOnScreen()).toEqual(["Meal preference (in flight)", "Meal preference (on trip)", "Allergies (if any)"]);
    await user.click(step(/Nominee/));
    expect(labelsOnScreen()).toEqual(["Nominee name", "Nominee relation with student"]);
    await user.click(step(/PAN card details/));
    expect(labelsOnScreen()).toEqual(["PAN card holder name", "PAN card no", "PAN card holder's DOB", "Relation with student", "Remarks (if any)"]);
  });

  it("International teacher / team leader: nominee is 'with teacher', no 'Relation with student', team leader has no branch", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "international", "Team Leader");
    await user.click(step(/^Step 3 Address,/));
    expect(labelsOnScreen()).toEqual(["Address"]);
    await user.click(step(/Nominee/));
    expect(labelsOnScreen()).toEqual(["Nominee name", "Nominee relation with teacher"]);
    await user.click(step(/PAN card details/));
    expect(labelsOnScreen()).not.toContain("Relation with student");
  });

  it("Passport validity is a read-only calculated value; Age is not on the form (the server calculates it)", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "international");
    expect(screen.queryByLabelText(/^Age/)).not.toBeInTheDocument();
    await user.click(step(/Passport details/));
    expect(field(/Passport validity/).tagName).toBe("OUTPUT");
    expect(field(/Passport validity/)).toHaveTextContent("—");
    setDate(/Expiry date/, `${Number(todayIso().slice(0, 4)) + 5}-01-01`);
    expect(field(/Passport validity/)).toHaveTextContent(/^4 years|^5 years/);
  });
});

describe("progress bar and percentage", () => {
  it("starts at 0% and is computed from the required fields of the actual form", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    expect(percent()).toBe(0);
    expect(screen.getByText("0 of 8 required answers complete")).toBeInTheDocument();
    expect(screen.getByText("0%")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Form completion" });
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "0% complete");
  });

  it("rises as required answers are given and only counts valid ones", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await user.type(field(/Full name/), "Asha Rao");
    expect(percent()).toBe(13);
    await user.selectOptions(field(/Gender/), "Female");
    expect(percent()).toBe(25);
    setDate(/Date of birth/, "2999-01-01"); // a future date is not valid, so it does not count
    expect(percent()).toBe(25);
    setDate(/Date of birth/, "2016-05-04");
    expect(percent()).toBe(38);
    expect(screen.getByText("3 of 8 required answers complete")).toBeInTheDocument();
    expect(screen.getByText("38%")).toBeInTheDocument();
  });

  it("optional answers do not change it, and clearing a required answer lowers it again", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await user.click(step(/Meals & health/));
    await user.type(field(/Allergy/), "dust");
    expect(percent()).toBe(0);
    await user.click(step(/Personal details/));
    await user.type(field(/Full name/), "Asha");
    expect(percent()).toBe(13);
    await user.clear(field(/Full name/));
    expect(percent()).toBe(0);
  });

  it("reaches 100% only when every required field is valid", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await fillDomestic();
    expect(percent()).toBe(100);
    expect(screen.getByText("8 of 8 required answers complete")).toBeInTheDocument();
  });

  it("shows which sections are complete, need attention, or are not complete, by text as well as colour", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await user.type(field(/Full name/), "Asha Rao");
    setDate(/Date of birth/, "2999-01-01");
    await user.click(step(/Nominee/));
    await user.type(field(/Nominee name/), "B Vijaya");
    await user.type(field(/Nominee relation/), "Mother");

    expect(step(/Personal details/)).toHaveTextContent("needs attention");
    expect(step(/Nominee/)).toHaveTextContent("complete");
    expect(step(/Nominee/)).not.toHaveTextContent("not complete");
    expect(step(/Meals & health/)).toHaveTextContent("not complete");
    expect(step(/Nominee/)).toHaveAttribute("aria-current", "step");
  });
});

describe("moving through the form", () => {
  it("Next and Back move between sections, and every section can be revisited and edited", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    expect(screen.getByRole("button", { name: "Previous section" })).toBeDisabled();
    await user.type(field(/Full name/), "Asha");
    await next();
    expect(heading()).toHaveTextContent("Nominee");
    await back();
    expect(heading()).toHaveTextContent("Personal details");
    expect(field(/Full name/)).toHaveValue("Asha");
    await user.type(field(/Full name/), " Rao");
    expect(field(/Full name/)).toHaveValue("Asha Rao");
  });

  it("is not blocked by incomplete sections: the user can move on and come back later", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await next();
    await next();
    await next();
    await next();
    expect(heading()).toHaveTextContent("Review & submit");
  });

  it("moves keyboard focus to the new section's heading", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await next();
    expect(heading()).toHaveFocus();
  });

  it("the section list is a labelled navigation landmark and the fields are reachable by Tab", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    expect(screen.getByRole("navigation", { name: "Form sections" })).toBeInTheDocument();
    await user.click(step(/Personal details/));
    await user.tab();
    expect(step(/Nominee/)).toHaveFocus();
  });
});

describe("validation messages", () => {
  it("appear after the user leaves a field, are linked to it, and clear when fixed", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await user.click(step(/Contact & remarks/));
    await user.click(field(/Phone number/));
    expect(screen.queryByText("Phone number is required.")).not.toBeInTheDocument(); // not before the user leaves the field
    await user.tab();
    const error = await screen.findByText("Phone number is required.");
    expect(field(/Phone number/)).toHaveAttribute("aria-invalid", "true");
    expect(field(/Phone number/).getAttribute("aria-describedby").split(" ")).toContain(error.id);
    expect(field(/Phone number/)).toHaveAttribute("aria-required", "true");

    await user.type(field(/Phone number/), "98765 12ab");
    await user.tab();
    expect(await screen.findByText("Use digits only, with no spaces, letters or symbols.")).toBeInTheDocument();
    await user.clear(field(/Phone number/));
    await user.type(field(/Phone number/), "9876543210");
    expect(screen.queryByText(/Use only digits/)).not.toBeInTheDocument();
    expect(field(/Phone number/)).not.toHaveAttribute("aria-invalid");
  });

  it("explains format rules: PAN, passport, expiry after issue", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "international");
    await user.click(step(/Passport details/));
    await user.type(field(/Passport number/), "12");
    await user.tab();
    expect(await screen.findByText(/Enter the passport number as printed/)).toBeInTheDocument();
    setDate(/Issue date/, "2020-01-10");
    setDate(/Expiry date/, "2019-01-01");
    await user.click(field(/Expiry date/));
    await user.tab();
    expect(await screen.findByText("Expiry date must be after the issue date.")).toBeInTheDocument();
    await user.click(step(/PAN card details/));
    await user.type(field(/PAN card no/), "abc");
    await user.tab();
    expect(await screen.findByText("Enter a valid PAN, for example ABCDE1234F.")).toBeInTheDocument();
  });
});

describe("autosave", () => {
  it("saves changes to the server after a short pause and says so", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    const before = be.saves().length;
    await user.type(field(/Full name/), "Asha Rao");
    await waitFor(() => expect(be.state.form.data).toEqual({ fullName: "Asha Rao" }));
    expect(be.saves().length).toBeGreaterThan(before);
    expect(be.saves().length).toBeLessThanOrEqual(before + 8); // debounced: not one request per keystroke storm
    expect(be.saves().at(-1).body).toMatchObject({ tourType: "domestic", data: { fullName: "Asha Rao" }, currentSection: "personal" });
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
    expect(be.state.form.version).toBe(be.saves().length); // the draft was created at version 1, then every save bumped it exactly once
  });

  it("shows 'Saving…' while a request is in flight", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    const pending = deferred();
    be.queue(PUT, () => pending.promise);
    await user.type(field(/Full name/), "A");
    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    be.state.form = { ...be.state.form, data: { fullName: "A" }, version: 2 };
    await act(async () => pending.resolve(reply(200, { form: { ...be.state.form, progress: { percent: 0 } } })));
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
  });

  it("never runs two saves at once, and each uses the version the server returned", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    be.state.saveDelayMs = 60;
    const start = be.saves().length;
    await user.type(field(/Full name/), "Asha");
    await waitFor(() => expect(be.saves().length).toBeGreaterThanOrEqual(start + 1));
    await user.type(field(/Full name/), " Rao"); // typed while the first save is in flight
    await waitFor(() => expect(be.state.form.data.fullName).toBe("Asha Rao"), { timeout: 3000 });
    const versions = be.saves().slice(start).map((c) => c.body.version);
    expect(versions).toEqual(versions.map((_, i) => 1 + i)); // 1, 2, ... never reused, never skipped
  });

  it("saves the section the user is on, immediately when they move", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await next();
    await waitFor(() => expect(be.state.form.currentSection).toBe("nominee"));
  });

  it("a failed save says so, keeps the answers on screen, and Retry saves them", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    const offline = () => {
      throw new TypeError("Failed to fetch");
    };
    be.queue(PUT, ...Array(20).fill(offline)); // every save fails until the "network" is back (typing can trigger several)
    await user.type(field(/Full name/), "Asha");
    expect(await screen.findByText(/couldn't save your latest changes/)).toBeInTheDocument();
    expect(field(/Full name/)).toHaveValue("Asha");
    expect(be.state.form.data.fullName).toBeUndefined();
    be.state.queued[PUT] = []; // the network is back
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("All changes saved")).toBeInTheDocument();
    expect(be.state.form.data.fullName).toBe("Asha");
  });

  it("warns before the page is closed while changes are unsaved, and not otherwise", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await screen.findByText("Your answers are saved automatically.");
    const quiet = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);

    be.state.saveDelayMs = 200;
    await user.type(field(/Full name/), "A");
    const pendingUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pendingUnload);
    expect(pendingUnload.defaultPrevented).toBe(true);
    await screen.findByText("All changes saved");
  });

  it("answers only ever go to the server: nothing in localStorage/sessionStorage, nothing logged", async () => {
    const logged = watchConsole();
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "international");
    await user.type(field(/First name/), "Asha");
    await screen.findByText("All changes saved");
    expect(storageIsEmpty()).toBe(true);
    expect(logged("Asha")).toBe(false);
  });
});

describe("saving and resuming", () => {
  it("restores the saved answers, the section the user was on and the progress", async () => {
    const be = createFakeBackend({
      signedIn: true,
      form: draftForm({ data: { fullName: "Asha Rao", gender: "Female", nomineeName: "B Vijaya" }, currentSection: "nominee", version: 4 }),
    });
    mount(be);
    expect(await screen.findByRole("heading", { level: 2, name: "Nominee" })).toBeInTheDocument();
    expect(field(/Nominee name/)).toHaveValue("B Vijaya");
    expect(percent()).toBe(38);
    await user.click(step(/Personal details/));
    expect(field(/Full name/)).toHaveValue("Asha Rao");
    expect(field(/Gender/)).toHaveValue("Female");
    expect(step(/Personal details/)).toHaveAttribute("aria-current", "step");
  });

  it("continues saving with the stored version (no lost or duplicate draft)", async () => {
    const be = createFakeBackend({ signedIn: true, form: draftForm({ data: { fullName: "Asha" }, version: 4 }) });
    mount(be);
    await screen.findByRole("progressbar");
    await user.type(field(/Full name/), " Rao");
    await waitFor(() => expect(be.state.form.data.fullName).toBe("Asha Rao"));
    expect(be.saves()[0].body.version).toBe(4); // the first save continues from the stored version
    await screen.findByText("All changes saved");
    expect(be.state.form.version).toBe(4 + be.saves().length); // each save bumped it once: nothing lost or duplicated
  });

  it("edit, leave, log back in: the edits are what comes back (state lives on the server)", async () => {
    const be = createFakeBackend({ signedIn: true });
    const first = mount(be);
    await screen.findByRole("group", { name: "Which tour is this for?" });
    await user.click(screen.getByRole("radio", { name: /Domestic/ }));
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    await screen.findByRole("progressbar");
    await user.type(field(/Full name/), "Asha Rao");
    await next();
    await user.type(field(/Nominee name/), "B Vijaya");
    await user.click(screen.getByRole("button", { name: /Log out/ }));
    await waitFor(() => expect(first.onSignedOut).toHaveBeenCalled());
    expect(be.state.form.data).toEqual({ fullName: "Asha Rao", nomineeName: "B Vijaya" }); // pending edits were flushed before logging out
    first.unmount();

    // A fresh page load (nothing carried over in the browser): the server provides everything.
    mount(be);
    expect(await screen.findByRole("heading", { level: 2, name: "Nominee" })).toBeInTheDocument();
    expect(field(/Nominee name/)).toHaveValue("B Vijaya");
    await user.click(step(/Personal details/));
    expect(field(/Full name/)).toHaveValue("Asha Rao");
    expect(storageIsEmpty()).toBe(true);
  });

  it("logging out right after typing saves the pending edit first (it does not wait for the debounce)", async () => {
    const be = createFakeBackend({ signedIn: true, form: draftForm({ data: { fullName: "Asha" } }) });
    const { onSignedOut } = mount(be, { delay: 60_000 });
    await screen.findByRole("progressbar");
    await user.type(field(/Full name/), " Rao");
    expect(be.saves()).toHaveLength(0); // still waiting for the debounce
    await user.click(screen.getByRole("button", { name: /Log out/ }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
    expect(be.state.form.data.fullName).toBe("Asha Rao");
    expect(be.calls().map((c) => c.key).slice(-2)).toEqual([PUT, "POST /api/auth/logout"]);
  });

  it("every saved field stays editable until submission", async () => {
    const be = createFakeBackend({ signedIn: true, form: draftForm({ data: { fullName: "Asha Rao" } }) });
    mount(be);
    await screen.findByRole("progressbar");
    await user.clear(field(/Full name/));
    await user.type(field(/Full name/), "Asha Devi");
    await waitFor(() => expect(be.state.form.data.fullName).toBe("Asha Devi"));
  });

  it("a draft is clearly not a submission: no 'submitted' message anywhere", async () => {
    const be = createFakeBackend({ signedIn: true, form: draftForm({ data: { fullName: "Asha" } }) });
    mount(be);
    await screen.findByRole("progressbar");
    expect(screen.queryByText(/Form submitted/)).not.toBeInTheDocument();
    expect(screen.getByText("Your answers are saved automatically.")).toBeInTheDocument();
  });

  it("if loading the saved form fails it says so and Try again reloads it", async () => {
    const be = createFakeBackend({ signedIn: true, form: draftForm({ data: { fullName: "Asha" } }) });
    be.queue(GET, () => {
      throw new TypeError("Failed to fetch");
    });
    mount(be);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Can't reach the server/);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("progressbar");
    expect(field(/Full name/)).toHaveValue("Asha");
  });

  it("an expired session while saving sends the user back to log in", async () => {
    const be = createFakeBackend({ signedIn: true });
    const { onSignedOut } = mount(be);
    await screen.findByRole("group", { name: "Which tour is this for?" });
    await user.click(screen.getByRole("radio", { name: /Domestic/ }));
    await user.click(screen.getByRole("button", { name: /Continue/ }));
    await screen.findByRole("progressbar");
    be.state.refreshOk = false; // the sign-in itself is over, so the page's one renewal attempt is refused
    be.queue(PUT, apiError(401, "UNAUTHENTICATED"));
    await user.type(field(/Full name/), "A");
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledWith("Your session has ended. Please log in again."));
  });

  it("a stale save (another tab changed the form) is refused, nothing is overwritten, and the user can reload", async () => {
    const be = createFakeBackend({ signedIn: true, form: draftForm({ data: { fullName: "Asha" }, version: 2 }) });
    mount(be);
    await screen.findByRole("progressbar");
    be.state.form = { ...be.state.form, data: { fullName: "From another tab" }, version: 3 };
    await user.type(field(/Full name/), " Rao");
    expect(await screen.findByRole("alert")).toHaveTextContent(/changed in another tab or device/);
    expect(be.state.form.data.fullName).toBe("From another tab");
    expect(screen.getByText("Changes are not being saved.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reload latest" }));
    await screen.findByRole("progressbar");
    expect(field(/Full name/)).toHaveValue("From another tab");
  });
});

describe("review and final submission", () => {
  it("lists the answers by section with Edit buttons that jump back, and nothing is submitted by looking", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await fillDomestic();
    await next();
    expect(heading()).toHaveTextContent("Review & submit");
    const personal = within(screen.getByLabelText("Personal details answers"));
    expect(personal.getByText("Asha Rao")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit Nominee" }));
    expect(heading()).toHaveTextContent("Nominee");
    expect(be.calls(SUBMIT)).toHaveLength(0);
  });

  it("an incomplete form cannot be submitted: it says what is missing, makes no submit request, and stays a draft", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await user.type(field(/Full name/), "Asha");
    await user.click(step(/Review & submit/));
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/answers need attention/);
    expect(screen.getByText("Gender is required.")).toBeInTheDocument();
    expect(be.calls(SUBMIT)).toHaveLength(0);
    expect(screen.queryByText("Registration submitted")).not.toBeInTheDocument();
    expect(be.state.form.status).toBe("draft");
  });

  it("an invalid answer blocks submission too", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await fillDomestic();
    await user.clear(field(/Phone number/));
    await user.type(field(/Phone number/), "abc");
    await user.click(step(/Review & submit/));
    await user.click(submitButton());
    expect(await screen.findByText("Use digits only, with no spaces, letters or symbols.")).toBeInTheDocument();
    expect(be.calls(SUBMIT)).toHaveLength(0);
  });

  it("success appears only after the server confirms, with a pending state meanwhile", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await fillDomestic();
    await next();
    await sign();
    const pending = deferred();
    be.queue(SUBMIT, () => pending.promise);
    await user.click(submitButton());

    expect(await screen.findByRole("button", { name: /Submitting…/ })).toBeDisabled();
    expect(screen.queryByText("Registration submitted")).not.toBeInTheDocument();
    be.state.form = { ...be.state.form, status: "submitted", submittedAt: new Date().toISOString(), version: be.state.form.version + 1 };
    await act(async () => pending.resolve(reply(200, { form: { ...be.state.form, progress: { percent: 100 } } })));
    expect(await screen.findByText("Registration submitted")).toBeInTheDocument();
  });

  it("submits what was saved: pending edits are flushed first, and the version sent is the latest one", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await fillDomestic();
    await next();
    await sign();
    await user.click(submitButton());
    expect(await screen.findByText("Registration submitted")).toBeInTheDocument();
    expect(be.calls(SUBMIT)).toHaveLength(1);
    expect(be.calls(SUBMIT)[0].body.version).toBe(be.state.form.version - 1);
    expect(be.state.form.status).toBe("submitted");
    expect(be.state.form.data).toMatchObject({ fullName: "Asha Rao", phone: "9876543210", classSection: "4 - B" });
  });

  it("double-clicking Submit sends one request", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await fillDomestic();
    await next();
    await sign();
    const pending = deferred();
    be.queue(SUBMIT, () => pending.promise);
    const button = submitButton();
    await user.dblClick(button);
    await user.click(button);
    expect(be.calls(SUBMIT)).toHaveLength(1);
    be.state.form = { ...be.state.form, status: "submitted", submittedAt: new Date().toISOString(), version: be.state.form.version + 1 };
    await act(async () => pending.resolve(reply(200, { form: { ...be.state.form, progress: { percent: 100 } } })));
    await screen.findByText("Registration submitted");
    expect(be.calls(SUBMIT)).toHaveLength(1);
  });

  it("server-side rejection (FORM_INCOMPLETE) shows the server's field errors and nothing is claimed as submitted", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await fillDomestic();
    await next();
    await sign();
    be.queue(SUBMIT, apiError(422, "FORM_INCOMPLETE", { fields: [{ path: "data.phone", message: "Server says: phone is not valid." }] }));
    await user.click(submitButton());
    expect(await screen.findByText("Server says: phone is not valid.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/missing or invalid/);
    expect(screen.queryByText("Registration submitted")).not.toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
  });

  it("a server or network error keeps the draft and allows a retry that succeeds", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await fillDomestic();
    await next();
    await sign();
    be.queue(SUBMIT, apiError(500, "INTERNAL_ERROR"));
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Something went wrong/);
    expect(screen.queryByText("Registration submitted")).not.toBeInTheDocument();
    await user.click(submitButton());
    expect(await screen.findByText("Registration submitted")).toBeInTheDocument();
    expect(be.calls(SUBMIT)).toHaveLength(2);
  });

  it("if the latest changes can't be saved first, it does not submit", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await fillDomestic();
    await next();
    await user.click(step(/Personal details/));
    const offline = () => {
      throw new TypeError("Failed to fetch");
    };
    be.queue(PUT, ...Array(12).fill(offline)); // every save fails (autosaves while typing, on moving, and before submitting)
    await user.type(field(/Full name/), " X");
    await user.click(step(/Review & submit/));
    await sign();
    await user.click(submitButton());
    expect(await screen.findByText(/form was not submitted/)).toBeInTheDocument();
    expect(be.calls(SUBMIT)).toHaveLength(0);
  });

  it("already submitted elsewhere: reloads and shows the submitted form instead of submitting twice", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await fillDomestic();
    await next();
    await sign();
    be.queue(SUBMIT, () => {
      be.state.form = { ...be.state.form, status: "submitted", submittedAt: new Date().toISOString(), version: be.state.form.version + 1 };
      return apiError(409, "ALREADY_SUBMITTED");
    });
    await user.click(submitButton());
    expect(await screen.findByText("Registration submitted")).toBeInTheDocument();
  });
});

describe("after submission (policy: read-only)", () => {
  const submitted = () =>
    draftForm({
      status: "submitted",
      currentSection: "review",
      version: 9,
      submittedAt: "2026-10-21T10:30:00.000Z",
      data: { fullName: "Asha Rao", gender: "Female", classSection: "4 - B", dateOfBirth: "2016-05-04", nomineeName: "B Vijaya", nomineeRelation: "Mother", mealPreference: "Non-veg", phone: "9876543210" },
    });

  it("shows the submitted answers with no editable fields, and says how to ask for a change", async () => {
    const be = createFakeBackend({ signedIn: true, form: submitted() });
    mount(be);
    expect(await screen.findByText("Registration submitted")).toBeInTheDocument();
    expect(screen.getByText(/can no longer be edited here/)).toBeInTheDocument();
    expect(screen.getByText(/contact the school or Young Edsplorer/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Your submitted answers" })).getByText("Asha Rao")).toBeInTheDocument();
    expect(document.querySelectorAll("input, select, textarea")).toHaveLength(0);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Submit|Start over/ })).not.toBeInTheDocument();
  });

  it("a returning user whose form is submitted sees the submitted view, not an empty form", async () => {
    const be = createFakeBackend({ signedIn: true, form: submitted() });
    mount(be);
    await screen.findByText("Registration submitted");
    expect(screen.queryByRole("group", { name: "Which tour is this for?" })).not.toBeInTheDocument();
    expect(be.saves()).toHaveLength(0);
  });
});

describe("no 'Start over' and no navigation away inside the active form", () => {
  it("the form has no Start over control, no delete request is ever possible from it, and no My registrations link", async () => {
    const be = createFakeBackend({ signedIn: true, form: draftForm({ data: { fullName: "Asha" } }) });
    mount(be);
    await screen.findByRole("progressbar");
    expect(screen.queryByRole("button", { name: /Start over/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/deletes your saved answers/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /My registrations/ })).not.toBeInTheDocument();
    await user.click(step(/Review & submit/));
    expect(screen.queryByRole("button", { name: /Start over/i })).not.toBeInTheDocument();
    expect(be.calls(DELETE)).toHaveLength(0);
  });
});

describe("heading, greeting and layout", () => {
  it("shows no trip-type heading or intro sentence above the greeting", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "international");
    expect(screen.queryByRole("heading", { level: 1, name: "International Tour" })).not.toBeInTheDocument();
    expect(screen.queryByText(/review your answers before you submit/)).not.toBeInTheDocument();
  });

  it("the greeting names the trip's destination from the server, and leaves the place out when there is none", async () => {
    const trip = { address: { school: "g", branch: "main", trip: "t" }, school: "Greenfield", title: "Bali 2027", destination: "Bali", tourType: "domestic" };
    const be = createFakeBackend({ signedIn: true, join: trip });
    be.state.trip = trip;
    be.state.currentId = "00000000-0000-4000-9000-000000000001";
    be.state.form = draftForm();
    mount(be);
    const greeting = await screen.findByRole("region", { name: "Welcome message" });
    expect(greeting).toHaveTextContent("Dear Parents,");
    expect(greeting).toHaveTextContent("Thank you for your interest in the upcoming trip to Bali.");
    expect(greeting.textContent).not.toMatch(/PLACE|\[DESTINATION\]/);
  });

  it("without a destination the greeting has no placeholder", async () => {
    const be = createFakeBackend({ signedIn: true, form: draftForm() });
    mount(be);
    const greeting = await screen.findByRole("region", { name: "Welcome message" });
    expect(greeting).toHaveTextContent("Thank you for your interest in the upcoming trip. Please complete");
    expect(greeting.textContent).not.toMatch(/PLACE|DESTINATION|undefined|null/);
  });

  it("the active form shows no trip summary card, payment or itinerary", async () => {
    const trip = { address: { school: "g", branch: "main", trip: "t" }, school: "Greenfield", title: "Bali 2027", destination: "Bali", tourType: "domestic", paymentMode: "payment" };
    const be = createFakeBackend({ signedIn: true, join: trip });
    Object.assign(be.state, { trip, currentId: "00000000-0000-4000-9000-000000000001", form: draftForm() });
    mount(be);
    await screen.findByRole("progressbar");
    expect(screen.queryByText(/Itinerary/)).not.toBeInTheDocument();
    expect(screen.queryByText(/payment/i)).not.toBeInTheDocument();
    expect(document.querySelector(".trip-details")).toBeNull();
  });
});

describe("declaration and digital signature", () => {
  async function atReview(be) {
    await pickTour(be, "domestic");
    await fillDomestic();
    await next();
  }
  const checkbox = () => screen.getByRole("checkbox", { name: /I confirm that the information provided/ });
  const signatureInput = () => screen.getByLabelText(/Full name \(Digital Signature\)/);

  it("shows the server's declaration, unchecked, and an empty signature with today's date and an explanation", async () => {
    const be = createFakeBackend({ signedIn: true });
    await atReview(be);
    expect(checkbox()).not.toBeChecked();
    expect(checkbox()).toHaveAccessibleName(/accurate and complete to the best of my knowledge\. I understand that I should contact the school or Young Edsplorer/);
    expect(screen.getByRole("heading", { name: /Digital Signature/ })).toBeInTheDocument();
    expect(screen.getByText("Type your full legal name as your digital signature to confirm this submission.")).toBeInTheDocument();
    expect(signatureInput()).toHaveValue("");
    const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    expect(screen.getByText(today)).toBeInTheDocument();
    expect(screen.getByText(/records your electronic acknowledgement/)).toBeInTheDocument();
    // it sits right before the submit button
    expect(document.querySelector(".acknowledgement").compareDocumentPosition(submitButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("can't submit without accepting the declaration: an inline message, no request", async () => {
    const be = createFakeBackend({ signedIn: true });
    await atReview(be);
    await user.type(signatureInput(), "Asha Rao");
    await user.click(submitButton());
    expect(await screen.findByText("Please confirm the declaration to submit.")).toBeInTheDocument();
    expect(checkbox()).toHaveAttribute("aria-invalid", "true");
    expect(checkbox()).toHaveAttribute("aria-describedby", "declaration-error");
    expect(be.calls(SUBMIT)).toHaveLength(0);
    expect(be.state.form.status).toBe("draft");
  });

  it("can't submit without a real signature: empty, spaces only or one letter are refused inline", async () => {
    const be = createFakeBackend({ signedIn: true });
    await atReview(be);
    await user.click(checkbox());
    for (const typed of ["", "    ", "A"]) {
      await user.clear(signatureInput());
      if (typed) await user.type(signatureInput(), typed);
      await user.click(submitButton());
      expect(await screen.findByText("Type your full name as your signature.")).toBeInTheDocument();
      expect(signatureInput()).toHaveAttribute("aria-invalid", "true");
    }
    expect(be.calls(SUBMIT)).toHaveLength(0);
  });

  it("shows a live preview of the typed name", async () => {
    const be = createFakeBackend({ signedIn: true });
    await atReview(be);
    await user.type(signatureInput(), "  अनन्या शर्मा ");
    expect(document.querySelector(".signature-value")).toHaveTextContent("अनन्या शर्मा");
  });

  it("sends the declaration version and the trimmed signature, never a date; the confirmation shows who signed and when (server time)", async () => {
    const be = createFakeBackend({ signedIn: true });
    await atReview(be);
    await sign("  Asha Rao  ");
    await user.click(submitButton());
    expect(await screen.findByText("Registration submitted")).toBeInTheDocument();
    const body = be.calls(SUBMIT)[0].body;
    expect(body).toEqual({ version: body.version, declarationAccepted: true, declarationVersion: "2026-10-v1", signatureName: "Asha Rao", enrolmentId: "legacy" });
    expect(be.state.form.acknowledgement).toMatchObject({ declarationVersion: "2026-10-v1", signatureName: "Asha Rao" });
    const ack = within(screen.getByRole("region", { name: "Declaration and signature" }));
    expect(ack.getByText("Asha Rao")).toHaveClass("signature-value");
    expect(ack.getByText("Digital Signature")).toBeInTheDocument();
    expect(ack.queryByText(/electronic signature/i)).not.toBeInTheDocument();
    expect(ack.getByText("Declaration accepted")).toBeInTheDocument();
    expect(ack.getByText(/I confirm that the information provided in this registration form is accurate/)).toBeInTheDocument();
  });

  it("a declaration or signature refused by the server keeps the form a draft and says so", async () => {
    const be = createFakeBackend({ signedIn: true });
    await atReview(be);
    await sign();
    be.queue(SUBMIT, apiError(400, "VALIDATION_ERROR", { fields: [{ path: "signatureName", message: "Your signature contains characters that aren't allowed." }] }));
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Your signature contains characters that aren't allowed.");
    expect(be.state.form.status).toBe("draft");
    expect(screen.queryByText("Registration submitted")).not.toBeInTheDocument();
  });

  it("drafts never carry the declaration or signature", async () => {
    const be = createFakeBackend({ signedIn: true });
    await atReview(be);
    const before = be.saves().length;
    await sign("Unique Signer");
    await back();
    await waitFor(() => expect(be.saves().length).toBeGreaterThan(before));
    for (const save of be.saves()) {
      expect(JSON.stringify(save.body)).not.toMatch(/signature|declaration|Unique Signer/i);
    }
  });
});

describe("responsive layout hooks", () => {
  it("renders the section list and the form panel as separate regions that CSS can stack on small screens", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    expect(document.querySelector(".onboarding-body > .step-nav")).toBeTruthy();
    expect(document.querySelector(".onboarding-body > .step-panel")).toBeTruthy();
    expect(document.querySelector(".form-grid")).toBeTruthy();
  });
});

describe("age, phone and name fields", () => {
  it("there is no Age field: Date of birth stays editable, and saves never carry an age", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    expect(screen.queryByLabelText(/^Age/)).not.toBeInTheDocument();
    expect(labelsOnScreen()).not.toContain("Age");
    setDate(/Date of birth/, "2016-05-04");
    expect(field(/Date of birth/)).toHaveValue("2016-05-04");
    await waitFor(() => expect(be.saves().length).toBeGreaterThan(1));
    for (const s of be.saves()) expect(s.body.data).not.toHaveProperty("age");
  });

  it("the review and the submitted view don't show a separate Age either", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await fillDomestic();
    await next();
    expect(within(screen.getByLabelText("Personal details answers")).queryByText("Age")).not.toBeInTheDocument();
    await sign();
    await user.click(submitButton());
    await screen.findByText("Registration submitted");
    expect(within(screen.getByLabelText("Personal details answers")).queryByText("Age")).not.toBeInTheDocument();
  });

  it("the phone field has the right input type and no helper text under it", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await user.click(step(/Contact & remarks/));
    const phone = screen.getByLabelText(/^Phone number/);
    expect(phone).toHaveAttribute("type", "tel");
    expect(phone).toHaveAttribute("inputmode", "numeric");
    expect(phone).toHaveAttribute("autocomplete", "tel-national");
    expect(phone).toHaveAttribute("placeholder", "9876543210");
    expect(phone).not.toHaveAttribute("maxlength");
    expect(phone).toHaveAccessibleDescription("");
    expect(screen.queryByText(/10-digit|country code/)).not.toBeInTheDocument();
  });

  it("typing stops at 10 digits; 9 digits or a pasted country code get an inline message, and what was entered is kept", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    await user.click(step(/Contact & remarks/));
    const phone = screen.getByLabelText(/Phone number/);
    await user.type(phone, "987654321");
    await user.tab();
    expect(await screen.findByText("Enter all 10 digits of your mobile number (you entered 9).")).toBeInTheDocument();
    expect(phone).toHaveAttribute("aria-invalid", "true");
    expect(phone).toHaveValue("987654321");
    await user.type(phone, "012");
    expect(phone).toHaveValue("9876543210"); // the 11th and 12th keystrokes were ignored
    expect(phone).not.toHaveAttribute("aria-invalid");
    await user.clear(phone);
    await user.click(phone);
    await user.paste("+919876543210");
    expect(phone).toHaveValue("+919876543210"); // never cut down to something that merely looks valid
    expect(await screen.findByText("Enter your 10-digit mobile number without the country code (no + or 91 in front).")).toBeInTheDocument();
  });

  it("a name with digits gets a field-specific message and is kept as typed; an international name is fine", async () => {
    const be = createFakeBackend({ signedIn: true });
    await pickTour(be, "domestic");
    const name = field(/Full name/);
    await user.type(name, "Asha2");
    await user.tab();
    expect(await screen.findByText("Full name can't contain numbers.")).toBeInTheDocument();
    expect(name).toHaveValue("Asha2");
    await user.clear(name);
    await user.type(name, "José Ñúñez-O'Brien");
    expect(screen.queryByText(/Full name can/)).not.toBeInTheDocument();
  });

  it("a draft saved before, with a typed age, still opens (the age isn't shown or sent back)", async () => {
    const be = createFakeBackend({ signedIn: true, form: draftForm({ data: { fullName: "Asha Rao", dateOfBirth: "2016-05-04", age: "42" } }) });
    mount(be);
    await screen.findByRole("progressbar");
    expect(screen.queryByLabelText(/^Age/)).not.toBeInTheDocument();
    await user.type(field(/Full name/), "x");
    await waitFor(() => expect(be.saves().length).toBeGreaterThan(0));
    expect(be.saves().at(-1).body.data).not.toHaveProperty("age");
  });
});
