import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createSchool } from "./adminApi.js";
import { useStaff } from "./staffContext.js";
import { attempt } from "./useAdminData.js";

/** Add a school. The server records who added it; a salesperson then manages it (and only their own schools). */
export default function NewSchoolPage() {
  const { expire, base } = useStaff();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) return setFormError("Enter the school's name.");
    setBusy(true);
    const created = await attempt(() => createSchool(name, branch), { expire, setError: setFormError });
    setBusy(false);
    if (created) navigate(`${base}/schools/${created.id}`, { state: { justCreated: true } }); // next step: create a trip
  };

  return (
    <>
      <p><Link to={`${base}/schools`}>← Schools</Link></p>
      <h1>Add a school</h1>
      <section className="admin-card" aria-labelledby="add-school">
        <h2 id="add-school">School details</h2>
        <form onSubmit={add} noValidate className="admin-row">
          <div className="admin-grow">
            <label htmlFor="school-name">School name</label>
            <input id="school-name" className="admin-input" value={name} maxLength={150} autoFocus onChange={(e) => { setName(e.target.value); setFormError(""); }} />
          </div>
          <div className="admin-grow">
            <label htmlFor="school-branch">Branch</label>
            <input id="school-branch" className="admin-input" value={branch} maxLength={100} placeholder="e.g. Kolkata Branch" onChange={(e) => { setBranch(e.target.value); setFormError(""); }} aria-describedby="school-branch-help" />
          </div>
          <button type="submit" className="admin-button admin-button-primary" disabled={busy}>{busy ? "Adding…" : "Add school"}</button>
        </form>
        <p id="school-branch-help" className="admin-muted">Add the branch if the school has more than one (for example Kolkata Branch). The same school can be added once per branch.</p>
        {formError && <p className="admin-error" role="alert">{formError}</p>}
      </section>
    </>
  );
}
