import { useState } from "react";
import { createStaff, listStaff, setStaffActive } from "./adminApi.js";
import { useStaff } from "./staffContext.js";
import { attempt, useAdminData } from "./useAdminData.js";

const EMPTY = { name: "", email: "" };
const STATUS_LABEL = { pending: "Pending setup", active: "Active", inactive: "Deactivated" };

/**
 * Manage staff (admins only; the server checks again). Admins create SALES accounts here and can switch
 * them on and off. Admin accounts are created and changed only with the command-line tool or by IT, so
 * no screen can mint or lock out an admin. There is NO password here: a new account is "pending", and its
 * owner sets their own password at /sales/login with a code emailed to them.
 */
export default function StaffPage() {
  const { expire } = useStaff();
  const { status, data, error, reload } = useAdminData((o) => listStaff(o), []);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [created, setCreated] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null); // id of the person whose "Deactivate" awaits confirmation
  const [rowError, setRowError] = useState("");

  const set = (key, value) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: "" }));
    setFormError("");
    setCreated("");
  };

  const add = async (event) => {
    event.preventDefault();
    if (busy) return;
    const next = {};
    if (!values.name.trim()) next.name = "Enter the person's name.";
    if (!values.email.trim()) next.email = "Enter an email address.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) next.email = "Enter a valid email address.";
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    const made = await attempt(
      () => createStaff({ name: values.name.trim(), email: values.email.trim().toLowerCase() }),
      { expire, setError: setFormError },
    );
    setBusy(false);
    if (made) {
      setValues(EMPTY);
      setCreated(made.email);
      reload();
    }
  };

  const change = async (person, active) => {
    setRowError("");
    const done = await attempt(() => setStaffActive(person.id, active), { expire, setError: setRowError });
    setConfirming(null);
    if (done) reload();
  };

  return (
    <>
      <h1>Manage staff</h1>
      <p className="admin-muted">Create sales accounts and switch them on or off. Admin accounts are managed with the command-line tool.</p>

      <section className="admin-card" aria-labelledby="add-staff">
        <h2 id="add-staff">Add a sales account</h2>
        <form onSubmit={add} noValidate className="admin-form-grid" autoComplete="off">
          <div>
            <label htmlFor="staff-name">Full name</label>
            <input id="staff-name" className="admin-input" value={values.name} maxLength={100} onChange={(e) => set("name", e.target.value)} aria-invalid={Boolean(errors.name)} />
            {errors.name && <p className="admin-error">{errors.name}</p>}
          </div>
          <div>
            <label htmlFor="staff-email">Email address</label>
            <input id="staff-email" className="admin-input" type="email" value={values.email} maxLength={254} onChange={(e) => set("email", e.target.value)} aria-invalid={Boolean(errors.email)} />
            {errors.email && <p className="admin-error">{errors.email}</p>}
          </div>
          <div className="admin-full">
            <p className="admin-muted">The role is Sales. You don't set a password: tell the person to open /sales/login and choose "First time or forgot your password?". A code is emailed to this address, and only its owner can set the password.</p>
            {formError && <p className="admin-error" role="alert">{formError}</p>}
            {created && <p className="admin-success" role="status">Added {created}. Their status is Pending setup until they set a password at /sales/login.</p>}
            <button type="submit" className="admin-button admin-button-primary" disabled={busy}>{busy ? "Adding…" : "Add sales account"}</button>
          </div>
        </form>
      </section>

      <section className="admin-card" aria-labelledby="staff-list">
        <h2 id="staff-list">Staff</h2>
        {rowError && <p className="admin-error" role="alert">{rowError}</p>}
        {status === "loading" && <p role="status">Loading…</p>}
        {status === "error" && <p className="admin-error" role="alert">{error}</p>}
        {status === "ready" && (
          <div className="admin-table-wrap">
            <table className="admin-table admin-table-stack">
              <caption className="admin-sr">Staff accounts</caption>
              <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{p.name}</th>
                    <td data-label="Email" className="admin-break">{p.email}</td>
                    <td data-label="Role"><em className={`admin-role admin-role-${p.role}`}>{p.role}</em></td>
                    <td data-label="Status"><span className={`admin-tag ${p.status === "active" ? "" : "admin-tag-off"}`}>{STATUS_LABEL[p.status] ?? p.status}</span></td>
                    <td data-label="Action">
                      {p.role !== "sales" ? (
                        <span className="admin-muted">Command-line tool</span>
                      ) : p.status === "inactive" ? (
                        <button type="button" className="admin-button" onClick={() => change(p, true)} aria-label={`Activate ${p.name}`}>Activate</button>
                      ) : confirming === p.id ? (
                        <span className="admin-row">
                          <button type="button" className="admin-button admin-button-danger" onClick={() => change(p, false)} aria-label={`Confirm deactivating ${p.name}`}>Yes, deactivate</button>
                          <button type="button" className="admin-button" onClick={() => setConfirming(null)}>Cancel</button>
                        </span>
                      ) : (
                        <button type="button" className="admin-button admin-button-danger" onClick={() => setConfirming(p.id)} aria-label={`Deactivate ${p.name}`}>Deactivate</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {status === "ready" && <p className="admin-muted">Deactivating someone signs them out straight away and stops them logging in or resetting their password. You can activate them again later.</p>}
      </section>
    </>
  );
}
