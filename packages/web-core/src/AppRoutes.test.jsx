import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AppRoutes from "./AppRoutes.jsx";
import { createFakeAdmin } from "./test/fakeAdmin.js";
import { PASSWORD, createFakeBackend } from "./test/fakeBackend.js";
import { apiError, deferred, reply, storageIsEmpty, watchConsole } from "./test/helpers.js";
import { preloadRouteChunks } from "./test/routeChunks.js";

// Load the lazy route chunks outside the timed assertions (see test/routeChunks.js).
beforeAll(preloadRouteChunks, 60_000);

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
  it("'/' is the parent landing with a Sales login link; /sales/login is the Sales sign-in; /parent is the parent portal", async () => {
    createFakeAdmin({ signedIn: false });
    const v = at("/");
    expect(await screen.findByRole("heading", { name: "Registration" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sales staff? Log in" })).toHaveAttribute("href", "/sales/login");
    v.unmount();
    const w = at("/sales/login");
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
    w.unmount();
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
    expect(be.calls(/\/api\/sales/)).toHaveLength(0);
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

describe("from the public page into registration", () => {
  it("'Register or log in' opens the portal still knowing the school, and sends nothing extra before that", async () => {
    const be = createFakeAdmin({ signedIn: false, joinResponses: { [JOIN_KEY]: reply(200, info()) } });
    at(JOIN_PATH);
    await screen.findByText("Type");
    expect(storageIsEmpty()).toBe(true); // just viewing the link stores nothing

    await user.click(screen.getByRole("link", { name: "Register or log in" }));
    expect(await screen.findByRole("tab", { name: "Register" })).toBeInTheDocument();
    expect(screen.queryByText(/Registering for|Logging in for/)).not.toBeInTheDocument();
    expect(be.calls(/\/api\/sales/)).toHaveLength(0);
  });
});

describe("/sales/login: first-time setup and forgot password", () => {
  const GOOD = "a-strong-pass-123";
  const openFlow = async (be) => {
    at("/sales");
    await screen.findByRole("heading", { name: "Sales log in" });
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
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
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
    const view = at("/sales");
    const heading = await screen.findByRole("heading", { name: "Sales log in" });
    expect(inside(heading, "main.parent-portal > section.glass-card > .auth-content")).toBe(true);
    expect(inside(heading, ".admin")).toBe(false);
    expect(screen.getByAltText("Young Edsplorer")).toHaveClass("brand-logo");
    expect(view.container.querySelector(".admin")).toBeNull();
    expect(screen.getByLabelText("Email address").closest(".input-wrap")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Log in/ })).toHaveClass("primary-button");
    expect(screen.getByText("Young Edsplorer sales team only")).toHaveClass("staff-caption");
  });

  it("every setup screen (email, code, password, done) is in the same card and outside .admin", async () => {
    const be = createFakeAdmin({ signedIn: false });
    at("/sales");
    await screen.findByRole("heading", { name: "Sales log in" });
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
    at("/sales");
    await screen.findByRole("heading", { name: "Sales log in" });
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
    at("/sales");
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
      at("/sales");
      await screen.findByRole("heading", { name: "Sales log in" });
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
    at("/sales");
    await screen.findByRole("heading", { name: "Sales log in" });
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
    const view = at("/sales");
    await screen.findByRole("heading", { name: "Sales dashboard" });
    expect(view.container.querySelector(".admin > .admin-header")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Sales portal sections" })).toBeInTheDocument();
    expect(document.querySelector(".parent-portal")).toBeNull();
  });
});

describe("/sales/password: change your own password", () => {
  const GOOD = "changed-pass-4321";
  const open = async (be) => {
    at("/sales/password");
    await screen.findByRole("heading", { name: "Change password" });
    return be;
  };
  const fill = async ({ current = "right-staff-password", next = GOOD, confirm = next } = {}) => {
    if (current) await user.type(screen.getByLabelText("Current password"), current);
    if (next) await user.type(screen.getByLabelText("New password"), next);
    if (confirm) await user.type(screen.getByLabelText("Confirm new password"), confirm);
    await user.click(screen.getByRole("button", { name: "Change password" }));
  };

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
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
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
    visit(["/sales"]);
    await user.click(await screen.findByRole("button", { name: "First time or forgot your password?" }));
    expect(where()).toBe("/sales/login/setup");
    expect(await screen.findByRole("heading", { name: "Set up or reset your password" })).toBeInTheDocument();
  });

  it("opening or refreshing the setup address starts at the email step with nothing carried over", async () => {
    createFakeAdmin({ signedIn: false });
    visit(["/sales/login/setup"]);
    expect(await screen.findByRole("heading", { name: "Set up or reset your password" })).toBeInTheDocument();
    expect(screen.getByLabelText("Work email address")).toHaveValue("");
    expect(storageIsEmpty()).toBe(true);
  });

  it("the browser's Back from the setup screen returns to the login screen (it is a real history step)", async () => {
    createFakeAdmin({ signedIn: false });
    visit(["/sales/login", "/sales/login/setup"]);
    await screen.findByRole("heading", { name: "Set up or reset your password" });
    // the history entry before it is the login page: this is what the Back button goes to
    await user.click(screen.getByRole("button", { name: "Back to log in" }));
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
    expect(where()).toBe("/sales/login");
  });

  it("email step: a visible back arrow returns to log in without sending anything", async () => {
    const be = createFakeAdmin({ signedIn: false });
    visit(["/sales/login/setup"]);
    const back = await screen.findByRole("button", { name: "Back to log in" });
    expect(back.querySelector("svg")).not.toBeNull();
    await user.click(back);
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
    expect(be.calls(/password\//)).toHaveLength(0);
  });

  it("code step: 'Change email' goes back to an EMPTY email step, so the next code goes to whatever is typed fresh", async () => {
    visit(["/sales/login/setup"]);
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
    visit(["/sales/login/setup"]);
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
    visit(["/sales/login/setup"]);
    await screen.findByRole("heading", { name: "Set up or reset your password" });
    await toPassword();
    await user.type(screen.getByLabelText("New password"), GOOD);
    await user.type(screen.getByLabelText("Confirm new password"), GOOD);
    await user.click(screen.getByRole("button", { name: "Save password" }));
    await user.click(await screen.findByRole("button", { name: /Go to log in/ }));
    expect(where()).toBe("/sales/login");
    expect(await screen.findByLabelText("Email address")).toHaveValue("sam@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("a signed-in person who opens the login or setup address is sent to the panel (no loop), and signed-out visitors cannot see protected pages", async () => {
    const inBe = createFakeAdmin();
    const view = visit(["/sales/login/setup"]);
    expect(await screen.findByRole("heading", { name: "Sales dashboard" })).toBeInTheDocument();
    expect(where()).toBe("/sales/dashboard");
    view.unmount();
    expect(inBe.calls(/auth\/session/).length).toBeGreaterThan(0);

    const outBe = createFakeAdmin({ signedIn: false });
    for (const path of ["/sales/staff", "/sales/dashboard", "/sales/password", "/sales/schools/x", "/sales/trips/x"]) {
      const v = visit([path]);
      expect(await screen.findByRole("heading", { name: "Sales log in" }), path).toBeInTheDocument();
      expect(where(), path).toBe("/sales/login");
      v.unmount();
    }
    // protected data was never requested without a session
    expect(outBe.calls(/api\/admin\/(staff|audit|schools|trips)/)).toHaveLength(0);
  });

  describe("change password page", () => {
    it("leaves immediately when nothing was typed, and asks first when something was", async () => {
      createFakeAdmin();
      visit(["/sales/password"]);
      await user.type(await screen.findByLabelText("Current password"), "right-staff-password");
      await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
      expect(screen.getByRole("alertdialog", { name: "Leave this page?" })).toBeInTheDocument();
      expect(where()).toBe("/sales/password");
      await user.click(screen.getByRole("button", { name: "Stay" }));
      expect(screen.getByLabelText("Current password")).toHaveValue("right-staff-password");
      await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
      await user.click(screen.getByRole("button", { name: "Leave" }));
      expect(await screen.findByRole("heading", { name: "Sales dashboard" })).toBeInTheDocument();
      expect(where()).toBe("/sales/dashboard");
    });

    it("a clean form goes back without any question", async () => {
      createFakeAdmin();
      visit(["/sales/password"]);
      await user.click(await screen.findByRole("button", { name: "Back to dashboard" }));
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: "Sales dashboard" })).toBeInTheDocument();
    });
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

describe("show / hide password on every staff password field", () => {
  const toggle = (name) => screen.getByRole("button", { name });

  it("staff login: masked by default, can be shown, and signing in works while shown", async () => {
    const be = createFakeAdmin({ signedIn: false });
    at("/sales");
    await screen.findByRole("heading", { name: "Sales log in" });
    const pw = screen.getByLabelText("Password");
    expect(pw).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("Email address"), "sales@example.com");
    await user.type(pw, "right-staff-password");
    await user.click(toggle("Show password"));
    expect(pw).toHaveAttribute("type", "text");
    expect(pw).toHaveAttribute("autocomplete", "current-password");
    await user.click(screen.getByRole("button", { name: /^Log in/ }));
    expect(await screen.findByRole("heading", { name: "Sales dashboard" })).toBeInTheDocument();
    expect(be.calls(/POST \/api\/admin\/auth\/login/)[0].body.password).toBe("right-staff-password");
  });

  it("first-time setup: new and confirm fields have independent toggles", async () => {
    createFakeAdmin({ signedIn: false });
    at("/sales");
    await screen.findByRole("heading", { name: "Sales log in" });
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
    at("/sales/password");
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
    at("/sales/password");
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
    visit("/sales/login");
    await screen.findByRole("heading", { name: "Sales log in" });
    await signIn("sales@example.com");
    expect(await screen.findByRole("heading", { name: "Sales dashboard" })).toBeInTheDocument();
    expect(where()).toBe("/sales/dashboard");
  });

  it.each(["/sales", "/sales/dashboard", "/sales/schools/new", "/sales/trips/x/links"])("signed out, %s goes to the Sales log in", async (path) => {
    const be = createFakeAdmin({ signedIn: false });
    visit(path);
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
    expect(where()).toBe("/sales/login");
    expect(be.calls(/GET \/api\/admin\/(schools|trips)/)).toHaveLength(0);
  });

  it("parents have their own sign-in at /parent/login, with links to the staff portals for anyone who landed there by mistake", async () => {
    createFakeAdmin({ signedIn: false });
    visit("/parent/login");
    expect(await screen.findByRole("tab", { name: "Login", selected: true })).toBeInTheDocument();
    expect(screen.getByText(/Parent portal\. Young Edsplorer staff\?/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sales log in" })).toHaveAttribute("href", "/sales/login");
    expect(screen.getByRole("link", { name: "Sales log in" })).toHaveAttribute("href", "/sales/login");
    expect(screen.queryByRole("navigation", { name: /portal sections/ })).not.toBeInTheDocument();
  });

  it("an old /registrations/<id> address moves to /parent/registrations/<id>", async () => {
    createFakeBackend({ signedIn: false });
    visit("/registrations/00000000-0000-4000-9000-000000000001");
    await screen.findByRole("tab", { name: "Register" });
    expect(where()).toBe("/parent/registrations/00000000-0000-4000-9000-000000000001");
  });
});


describe("entry points: / is the Sales portal, /admin the Sales portal, parents only via their own routes and trip links", () => {
  const Here = () => <p data-testid="where">{useLocation().pathname}</p>;
  const visit = (path) => render(<MemoryRouter initialEntries={[path]}><AppRoutes /><Here /></MemoryRouter>);
  const staffVisit = (path) => render(<MemoryRouter initialEntries={[path]}><AppRoutes target="staff" /><Here /></MemoryRouter>);
  const where = () => screen.getByTestId("where").textContent;
  const SUBMITTED = { tourType: "domestic", role: "student", status: "submitted", data: { fullName: "Asha Rao" }, currentSection: "review", version: 4, updatedAt: "2026-10-01T00:00:00.000Z", submittedAt: "2026-10-01T00:00:00.000Z" };
  const TRIP = { address: { school: "sunrise-academy", branch: "main", trip: "shimla" }, school: "Sunrise Academy", title: "Shimla", destination: "Himachal Pradesh", tourType: "domestic" };

  it("1. / in a fresh browser shows the Sales log in, never the parent form", async () => {
    const be = createFakeAdmin({ signedIn: false });
    staffVisit("/");
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
    expect(where()).toBe("/sales/login");
    expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();
    expect(be.calls(/\/api\/(auth\/session|onboarding|enrolments)/)).toHaveLength(0); // the parent session is not even looked at
  });

  it("2. / with a Sales session shows the Sales dashboard", async () => {
    createFakeAdmin({ role: "sales" });
    staffVisit("/");
    expect(await screen.findByRole("heading", { name: "Sales dashboard" })).toBeInTheDocument();
    expect(where()).toBe("/sales/dashboard");
  });

  it("3. / with a parent session (and a submitted registration) shows the Sales log in, never the parent's registration", async () => {
    const be = createFakeBackend({ signedIn: true, form: SUBMITTED });
    be.queue("GET /api/admin/auth/session", apiError(401, "UNAUTHENTICATED")); // no staff session
    staffVisit("/");
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
    visit("/sales");
    expect(await screen.findByRole("heading", { name: "Sales log in" })).toBeInTheDocument();
    expect(where()).toBe("/sales/login");
  });

  it("5. /admin signed in as Admin shows the Admin dashboard", async () => {
    createFakeAdmin({ role: "sales" });
    visit("/sales");
    expect(await screen.findByRole("heading", { name: "Sales dashboard" })).toBeInTheDocument();
    expect(where()).toBe("/sales/dashboard");
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
    expect(screen.getByRole("link", { name: "Sales portal" })).toHaveAttribute("href", "/sales");
    expect(screen.getByRole("link", { name: "Parent log in" })).toHaveAttribute("href", "/parent/login");
  });
});

describe("presentation clean-up (Sales and Admin)", () => {
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
