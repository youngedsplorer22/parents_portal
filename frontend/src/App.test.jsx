import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import { PASSWORD, createFakeBackend, USER } from "./test/fakeBackend.js";
import { CHALLENGE, TOKEN, apiError, deferred, reply, storageIsEmpty, watchConsole } from "./test/helpers.js";

const SESSION = "GET /api/auth/session";
const SEND = "POST /api/email-otp/send";
const RESEND = "POST /api/email-otp/resend";
const VERIFY = "POST /api/email-otp/verify";
const REGISTER = "POST /api/registrations";
const LOGIN = "POST /api/auth/login";
const LOGIN_PW = "POST /api/auth/login/password";
const RESET_REQUEST = "POST /api/auth/password-reset/request";
const RESET_RESEND = "POST /api/auth/password-reset/resend";
const RESET_VERIFY = "POST /api/auth/password-reset/verify";
const RESET_CONFIRM = "POST /api/auth/password-reset/confirm";
const LOGOUT = "POST /api/auth/logout";
const ONBOARDING = "GET /api/onboarding";
const ENROL = "POST /api/enrolments";
const RESUME = "GET /api/enrolments/resume";

let user;
beforeEach(() => {
  user = userEvent.setup();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const field = (label) => screen.getByLabelText(label);
async function fillForm({ email = "  Parent@Example.com ", role = "Student", password = PASSWORD } = {}) {
  await user.type(field(/first name/i), "Asha");
  await user.type(field(/last name/i), "Rao");
  await user.selectOptions(field(/role/i), role);
  await user.type(field(/phone/i), "9876543210");
  await user.type(field(/email address/i), email);
  await user.type(field(/^password/i), password);
}
const submitButton = () => screen.getByRole("button", { name: /Verify email|Continue|Sending code/ });
const boxes = () => screen.getAllByLabelText(/Digit \d of 6/);
// Signed in on the plain homepage with no registration: the parent is asked to open their school's trip link.
const signedInHome = () => screen.findByRole("heading", { name: "Open your school's trip registration link" });

async function showRegisterForm(join) {
  render(<App join={join} />);
  await screen.findByRole("tab", { name: "Register" }); // the session check has finished
}
async function reachOtpStep(join) {
  await showRegisterForm(join);
  await fillForm();
  await user.click(submitButton());
  await screen.findByRole("heading", { name: "Enter verification code" });
}
async function enterCode(code = "482913") {
  await user.click(boxes()[0]);
  await user.paste(code);
  await user.click(screen.getByRole("button", { name: /Verify OTP/ }));
}

describe("First Name / Last Name fields (regression)", () => {
  it("hold independent values", async () => {
    createFakeBackend();
    await showRegisterForm();
    await user.type(field(/first name/i), "Asha");
    await user.type(field(/last name/i), "Rao");
    expect(field(/first name/i)).toHaveValue("Asha");
    expect(field(/last name/i)).toHaveValue("Rao");
    await user.type(field(/first name/i), " Devi");
    expect(field(/last name/i)).toHaveValue("Rao");
  });

  it("are validated separately, each showing its own error", async () => {
    const be = createFakeBackend();
    await showRegisterForm();
    await user.type(field(/first name/i), "Asha");
    await user.click(submitButton());
    expect(screen.getByText("Please enter your last name.")).toBeInTheDocument();
    expect(screen.queryByText("Please enter your first name.")).not.toBeInTheDocument();

    await user.clear(field(/first name/i));
    await user.click(submitButton());
    expect(screen.getByText("Please enter your first name.")).toBeInTheDocument();
    expect(be.calls(SEND)).toHaveLength(0);
  });

  it("clears an error as soon as the field is edited", async () => {
    createFakeBackend();
    await showRegisterForm();
    await user.click(submitButton());
    expect(screen.getByText("Please enter your last name.")).toBeInTheDocument();
    await user.type(field(/last name/i), "R");
    expect(screen.queryByText("Please enter your last name.")).not.toBeInTheDocument();
  });
});

describe("registration: sending the code", () => {
  it("validates everything before any request is made", async () => {
    const be = createFakeBackend();
    await showRegisterForm();
    await user.click(submitButton());
    for (const message of [
      "Please enter your first name.",
      "Please enter your last name.",
      "Please select your role.",
      "Phone number is required.",
      "Email address is required.",
      "Create a password.",
    ]) {
      expect(screen.getByText(message)).toBeInTheDocument();
    }
    expect(screen.queryByText("Confirm your password.")).not.toBeInTheDocument();
    expect(be.calls().map((c) => c.key)).toEqual([SESSION]);
  });

  it("sends the normalised email for the registration purpose, then shows the OTP step", async () => {
    const be = createFakeBackend();
    await reachOtpStep();
    expect(be.calls(SEND)).toHaveLength(1);
    expect(be.calls(SEND)[0].body).toEqual({ email: "parent@example.com", purpose: "registration" });
    expect(screen.getByText("parent@example.com")).toBeInTheDocument();
    expect(screen.getByText("Code expires in 5:00")).toBeInTheDocument();
  });

  it("shows a sending state and ignores a second submit", async () => {
    const be = createFakeBackend();
    const pending = deferred();
    be.queue(SEND, () => pending.promise);
    await showRegisterForm();
    await fillForm();
    await user.click(submitButton());
    expect(submitButton()).toHaveTextContent("Sending code…");
    expect(submitButton()).toBeDisabled();
    await user.click(submitButton());
    expect(be.calls(SEND)).toHaveLength(1);
    await act(async () => pending.resolve(reply(200, CHALLENGE)));
    await screen.findByRole("heading", { name: "Enter verification code" });
  });

  it.each([
    ["DELIVERY_FAILED", 502, {}, /couldn't send the email/],
    ["RATE_LIMITED", 429, { retryAfterSeconds: 600 }, /Too many verification requests/],
    ["RESEND_COOLDOWN", 429, { retryAfterSeconds: 20 }, /Please wait 20s/],
  ])("%s: stays on the form with a clear error and lets the user retry", async (code, status, details, message) => {
    const be = createFakeBackend();
    be.queue(SEND, apiError(status, code, details));
    await showRegisterForm();
    await fillForm();
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(field(/first name/i)).toHaveValue("Asha");
    expect(submitButton()).toBeEnabled();

    await user.click(submitButton());
    await screen.findByRole("heading", { name: "Enter verification code" });
    expect(be.calls(SEND)).toHaveLength(2);
  });

  it("explains a network failure", async () => {
    const be = createFakeBackend();
    be.queue(SEND, () => {
      throw new TypeError("Failed to fetch");
    });
    await showRegisterForm();
    await fillForm();
    await user.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Can't reach the server/);
  });

  it("returning to the form and resubmitting the same email reuses the pending code", async () => {
    const be = createFakeBackend();
    be.queue(SEND, reply(200, CHALLENGE), reply(200, { ...CHALLENGE, expiresInSeconds: 250, alreadySent: true }));
    await showRegisterForm();
    await fillForm();
    await user.click(submitButton());
    await screen.findByRole("heading", { name: "Enter verification code" });

    await user.click(screen.getByRole("button", { name: /Change email/ }));
    expect(field(/last name/i)).toHaveValue("Rao");
    await user.click(submitButton());
    expect(await screen.findByRole("status")).toHaveTextContent(/already sent/i);
  });

  it("resend from the registration OTP step uses the existing /resend endpoint", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const be = createFakeBackend();
    user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await reachOtpStep();
    await act(async () => vi.advanceTimersByTime(31_000));
    await user.click(screen.getByRole("button", { name: /Resend/ }));
    await waitFor(() => expect(be.calls(RESEND)).toHaveLength(1));
    expect(be.calls(RESEND)[0].body).toEqual({ email: "parent@example.com", purpose: "registration" });
  });
});

describe("OTP success goes straight to the onboarding form", () => {
  it("verifies, creates the account and opens the form, with no verified/review screen and no second button", async () => {
    const be = createFakeBackend();
    await reachOtpStep();
    await enterCode();

    await signedInHome(); // signed in: with no trip yet, the parent is pointed at their school's link
    expect(screen.queryByRole("heading", { name: "Email verified" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Complete registration/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Your registration is not complete until/)).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Register" })).not.toBeInTheDocument();

    // The order of the requests: check session, send, verify, create the account, confirm the session, ask the server
    // which registration to open (none here: no trip was chosen, so none is invented).
    expect(be.calls().map((c) => c.key)).toEqual([SESSION, SEND, VERIFY, REGISTER, SESSION, RESUME]);
    expect(be.calls(VERIFY)[0].body).toEqual({ email: "parent@example.com", purpose: "registration", code: "482913" });
  });

  it("registers with the verified token and the form details, and the token appears only in that request", async () => {
    const be = createFakeBackend();
    await reachOtpStep();
    await enterCode();
    await signedInHome();

    expect(be.calls(REGISTER)).toHaveLength(1);
    expect(be.calls(REGISTER)[0].body).toEqual({
      firstName: "Asha",
      lastName: "Rao",
      role: "Student",
      phone: "9876543210",
      email: "parent@example.com",
      password: PASSWORD,
      verificationToken: TOKEN,
    });
    const elsewhere = be.calls().filter((c) => c.key !== REGISTER);
    expect(JSON.stringify(elsewhere.map((c) => [c.url, c.body]))).not.toContain(TOKEN);
  });

  it("shows a progress state while the account is being created, and never claims success before the server does", async () => {
    const be = createFakeBackend();
    const pending = deferred();
    be.queue(REGISTER, () => pending.promise);
    await reachOtpStep();
    await enterCode();

    expect(await screen.findByRole("heading", { name: "Setting up your account…" })).toBeInTheDocument();
    expect(screen.queryByText("Which tour is this for?")).not.toBeInTheDocument();
    expect(screen.queryByText(/Registration complete|Email verified|Account created/)).not.toBeInTheDocument();

    be.state.signedIn = true; // the real server starts the session together with the account
    await act(async () => pending.resolve(reply(201, { registered: true, registrationId: "8f0c2d3e-1111-4222-8333-444455556666", email: "parent@example.com" })));
    await signedInHome();
  });

  it("keeps the token in memory only: not on screen, not in storage, not in the console, not in the URL", async () => {
    const logged = watchConsole();
    createFakeBackend();
    await reachOtpStep();
    await enterCode();
    await signedInHome();

    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    expect(storageIsEmpty()).toBe(true);
    expect(logged(TOKEN)).toBe(false);
    expect(logged("482913")).toBe(false);
  });

  it("a server error keeps the user in place, and Try again uses the same token", async () => {
    const be = createFakeBackend();
    be.queue(REGISTER, apiError(500, "INTERNAL_ERROR"));
    await reachOtpStep();
    await enterCode();

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't complete your registration/);
    expect(screen.queryByText("Which tour is this for?")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await signedInHome();
    expect(be.calls(REGISTER)).toHaveLength(2);
    expect(be.calls(REGISTER)[1].body.verificationToken).toBe(TOKEN);
    expect(be.calls(VERIFY)).toHaveLength(1); // no second verification needed
  });

  it("a network failure says the result could not be confirmed and allows a retry", async () => {
    const be = createFakeBackend();
    be.queue(REGISTER, () => {
      throw new TypeError("Failed to fetch");
    });
    await reachOtpStep();
    await enterCode();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Can't reach the server, so we couldn't confirm your registration/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("duplicate email: back to the form with the email error and every other value intact", async () => {
    createFakeBackend({ accounts: ["parent@example.com"] });
    await reachOtpStep();
    await enterCode();

    expect(await screen.findByText(/already registered/)).toBeInTheDocument();
    expect(field(/first name/i)).toHaveValue("Asha");
    expect(field(/last name/i)).toHaveValue("Rao");
    expect(field(/role/i)).toHaveValue("Student");
    expect(field(/phone/i)).toHaveValue("9876543210");
    expect(field(/email address/i)).toHaveValue("  Parent@Example.com ".trim());
    expect(screen.queryByText("Which tour is this for?")).not.toBeInTheDocument();
  });

  it("expired or used verification: back to the form, asks to verify again, keeps the details", async () => {
    const be = createFakeBackend();
    be.queue(REGISTER, apiError(403, "VERIFICATION_REQUIRED"));
    await reachOtpStep();
    await enterCode();
    expect(await screen.findByRole("alert")).toHaveTextContent(/verify your email again/);
    expect(field(/first name/i)).toHaveValue("Asha");
    expect(submitButton()).toHaveTextContent("Verify email");
  });

  it("server-side validation errors appear next to the fields they belong to", async () => {
    const be = createFakeBackend();
    be.queue(REGISTER, apiError(400, "VALIDATION_ERROR", { fields: [{ path: "phone", message: "Enter a valid phone number." }] }));
    await reachOtpStep();
    await enterCode();
    expect(await screen.findByText("Enter a valid phone number.")).toBeInTheDocument();
    expect(field(/first name/i)).toHaveValue("Asha");
  });

  it("if the account was created but no session can be confirmed, it says so and points to Login (no false success)", async () => {
    const be = createFakeBackend();
    await reachOtpStep();
    be.queue(SESSION, apiError(401, "UNAUTHENTICATED", { renewable: false })); // the new sign-in's cookies didn't arrive
    await enterCode();
    expect(await screen.findByRole("heading", { name: "Account created" })).toBeInTheDocument();
    expect(screen.getByText(/couldn't sign you in automatically/)).toBeInTheDocument();
    expect(screen.queryByText("Which tour is this for?")).not.toBeInTheDocument();
  });

  it("failure paths never expose the token either", async () => {
    const logged = watchConsole();
    const be = createFakeBackend();
    be.queue(REGISTER, apiError(500, "INTERNAL_ERROR"));
    await reachOtpStep();
    await enterCode();
    await screen.findByRole("alert");
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(storageIsEmpty()).toBe(true);
    expect(logged(TOKEN)).toBe(false);
  });

  it("changing the email after returning to the form discards the pending verification", async () => {
    const be = createFakeBackend();
    be.queue(REGISTER, apiError(500, "INTERNAL_ERROR"));
    await reachOtpStep();
    await enterCode();
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Back to form" }));
    await user.clear(field(/email address/i));
    await user.type(field(/email address/i), "other@example.com");
    await user.click(submitButton());
    await screen.findByRole("heading", { name: "Enter verification code" });
    expect(be.calls(SEND)).toHaveLength(2);
  });
});

describe("login", () => {
  const goToLogin = async () => {
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Login" }));
  };
  async function loginToCode(be) {
    await goToLogin();
    await user.type(field(/email address/i), " Parent@Example.com ");
    await user.click(screen.getByRole("button", { name: /Send OTP/ }));
    await screen.findByRole("heading", { name: "Enter verification code" });
    return be;
  }

  it("is a real flow: sends a login code, verifies it, and opens the form only after the server signs the user in", async () => {
    const be = createFakeBackend({ accounts: ["parent@example.com"] });
    await loginToCode(be);
    await enterCode();
    await signedInHome();

    expect(be.calls(SEND)[0].body).toEqual({ email: "parent@example.com", purpose: "login" });
    expect(be.calls(VERIFY)[0].body).toEqual({ email: "parent@example.com", purpose: "login", code: "482913" });
    expect(be.calls(LOGIN)).toHaveLength(1);
    expect(be.calls(LOGIN)[0].body).toEqual({ email: "parent@example.com", verificationToken: TOKEN });
    expect(be.calls(REGISTER)).toHaveLength(0);
    expect(screen.getByText("Hi, Asha")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(storageIsEmpty()).toBe(true);
  });

  it("no longer shows the demo-mode note, and a wrong email format is caught before any request", async () => {
    const be = createFakeBackend();
    await goToLogin();
    await user.type(field(/email address/i), "nope");
    await user.click(screen.getByRole("button", { name: /Send OTP/ }));
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(be.calls(SEND)).toHaveLength(0);
    expect(screen.queryByText(/Demo mode/)).not.toBeInTheDocument();
  });

  it("a verified email with no account goes back to the email step with a clear message", async () => {
    const be = createFakeBackend();
    be.queue(LOGIN, apiError(404, "ACCOUNT_NOT_FOUND"));
    await loginToCode(be);
    await enterCode();
    expect(await screen.findByText(/couldn't find an account/)).toBeInTheDocument();
    expect(screen.queryByText("Which tour is this for?")).not.toBeInTheDocument();
    expect(field(/email address/i)).toBeInTheDocument();
  });

  it("a network failure while logging in offers Try again with the same token", async () => {
    const be = createFakeBackend({ accounts: ["parent@example.com"] });
    be.queue(LOGIN, () => {
      throw new TypeError("Failed to fetch");
    });
    await loginToCode(be);
    await enterCode();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Can't reach the server/);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await signedInHome();
    expect(be.calls(LOGIN)).toHaveLength(2);
    expect(be.calls(LOGIN)[1].body.verificationToken).toBe(TOKEN);
  });

  it("a send error stays on the login form", async () => {
    const be = createFakeBackend();
    be.queue(SEND, apiError(429, "RATE_LIMITED", { retryAfterSeconds: 60 }));
    await goToLogin();
    await user.type(field(/email address/i), "parent@example.com");
    await user.click(screen.getByRole("button", { name: /Send OTP/ }));
    expect(await screen.findByText(/Too many verification requests/)).toBeInTheDocument();
  });
});

describe("session handling", () => {
  it("a returning user with a valid session goes straight to their saved form (nothing to log in again)", async () => {
    const be = createFakeBackend({ signedIn: true });
    render(<App />);
    await signedInHome();
    expect(be.calls().map((c) => c.key)).toEqual([SESSION, RESUME]);
    expect(screen.queryByRole("tab", { name: "Login" })).not.toBeInTheDocument();
  });

  it("an expired session (401 loading the form) returns to Login with a notice", async () => {
    const be = createFakeBackend({ signedIn: true });
    be.state.refreshOk = false; // the sign-in itself is over, so the page's one renewal attempt is refused
    be.queue(RESUME, apiError(401, "UNAUTHENTICATED"));
    render(<App />);
    expect(await screen.findByText("Your session has ended. Please log in again.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Login", selected: true })).toBeInTheDocument();
  });

  it("log out ends the session on the server and returns to the login screen", async () => {
    const be = createFakeBackend({ signedIn: true });
    render(<App />);
    await signedInHome();
    await user.click(screen.getByRole("button", { name: /Log out/ }));
    await screen.findByRole("tab", { name: "Login" });
    expect(be.calls(LOGOUT)).toHaveLength(1);
    expect(be.state.signedIn).toBe(false);
    expect(screen.queryByText("Hi, Asha")).not.toBeInTheDocument();
  });

  it("a failed log out stays signed in and says so", async () => {
    const be = createFakeBackend({ signedIn: true });
    be.queue(LOGOUT, () => {
      throw new TypeError("Failed to fetch");
    });
    render(<App />);
    await signedInHome();
    await user.click(screen.getByRole("button", { name: /Log out/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't log you out/);
    expect(screen.getByText("Hi, Asha")).toBeInTheDocument();
  });

  it("if the session check cannot reach the server the user sees the login screen, not an empty page", async () => {
    const be = createFakeBackend();
    be.queue(SESSION, () => {
      throw new TypeError("Failed to fetch");
    });
    render(<App />);
    expect(await screen.findByRole("tab", { name: "Login" })).toBeInTheDocument();
    expect(within(screen.getByRole("tablist")).getAllByRole("tab")).toHaveLength(2);
  });

  it("switching tabs drops an in-memory verification and the login still works afterwards", async () => {
    createFakeBackend();
    await reachOtpStep();
    await user.click(screen.getByRole("button", { name: /Change email/ }));
    await user.click(screen.getByRole("tab", { name: "Login" }));
    expect(screen.getByRole("button", { name: /Send OTP/ })).toBeInTheDocument();
  });

  it("the HttpOnly session cookie is never read or stored by the page", async () => {
    createFakeBackend({ signedIn: true });
    render(<App />);
    await signedInHome();
    expect(document.cookie).toBe("");
    expect(storageIsEmpty()).toBe(true);
    expect(USER.email).toBeTruthy();
  });
});

describe("registration: password", () => {
  it("has a single masked Password field and no confirm-password or school field", async () => {
    createFakeBackend();
    await showRegisterForm();
    expect(field(/^password/i)).toHaveAttribute("type", "password");
    expect(field(/^password/i)).toHaveAttribute("autocomplete", "new-password");
    expect(screen.queryByLabelText(/confirm password/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/school/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeInTheDocument();
    for (const label of [/first name/i, /last name/i, /^role/i, /phone/i, /email address/i]) expect(field(label)).toBeInTheDocument();
  });

  it("checks length before any request, and clears each error when the field is edited", async () => {
    const be = createFakeBackend();
    await showRegisterForm();
    await fillForm({ password: "short" });
    await user.click(submitButton());
    expect(screen.getByText("Password must be at least 10 characters.")).toBeInTheDocument();
    expect(be.calls(SEND)).toHaveLength(0);

    await user.type(field(/^password/i), "-and-longer");
    expect(screen.queryByText("Password must be at least 10 characters.")).not.toBeInTheDocument();
  });

  it("the password goes only to the registration request, and is never on screen, in storage or in the console", async () => {
    const logged = watchConsole();
    const be = createFakeBackend();
    await reachOtpStep();
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    await enterCode();
    await signedInHome();

    expect(be.calls(REGISTER)[0].body).toMatchObject({ password: PASSWORD });
    expect(be.calls(REGISTER)[0].body).not.toHaveProperty("confirmPassword");
    const others = be.calls().filter((c) => c.key !== REGISTER);
    expect(JSON.stringify(others.map((c) => [c.url, c.body]))).not.toContain(PASSWORD);
    expect(document.body.textContent).not.toContain(PASSWORD);
    expect(storageIsEmpty()).toBe(true);
    expect(logged(PASSWORD)).toBe(false);
    expect(window.location.href).not.toContain(PASSWORD);
  });

  it("a password the server refuses (here: a common one) sends the user back to the form with that field marked", async () => {
    createFakeBackend();
    await showRegisterForm();
    await fillForm({ password: "password123" }); // long enough for the browser check, too common for the server
    await user.click(submitButton());
    await screen.findByRole("heading", { name: "Enter verification code" });
    await enterCode();
    expect(await screen.findByText(/too common/i)).toBeInTheDocument();
    expect(field(/first name/i)).toHaveValue("Asha");
    expect(screen.getByRole("alert")).toHaveTextContent(/check the highlighted details/i);
  });
});

describe("login: email and password", () => {
  const goToLogin = async (be) => {
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Login" }));
    return be;
  };
  const OK = { accounts: ["parent@example.com"], passwords: { "parent@example.com": PASSWORD } };

  it("shows email and password fields, a Log in button, and keeps Send OTP as an alternative", async () => {
    await goToLogin(createFakeBackend(OK));
    expect(field(/email address/i)).toBeInTheDocument();
    expect(field(/^password/i)).toHaveAttribute("type", "password");
    expect(field(/^password/i)).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByRole("button", { name: /Log in/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send OTP/ })).toBeInTheDocument();
  });

  it("signs in only after the server confirms, then opens the form", async () => {
    const be = await goToLogin(createFakeBackend(OK));
    await user.type(field(/email address/i), " Parent@Example.com ");
    await user.type(field(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    await signedInHome();

    expect(be.calls(LOGIN_PW)).toHaveLength(1);
    expect(be.calls(LOGIN_PW)[0].body).toEqual({ email: "parent@example.com", password: PASSWORD });
    expect(be.calls(SEND)).toHaveLength(0);
    expect(screen.queryByRole("tab", { name: "Login" })).not.toBeInTheDocument();
  });

  it("a wrong password shows one generic message, keeps the email, empties the password and stays signed out", async () => {
    const be = await goToLogin(createFakeBackend(OK));
    await user.type(field(/email address/i), "parent@example.com");
    await user.type(field(/^password/i), "wrong-password-here");
    await user.click(screen.getByRole("button", { name: /Log in/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The email or password is incorrect. You can also sign in with an email code.");
    expect(field(/email address/i)).toHaveValue("parent@example.com");
    expect(field(/^password/i)).toHaveValue("");
    expect(screen.getByRole("tab", { name: "Login" })).toBeInTheDocument();
    expect(be.state.signedIn).toBe(false);
  });

  it("an unknown email gets exactly the same message", async () => {
    await goToLogin(createFakeBackend(OK));
    await user.type(field(/email address/i), "nobody@example.com");
    await user.type(field(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The email or password is incorrect.");
  });

  it("rate limiting is explained with the wait time and points to the email code", async () => {
    const be = await goToLogin(createFakeBackend(OK));
    be.queue(LOGIN_PW, apiError(429, "RATE_LIMITED", { retryAfterSeconds: 540 }));
    await user.type(field(/email address/i), "parent@example.com");
    await user.type(field(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many sign-in attempts\. Try again in about 9 minutes, or sign in with an email code instead\./);
    expect(field(/^password/i)).toHaveValue(PASSWORD); // a limit is not the user's typo, so the field is kept
  });

  it("a busy server (503) says so with a short wait, keeps what was typed, and the retry signs in", async () => {
    const be = await goToLogin(createFakeBackend(OK));
    be.queue(LOGIN_PW, apiError(503, "SERVER_BUSY", { retryAfterSeconds: 3 }));
    await user.type(field(/email address/i), "parent@example.com");
    await user.type(field(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Lots of people are signing in right now. Please try again in a few seconds.");
    expect(field(/^password/i)).toHaveValue(PASSWORD);
    expect(be.state.signedIn).toBe(false);
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    await waitFor(() => expect(be.state.signedIn).toBe(true));
    expect(be.calls(LOGIN_PW)).toHaveLength(2);
  });

  it("checks for empty fields before any request", async () => {
    const be = await goToLogin(createFakeBackend(OK));
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    expect(screen.getByText("Email address is required.")).toBeInTheDocument();
    expect(screen.getByText("Password is required.")).toBeInTheDocument();
    expect(be.calls(LOGIN_PW)).toHaveLength(0);
  });

  it("a network failure is reported honestly and nothing is claimed", async () => {
    const be = await goToLogin(createFakeBackend(OK));
    be.queue(LOGIN_PW, () => {
      throw new TypeError("Failed to fetch");
    });
    await user.type(field(/email address/i), "parent@example.com");
    await user.type(field(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Can't reach the server/);
    expect(screen.getByRole("button", { name: /Log in/ })).toBeEnabled();
  });

  it("shows a pending state and ignores a second submit", async () => {
    const be = await goToLogin(createFakeBackend(OK));
    const pending = deferred();
    be.queue(LOGIN_PW, () => pending.promise);
    await user.type(field(/email address/i), "parent@example.com");
    await user.type(field(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    expect(screen.getByRole("button", { name: /Logging in/ })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(be.calls(LOGIN_PW)).toHaveLength(1);
    be.state.signedIn = true;
    await act(async () => pending.resolve(reply(200, { authenticated: true, user: USER })));
    await signedInHome();
  });

  it("Send OTP still works without a password, and never sends the typed password", async () => {
    const be = await goToLogin(createFakeBackend(OK));
    await user.type(field(/email address/i), "parent@example.com");
    await user.type(field(/^password/i), "typed-but-not-for-the-code");
    await user.click(screen.getByRole("button", { name: /Send OTP/ }));
    await screen.findByRole("heading", { name: "Enter verification code" });
    expect(be.calls(SEND)[0].body).toEqual({ email: "parent@example.com", purpose: "login" });
    expect(be.calls(LOGIN_PW)).toHaveLength(0);
  });

  it("the password is not kept in storage, the console or the page after signing in", async () => {
    const logged = watchConsole();
    await goToLogin(createFakeBackend(OK));
    await user.type(field(/email address/i), "parent@example.com");
    await user.type(field(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    await signedInHome();
    expect(storageIsEmpty()).toBe(true);
    expect(logged(PASSWORD)).toBe(false);
    expect(document.body.innerHTML).not.toContain(PASSWORD);
  });
});

describe("forgot password", () => {
  const OLD = { accounts: ["parent@example.com"], passwords: { "parent@example.com": PASSWORD } };
  const NEW_PASSWORD = "a-brand-new-passphrase";
  const goToLogin = async () => {
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Login" }));
  };
  const openForgot = async () => {
    await goToLogin();
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    await screen.findByRole("heading", { name: "Forgot your password?" });
  };
  const toCodeStep = async (email = " Parent@Example.com ") => {
    await openForgot();
    await user.type(field(/email address/i), email);
    await user.click(screen.getByRole("button", { name: /Send code/ }));
    await screen.findByRole("heading", { name: "Enter verification code" });
  };
  const toPasswordStep = async () => {
    await toCodeStep();
    await enterCode();
    await screen.findByRole("heading", { name: "Set a new password" });
  };
  const fillNew = async (password = NEW_PASSWORD, confirm = password) => {
    await user.type(field(/^new password/i), password);
    await user.type(field(/confirm new password/i), confirm);
  };

  it("is offered on the login screen only, and leads back to it", async () => {
    createFakeBackend(OLD);
    await showRegisterForm();
    expect(screen.queryByRole("button", { name: "Forgot password?" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Login" }));
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(screen.getByRole("heading", { name: "Forgot your password?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Back to login/ }));
    expect(screen.getByRole("button", { name: /Log in/ })).toBeInTheDocument();
  });

  it("keeps the email already typed on the login screen", async () => {
    createFakeBackend(OLD);
    await goToLogin();
    await user.type(field(/email address/i), "parent@example.com");
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(field(/email address/i)).toHaveValue("parent@example.com");
  });

  it("checks the email before any request", async () => {
    const be = createFakeBackend(OLD);
    await openForgot();
    await user.click(screen.getByRole("button", { name: /Send code/ }));
    expect(screen.getByText("Email address is required.")).toBeInTheDocument();
    await user.type(field(/email address/i), "not-an-email");
    await user.click(screen.getByRole("button", { name: /Send code/ }));
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(be.calls(RESET_REQUEST)).toHaveLength(0);
  });

  it("requests the code from the reset endpoint only, and the wording never says an email was sent", async () => {
    const be = createFakeBackend(OLD);
    await toCodeStep();
    expect(be.calls(RESET_REQUEST)).toHaveLength(1);
    expect(be.calls(RESET_REQUEST)[0].body).toEqual({ email: "parent@example.com" });
    expect(be.calls(SEND)).toHaveLength(0);
    expect(screen.getByText(/If an account exists for/)).toBeInTheDocument();
    expect(screen.queryByText(/We sent a 6-digit code/)).not.toBeInTheDocument();
    expect(screen.getByText("Code expires in 5:00")).toBeInTheDocument();
  });

  it("looks exactly the same for an unknown email", async () => {
    createFakeBackend(OLD);
    await toCodeStep("nobody@example.com");
    expect(screen.getByText(/If an account exists for/)).toBeInTheDocument();
    expect(screen.getByText("nobody@example.com")).toBeInTheDocument();
  });

  it("shows a sending state and ignores a second submit", async () => {
    const be = createFakeBackend(OLD);
    const pending = deferred();
    be.queue(RESET_REQUEST, () => pending.promise);
    await openForgot();
    await user.type(field(/email address/i), "parent@example.com");
    await user.click(screen.getByRole("button", { name: /Send code/ }));
    expect(screen.getByRole("button", { name: /Sending code/ })).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(be.calls(RESET_REQUEST)).toHaveLength(1);
    await act(async () => pending.resolve(reply(200, CHALLENGE)));
    await screen.findByRole("heading", { name: "Enter verification code" });
  });

  it.each([
    ["RATE_LIMITED", 429, { retryAfterSeconds: 600 }, /Too many verification requests/],
    ["RESEND_COOLDOWN", 429, { retryAfterSeconds: 20 }, /Please wait 20s/],
  ])("%s on the request: stays on the email step with a clear error and allows a retry", async (code, status, details, message) => {
    const be = createFakeBackend(OLD);
    be.queue(RESET_REQUEST, apiError(status, code, details));
    await openForgot();
    await user.type(field(/email address/i), "parent@example.com");
    await user.click(screen.getByRole("button", { name: /Send code/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("heading", { name: "Forgot your password?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Send code/ }));
    await screen.findByRole("heading", { name: "Enter verification code" });
    expect(be.calls(RESET_REQUEST)).toHaveLength(2);
  });

  it("a network failure on the request is reported and nothing moves on", async () => {
    const be = createFakeBackend(OLD);
    be.queue(RESET_REQUEST, () => {
      throw new TypeError("Failed to fetch");
    });
    await openForgot();
    await user.type(field(/email address/i), "parent@example.com");
    await user.click(screen.getByRole("button", { name: /Send code/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Can't reach the server/);
    expect(screen.queryByRole("heading", { name: "Enter verification code" })).not.toBeInTheDocument();
  });

  it("verifies the code against the reset endpoint, with the email and the code only", async () => {
    const be = createFakeBackend(OLD);
    await toPasswordStep();
    expect(be.calls(RESET_VERIFY)).toHaveLength(1);
    expect(be.calls(RESET_VERIFY)[0].body).toEqual({ email: "parent@example.com", code: "482913" });
    expect(be.calls(VERIFY)).toHaveLength(0);
  });

  it("a wrong code shows the attempts left and stays on the code step", async () => {
    const be = createFakeBackend(OLD);
    be.queue(RESET_VERIFY, apiError(400, "INVALID_CODE", { attemptsRemaining: 4 }));
    await toCodeStep();
    await enterCode("111111");
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is incorrect. 4 attempts left.");
    expect(screen.queryByRole("heading", { name: "Set a new password" })).not.toBeInTheDocument();
  });

  it.each([
    ["OTP_EXPIRED", 410, "This code has expired. Request a new code."],
    ["TOO_MANY_ATTEMPTS", 429, "Too many incorrect attempts. Request a new code."],
  ])("%s asks for a new code", async (code, status, message) => {
    const be = createFakeBackend(OLD);
    be.queue(RESET_VERIFY, apiError(status, code));
    await toCodeStep();
    await enterCode();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("Resend uses the reset endpoint, follows the server's cooldown, and says a code was 'requested'", async () => {
    const be = createFakeBackend(OLD);
    be.queue(RESET_REQUEST, reply(200, { ...CHALLENGE, resendAvailableInSeconds: 0 }));
    await toCodeStep();
    expect(screen.getByRole("button", { name: "Resend OTP" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Resend OTP" }));
    expect(await screen.findByText("A new code has been requested. Earlier codes no longer work.")).toBeInTheDocument();
    expect(be.calls(RESET_RESEND)).toHaveLength(1);
    expect(be.calls(RESET_RESEND)[0].body).toEqual({ email: "parent@example.com" });
    expect(be.calls(RESEND)).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Resend OTP in 30s/ })).toBeDisabled();
  });

  it("while the server's cooldown runs, Resend is disabled with the countdown", async () => {
    createFakeBackend(OLD);
    await toCodeStep();
    expect(screen.getByRole("button", { name: /Resend OTP in 30s/ })).toBeDisabled();
  });

  it("a resend refused by the server's cooldown shows its message", async () => {
    const be = createFakeBackend(OLD);
    be.queue(RESET_REQUEST, reply(200, { ...CHALLENGE, resendAvailableInSeconds: 0 }));
    be.queue(RESET_RESEND, apiError(429, "RESEND_COOLDOWN", { retryAfterSeconds: 12 }));
    await toCodeStep();
    await user.click(screen.getByRole("button", { name: "Resend OTP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Please wait 12s before requesting a new code.");
  });

  it("the code step can go back to change the email", async () => {
    createFakeBackend(OLD);
    await toCodeStep();
    await user.click(screen.getByRole("button", { name: /Change email/ }));
    expect(screen.getByRole("heading", { name: "Forgot your password?" })).toBeInTheDocument();
  });

  it("the new-password step has masked, labelled fields with the right autocomplete", async () => {
    createFakeBackend(OLD);
    await toPasswordStep();
    expect(field(/^new password/i)).toHaveAttribute("type", "password");
    expect(field(/^new password/i)).toHaveAttribute("autocomplete", "new-password");
    expect(field(/confirm new password/i)).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: /Change password/ })).toBeInTheDocument();
  });

  it("checks length and confirmation before any request, and clears each error when edited", async () => {
    const be = createFakeBackend(OLD);
    await toPasswordStep();
    await fillNew("short", "different");
    await user.click(screen.getByRole("button", { name: /Change password/ }));
    const short = screen.getByText("Password must be at least 10 characters.");
    expect(short).toBeInTheDocument();
    expect(field(/^new password/i)).toHaveAttribute("aria-invalid", "true");
    expect(field(/^new password/i)).toHaveAccessibleDescription("Password must be at least 10 characters.");
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
    expect(be.calls(RESET_CONFIRM)).toHaveLength(0);
    await user.type(field(/^new password/i), "-and-longer");
    expect(screen.queryByText("Password must be at least 10 characters.")).not.toBeInTheDocument();
  });

  it("changes the password only after the server confirms, shows a pending state, and does not sign in", async () => {
    const be = createFakeBackend(OLD);
    const pending = deferred();
    be.queue(RESET_CONFIRM, () => pending.promise);
    await toPasswordStep();
    await fillNew();
    await user.click(screen.getByRole("button", { name: /Change password/ }));
    expect(screen.getByRole("button", { name: /Saving/ })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "Password updated" })).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(be.calls(RESET_CONFIRM)).toHaveLength(1);

    await act(async () => pending.resolve(reply(200, { passwordChanged: true })));
    expect(await screen.findByRole("heading", { name: "Password updated" })).toBeInTheDocument();
    expect(screen.getByText(/Please log in with your new password/)).toBeInTheDocument();
    expect(be.calls(RESET_CONFIRM)[0].body).toEqual({
      email: "parent@example.com",
      verificationToken: TOKEN,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    // not signed in: no session was requested or created, and the form never opened
    expect(be.calls(SESSION)).toHaveLength(1);
    expect(be.calls(LOGIN_PW)).toHaveLength(0);
    expect(screen.queryByText("Which tour is this for?")).not.toBeInTheDocument();
    expect(be.state.signedIn).toBe(false);
  });

  it("then back to login: email filled in, password empty, and the new password works", async () => {
    const be = createFakeBackend(OLD);
    await toPasswordStep();
    await fillNew();
    await user.click(screen.getByRole("button", { name: /Change password/ }));
    await user.click(await screen.findByRole("button", { name: /Back to login/ }));

    expect(screen.getByText("Your password was changed. Log in with your new password.")).toBeInTheDocument();
    expect(field(/email address/i)).toHaveValue("parent@example.com");
    expect(field(/^password/i)).toHaveValue("");

    await user.type(field(/^password/i), PASSWORD); // the OLD password no longer works
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The email or password is incorrect.");

    await user.type(field(/^password/i), NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: /Log in/ }));
    await signedInHome();
    expect(be.calls(LOGIN_PW).map((c) => c.body.password)).toEqual([PASSWORD, NEW_PASSWORD]);
  });

  it("a password the server refuses (here: too common) is shown on that field, and the same code can be retried", async () => {
    const be = createFakeBackend(OLD);
    await toPasswordStep();
    await fillNew("password123");
    await user.click(screen.getByRole("button", { name: /Change password/ }));
    expect(await screen.findByText(/too common/i)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/check the highlighted details/i);
    expect(screen.queryByRole("heading", { name: "Password updated" })).not.toBeInTheDocument();

    await user.clear(field(/^new password/i));
    await user.clear(field(/confirm new password/i));
    await fillNew();
    await user.click(screen.getByRole("button", { name: /Change password/ }));
    expect(await screen.findByRole("heading", { name: "Password updated" })).toBeInTheDocument();
    expect(be.calls(RESET_CONFIRM).map((c) => c.body.verificationToken)).toEqual([TOKEN, TOKEN]);
  });

  it("an expired or used authorisation sends the user back to the start with an explanation", async () => {
    const be = createFakeBackend(OLD);
    be.queue(RESET_CONFIRM, apiError(403, "VERIFICATION_REQUIRED"));
    await toPasswordStep();
    await fillNew();
    await user.click(screen.getByRole("button", { name: /Change password/ }));
    expect(await screen.findByRole("heading", { name: "Forgot your password?" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/expired or was already used/);
    expect(field(/email address/i)).toHaveValue("Parent@Example.com"); // what the user typed is kept
  });

  it("a server or network error keeps the form and lets the user retry with the same token", async () => {
    const be = createFakeBackend(OLD);
    be.queue(RESET_CONFIRM, apiError(500, "INTERNAL_ERROR"), () => {
      throw new TypeError("Failed to fetch");
    });
    await toPasswordStep();
    await fillNew();
    await user.click(screen.getByRole("button", { name: /Change password/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't change your password/);
    expect(field(/^new password/i)).toHaveValue(NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: /Change password/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Can't reach the server/));
    await user.click(screen.getByRole("button", { name: /Change password/ }));
    expect(await screen.findByRole("heading", { name: "Password updated" })).toBeInTheDocument();
    expect(be.calls(RESET_CONFIRM)).toHaveLength(3);
  });

  it("the new-password step can be cancelled back to login without changing anything", async () => {
    const be = createFakeBackend(OLD);
    await toPasswordStep();
    await user.click(screen.getByRole("button", { name: /Cancel and go back to login/ }));
    expect(screen.getByRole("button", { name: /Log in/ })).toBeInTheDocument();
    expect(be.calls(RESET_CONFIRM)).toHaveLength(0);
  });

  it("keeps the token and passwords in memory only: not on screen, in storage, the console or the URL", async () => {
    const logged = watchConsole();
    const be = createFakeBackend(OLD);
    await toPasswordStep();
    await fillNew();
    await user.click(screen.getByRole("button", { name: /Change password/ }));
    await screen.findByRole("heading", { name: "Password updated" });

    for (const secret of [TOKEN, NEW_PASSWORD, "482913"]) {
      expect(document.body.textContent).not.toContain(secret);
      expect(document.body.innerHTML).not.toContain(secret);
      expect(window.location.href).not.toContain(secret);
      expect(logged(secret)).toBe(false);
    }
    expect(storageIsEmpty()).toBe(true);
    const elsewhere = be.calls().filter((c) => c.key !== RESET_CONFIRM);
    expect(JSON.stringify(elsewhere.map((c) => [c.url, c.body]))).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(elsewhere.map((c) => [c.url, c.body]))).not.toContain(TOKEN);
  });

  it("does not disturb email-code login", async () => {
    const be = createFakeBackend(OLD);
    await goToLogin();
    await user.type(field(/email address/i), "parent@example.com");
    await user.click(screen.getByRole("button", { name: /Send OTP/ }));
    await screen.findByRole("heading", { name: "Enter verification code" });
    expect(be.calls(SEND)[0].body).toEqual({ email: "parent@example.com", purpose: "login" });
    expect(be.calls(RESET_REQUEST)).toHaveLength(0);
  });
});

describe("registration from a trip's public page (the trip comes in from the address)", () => {
  const LINK = { school: "greenfield-public-school", branch: "main", trip: "winter-trip" };
  const TRIP = { address: LINK, school: "Greenfield Public School", title: "Winter Trip", destination: "Japan", tourType: "international" };
  const JOIN = { address: LINK, school: TRIP.school, trip: { title: TRIP.title, destination: TRIP.destination, tourType: TRIP.tourType } };

  it("offers no school field and shows no school or trip line", async () => {
    createFakeBackend({ join: TRIP });
    await showRegisterForm(JOIN);
    expect(screen.queryByText(/Registering for|Logging in for/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/school/i)).not.toBeInTheDocument();
  });

  it("the Login tab shows no school or trip line", async () => {
    createFakeBackend({ join: TRIP });
    render(<App join={JOIN} />);
    await user.click(await screen.findByRole("tab", { name: "Login" }));
    expect(screen.queryByText(/Registering for|Logging in for/)).not.toBeInTheDocument();
  });

  it("sends the link with the registration, then opens the form for the trip's school and tour", async () => {
    const be = createFakeBackend({ join: TRIP });
    await reachOtpStep(JOIN);
    await enterCode();

    const group = await screen.findByRole("group", { name: "Your school's trip" });
    expect(be.calls(REGISTER)[0].body.publicTrip).toEqual(LINK);
    expect(document.querySelector(".onboarding-context")).toBeNull();
    expect(within(group).getByText("Winter Trip")).toBeInTheDocument();
    // The trip decides the form: only that tour is offered, already selected.
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(1);
    expect(radios[0]).toBeChecked();
    expect(radios[0]).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /Continue/ }));
    await waitFor(() => expect(be.saves()).toHaveLength(1));
    expect(be.saves()[0].body.tourType).toBe("international");
  });

  it("an existing parent who logs in on the trip's address is joined to THAT trip", async () => {
    const be = createFakeBackend({ join: TRIP, accounts: ["parent@example.com"], passwords: { "parent@example.com": PASSWORD } });
    render(<App join={JOIN} />);
    await user.click(await screen.findByRole("tab", { name: "Login" }));
    await user.type(screen.getByLabelText(/email address/i), "parent@example.com");
    await user.type(screen.getByLabelText(/^password/i), PASSWORD);
    await user.click(screen.getByRole("button", { name: /^Log in/ }));
    await screen.findByRole("group", { name: "Your school's trip" });
    expect(be.calls(ENROL)[0].body).toEqual({ trip: LINK });
    expect(document.querySelector(".onboarding-context")).toBeNull();
  });

  it("nothing about the trip goes into browser storage or the console", async () => {
    const logged = watchConsole();
    createFakeBackend({ join: TRIP });
    await reachOtpStep(JOIN);
    await enterCode();
    await screen.findByRole("group", { name: "Your school's trip" });
    expect(storageIsEmpty()).toBe(true);
    expect(logged(LINK.trip)).toBe(false);
  });

  it("a trip the server no longer accepts: nothing is created, the parent is told, and it never falls back to registering without the trip", async () => {
    const be = createFakeBackend({ join: { ...TRIP, address: { ...LINK, trip: "other-trip" } } });
    await reachOtpStep(JOIN);
    await enterCode();
    expect(await screen.findByRole("alert")).toHaveTextContent(/registration page isn't available any more/);
    expect(be.state.accounts.size).toBe(0);
    expect(field(/first name/i)).toHaveValue("Asha"); // details are kept
    // trying again still sends THIS trip (it is not dropped, and no trip-less account is created)
    await user.click(submitButton());
    await waitFor(() => expect(be.calls(REGISTER)).toHaveLength(2));
    expect(be.calls(REGISTER)[1].body.publicTrip).toEqual(LINK);
    expect(be.state.accounts.size).toBe(0);
  });

  it("a trip that has closed says so in plain words", async () => {
    createFakeBackend({ join: { ...TRIP, open: false } });
    await reachOtpStep(JOIN);
    await enterCode();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Registration isn't open for this trip/);
  });

  it("without a trip page no trip is invented: no school line, no trip in the request, no form; the parent is asked to open their school's link", async () => {
    const be = createFakeBackend({ join: TRIP }); // a trip exists, but this parent did not come from its page
    await reachOtpStep();
    expect(screen.queryByText(/Registering for/)).not.toBeInTheDocument();
    await enterCode();
    expect(await signedInHome()).toBeInTheDocument();
    expect(screen.getByText(/open the trip registration link your school sent you/)).toBeInTheDocument();
    expect(be.calls(REGISTER)[0].body).not.toHaveProperty("publicTrip");
    expect(be.calls(ENROL)).toHaveLength(0);
    expect(be.calls(ONBOARDING)).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "Which tour is this for?" })).not.toBeInTheDocument();
    expect(screen.queryByText("Greenfield Public School")).not.toBeInTheDocument();
  });

  it("a link remembered in browser storage by an older version is ignored on the plain homepage", async () => {
    window.sessionStorage.setItem("pp_join", JSON.stringify({ token: "L".repeat(43), school: "Greenfield Public School" }));
    const be = createFakeBackend({ join: TRIP });
    await reachOtpStep();
    expect(screen.queryByText(/Registering for/)).not.toBeInTheDocument();
    await enterCode();
    await signedInHome();
    expect(be.calls(REGISTER)[0].body).not.toHaveProperty("publicTrip");
  });
});

describe("a returning parent following a trip's public page", () => {
  const LINK = { school: "greenfield-public-school", branch: "main", trip: "japan-2027" };
  const NEW_TRIP = { address: LINK, school: "Greenfield Public School", title: "Japan 2027", destination: "Tokyo", tourType: "international" };
  const JOIN = { address: LINK, school: NEW_TRIP.school, trip: { title: NEW_TRIP.title, destination: NEW_TRIP.destination, tourType: NEW_TRIP.tourType } };
  const lastYearsForm = { tourType: "domestic", role: "student", status: "submitted", data: { fullName: "Asha Rao" }, currentSection: "review", version: 4, updatedAt: "2026-01-01T00:00:00.000Z", submittedAt: "2026-01-01T00:00:00.000Z" };

  it("joins the new trip first, then opens a fresh form for it; last year's submission is kept", async () => {
    const be = createFakeBackend({ signedIn: true, form: lastYearsForm, join: NEW_TRIP });
    render(<App join={JOIN} />);
    const group = await screen.findByRole("group", { name: "Your school's trip" });
    expect(be.calls().map((c) => c.key)).toEqual([SESSION, ENROL, ONBOARDING]);
    expect(be.calls(ENROL)[0].body).toEqual({ trip: LINK });
    expect(within(group).getByText("Japan 2027")).toBeInTheDocument();
    expect(document.querySelector(".onboarding-context")).toBeNull();
    expect(be.state.pastForms).toEqual([lastYearsForm]);
    expect(be.state.form).toBeNull();
    expect(storageIsEmpty()).toBe(true);
  });

  it("a refresh on the trip's address keeps the same trip (joining again is a no-op)", async () => {
    const be = createFakeBackend({ signedIn: true, join: NEW_TRIP });
    const first = render(<App join={JOIN} />);
    await screen.findByRole("group", { name: "Your school's trip" });
    first.unmount(); // the page is reloaded
    render(<App join={JOIN} />);
    const group = await screen.findByRole("group", { name: "Your school's trip" });
    expect(within(group).getByText("Japan 2027")).toBeInTheDocument();
    expect(be.calls(ENROL).map((c) => c.body.trip)).toEqual([LINK, LINK]);
    expect(be.state.pastForms).toEqual([]); // nothing was replaced by the second visit
  });

  it("without a link it does not enrol anywhere", async () => {
    const be = createFakeBackend({ signedIn: true, form: lastYearsForm });
    render(<App />);
    await screen.findByRole("heading", { name: "Registration submitted" });
    expect(be.calls(ENROL)).toHaveLength(0);
  });

  it("a link the server refuses: the parent is told, and their existing form still opens", async () => {
    const be = createFakeBackend({ signedIn: true, form: lastYearsForm, join: { ...NEW_TRIP, address: { ...LINK, trip: "other-trip" } } });
    render(<App join={JOIN} />);
    await screen.findByText(/isn't available any more, so we couldn't add this trip/);
    // refused: the server then picks among the parent's OWN registrations (just one here), never another trip
    expect(be.calls().map((c) => c.key)).toEqual([SESSION, ENROL, RESUME, ONBOARDING]);
    expect(be.state.form).toEqual(lastYearsForm);
  });

  it("a closed trip says so", async () => {
    createFakeBackend({ signedIn: true, join: { ...NEW_TRIP, open: false } });
    render(<App join={JOIN} />);
    await screen.findByText(/Registration isn't open for that trip right now/);
  });

  it("a network failure offers Try again, which repeats the enrolment", async () => {
    const be = createFakeBackend({ signedIn: true, join: NEW_TRIP });
    be.queue(ENROL, () => { throw new TypeError("Failed to fetch"); });
    render(<App join={JOIN} />);
    await screen.findByText(/couldn't add this trip. Check your connection/);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("group", { name: "Your school's trip" });
    expect(be.calls(ENROL)).toHaveLength(2);
    expect(storageIsEmpty()).toBe(true);
  });

  it("sends only the page's address words: no token, no trip or school id", async () => {
    const be = createFakeBackend({ signedIn: true, join: NEW_TRIP });
    render(<App join={JOIN} />);
    await screen.findByRole("group", { name: "Your school's trip" });
    expect(Object.keys(be.calls(ENROL)[0].body)).toEqual(["trip"]);
    expect(Object.keys(be.calls(ENROL)[0].body.trip).sort()).toEqual(["branch", "school", "trip"]);
  });
});

describe("show / hide password on every parent password field", () => {
  const OK = { accounts: ["parent@example.com"], passwords: { "parent@example.com": PASSWORD } };
  const toggle = (name) => screen.getByRole("button", { name });

  it("registration: the password is masked by default and can be shown; registering works while shown", async () => {
    const be = createFakeBackend();
    await showRegisterForm();
    expect(field(/^password/i)).toHaveAttribute("type", "password");
    await fillForm();
    await user.click(toggle("Show password"));
    expect(field(/^password/i)).toHaveAttribute("type", "text");
    await user.click(toggle("Hide password"));
    expect(field(/^password/i)).toHaveAttribute("type", "password");
    expect(field(/^password/i)).toHaveValue(PASSWORD);
    expect(field(/^password/i)).toHaveAttribute("autocomplete", "new-password");
    await user.click(submitButton());
    await screen.findByRole("heading", { name: "Enter verification code" });
    await enterCode();
    await signedInHome();
    expect(be.calls(REGISTER)[0].body).toMatchObject({ password: PASSWORD });
  });

  it("login: the password can be shown and the parent still logs in", async () => {
    const be = createFakeBackend(OK);
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Login" }));
    await user.type(field(/email address/i), "parent@example.com");
    await user.type(field(/^password/i), PASSWORD);
    await user.click(toggle("Show password"));
    expect(field(/^password/i)).toHaveAttribute("type", "text");
    expect(field(/^password/i)).toHaveAttribute("autocomplete", "current-password");
    await user.click(screen.getByRole("button", { name: /^Log in/ }));
    await signedInHome();
    expect(be.calls(LOGIN_PW)[0].body.password).toBe(PASSWORD);
  });

  it("forgot password: new and confirm fields have independent toggles, and the change works while shown", async () => {
    const be = createFakeBackend(OK);
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Login" }));
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    await user.type(await screen.findByLabelText(/email address/i), "parent@example.com");
    await user.click(screen.getByRole("button", { name: /Send code/ }));
    await screen.findByRole("heading", { name: "Enter verification code" });
    await enterCode();
    await screen.findByRole("heading", { name: "Set a new password" });
    await user.type(field(/^new password/i), "a-brand-new-passphrase");
    await user.type(field(/confirm new password/i), "a-brand-new-passphrase");
    await user.click(toggle("Show password confirmation"));
    expect(field(/confirm new password/i)).toHaveAttribute("type", "text");
    expect(field(/^new password/i)).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: /Change password/ }));
    await waitFor(() => expect(be.calls(RESET_CONFIRM)).toHaveLength(1));
    expect(be.calls(RESET_CONFIRM)[0].body).toMatchObject({ password: "a-brand-new-passphrase", confirmPassword: "a-brand-new-passphrase" });
  });
});

describe("registration: 10-digit phone number, real names", () => {
  it("the phone field is a numeric phone input, with no helper text under it (the 10-digit rule is enforced, not described)", async () => {
    createFakeBackend();
    await showRegisterForm();
    const phone = field(/^Phone Number/);
    expect(phone).toHaveAttribute("type", "tel");
    expect(phone).toHaveAttribute("inputmode", "numeric");
    expect(phone).toHaveAttribute("autocomplete", "tel-national");
    expect(phone).toHaveAttribute("placeholder", "9876543210");
    expect(phone).not.toHaveAttribute("maxlength"); // a paste must never be cut down
    expect(screen.queryByText(/10-digit|country code/)).not.toBeInTheDocument();
    expect(phone).not.toHaveAttribute("aria-describedby");
    expect(screen.getByText("Phone Number", { selector: "label, label *" })).toBeInTheDocument();
    expect(field(/first name/i)).toHaveAttribute("autocomplete", "given-name");
    expect(field(/last name/i)).toHaveAttribute("autocomplete", "family-name");
  });

  it("typing stops at 10 digits", async () => {
    createFakeBackend();
    await showRegisterForm();
    await user.type(field(/phone/i), "987654321012");
    expect(field(/phone/i)).toHaveValue("9876543210");
  });

  it("a pasted number with a country code is kept whole (never shortened) and refused with a clear message", async () => {
    const be = createFakeBackend();
    await showRegisterForm();
    await fillForm();
    await user.clear(field(/phone/i));
    await user.click(field(/phone/i));
    await user.paste("919876543210");
    expect(field(/phone/i)).toHaveValue("919876543210");
    await user.click(submitButton());
    expect(await screen.findByText("That's 12 digits. Enter your 10-digit mobile number without the country code.")).toBeInTheDocument();
    expect(field(/phone/i)).toHaveAttribute("aria-invalid", "true");
    expect(be.calls(SEND)).toHaveLength(0);
  });

  it("nine digits, a + country code, or a name with digits are refused before anything is sent, and everything typed is kept", async () => {
    const be = createFakeBackend();
    await showRegisterForm();
    await user.type(field(/first name/i), "Asha2");
    await user.type(field(/last name/i), "Rao");
    await user.selectOptions(field(/role/i), "Student");
    await user.type(field(/phone/i), "987654321");
    await user.type(field(/email address/i), "parent@example.com");
    await user.type(field(/^password/i), PASSWORD);
    await user.click(submitButton());
    expect(await screen.findByText("First name can't contain numbers.")).toBeInTheDocument();
    expect(screen.getByText("Enter all 10 digits of your mobile number (you entered 9).")).toBeInTheDocument();
    expect(field(/phone/i)).toHaveAccessibleDescription("Enter all 10 digits of your mobile number (you entered 9)."); // the error is tied to the field
    expect(field(/first name/i)).toHaveValue("Asha2");
    expect(field(/phone/i)).toHaveValue("987654321");
    expect(field(/email address/i)).toHaveValue("parent@example.com");
    expect(be.calls(SEND)).toHaveLength(0);

    await user.clear(field(/phone/i));
    await user.type(field(/phone/i), "+91987654");
    await user.click(submitButton());
    expect(await screen.findByText("Enter your 10-digit mobile number without the country code (no + or 91 in front).")).toBeInTheDocument();
    expect(be.calls(SEND)).toHaveLength(0);
  });

  it("a valid 10-digit number passes the browser check and the real server rule (the fake uses the server schema)", async () => {
    const be = createFakeBackend();
    await showRegisterForm();
    await fillForm();
    await user.click(submitButton());
    await screen.findByRole("heading", { name: "Enter verification code" });
    expect(be.calls(SEND)).toHaveLength(1);
    expect(be.state.accounts.size).toBe(0);
  });

  it("when the server refuses the phone (a crafted or outdated client), its message appears under the field", async () => {
    const be = createFakeBackend();
    be.queue(REGISTER, apiError(400, "VALIDATION_ERROR", { fields: [{ path: "phone", message: "That's 11 digits. Enter your 10-digit mobile number without the country code." }] }));
    await reachOtpStep();
    await enterCode();
    expect(await screen.findByText("That's 11 digits. Enter your 10-digit mobile number without the country code.")).toBeInTheDocument();
  });
});
