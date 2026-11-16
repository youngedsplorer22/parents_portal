import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CircleCheck, LoaderCircle, Lock, Mail } from "lucide-react";
import { normalizeEmail, otpErrorMessage } from "../../api/emailOtpApi.js";
import {
  confirmPasswordReset,
  requestPasswordReset,
  resendPasswordReset,
  resetErrorMessage,
  verifyPasswordResetCode,
} from "../../api/passwordResetApi.js";
import { fieldErrorsFrom } from "../../api/registrationApi.js";
import { confirmProblem, passwordProblem, PASSWORD_MIN } from "../../auth/passwordRules.js";
import EmailOtpStep from "./EmailOtpStep.jsx";
import PasswordInput from "../PasswordInput.jsx";

const client = { verify: verifyPasswordResetCode, resend: resendPasswordReset };

function Field({ id, label, error, hint, children }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        <span className="required">*</span>
      </label>
      {children}
      {error ? <p className="field-error" id={`${id}-error`}>{error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

/**
 * Forgot Password: email -> code -> new password -> done.
 *
 * The screens never say whether an account exists: the server answers the same way
 * for every email, so after "Send code" the wording is "If an account exists...".
 * The verification token lives in this component's memory only (never rendered, logged
 * or stored) and is spent by the one request that changes the password. Finishing does
 * NOT sign the user in; they are sent back to Login to sign in with the new password.
 */
export default function ForgotPasswordFlow({ initialEmail = "", onBackToLogin }) {
  const [step, setStep] = useState("email"); // "email" | "otp" | "password" | "done"
  const [email, setEmail] = useState(initialEmail);
  const [emailError, setEmailError] = useState("");
  const [formError, setFormError] = useState("");
  const [sending, setSending] = useState(false);
  const [challenge, setChallenge] = useState(null);
  const [token, setToken] = useState(null); // in memory only
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);

  const abortable = () => {
    request.current?.abort();
    request.current = new AbortController();
    return { signal: request.current.signal };
  };

  const sendCode = async (event) => {
    event.preventDefault();
    if (sending) return;
    const address = email.trim();
    if (!address) return setEmailError("Email address is required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return setEmailError("Enter a valid email address.");
    setEmailError("");
    setFormError("");
    setSending(true);
    try {
      const result = await requestPasswordReset(address, abortable());
      setChallenge({ email: normalizeEmail(address), ...result });
      setStep("otp");
    } catch (err) {
      if (err?.name === "AbortError") return;
      setFormError(otpErrorMessage(err));
    }
    setSending(false);
  };

  const backToEmail = (message = "") => {
    setToken(null);
    setPassword("");
    setConfirm("");
    setErrors({});
    setFormError(message);
    setSending(false);
    setStep("email");
  };

  const submitPassword = async (event) => {
    event.preventDefault();
    if (saving) return;
    const next = { password: passwordProblem(password), confirmPassword: confirmProblem(password, confirm) };
    setErrors(next);
    setFormError("");
    if (next.password || next.confirmPassword) return;
    setSaving(true);
    try {
      await confirmPasswordReset(
        { email: challenge.email, verificationToken: token, password, confirmPassword: confirm },
        abortable(),
      );
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (err.code === "VERIFICATION_REQUIRED") {
        backToEmail(resetErrorMessage(err));
        return;
      }
      if (err.code === "VALIDATION_ERROR") setErrors((current) => ({ ...current, ...fieldErrorsFrom(err) }));
      setFormError(resetErrorMessage(err));
      setSaving(false);
      return;
    }
    // Changed. Nothing secret is kept, and there is no session: the user logs in.
    setToken(null);
    setPassword("");
    setConfirm("");
    setSaving(false);
    setStep("done");
  };

  if (step === "otp" && challenge) {
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
      <form className="auth-form" onSubmit={submitPassword} noValidate>
        <div className="form-heading">
          <h1 className="text-center">Set a new password</h1>
          <p>Choose a new password for <strong>{challenge.email}</strong>.</p>
        </div>
        <Field id="reset-password" label="New password" error={errors.password} hint={`At least ${PASSWORD_MIN} characters.`}>
          <div className={`input-wrap ${errors.password ? "has-error" : ""}`}>
            <Lock size={18} />
            <PasswordInput
              id="reset-password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setErrors((c) => ({ ...c, password: "" })); setFormError(""); }}
              placeholder="Create a new password"
              autoComplete="new-password"
              aria-describedby={errors.password ? "reset-password-error" : undefined}
              aria-invalid={Boolean(errors.password)}
              autoFocus
              toggleLabel="password"
            />
          </div>
        </Field>
        <Field id="reset-confirm" label="Confirm new password" error={errors.confirmPassword}>
          <div className={`input-wrap ${errors.confirmPassword ? "has-error" : ""}`}>
            <Lock size={18} />
            <PasswordInput
              id="reset-confirm"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setErrors((c) => ({ ...c, confirmPassword: "" })); setFormError(""); }}
              placeholder="Re-enter the new password"
              autoComplete="new-password"
              aria-describedby={errors.confirmPassword ? "reset-confirm-error" : undefined}
              aria-invalid={Boolean(errors.confirmPassword)}
              toggleLabel="password confirmation"
            />
          </div>
        </Field>
        {formError && (
          <div className="status-message error" role="alert">
            <span>{formError}</span>
          </div>
        )}
        <button className="primary-button" type="submit" disabled={saving}>
          {saving ? (<><LoaderCircle size={18} className="spin" /> Saving…</>) : (<>Change password <ArrowRight size={18} /></>)}
        </button>
        <div className="otp-actions">
          <button type="button" className="text-button" onClick={onBackToLogin} disabled={saving}>Cancel and go back to login</button>
        </div>
      </form>
    );
  }

  if (step === "done") {
    return (
      <div className="success-panel" role="status" aria-live="polite">
        <CircleCheck size={28} aria-hidden="true" />
        <h1>Password updated</h1>
        <p>Your password has been changed and you've been signed out on every device. Please log in with your new password.</p>
        <button className="primary-button" type="button" onClick={() => onBackToLogin(challenge.email)}>
          Back to login <ArrowRight size={18} />
        </button>
      </div>
    );
  }

  return (
    <form className="auth-form" onSubmit={sendCode} noValidate>
      <button type="button" className="back-link" onClick={() => onBackToLogin()} disabled={sending}>
        <ArrowLeft size={16} /> Back to login
      </button>
      <div className="form-heading">
        <h1 className="text-center">Forgot your password?</h1>
        <p>Enter the email address you registered with. If there is an account for it, we'll send a 6-digit code to reset your password.</p>
      </div>
      <Field id="forgot-email" label="Email address" error={emailError}>
        <div className={`input-wrap ${emailError ? "has-error" : ""}`}>
          <Mail size={18} />
          <input
            id="forgot-email"
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setEmailError(""); setFormError(""); }}
            placeholder="you@example.com"
            autoComplete="email"
            inputMode="email"
            aria-describedby={emailError ? "forgot-email-error" : undefined}
            aria-invalid={Boolean(emailError)}
            autoFocus
          />
        </div>
      </Field>
      {formError && (
        <div className="status-message error" role="alert">
          <span>{formError}</span>
        </div>
      )}
      <button className="primary-button" type="submit" disabled={sending}>
        {sending ? (<><LoaderCircle size={18} className="spin" /> Sending code…</>) : (<>Send code <ArrowRight size={18} /></>)}
      </button>
    </form>
  );
}
