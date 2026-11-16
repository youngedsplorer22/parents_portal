import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  LoaderCircle,
  Lock,
  Mail,
  Phone,
  UserRound,
} from "lucide-react";
import { getSession, loginErrorMessage, loginWithPassword, loginWithToken } from "./api/authApi.js";
import { normalizeEmail, otpErrorMessage, sendEmailOtp } from "./api/emailOtpApi.js";
import { fieldErrorsFrom, registerParent, registrationErrorMessage } from "./api/registrationApi.js";
import BrandLogo from "./components/BrandLogo.jsx";
import EmailOtpStep from "./components/auth/EmailOtpStep.jsx";
import ForgotPasswordFlow from "./components/auth/ForgotPasswordFlow.jsx";
import { passwordProblem } from "./auth/passwordRules.js";
import OnboardingFlow from "./components/onboarding/OnboardingFlow.jsx";
import PasswordInput from "./components/PasswordInput.jsx";
import { personNameError, phoneError } from "./validation/rules.js";
import { nextPhoneValue } from "./validation/phoneInput.js";
const ROLES = ["Student", "Teacher", "Team Leader"];
function SocialButtons({ onSocial }) {
  return (
    <div className="social-actions">
      <button
        type="button"
        className="social-action-button"
        onClick={() => onSocial("Google")}
      >
        <span className="google-g" aria-hidden="true">
          G
        </span>
        <span>Google</span>
      </button>

      <button
        type="button"
        className="social-action-button"
        onClick={() => onSocial("Microsoft")}
      >
        <span className="microsoft-icon" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span>Microsoft</span>
      </button>
    </div>
  );
}
function Field({ id, label, required, error, hint, children }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {required && <span className="required">*</span>}
      </label>
      {children}
      {error ? <p id={`${id}-error`} className="field-error">{error}</p> : hint ? <p id={`${id}-hint`} className="field-hint">{hint}</p> : null}
    </div>
  );
}
/** For the input inside a Field: marks it invalid and links it to the message Field shows (the error, else the hint). */
const fieldA11y = (id, error, hint) => ({
  "aria-invalid": error ? "true" : undefined,
  "aria-describedby": error ? `${id}-error` : hint ? `${id}-hint` : undefined,
});
const EMPTY_REGISTRATION = { firstName: "", lastName: "", role: "", phone: "", email: "", password: "" };
function RegisterForm({ onAuthenticated, join = null }) {
  const [values, setValues] = useState(EMPTY_REGISTRATION);
  const [errors, setErrors] = useState({});
  const [step, setStep] = useState("form"); // "form" | "otp" | "registering" | "created"
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [formError, setFormError] = useState("");
  const [challenge, setChallenge] = useState(null);
  // The verification token lives in this component's memory only. It is never
  // rendered, logged or written to localStorage/sessionStorage, and it is lost
  // on reload or when switching tabs. It is bound to this email by the server.
  const [verification, setVerification] = useState(null); // { email, token, expiresAt }
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);

  const update = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
    setFormError("");
    if (key === "email") setVerification(null);
  };
  const validate = () => {
    const next = {};
    // Same name and phone rules as the server (validation/rules.js); the server checks again and is the authority.
    if (!values.firstName.trim()) next.firstName = "Please enter your first name.";
    else if (personNameError("First name", values.firstName.trim())) next.firstName = personNameError("First name", values.firstName.trim());
    if (!values.lastName.trim()) next.lastName = "Please enter your last name.";
    else if (personNameError("Last name", values.lastName.trim())) next.lastName = personNameError("Last name", values.lastName.trim());
    if (!values.role) next.role = "Please select your role.";
    if (!values.phone.trim()) next.phone = "Phone number is required.";
    else if (phoneError(values.phone.trim())) next.phone = phoneError(values.phone.trim());
    if (!values.email.trim()) next.email = "Email address is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) next.email = "Enter a valid email address.";
    // The server applies the same rules (and a common-password check); these only save a round trip.
    const passwordIssue = passwordProblem(values.password);
    if (passwordIssue) next.password = passwordIssue;
    return next;
  };

  // Creates the account with the verified token, then continues straight into the onboarding form.
  // Nothing is shown as done until the backend has confirmed the registration (201) and a session exists.
  const completeRegistration = async (token) => {
    setStep("registering");
    setSubmitError("");
    request.current?.abort();
    request.current = new AbortController();
    const { signal } = request.current;
    try {
      await registerParent({ ...values, verificationToken: token, publicTrip: join?.address }, { signal });
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (err.code === "EMAIL_ALREADY_REGISTERED") {
        // Keep everything the user typed; only the email needs to change.
        setVerification(null);
        setErrors((current) => ({ ...current, email: registrationErrorMessage(err) }));
        setStep("form");
      } else if (err.code === "VERIFICATION_REQUIRED") {
        setVerification(null);
        setFormError(registrationErrorMessage(err));
        setStep("form");
      } else if (err.code === "TRIP_NOT_FOUND" || err.code === "TRIP_NOT_OPEN") {
        // Nothing was created. The trip stays as it is: this page never falls back to registering the
        // parent without it (or for another trip).
        setFormError(registrationErrorMessage(err));
        setStep("form");
      } else if (err.code === "VALIDATION_ERROR") {
        setErrors((current) => ({ ...current, ...fieldErrorsFrom(err) }));
        setFormError(registrationErrorMessage(err));
        setStep("form");
      } else {
        setSubmitError(registrationErrorMessage(err));
      }
      return;
    }
    // The token is spent: drop it. The server has also started the session (HttpOnly cookie).
    setVerification(null);
    try {
      const user = await getSession({ signal });
      if (!user) throw new Error("no session");
      onAuthenticated(user);
    } catch (err) {
      if (err?.name === "AbortError") return;
      setStep("created");
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (sending) return;
    const next = validate();
    setErrors(next);
    setFormError("");
    if (Object.keys(next).length > 0) return;

    const email = normalizeEmail(values.email);
    if (verification && verification.email === email && Date.now() < verification.expiresAt) {
      completeRegistration(verification.token);
      return;
    }
    setVerification(null);
    setSending(true);
    request.current?.abort();
    request.current = new AbortController();
    try {
      const result = await sendEmailOtp(email, { signal: request.current.signal });
      setChallenge({ email, ...result });
      setStep("otp");
    } catch (err) {
      if (err?.name === "AbortError") return;
      setFormError(otpErrorMessage(err));
    }
    setSending(false);
  };

  if (step === "otp" && challenge) {
    return (
      <EmailOtpStep
        email={challenge.email}
        challenge={challenge}
        onBack={() => setStep("form")}
        onVerified={({ token, expiresInSeconds }) => {
          setVerification({ email: challenge.email, token, expiresAt: Date.now() + expiresInSeconds * 1000 });
          completeRegistration(token);
        }}
      />
    );
  }
  if (step === "registering") {
    return (
      <div className="success-panel" role="status" aria-live="polite">
        {submitError ? null : <LoaderCircle size={28} className="spin" aria-hidden="true" />}
        <h1>{submitError ? "We couldn't finish yet" : "Setting up your account…"}</h1>
        {!submitError && <p>Please wait while we create your account and open your form.</p>}
        {submitError && (
          <>
            <div className="status-message error" role="alert">
              <span>{submitError}</span>
            </div>
            <button className="primary-button" type="button" onClick={() => completeRegistration(verification.token)} disabled={!verification}>
              Try again
            </button>
            <div className="otp-actions">
              <button className="text-button" type="button" onClick={() => setStep("form")}>
                Back to form
              </button>
            </div>
          </>
        )}
      </div>
    );
  }
  if (step === "created") {
    return (
      <div className="success-panel">
        <h1>Account created</h1>
        <p>Your account was created, but we couldn't sign you in automatically. Please open the Login tab and sign in with your password or a code sent to your email.</p>
      </div>
    );
  }

  const emailVerified = verification && verification.email === normalizeEmail(values.email);
  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      <div className="form-heading">
        <h1 className="text-center">Create your account</h1>
      </div>
      <div className="form-grid">
        <Field id="register-firstname" label="First Name" required error={errors.firstName}>
          <div className={`input-wrap ${errors.firstName ? "has-error" : ""}`}>
            <UserRound size={18} />
            <input
              id="register-firstname" {...fieldA11y("register-firstname", errors.firstName, null)}
              value={values.firstName}
              onChange={(e) => update("firstName", e.target.value)}
              placeholder="As per Passport/Govt ID"
              autoComplete="given-name"
            />
          </div>
        </Field>
        <Field id="register-lastname" label="Last Name" required error={errors.lastName}>
          <div className={`input-wrap ${errors.lastName ? "has-error" : ""}`}>
            <UserRound size={18} />
            <input
              id="register-lastname" {...fieldA11y("register-lastname", errors.lastName, null)}
              value={values.lastName}
              onChange={(e) => update("lastName", e.target.value)}
              placeholder="As per Passport/Govt ID"
              autoComplete="family-name"
            />
          </div>
        </Field>
        <Field id="register-role" label="Role" required error={errors.role}>
          <div className={`input-wrap select-wrap ${errors.role ? "has-error" : ""}`}>
            <select id="register-role" {...fieldA11y("register-role", errors.role, null)} value={values.role} onChange={(e) => update("role", e.target.value)}>
              <option value="">Select role</option>
              {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
            </select>
            <ChevronDown size={18} className="select-icon" aria-hidden="true" />
          </div>
        </Field>
        <Field id="register-phone" label="Phone Number" required error={errors.phone}>
          <div className={`input-wrap ${errors.phone ? "has-error" : ""}`}>
            <Phone size={18} />
            {/* No maxLength on purpose: typing stops at 10, but a paste is never cut down (validation/phoneInput.js). */}
            <input
              id="register-phone" {...fieldA11y("register-phone", errors.phone, null)}
              type="tel"
              value={values.phone}
              onChange={(e) => update("phone", nextPhoneValue(values.phone, e.target.value))}
              placeholder="9876543210"
              autoComplete="tel-national"
              inputMode="numeric"
            />
          </div>
        </Field>
        <Field
          id="register-email"
          label="Email address"
          required
          error={errors.email}
          hint={emailVerified ? "Email verified." : "We'll send a 6-digit code to this address."}
        >
          <div className={`input-wrap ${errors.email ? "has-error" : ""}`}>
            <Mail size={18} />
            <input
              id="register-email" {...fieldA11y("register-email", errors.email, true)}
              type="email"
              value={values.email}
              onChange={(e) => update("email", e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
        </Field>
        <Field id="register-password" label="Password" required error={errors.password} hint="At least 10 characters.">
          <div className={`input-wrap ${errors.password ? "has-error" : ""}`}>
            <Lock size={18} />
            <PasswordInput
              id="register-password" {...fieldA11y("register-password", errors.password, true)}
              value={values.password}
              onChange={(e) => update("password", e.target.value)}
              placeholder="Create a password"
              autoComplete="new-password"
              toggleLabel="password"
            />
          </div>
        </Field>
      </div>
      {formError && (
        <div className="status-message error" role="alert">
          <span>{formError}</span>
        </div>
      )}
      <button className="primary-button" type="submit" disabled={sending}>
        {sending ? (<><LoaderCircle size={18} className="spin" /> Sending code…</>) : (<>{emailVerified ? "Continue" : "Verify email"} <ArrowRight size={18} /></>)}
      </button>
    </form>
  );
}
function LoginForm({ onAuthenticated, notice }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [formError, setFormError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [resetNotice, setResetNotice] = useState("");
  const [socialMessage, setSocialMessage] = useState("");
  const [step, setStep] = useState("email"); // "email" | "otp" | "signing-in"
  const [sending, setSending] = useState(false);
  const [challenge, setChallenge] = useState(null);
  const [signInError, setSignInError] = useState("");
  const [pendingToken, setPendingToken] = useState(null); // in memory only, like the registration token
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);

  // Exchanges the verified login token for a session. Success is the server's answer, nothing else.
  const signIn = async (token, forEmail) => {
    setStep("signing-in");
    setSignInError("");
    request.current?.abort();
    request.current = new AbortController();
    try {
      const user = await loginWithToken(forEmail, token, { signal: request.current.signal });
      setPendingToken(null);
      onAuthenticated(user);
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (err.code === "ACCOUNT_NOT_FOUND" || err.code === "VERIFICATION_REQUIRED") {
        setPendingToken(null);
        setError(loginErrorMessage(err));
        setStep("email");
      } else {
        setPendingToken(token);
        setSignInError(loginErrorMessage(err));
      }
    }
  };

  if (forgot) {
    return (
      <ForgotPasswordFlow
        initialEmail={email}
        onBackToLogin={(resetEmail) => {
          if (resetEmail) {
            // after a reset: the email is filled in, the password is not, and the user logs in themselves
            setEmail(resetEmail);
            setResetNotice("Your password was changed. Log in with your new password.");
          }
          setPassword("");
          setForgot(false);
        }}
      />
    );
  }
  if (step === "otp" && challenge) {
    return (
      <EmailOtpStep
        email={challenge.email}
        challenge={challenge}
        purpose="login"
        onBack={() => setStep("email")}
        onVerified={({ token }) => signIn(token, challenge.email)}
      />
    );
  }
  if (step === "signing-in") {
    return (
      <div className="success-panel" role="status" aria-live="polite">
        {signInError ? null : <LoaderCircle size={28} className="spin" aria-hidden="true" />}
        <h1>{signInError ? "We couldn't log you in" : "Logging you in…"}</h1>
        {signInError && (
          <>
            <div className="status-message error" role="alert">
              <span>{signInError}</span>
            </div>
            <button className="primary-button" type="button" onClick={() => signIn(pendingToken, normalizeEmail(email))} disabled={!pendingToken}>
              Try again
            </button>
            <div className="otp-actions">
              <button className="text-button" type="button" onClick={() => setStep("email")}>
                Back
              </button>
            </div>
          </>
        )}
      </div>
    );
  }
  // Email + password. Success is the server's answer (it creates the session); nothing is assumed.
  const submitPassword = async (event) => {
    event.preventDefault();
    if (loggingIn || sending) return;
    setFormError("");
    const emailProblem = !email.trim()
      ? "Email address is required."
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
        ? "Enter a valid email address."
        : "";
    const passwordProblem = password ? "" : "Password is required.";
    setError(emailProblem);
    setPasswordError(passwordProblem);
    if (emailProblem || passwordProblem) return;
    setLoggingIn(true);
    request.current?.abort();
    request.current = new AbortController();
    try {
      const user = await loginWithPassword(email, password, { signal: request.current.signal });
      onAuthenticated(user);
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (err.code === "INVALID_CREDENTIALS") setPassword("");
      setFormError(loginErrorMessage(err));
    }
    setLoggingIn(false);
  };

  const sendOtp = async (event) => {
    event.preventDefault();
    if (sending || loggingIn) return;
    if (!email.trim()) {
      setError("Email address is required.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setError("");
    setFormError("");
    setSending(true);
    request.current?.abort();
    request.current = new AbortController();
    try {
      const result = await sendEmailOtp(normalizeEmail(email), { signal: request.current.signal, purpose: "login" });
      setChallenge({ email: normalizeEmail(email), ...result });
      setStep("otp");
    } catch (err) {
      if (err?.name === "AbortError") return;
      setError(otpErrorMessage(err));
    }
    setSending(false);
  };
  return (
    <div className="login-content">
      <div className="form-heading">
        <h1 className="text-center">Welcome back</h1>
      </div>
      {notice && <div className="status-message info" role="status"><span>{notice}</span></div>}
      {resetNotice && <div className="status-message info" role="status"><span>{resetNotice}</span></div>}
      <form className="auth-form" onSubmit={submitPassword} noValidate>
        <Field id="login-email" label="Email address" required error={error}>
          <div className={`input-wrap ${error ? "has-error" : ""}`}>
            <Mail size={18} />
            <input
              id="login-email" {...fieldA11y("login-email", error, null)}
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(""); setFormError(""); setSocialMessage(""); }}
              placeholder="you@example.com"
              autoComplete="email"
              inputMode="email"
            />
          </div>
        </Field>
        <Field id="login-password" label="Password" required error={passwordError}>
          <div className={`input-wrap ${passwordError ? "has-error" : ""}`}>
            <Lock size={18} />
            <PasswordInput
              id="login-password" {...fieldA11y("login-password", passwordError, null)}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setPasswordError(""); setFormError(""); }}
              placeholder="Enter your password"
              autoComplete="current-password"
              toggleLabel="password"
            />
          </div>
        </Field>
        <div className="forgot-row">
          <button type="button" className="text-button" onClick={() => setForgot(true)} disabled={loggingIn || sending}>
            Forgot password?
          </button>
        </div>
        {formError && (
          <div className="status-message error" role="alert">
            <span>{formError}</span>
          </div>
        )}
        <button className="primary-button" type="submit" disabled={loggingIn || sending}>
          {loggingIn ? (<><LoaderCircle size={18} className="spin" /> Logging in…</>) : (<>Log in <ArrowRight size={18} /></>)}
        </button>
        <button className="secondary-button" type="button" onClick={sendOtp} disabled={loggingIn || sending}>
          {sending ? (<><LoaderCircle size={18} className="spin" /> Sending code…</>) : "Send OTP"}
        </button>
      </form>
      <div className="divider"><span>or continue with Google/Microsoft</span></div>
      <SocialButtons onSocial={(provider) => { setSocialMessage(`${provider} authentication will be connected later.`); setError(""); }} />
      {socialMessage && <div className="status-message info" role="status"><span>{socialMessage}</span></div>}
    </div>
  );
}
/**
 * The parent portal. `join` is set only on a trip's public page (/join/:school/:branch/:trip/continue): { address, school, trip }.
 * The token comes from the address bar, so a refresh or a new tab keeps the same trip, and the server resolves and
 * checks it on every request that uses it. On the plain homepage (/) there is no trip at all.
 * `enrolmentId` (from /registrations/:id) opens one of the parent's own registrations. Both still need the parent to be signed in, and the server checks ownership.
 */
export default function App({ join = null, enrolmentId = null, existingOnly = false, initialTab = "register" }) {
  const [activeTab, setActiveTab] = useState(initialTab);
  // "loading" until the server says whether there is a valid session (HttpOnly cookie).
  const [session, setSession] = useState({ status: "loading", user: null });
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    getSession({ signal: controller.signal })
      .then((user) => setSession(user ? { status: "authenticated", user } : { status: "anonymous", user: null }))
      .catch((err) => {
        if (err?.name !== "AbortError") setSession({ status: "anonymous", user: null });
      });
    return () => controller.abort();
  }, []);

  const authenticated = useCallback((user) => {
    setNotice("");
    setSession({ status: "authenticated", user });
  }, []);
  const signedOut = useCallback((message = "") => {
    setNotice(message);
    setActiveTab("login");
    setSession({ status: "anonymous", user: null });
  }, []);

  if (session.status === "authenticated") {
    return (
      <main className="onboarding-screen" aria-label="Young Edsplorer onboarding">
        <OnboardingFlow user={session.user} onSignedOut={signedOut} join={join} enrolmentId={enrolmentId} existingOnly={existingOnly} />
      </main>
    );
  }
  if (session.status === "loading") {
    return (
      <main className="parent-portal">
        <section className="glass-card" aria-label="Young Edsplorer authentication">
          <div className="auth-content">
            <BrandLogo />
            <p className="onboarding-loading" role="status"><LoaderCircle size={18} className="spin" /> Loading…</p>
          </div>
        </section>
      </main>
    );
  }
  return (
    <main className="parent-portal">
      <section className="glass-card" aria-label="Young Edsplorer authentication">
        <div className="auth-content">
          <BrandLogo />
          <div className="auth-tabs" role="tablist" aria-label="Authentication method">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "login"}
              className={`auth-tab ${activeTab === "login" ? "active" : ""}`}
              onClick={() => setActiveTab("login")}
            >Login</button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "register"}
              className={`auth-tab ${activeTab === "register" ? "active" : ""}`}
              onClick={() => setActiveTab("register")}
            >Register</button>
          </div>
          <div className="auth-form-area">
            {activeTab === "register" ? <RegisterForm onAuthenticated={authenticated} join={join} /> : <LoginForm onAuthenticated={authenticated} notice={notice} />}
          </div>
          {!join && (
            <p className="portal-switch">
              Parent portal. Young Edsplorer staff? <a href="/sales/login">Sales log in</a> · <a href="/admin/login">Admin log in</a>
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
