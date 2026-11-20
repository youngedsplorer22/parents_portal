import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { confirmProblem, passwordProblem } from "../auth/passwordRules.js";
import { changeStaffPassword } from "./adminApi.js";
import { useStaff } from "./staffContext.js";
import { attempt } from "./useAdminData.js";
import PasswordInput from "../components/PasswordInput.jsx";

const EMPTY = { currentPassword: "", password: "", confirmPassword: "" };

/**
 * Change your own password while signed in. The current password is required (checked by the server,
 * which counts wrong guesses). Your other devices are signed out; this one stays signed in.
 */
export default function ChangePasswordPage() {
  const { expire, base } = useStaff();
  const navigate = useNavigate();
  const cameFromInside = useLocation().key !== "default"; // opened from another page, so "back" has somewhere real to go
  const [leaving, setLeaving] = useState(false);
  const [values, setValues] = useState(EMPTY);
  const [round, setRound] = useState(0); // remounts the fields after a change, so every eye toggle is masked again
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = (key, value) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: "" }));
    setFormError("");
    setDone(false);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const next = {};
    if (!values.currentPassword) next.currentPassword = "Enter your current password.";
    const pw = passwordProblem(values.password);
    if (pw) next.password = pw;
    else if (values.password === values.currentPassword) next.password = "Choose a password different from your current one.";
    const cf = confirmProblem(values.password, values.confirmPassword);
    if (cf) next.confirmPassword = cf;
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    const ok = await attempt(() => changeStaffPassword(values).then(() => true), { expire, setError: setFormError });
    setBusy(false);
    if (ok) {
      setValues(EMPTY); // nothing secret stays in the page
      setRound((r) => r + 1);
      setDone(true);
    }
  };

  const dirty = Boolean(values.currentPassword || values.password || values.confirmPassword);
  const goBack = () => (cameFromInside ? navigate(-1) : navigate(`${base}/dashboard`));

  return (
    <>
      {leaving ? (
        <p className="admin-notice" role="alertdialog" aria-label="Leave this page?">
          You've typed something that hasn't been saved. Leave anyway?{" "}
          <button type="button" className="admin-button" onClick={goBack}>Leave</button>{" "}
          <button type="button" className="admin-button" onClick={() => setLeaving(false)}>Stay</button>
        </p>
      ) : (
        <button type="button" className="admin-back" onClick={() => (dirty ? setLeaving(true) : goBack())}>
          <ArrowLeft size={16} aria-hidden="true" /> {cameFromInside ? "Back" : "Back to dashboard"}
        </button>
      )}
      <h1>Change password</h1>
      <p className="admin-muted">You'll stay signed in here. Any other device where you are signed in is signed out.</p>
      <section className="admin-card" aria-labelledby="change-password">
        <h2 id="change-password">Your password</h2>
        <form key={round} onSubmit={submit} noValidate className="admin-form-grid" autoComplete="off">
          <div className="admin-full">
            <label htmlFor="current-password">Current password</label>
            <div className="admin-password">
              <PasswordInput id="current-password" className="admin-input" autoComplete="current-password" value={values.currentPassword} onChange={(e) => set("currentPassword", e.target.value)} aria-invalid={Boolean(errors.currentPassword)} toggleLabel="current password" />
            </div>
            {errors.currentPassword && <p className="admin-error">{errors.currentPassword}</p>}
          </div>
          <div>
            <label htmlFor="new-password">New password</label>
            <div className="admin-password">
              <PasswordInput id="new-password" className="admin-input" autoComplete="new-password" value={values.password} onChange={(e) => set("password", e.target.value)} aria-invalid={Boolean(errors.password)} toggleLabel="new password" />
            </div>
            {errors.password && <p className="admin-error">{errors.password}</p>}
          </div>
          <div>
            <label htmlFor="confirm-new-password">Confirm new password</label>
            <div className="admin-password">
              <PasswordInput id="confirm-new-password" className="admin-input" autoComplete="new-password" value={values.confirmPassword} onChange={(e) => set("confirmPassword", e.target.value)} aria-invalid={Boolean(errors.confirmPassword)} toggleLabel="password confirmation" />
            </div>
            {errors.confirmPassword && <p className="admin-error">{errors.confirmPassword}</p>}
          </div>
          <div className="admin-full">
            {formError && <p className="admin-error" role="alert">{formError}</p>}
            {done && <p className="admin-success" role="status">Your password was changed.</p>}
            <button type="submit" className="admin-button admin-button-primary" disabled={busy}>{busy ? "Saving…" : "Change password"}</button>
          </div>
        </form>
      </section>
    </>
  );
}
