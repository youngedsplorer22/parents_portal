import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Mail,
  Phone,
  ShieldCheck,
  UserRound,
} from "lucide-react";
const SCHOOLS = [
  "Young Edsplorer International School",
  "Young Edsplorer Public School",
  "Young Edsplorer Academy",
  "Other / Not listed",
];
const ROLES = ["Student", "Teacher", "Team Leader"];
function BrandLogo() {
  return (
    <div className="brand" aria-label="Young Edsplorer Parent Portal">
      <div className="brand">
        <img
            src="./../public/company_logo.png"
            alt="Young Edsplorer"
            className="brand-logo"
        />  
      </div>
    </div>
  );
}
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
      {error ? <p className="field-error">{error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}
function RegisterForm() {
  const [values, setValues] = useState({
    name: "",
    school: "",
    role: "",
    phone: "",
    email: "",
  });
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const update = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
    setSubmitted(false);
  };
  const validate = () => {
    const next = {};
    if (!values.name.trim()) next.name = "Please enter your name.";
    if (!values.school) next.school = "Please select your school.";
    if (!values.role) next.role = "Please select your role.";
    if (!values.phone.trim()) next.phone = "Phone number is required.";
    else if (!/^\+?[0-9\s()-]{8,15}$/.test(values.phone.trim())) next.phone = "Enter a valid phone number.";
    if (!values.email.trim()) next.email = "Email address is required.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) next.email = "Enter a valid email address.";
    return next;
  };
  const submit = (event) => {
    event.preventDefault();
    const next = validate();
    setErrors(next);
    setSubmitted(Object.keys(next).length === 0);
  };
  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      <div className="form-heading">
        <h1 className="text-center">Create your account</h1>
      </div>
      <div className="form-grid">
        <Field id="register-firstname" label="First Name" required error={errors.firstname}>
          <div className={`input-wrap ${errors.name ? "has-error" : ""}`}>
            <UserRound size={18} />
            <input
              id="register-firstname"
              value={values.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="As per Passport/Govt ID"
              autoComplete="firstName"
            />
          </div>
        </Field>
        <Field id="register-lastname" label="Last Name" required error={errors.firstname}>
          <div className={`input-wrap ${errors.name ? "has-error" : ""}`}>
            <UserRound size={18} />
            <input
              id="register-lastname"
              value={values.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="As per Passport/Govt ID"
              autoComplete="lastName"
            />
          </div>
        </Field>      
        <Field id="register-school" label="School" required error={errors.school}>
          <div className={`input-wrap select-wrap ${errors.school ? "has-error" : ""}`}>
            <select id="register-school" value={values.school} onChange={(e) => update("school", e.target.value)}>
              <option value="">Select school</option>
              {SCHOOLS.map((school) => <option key={school} value={school}>{school}</option>)}
            </select>
            <ChevronDown size={18} className="select-icon" aria-hidden="true" />
          </div>
        </Field>
        <Field id="register-role" label="Role" required error={errors.role}>
          <div className={`input-wrap select-wrap ${errors.role ? "has-error" : ""}`}>
            <select id="register-role" value={values.role} onChange={(e) => update("role", e.target.value)}>
              <option value="">Select role</option>
              {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
            </select>
            <ChevronDown size={18} className="select-icon" aria-hidden="true" />
          </div>
        </Field>
        <Field id="register-phone" label="Phone" required error={errors.phone}>
          <div className={`input-wrap ${errors.phone ? "has-error" : ""}`}>
            <Phone size={18} />
            <input
              id="register-phone"
              type="tel"
              value={values.phone}
              onChange={(e) => update("phone", e.target.value)}
              placeholder="Enter phone number"
              autoComplete="tel"
              inputMode="tel"
            />
          </div>
        </Field>
        <Field id="register-email" label="Email address" required error={errors.email}>
          <div className={`input-wrap ${errors.email ? "has-error" : ""}`}>
            <Mail size={18} />
            <input
              id="register-email"
              type="email"
              value={values.email}
              onChange={(e) => update("email", e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
        </Field>
      </div>
      {submitted && (
        <div className="status-message success" role="status">
          <Check size={17} />
          <span>Details validated successfully. Registration will be connected to the backend next.</span>
        </div>
      )}
      <button className="primary-button" type="submit">
        Create Account
        <ArrowRight size={18} />
      </button>
    </form>
  );
}
function OtpVerification({ email, onBack, onVerified }) {
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [seconds, setSeconds] = useState(60);
  const [error, setError] = useState("");
  const refs = useRef([]);
  useEffect(() => {
    refs.current[0]?.focus();
    const timer = setInterval(() => setSeconds((current) => current > 0 ? current - 1 : 0), 1000);
    return () => clearInterval(timer);
  }, []);
  const updateOtp = (index, value) => {
    const digits = value.replace(/\D/g, "");
    if (!digits) {
      setOtp((current) => current.map((item, i) => i === index ? "" : item));
      return;
    }
    const next = [...otp];
    digits.split("").slice(0, 6 - index).forEach((digit, offset) => {
      next[index + offset] = digit;
    });
    setOtp(next);
    refs.current[Math.min(index + digits.length, 5)]?.focus();
  };
  const keyDown = (index, event) => {
    if (event.key === "Backspace" && !otp[index] && index > 0) refs.current[index - 1]?.focus();
    if (event.key === "ArrowLeft" && index > 0) refs.current[index - 1]?.focus();
    if (event.key === "ArrowRight" && index < 5) refs.current[index + 1]?.focus();
  };
  const verify = (event) => {
    event.preventDefault();
    const code = otp.join("");
    if (code.length !== 6) {
      setError("Enter the 6-digit verification code.");
      return;
    }
    setError("");
    onVerified();
  };
  const resend = () => {
    setOtp(["", "", "", "", "", ""]);
    setSeconds(60);
    setError("");
    refs.current[0]?.focus();
  };
  return (
    <form className="auth-form otp-form" onSubmit={verify}>
      <button type="button" className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> Change email
      </button>
      <div className="form-heading">
        <h1>Enter verification code</h1>
        <p>We sent a one-time code to <strong>{email}</strong>.</p>
      </div>
      <div className="otp-row" aria-label="One-time password">
        {otp.map((value, index) => (
          <input
            key={index}
            ref={(element) => { refs.current[index] = element; }}
            className="otp-input"
            value={value}
            onChange={(event) => updateOtp(index, event.target.value)}
            onKeyDown={(event) => keyDown(index, event)}
            onPaste={(event) => {
              event.preventDefault();
              updateOtp(index, event.clipboardData.getData("text"));
            }}
            inputMode="numeric"
            maxLength={6}
            aria-label={`OTP digit ${index + 1}`}
          />
        ))}
      </div>
      {error && <p className="field-error centered-error">{error}</p>}
      <button className="primary-button" type="submit">Verify OTP <ArrowRight size={18} /></button>
      <div className="otp-actions">
        <button type="button" className="text-button" onClick={resend} disabled={seconds > 0}>
          {seconds > 0 ? `Resend OTP in ${seconds}s` : "Resend OTP"}
        </button>
      </div>
      <p className="mock-note">Demo mode: OTP delivery will be connected to the backend later.</p>
    </form>
  );
}
function LoginForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [socialMessage, setSocialMessage] = useState("");
  const [sent, setSent] = useState(false);
  const [verified, setVerified] = useState(false);
  if (verified) {
    return (
      <div className="success-panel">
        <div className="success-icon"><Check size={25} /></div>
        <h1>You're verified</h1>
        <p>The secure login flow is ready for backend integration.</p>
        <button className="secondary-button" type="button" onClick={() => { setVerified(false); setSent(false); setEmail(""); }}>
          Start again
        </button>
      </div>
    );
  }
  if (sent) {
    return <OtpVerification email={email} onBack={() => setSent(false)} onVerified={() => setVerified(true)} />;
  }
  const sendOtp = (event) => {
    event.preventDefault();
    if (!email.trim()) {
      setError("Email address is required.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setError("");
    setSent(true);
  };
  return (
    <div className="login-content">
      <div className="form-heading">
        <h1 className="text-center">Welcome back</h1>
      </div>
      <form className="auth-form" onSubmit={sendOtp} noValidate>
        <Field id="login-email" label="Email address" required error={email ? "" : error}>
          <div className={`input-wrap ${error && email ? "has-error" : ""}`}>
            <Mail size={18} />
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(""); setSocialMessage(""); }}
              placeholder="you@example.com"
              autoComplete="email"
              inputMode="email"
            />
          </div>
        </Field>
        <button className="primary-button" type="submit">Send OTP <ArrowRight size={18} /></button>
      </form>
      <div className="divider"><span>or continue with Google/Microsoft</span></div>
      <SocialButtons onSocial={(provider) => { setSocialMessage(`${provider} authentication will be connected later.`); setError(""); }} />
      {socialMessage && <div className="status-message info" role="status"><span>{socialMessage}</span></div>}
    </div>
  );
}
export default function App() {
  const [activeTab, setActiveTab] = useState("register");
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
            {activeTab === "register" ? <RegisterForm /> : <LoginForm />}
          </div>
        </div>
      </section>
    </main>
  );
}