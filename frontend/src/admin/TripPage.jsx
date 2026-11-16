import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Link2 } from "lucide-react";
import { getTrip, setTripStatus, updateTrip } from "./adminApi.js";
import { useStaff } from "./staffContext.js";
import { PAYMENT_LABEL, TOUR_LABEL, academicYearProblem, toIso, toLocalInput, when } from "./tripLabels.js";
import { attempt, useAdminData } from "./useAdminData.js";
import TripLiveLocation from "./TripLiveLocation.jsx";

// Which status buttons each role gets (the server enforces the same table).
const ACTIONS = {
  draft: [{ to: "active", label: "Activate", roles: ["admin", "sales"] }, { to: "archived", label: "Archive", roles: ["admin"], confirm: true }],
  active: [{ to: "closed", label: "Close trip", roles: ["admin", "sales"] }, { to: "archived", label: "Archive", roles: ["admin"], confirm: true }],
  closed: [{ to: "active", label: "Reopen", roles: ["admin"] }, { to: "archived", label: "Archive", roles: ["admin"], confirm: true }],
  archived: [],
};

export default function TripPage() {
  const { tripId } = useParams();
  const { staff, expire, base } = useStaff();
  const trip = useAdminData((o) => getTrip(tripId, o), [tripId]);
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editError, setEditError] = useState("");

  if (trip.status === "loading") return <p role="status">Loading…</p>;
  if (trip.status === "error") return <p className="admin-error" role="alert">{trip.error}</p>;
  const t = trip.data;

  const changeStatus = async (to) => {
    setConfirming(null);
    const done = await attempt(() => setTripStatus(tripId, to), { expire, setError: setMessage });
    if (done) {
      setMessage("");
      trip.reload();
    }
  };

  const startEdit = () =>
    setEditing({ title: t.title, destination: t.destination ?? "", academicYear: t.academicYear ?? "", tourType: t.tourType, paymentMode: t.paymentMode, opensAt: toLocalInput(t.opensAt), closesAt: toLocalInput(t.closesAt) });
  const saveEdit = async (event) => {
    event.preventDefault();
    if (!editing.title.trim()) return setEditError("Enter a trip title.");
    if (editing.opensAt && editing.closesAt && new Date(editing.closesAt) <= new Date(editing.opensAt)) return setEditError("Registration must close after it opens.");
    const yearProblem = academicYearProblem(editing.academicYear);
    if (yearProblem) return setEditError(yearProblem);
    const patch = { title: editing.title, destination: editing.destination.trim() || null, opensAt: toIso(editing.opensAt), closesAt: toIso(editing.closesAt) };
    if (editing.academicYear.trim() !== (t.academicYear ?? "")) patch.academicYear = editing.academicYear.trim() || null;
    if (t.status === "draft") Object.assign(patch, { tourType: editing.tourType, paymentMode: editing.paymentMode });
    const done = await attempt(() => updateTrip(tripId, patch), { expire, setError: setEditError });
    if (done) {
      setEditing(null);
      trip.reload();
    }
  };

  const actions = (ACTIONS[t.status] ?? []).filter((a) => a.roles.includes(staff.role));

  return (
    <>
      <p><Link to={`${base}/schools/${t.schoolId}`}>← {t.schoolName}</Link></p>
      <h1>{t.title} <span className="admin-tag">{t.status}</span></h1>

      <section className="admin-card" aria-labelledby="trip-details">
        <h2 id="trip-details">Details</h2>
        {editing === null ? (
          <>
            <dl className="admin-details">
              <div><dt>School</dt><dd>{t.schoolName}{t.schoolBranch ? ` · ${t.schoolBranch}` : ""}</dd></div>
              <div><dt>Tour type</dt><dd>{TOUR_LABEL[t.tourType]}</dd></div>
              <div><dt>Destination</dt><dd>{t.destination || "—"}</dd></div>
              <div><dt>Academic year</dt><dd>{t.academicYear || "—"}</dd></div>
              <div><dt>Payment mode</dt><dd>{PAYMENT_LABEL[t.paymentMode]}</dd></div>
              <div><dt>Form template</dt><dd>{t.templateKey}</dd></div>
              <div><dt>Registration opens</dt><dd>{when(t.opensAt)}</dd></div>
              <div><dt>Registration closes</dt><dd>{when(t.closesAt)}</dd></div>
            </dl>
            <p className="admin-muted">These dates control when parents can register. They are not the trip travel dates.</p>
            {t.status !== "archived" && <button type="button" className="admin-button" onClick={startEdit}>Edit details</button>}
          </>
        ) : (
          <form onSubmit={saveEdit} noValidate className="admin-form-grid">
            <div>
              <label htmlFor="edit-title">Trip title</label>
              <input id="edit-title" className="admin-input" value={editing.title} maxLength={150} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
            </div>
            <div>
              <label htmlFor="edit-destination">Destination</label>
              <input id="edit-destination" className="admin-input" value={editing.destination} maxLength={100} onChange={(e) => setEditing({ ...editing, destination: e.target.value })} />
            </div>
            <div>
              <label htmlFor="edit-year">Academic year</label>
              <input id="edit-year" className="admin-input" value={editing.academicYear} maxLength={7} placeholder="2026-27" onChange={(e) => setEditing({ ...editing, academicYear: e.target.value })} />
            </div>
            <div>
              <label htmlFor="edit-type">Tour type</label>
              <select id="edit-type" className="admin-input" value={editing.tourType} disabled={t.status !== "draft"} onChange={(e) => setEditing({ ...editing, tourType: e.target.value })}>
                <option value="domestic">Domestic</option>
                <option value="international">International</option>
              </select>
            </div>
            <div>
              <label htmlFor="edit-payment">Payment mode</label>
              <select id="edit-payment" className="admin-input" value={editing.paymentMode} disabled={t.status !== "draft"} onChange={(e) => setEditing({ ...editing, paymentMode: e.target.value })}>
                <option value="none">No payment</option>
                <option value="payment">Payment</option>
              </select>
            </div>
            <p id="edit-dates-help" className="admin-muted admin-full">These dates control when parents can register. They are not the trip travel dates.</p>
            <div>
              <label htmlFor="edit-opens">Registration opens</label>
              <input id="edit-opens" className="admin-input" type="datetime-local" value={editing.opensAt} onChange={(e) => setEditing({ ...editing, opensAt: e.target.value })} aria-describedby="edit-dates-help" />
            </div>
            <div>
              <label htmlFor="edit-closes">Registration closes</label>
              <input id="edit-closes" className="admin-input" type="datetime-local" value={editing.closesAt} onChange={(e) => setEditing({ ...editing, closesAt: e.target.value })} aria-describedby="edit-dates-help" />
            </div>
            <div className="admin-full">
              {t.status !== "draft" && <p className="admin-muted">Tour type and payment mode can only change while the trip is a draft.</p>}
              {editError && <p className="admin-error" role="alert">{editError}</p>}
              <div className="admin-row">
                <button type="submit" className="admin-button admin-button-primary">Save changes</button>
                <button type="button" className="admin-button" onClick={() => { setEditing(null); setEditError(""); }}>Cancel</button>
              </div>
            </div>
          </form>
        )}
      </section>

      <section className="admin-card" aria-labelledby="trip-status">
        <h2 id="trip-status">Status</h2>
        <p>
          {t.status === "draft" && "Draft: parents can't register yet."}
          {t.status === "active" && "Active: parents can register from the trip's public page when it is switched on (within the opening and closing times, if set)."}
          {t.status === "closed" && "Closed: no new registrations. Parents keep access to the registrations they already made."}
          {t.status === "archived" && "Archived: read-only, and its public page is no longer shown."}
        </p>
        <div className="admin-row">
          {actions.map((a) =>
            confirming === a.to ? (
              <span key={a.to} className="admin-row">
                <button type="button" className="admin-button admin-button-danger" onClick={() => changeStatus(a.to)}>Confirm: {a.label.toLowerCase()}</button>
                <button type="button" className="admin-button" onClick={() => setConfirming(null)}>Cancel</button>
              </span>
            ) : (
              <button key={a.to} type="button" className="admin-button" onClick={() => (a.confirm ? setConfirming(a.to) : changeStatus(a.to))}>{a.label}</button>
            ),
          )}
          {actions.length === 0 && t.status !== "archived" && <span className="admin-muted">Only an admin can make further status changes.</span>}
        </div>
        {message && <p className="admin-error" role="alert">{message}</p>}
      </section>

      <section className="admin-card" aria-labelledby="trip-link">
        <div className="admin-row admin-between">
          <h2 id="trip-link">Registration link</h2>
          <Link className="admin-button admin-button-primary" to={`${base}/trips/${t.id}/links`}><Link2 size={16} aria-hidden="true" /> Registration link</Link>
        </div>
        <p>
          <span className={`status-pill ${t.publicRegistration && t.status === "active" ? "success" : ""}`}>{t.publicRegistration ? "On" : "Off"}</span>{" "}
          {t.publicRegistration && t.status === "active" ? "Parents can register from the trip's link." : "Parents can't register from the link yet."}
        </p>
      </section>
      <TripLiveLocation tripId={t.id} tripStatus={t.status} />
    </>
  );
}
