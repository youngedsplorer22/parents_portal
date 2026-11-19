import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, LoaderCircle, Lock, Mail } from "lucide-react";
import { adminErrorMessage, staffLogin } from "./adminApi.js";
import StaffAuthLayout, { Field } from "./StaffAuthLayout.jsx";
import PasswordInput from "../components/PasswordInput.jsx";
import { PORTALS } from "./staffContext.js";

export default function SalesLogin({ portal = "sales", notice, onSignedIn }) {
  const info = PORTALS[portal];
  const navigate = useNavigate();
  // After setting a password the address they TYPED in the setup flow comes back here (router state, never storage).
  // The password is never carried.
  const cameBackWith = useLocation().state?.email;
  const [email, setEmail] = useState(typeof cameBackWith === "string" ? cameBackWith : "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(null);
  useEffect(() => () => request.current?.abort(), []);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setError("");
    setBusy(true);
    request.current?.abort();
    request.current = new AbortController();
    try {
      const staff = await staffLogin(email, password, { signal: request.current.signal });
      onSignedIn(staff);
      return;
    } catch (err) {
      if (err?.name === "AbortError") return;
      setPassword("");
      setError(adminErrorMessage(err));
    }
    setBusy(false);
  };

  return (
    <StaffAuthLayout>
      <form className="auth-form" onSubmit={submit} noValidate>
        <div className="form-heading">
          <h1 className="text-center">{info.login}</h1>
          <p className="staff-caption">Young Edsplorer sales team only</p>
        </div>
        {notice && <div className="status-message info" role="status"><span>{notice}</span></div>}
        <Field id="admin-email" label="Email address">
          <div className="input-wrap">
            <Mail size={18} />
            <input id="admin-email" type="email" autoComplete="username" inputMode="email" placeholder="you@company.com" value={email} onChange={(e) => { setEmail(e.target.value); setError(""); }} />
          </div>
        </Field>
        <Field id="admin-password" label="Password">
          <div className="input-wrap">
            <Lock size={18} />
            <PasswordInput id="admin-password" autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }} toggleLabel="password" />
          </div>
        </Field>
        <div className="forgot-row">
          <button type="button" className="text-button" onClick={() => navigate(`${info.base}/login/setup`)} disabled={busy}>
            First time or forgot your password?
          </button>
        </div>
        {error && <div className="status-message error" role="alert"><span>{error}</span></div>}
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? (<><LoaderCircle size={18} className="spin" aria-hidden="true" /> Logging in…</>) : (<>Log in <ArrowRight size={18} aria-hidden="true" /></>)}
        </button>
        {/* No parent entry point here: parents arrive through the trip registration link the Sales team shares. */}
      </form>
    </StaffAuthLayout>
  );
}
