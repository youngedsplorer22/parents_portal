import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, LoaderCircle } from "lucide-react";
import { OtpApiError, otpErrorMessage, resendEmailOtp, verifyEmailOtp } from "../../api/emailOtpApi.js";

const EMPTY = ["", "", "", "", "", ""];
// States where the server will not accept this code any more: only Resend can help.
const NEEDS_RESEND = new Set(["OTP_EXPIRED", "TOO_MANY_ATTEMPTS", "OTP_NOT_FOUND"]);

const deadlines = (challenge, from) => ({
  expiresAt: from + challenge.expiresInSeconds * 1000,
  resendAt: from + challenge.resendAvailableInSeconds * 1000,
});
const secondsLeft = (deadline, now) => Math.max(0, Math.ceil((deadline - now) / 1000));
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * Email OTP step for registration or login (`purpose`): six-digit input, verify, resend.
 * The server is the authority for expiry, cooldown and attempt limits; the
 * countdowns here only mirror the times it reports. On success the verification
 * token is handed straight to onVerified and never kept, rendered or logged here.
 */
export default function EmailOtpStep({ email, challenge, purpose, client, generic = false, onBack, onVerified }) {
  // `client` swaps the endpoints ({ verify(email, code, opts), resend(email, opts) }); by default the
  // generic email-otp ones for `purpose`. `generic` uses wording that doesn't say an email was sent.
  const verifyCode = client?.verify ?? ((e, code, opts) => verifyEmailOtp(e, code, { ...opts, purpose }));
  const resendCode = client?.resend ?? ((e, opts) => resendEmailOtp(e, { ...opts, purpose }));
  const [digits, setDigits] = useState(EMPTY);
  const [now, setNow] = useState(() => Date.now());
  const [times, setTimes] = useState(() => deadlines(challenge, Date.now()));
  const [delivery, setDelivery] = useState(challenge.delivery);
  const [busy, setBusy] = useState(null); // null | "verify" | "resend"
  const [locked, setLocked] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(
    challenge.alreadySent && challenge.expiresInSeconds > 0
      ? `A code was already ${generic ? "requested for" : "sent to"} this address. Enter it below, or request a new one when the timer allows.`
      : "",
  );
  const refs = useRef([]);
  const controller = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    refs.current[0]?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      controller.current?.abort();
    };
  }, []);

  // Focus the first box once the inputs are enabled again (a disabled input cannot take focus).
  useEffect(() => {
    if (focusRequest > 0) refs.current[0]?.focus();
  }, [focusRequest]);

  const expiresIn = secondsLeft(times.expiresAt, now);
  const resendIn = secondsLeft(times.resendAt, now);
  const expired = expiresIn === 0;
  const canVerify = !busy && !expired && !locked;
  const canResend = !busy && resendIn === 0;

  const request = () => {
    controller.current?.abort();
    controller.current = new AbortController();
    return { signal: controller.current.signal };
  };

  const reset = () => {
    setDigits(EMPTY);
    setFocusRequest((n) => n + 1);
  };

  const updateDigits = (index, value) => {
    const entered = value.replace(/\D/g, "");
    if (!entered) {
      setDigits((current) => current.map((item, i) => (i === index ? "" : item)));
      return;
    }
    const next = [...digits];
    entered.split("").slice(0, 6 - index).forEach((digit, offset) => {
      next[index + offset] = digit;
    });
    setDigits(next);
    setError("");
    refs.current[Math.min(index + entered.length, 5)]?.focus();
  };

  const keyDown = (index, event) => {
    if (event.key === "Backspace" && !digits[index] && index > 0) refs.current[index - 1]?.focus();
    if (event.key === "ArrowLeft" && index > 0) refs.current[index - 1]?.focus();
    if (event.key === "ArrowRight" && index < 5) refs.current[index + 1]?.focus();
  };

  const verify = async (event) => {
    event.preventDefault();
    if (!canVerify) return;
    const code = digits.join("");
    if (code.length !== 6) {
      setError("Enter the 6-digit verification code.");
      return;
    }
    setError("");
    setNotice("");
    setBusy("verify");
    try {
      const result = await verifyCode(email, code, request());
      onVerified({ token: result.verificationToken, expiresInSeconds: result.verificationTokenExpiresInSeconds });
    } catch (err) {
      if (!mounted.current || err?.name === "AbortError") return;
      setError(otpErrorMessage(err));
      if (err instanceof OtpApiError && err.code === "INVALID_CODE") reset();
      if (err instanceof OtpApiError && NEEDS_RESEND.has(err.code)) setLocked(true);
      setBusy(null);
    }
  };

  const resend = async () => {
    if (!canResend) return;
    setError("");
    setNotice("");
    setBusy("resend");
    try {
      const next = await resendCode(email, request());
      if (!mounted.current) return;
      const from = Date.now();
      setNow(from);
      setTimes(deadlines(next, from));
      setDelivery(next.delivery);
      setLocked(false);
      reset();
      setNotice(generic ? "A new code has been requested. Earlier codes no longer work." : "A new code has been sent. Earlier codes no longer work.");
    } catch (err) {
      if (!mounted.current || err?.name === "AbortError") return;
      if (err instanceof OtpApiError && err.code === "RESEND_COOLDOWN" && Number.isFinite(err.details.retryAfterSeconds)) {
        const at = Date.now();
        setNow(at);
        setTimes((current) => ({ ...current, resendAt: at + err.details.retryAfterSeconds * 1000 }));
      }
      setError(otpErrorMessage(err));
    }
    if (mounted.current) setBusy(null);
  };

  return (
    <form className="auth-form otp-form" onSubmit={verify} noValidate>
      <button type="button" className="back-link" onClick={onBack} disabled={busy === "verify"}>
        <ArrowLeft size={16} /> Change email
      </button>
      <div className="form-heading">
        <h1>Enter verification code</h1>
        {delivery === "dev-console" ? (
          <p>Enter the 6-digit code for <strong>{email}</strong>.</p>
        ) : generic ? (
          <p>If an account exists for <strong>{email}</strong>, we've sent it a 6-digit code. Check your spam folder if it doesn't arrive.</p>
        ) : (
          <p>We sent a 6-digit code to <strong>{email}</strong>. Check your spam folder if it doesn't arrive.</p>
        )}
      </div>
      <div className="otp-row" role="group" aria-label="One-time password">
        {digits.map((value, index) => (
          <input
            key={index}
            ref={(element) => { refs.current[index] = element; }}
            className="otp-input"
            value={value}
            onChange={(event) => updateDigits(index, event.target.value)}
            onKeyDown={(event) => keyDown(index, event)}
            onPaste={(event) => {
              event.preventDefault();
              updateDigits(index, event.clipboardData.getData("text"));
            }}
            inputMode="numeric"
            autoComplete={index === 0 ? "one-time-code" : "off"}
            maxLength={6}
            disabled={busy === "verify"}
            aria-label={`Digit ${index + 1} of 6`}
          />
        ))}
      </div>
      <p className={`otp-timer ${expired ? "expired" : ""}`} aria-live="off">
        {expired ? "This code has expired. Request a new code." : `Code expires in ${clock(expiresIn)}`}
      </p>
      {error && <p className="field-error centered-error" role="alert">{error}</p>}
      {notice && <div className="status-message info" role="status"><span>{notice}</span></div>}
      <button className="primary-button" type="submit" disabled={!canVerify}>
        {busy === "verify" ? (<><LoaderCircle size={18} className="spin" /> Verifying…</>) : (<>Verify OTP <ArrowRight size={18} /></>)}
      </button>
      <div className="otp-actions">
        <button type="button" className="text-button" onClick={resend} disabled={!canResend}>
          {busy === "resend" ? "Sending…" : resendIn > 0 ? `Resend OTP in ${resendIn}s` : "Resend OTP"}
        </button>
      </div>
      {delivery === "dev-console" && (
        <p className="mock-note">Development mode: no email is sent. The code is printed in the backend terminal.</p>
      )}
    </form>
  );
}
