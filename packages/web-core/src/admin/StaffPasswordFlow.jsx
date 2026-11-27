import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CircleCheck, LoaderCircle, Lock, Mail } from "lucide-react";
import EmailOtpStep from "../components/auth/EmailOtpStep.jsx";
import { normalizeEmail, otpErrorMessage } from "../api/emailOtpApi.js";
import { confirmProblem, passwordProblem, PASSWORD_MIN } from "../auth/passwordRules.js";
import {
  adminErrorMessage,
  confirmStaffPassword,
  requestStaffPasswordCode,
  resendStaffPasswordCode,
  verifyStaffPasswordCode,
} from "./adminApi.js";
import { Field } from "./StaffAuthLayout.jsx";
import PasswordInput from "../components/PasswordInput.jsx";

// The six-box code step is the parents' own component. It only draws the boxes and the timers the SERVER
// reports; expiry, the resend cooldown, the attempt limit and the single-use token are all enforced by
// the server. It is pointed at the staff endpoints here.
const client = { verify: verifyStaffPasswordCode, resend: resendStaffPasswordCode };

/**
 * Staff first-time setup AND forgot-password, one flow: work email -> emailed code -> new password.
 * (Rendered inside StaffAuthLayout by AdminLogin.)
 *
 * It never says whether an address is staff: the server answers the same way for every email, so the
 * wording after "Send code" is "If an account exists ...". The code email itself says whether the person
 * is setting or resetting a password, and so does the final screen (the server only reveals that after the
 * code has been proven). The verification token lives in this component's memory only and is spent by the
 * one request that saves the password. Finishing does NOT sign anyone in.
 *
 * The email box starts EMPTY and is not auto-fillable: a browser or password manager must not silently
 * put a saved login in it, because the code goes to whatever address is shown here.
 */
export default function StaffPasswordFlow({ onBackToLogin }) {
  const [step, setStep] = useState("email"); // "email" | "code" | "password" | "done"
  const [email, setEmail] = useState("");
  const [challenge, setChallenge] = useState(null);
  const [token, setToken] = useState(null); // in memory only
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false); // asking "go back and discard your verified code?" on the password step
  const [firstTime, setFirstTime] = useState(false);
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);
  const abortable = () => {
    request.current?.abort();
    request.current = new AbortController();
    return { signal: request.current.signal };
  };

  const typed = email.trim();
  const looksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed);

  const sendCode = async (event) => {
    event.preventDefault();
    if (busy) return;
    const address = email.trim();
    if (!address) return setError("Enter your work email address.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return setError("Enter a valid email address.");
    setError("");
    setBusy(true);
    try {
      const result = await requestStaffPasswordCode(address, abortable());
      setChallenge({ email: normalizeEmail(address), ...result });
      setStep("code");
    } catch (err) {
      if (err?.name === "AbortError") return;
      setError(otpErrorMessage(err));
    }
    setBusy(false);
  };

  // Going back always EMPTIES the address: the next code goes to whatever is typed fresh, never to a leftover.
  const backToEmail = (message = "") => {
    setEmail("");
    setToken(null);
    setPassword("");
    setConfirm("");
    setErrors({});
    setError(message);
    setBusy(false);
    setLeaving(false);
    setStep("email");
  };

  const savePassword = async (event) => {
    event.preventDefault();
    if (busy) return;
    const next = { password: passwordProblem(password), confirmPassword: confirmProblem(password, confirm) };
    setErrors(next);
    setError("");
    if (next.password || next.confirmPassword) return;
    setBusy(true);
    try {
      const result = await confirmStaffPassword({ email: challenge.email, verificationToken: token, password, confirmPassword: confirm }, abortable());
      setFirstTime(result.firstTime);
      setToken(null);
      setPassword("");
      setConfirm("");
      setStep("done");
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (err.code === "VERIFICATION_REQUIRED") {
        backToEmail(adminErrorMessage(err));
        return;
      }
      setError(adminErrorMessage(err));
    }
    setBusy(false);
  };

  if (step === "code" && challenge) {
    return (
      <EmailOtpStep
        email={challenge.email}
        challenge={challenge}
        client={client}
        generic
        onBack={() => backToEmail()}
        onVerified={({ token: verified }) => {
          setToken(verified);
          setStep("password");
        }}
      />
    );
  }

  if (step === "password") {
    return (
      <form className="auth-form" onSubmit={savePassword} noValidate>
        {/* The code was single-use and is spent, so going back means getting a new one: ask first, so a typed
            password is never thrown away by one stray click. */}
        {leaving ? (
          <div className="status-message info" role="alertdialog" aria-label="Go back?">
            <span>Going back means asking for a new code, and what you typed here is discarded.</span>
            <button type="button" className="text-button" onClick={() => backToEmail()}>Go back</button>
            <button type="button" className="text-button" onClick={() => setLeaving(false)}>Stay here</button>
          </div>
        ) : (
          <button type="button" className="back-link" onClick={() => setLeaving(true)} disabled={busy}>
            <ArrowLeft size={16} aria-hidden="true" /> Back
          </button>
        )}
        <div className="form-heading">
          <h1 className="text-center">Choose your password</h1>
          <p>For <strong>{challenge.email}</strong>.</p>
        </div>
        <Field id="setup-password" label="New password" error={errors.password} hint={`At least ${PASSWORD_MIN} characters.`}>
          <div className={`input-wrap ${errors.password ? "has-error" : ""}`}>
            <Lock size={18} />
            <PasswordInput
              id="setup-password"
              autoComplete="new-password"
              placeholder="Create a password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setErrors((c) => ({ ...c, password: "" })); setError(""); }}
              aria-invalid={Boolean(errors.password)}
              autoFocus
              toggleLabel="new password"
            />
          </div>
        </Field>
        <Field id="setup-confirm" label="Confirm new password" error={errors.confirmPassword}>
          <div className={`input-wrap ${errors.confirmPassword ? "has-error" : ""}`}>
            <Lock size={18} />
            <PasswordInput
              id="setup-confirm"
              autoComplete="new-password"
              placeholder="Re-enter the password"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setErrors((c) => ({ ...c, confirmPassword: "" })); setError(""); }}
              aria-invalid={Boolean(errors.confirmPassword)}
              toggleLabel="password confirmation"
            />
          </div>
        </Field>
        {error && <div className="status-message error" role="alert"><span>{error}</span></div>}
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? (<><LoaderCircle size={18} className="spin" aria-hidden="true" /> Saving…</>) : (<>Save password <ArrowRight size={18} aria-hidden="true" /></>)}
        </button>
      </form>
    );
  }

  if (step === "done") {
    return (
      <div className="success-panel" role="status" aria-live="polite">
        <CircleCheck size={28} aria-hidden="true" />
        <h1>{firstTime ? "Password set" : "Password reset"}</h1>
        <p>
          {firstTime
            ? "Your password is set. Log in with your email and this password."
            : "Your password was reset and you were signed out everywhere. Log in with your new password."}
        </p>
        <button className="primary-button" type="button" onClick={() => onBackToLogin(challenge.email)}>
          Go to log in <ArrowRight size={18} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={sendCode} noValidate>
      <button type="button" className="back-link" onClick={() => onBackToLogin()} disabled={busy}>
        <ArrowLeft size={16} aria-hidden="true" /> Back to log in
      </button>
      <div className="form-heading">
        <h1 className="text-center">Set up or reset your password</h1>
        <p>
          First time? We'll email you a code so you can set your password. Forgot it? The same steps let you reset it.
          Use the work email an administrator added for you.
        </p>
      </div>
      <Field
        id="setup-email"
        label="Work email address"
        error={error}
        hint={looksValid ? <>A code will be sent to <strong>{typed.toLowerCase()}</strong>. Check that this is the address you mean.</> : "Type the address yourself; it is never filled in for you."}
      >
        <div className={`input-wrap ${error ? "has-error" : ""}`}>
          <Mail size={18} />
          {/* autoComplete="off" (not "username"/"email") and the ignore hints keep browsers and password
              managers from filling in a saved login; the code goes to exactly what is typed here. */}
          <input
            id="setup-email"
            name="staff-setup-work-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(""); }}
            aria-invalid={Boolean(error)}
            autoFocus
          />
        </div>
      </Field>
      <button className="primary-button" type="submit" disabled={busy}>
        {busy ? (<><LoaderCircle size={18} className="spin" aria-hidden="true" /> Sending…</>) : (<>Send code <ArrowRight size={18} aria-hidden="true" /></>)}
      </button>
    </form>
  );
}
