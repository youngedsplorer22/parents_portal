import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHALLENGE, TOKEN, VERIFIED, apiError, deferred, mockApi, reply, storageIsEmpty, watchConsole } from "../../test/helpers.js";
import EmailOtpStep from "./EmailOtpStep.jsx";

const EMAIL = "parent@example.com";
const RESEND = "/api/email-otp/resend";
const VERIFY = "/api/email-otp/verify";

let user;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const passTime = (seconds) => act(async () => { vi.advanceTimersByTime(seconds * 1000); });
const boxes = () => screen.getAllByLabelText(/Digit \d of 6/);
const verifyButton = () => screen.getByRole("button", { name: /Verify OTP|Verifying/ });
const resendButton = () => screen.getByRole("button", { name: /Resend OTP|Sending/ });
const enterCode = async (code) => {
  await user.click(boxes()[0]);
  await user.paste(code);
};

function setup(challenge = {}, handlers = {}) {
  const api = mockApi(handlers);
  const onVerified = vi.fn();
  const onBack = vi.fn();
  render(<EmailOtpStep email={EMAIL} challenge={{ ...CHALLENGE, ...challenge }} onBack={onBack} onVerified={onVerified} />);
  return { api, onVerified, onBack };
}

describe("display", () => {
  it("shows six boxes, the email, the 5:00 expiry and a 30s resend cooldown", () => {
    setup();
    expect(boxes()).toHaveLength(6);
    expect(screen.getByText(EMAIL)).toBeInTheDocument();
    expect(screen.getByText(/We sent a 6-digit code to/)).toBeInTheDocument();
    expect(screen.getByText("Code expires in 5:00")).toBeInTheDocument();
    expect(resendButton()).toBeDisabled();
    expect(resendButton()).toHaveTextContent("Resend OTP in 30s");
    expect(screen.queryByText(/Development mode/)).not.toBeInTheDocument();
    expect(boxes()[0]).toHaveFocus();
  });

  it("in development console mode it does not claim an email was sent", () => {
    setup({ delivery: "dev-console" });
    expect(screen.queryByText(/We sent a 6-digit code/)).not.toBeInTheDocument();
    expect(screen.getByText(/no email is sent/i)).toBeInTheDocument();
  });

  it("Change email calls onBack", async () => {
    const { onBack } = setup();
    await user.click(screen.getByRole("button", { name: /Change email/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("explains when a code was already sent, without sending anything", () => {
    const { api } = setup({ alreadySent: true, expiresInSeconds: 200, resendAvailableInSeconds: 0 });
    expect(screen.getByRole("status")).toHaveTextContent(/already sent/i);
    expect(screen.getByText("Code expires in 3:20")).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });
});

describe("entering and verifying the code", () => {
  it("accepts typing digit by digit, moving focus along", async () => {
    setup();
    await user.click(boxes()[0]);
    await user.keyboard("482");
    expect(boxes().map((b) => b.value).join("")).toBe("482");
    expect(boxes()[3]).toHaveFocus();
  });

  it("accepts a pasted code and ignores non-digits", async () => {
    setup();
    await enterCode("48-29 13");
    expect(boxes().map((b) => b.value).join("")).toBe("482913");
  });

  it("verifies, then hands the token to the parent and nothing else", async () => {
    const logged = watchConsole();
    const { api, onVerified } = setup({}, { [VERIFY]: reply(200, VERIFIED) });
    await enterCode("482913");
    await user.click(verifyButton());

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(onVerified).toHaveBeenCalledWith({ token: TOKEN, expiresInSeconds: 900 });
    expect(api.calls[0]).toMatchObject({ url: VERIFY, body: { email: EMAIL, purpose: "registration", code: "482913" } });

    expect(document.body.textContent).not.toContain(TOKEN);
    expect(storageIsEmpty()).toBe(true);
    expect(logged(TOKEN)).toBe(false);
    expect(logged("482913")).toBe(false);
  });

  it("shows a loading state and ignores a second submit while verifying", async () => {
    const pending = deferred();
    const { api } = setup({}, { [VERIFY]: () => pending.promise });
    await enterCode("482913");
    await user.click(verifyButton());

    expect(verifyButton()).toHaveTextContent("Verifying…");
    expect(verifyButton()).toBeDisabled();
    expect(boxes().every((b) => b.disabled)).toBe(true);
    await user.click(verifyButton());
    expect(api.calls).toHaveLength(1);

    await act(async () => pending.resolve(reply(200, VERIFIED)));
  });

  it("asks for six digits before calling the server", async () => {
    const { api } = setup();
    await enterCode("123");
    await user.click(verifyButton());
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the 6-digit verification code.");
    expect(api.calls).toHaveLength(0);
  });
});

describe("keyboard and accessibility", () => {
  it("Backspace on an empty box steps back; the arrow keys move between boxes; typing never overruns the last box", async () => {
    setup();
    await user.click(boxes()[0]);
    await user.keyboard("12");
    expect(boxes()[2]).toHaveFocus();
    await user.keyboard("{Backspace}"); // box 3 is empty: focus goes back to box 2
    expect(boxes()[1]).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(boxes()[0]).toHaveFocus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(boxes()[3]).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}"); // never before the first box
    expect(boxes()[0]).toHaveFocus();
    await enterCode("1234567890"); // extra digits are ignored, only six are kept
    expect(boxes().map((b) => b.value).join("")).toBe("123456");
  });

  it("pasting into a later box fills from there, and a paste of letters changes nothing", async () => {
    setup();
    await user.click(boxes()[3]);
    await user.paste("789");
    expect(boxes().map((b) => b.value).join("")).toBe("789");
    expect(boxes().map((b) => b.value)).toEqual(["", "", "", "7", "8", "9"]);
    await user.click(boxes()[0]);
    await user.paste("abc");
    expect(boxes().map((b) => b.value)).toEqual(["", "", "", "7", "8", "9"]);
  });

  it("every box has its own accessible name, the group is named, and the first box offers the one-time-code hint", () => {
    setup();
    expect(screen.getByRole("group", { name: "One-time password" })).toBeInTheDocument();
    expect(boxes().map((b) => b.getAttribute("aria-label"))).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Digit ${n} of 6`));
    expect(boxes()[0]).toHaveAttribute("autocomplete", "one-time-code");
    expect(boxes()[1]).toHaveAttribute("autocomplete", "off");
    expect(boxes().every((b) => b.getAttribute("inputmode") === "numeric")).toBe(true);
    expect(screen.getByRole("heading", { name: "Enter verification code" })).toBeInTheDocument();
  });

  it("shows exactly the address it was given, and a new address replaces it (nothing is inherited)", () => {
    const api = mockApi({});
    const { rerender } = render(<EmailOtpStep email="first@example.com" challenge={CHALLENGE} onBack={() => {}} onVerified={() => {}} />);
    expect(screen.getByText("first@example.com")).toBeInTheDocument();
    rerender(<EmailOtpStep key="second" email="second@example.com" challenge={CHALLENGE} onBack={() => {}} onVerified={() => {}} />);
    expect(screen.getByText("second@example.com")).toBeInTheDocument();
    expect(screen.queryByText("first@example.com")).not.toBeInTheDocument();
    expect(api).toBeDefined();
  });

  it("the Verify button is disabled while verifying or after the code has expired", async () => {
    setup({ expiresInSeconds: 3 });
    await passTime(4);
    expect(verifyButton()).toBeDisabled();
    expect(screen.getByText("This code has expired. Request a new code.")).toBeInTheDocument();
  });
});

describe("verification failures", () => {
  it("wrong code: shows attempts left, clears the boxes and refocuses", async () => {
    setup({}, { [VERIFY]: apiError(400, "INVALID_CODE", { attemptsRemaining: 4 }) });
    await enterCode("000000");
    await user.click(verifyButton());

    expect(await screen.findByRole("alert")).toHaveTextContent("That code is incorrect. 4 attempts left.");
    expect(boxes().every((b) => b.value === "")).toBe(true);
    expect(boxes()[0]).toHaveFocus();
    expect(verifyButton()).toBeEnabled();
  });

  it("too many attempts: locks Verify until a new code is requested", async () => {
    const { api } = setup(
      {},
      { [VERIFY]: apiError(429, "TOO_MANY_ATTEMPTS"), [RESEND]: reply(200, CHALLENGE) },
    );
    await enterCode("000000");
    await user.click(verifyButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many incorrect attempts/);
    expect(verifyButton()).toBeDisabled();

    await passTime(30);
    await user.click(resendButton());
    await waitFor(() => expect(verifyButton()).toBeEnabled());
    expect(api.urls()).toEqual([VERIFY, RESEND]);
  });

  it("server says the code expired: locks Verify and points at Resend", async () => {
    setup({}, { [VERIFY]: apiError(410, "OTP_EXPIRED") });
    await enterCode("482913");
    await user.click(verifyButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired/i);
    expect(verifyButton()).toBeDisabled();
  });

  it("network failure: explains and lets the user retry the same code", async () => {
    const { api } = setup({}, { [VERIFY]: [() => { throw new TypeError("Failed to fetch"); }, reply(200, VERIFIED)] });
    await enterCode("482913");
    await user.click(verifyButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Can't reach the server/);
    expect(boxes().map((b) => b.value).join("")).toBe("482913");

    await user.click(verifyButton());
    await waitFor(() => expect(api.calls).toHaveLength(2));
  });
});

describe("timers: 5-minute expiry and 30-second cooldown", () => {
  it("counts the resend cooldown down and enables Resend at 30s", async () => {
    setup();
    await passTime(29);
    expect(resendButton()).toHaveTextContent("Resend OTP in 1s");
    expect(resendButton()).toBeDisabled();
    await passTime(1);
    expect(resendButton()).toHaveTextContent("Resend OTP");
    expect(resendButton()).toBeEnabled();
  });

  it("counts the expiry down and disables Verify at 5 minutes, without calling the server", async () => {
    const { api } = setup();
    await passTime(240);
    expect(screen.getByText("Code expires in 1:00")).toBeInTheDocument();
    expect(verifyButton()).toBeEnabled();

    await passTime(60);
    expect(screen.getByText(/This code has expired/)).toBeInTheDocument();
    expect(verifyButton()).toBeDisabled();
    await enterCode("482913");
    await user.click(verifyButton());
    expect(api.calls).toHaveLength(0);
    expect(resendButton()).toBeEnabled();
  });

  it("a code that arrives already expired offers Resend immediately", () => {
    setup({ alreadySent: true, expiresInSeconds: 0, resendAvailableInSeconds: 0 });
    expect(screen.getByText(/This code has expired/)).toBeInTheDocument();
    expect(verifyButton()).toBeDisabled();
    expect(resendButton()).toBeEnabled();
  });
});

describe("resend", () => {
  it("calls /resend, clears the boxes, restarts both timers and says the old code is dead", async () => {
    const { api } = setup({}, { [RESEND]: reply(200, { ...CHALLENGE, delivery: "smtp" }) });
    await enterCode("123456");
    await passTime(31);
    expect(screen.getByText("Code expires in 4:29")).toBeInTheDocument();

    await user.click(resendButton());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("A new code has been sent. Earlier codes no longer work."));
    expect(api.calls[0]).toMatchObject({ url: RESEND, body: { email: EMAIL, purpose: "registration" } });
    expect(boxes().every((b) => b.value === "")).toBe(true);
    expect(screen.getByText("Code expires in 5:00")).toBeInTheDocument();
    expect(resendButton()).toHaveTextContent("Resend OTP in 30s");
    expect(resendButton()).toBeDisabled();
  });

  it("shows a sending state and only sends one request for repeated clicks", async () => {
    const pending = deferred();
    const { api } = setup({}, { [RESEND]: () => pending.promise });
    await passTime(30);
    await user.click(resendButton());
    expect(resendButton()).toHaveTextContent("Sending…");
    expect(resendButton()).toBeDisabled();
    await user.click(resendButton());
    expect(api.calls).toHaveLength(1);
    await act(async () => pending.resolve(reply(200, CHALLENGE)));
  });

  it("respects the server's cooldown if the browser clock disagrees", async () => {
    setup({ resendAvailableInSeconds: 0 }, { [RESEND]: apiError(429, "RESEND_COOLDOWN", { retryAfterSeconds: 12 }) });
    await user.click(resendButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Please wait 12s before requesting a new code.");
    expect(resendButton()).toHaveTextContent("Resend OTP in 12s");
    expect(resendButton()).toBeDisabled();
  });

  it("a failed delivery shows an error and keeps Resend available", async () => {
    setup({ resendAvailableInSeconds: 0 }, { [RESEND]: apiError(502, "DELIVERY_FAILED") });
    await user.click(resendButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't send the email/);
    expect(resendButton()).toBeEnabled();
  });
});

describe("lifecycle", () => {
  it("aborts an in-flight request when the step is left", async () => {
    const pending = deferred();
    const api = mockApi({ [VERIFY]: () => pending.promise });
    const { unmount } = render(<EmailOtpStep email={EMAIL} challenge={CHALLENGE} onBack={() => {}} onVerified={() => {}} />);
    await enterCode("482913");
    await user.click(verifyButton());
    expect(api.calls[0].signal.aborted).toBe(false);
    unmount();
    expect(api.calls[0].signal.aborted).toBe(true);
    pending.resolve(reply(200, VERIFIED));
  });
});
