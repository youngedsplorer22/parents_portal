import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { addItineraryItem, listItinerary, listItineraryTrips, updateItineraryItem } from "./adminApi.js";
import { useStaff } from "./staffContext.js";
import { attempt, useAdminData } from "./useAdminData.js";

const EMPTY = { dayNumber: "", title: "", details: "" };

/** Whole number 1 to 366, as text, or a message. */
const dayProblem = (v) => (/^\d{1,3}$/.test(String(v).trim()) && Number(v) >= 1 && Number(v) <= 366 ? "" : "Enter the day as a whole number from 1 to 366.");

/**
 * One trip's itinerary: add an item, edit an item. There is no delete. The server lets Sales in only for trips assigned to
 * them and re-checks every request; a 403 here means "not your trip".
 */
export default function ItineraryPage() {
  const { tripId } = useParams();
  const { expire, base } = useStaff();
  const trips = useAdminData((o) => listItineraryTrips(o), []);
  const items = useAdminData((o) => listItinerary(tripId, o), [tripId]);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // { id, dayNumber, title, details }
  const [editErrors, setEditErrors] = useState({});
  const [editError, setEditError] = useState("");

  const trip = trips.status === "ready" ? trips.data.find((t) => t.id === tripId) : null;
  const set = (k, v) => { setValues((c) => ({ ...c, [k]: v })); setErrors((e) => ({ ...e, [k]: "" })); setFormError(""); };

  const validate = (v) => {
    const next = {};
    if (dayProblem(v.dayNumber)) next.dayNumber = dayProblem(v.dayNumber);
    if (!v.title.trim()) next.title = "Enter a title for this item.";
    return next;
  };

  const add = async (event) => {
    event.preventDefault();
    if (busy) return;
    const next = validate(values);
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const made = await attempt(
      () => addItineraryItem(tripId, { dayNumber: Number(values.dayNumber), title: values.title.trim(), details: values.details.trim() || null }),
      { expire, setError: setFormError },
    );
    setBusy(false);
    if (made) { setValues(EMPTY); items.reload(); }
  };

  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    const next = validate(editing);
    setEditErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const done = await attempt(
      () => updateItineraryItem(tripId, editing.id, { dayNumber: Number(editing.dayNumber), title: editing.title.trim(), details: editing.details.trim() || null }),
      { expire, setError: setEditError },
    );
    setBusy(false);
    if (done) { setEditing(null); items.reload(); }
  };

  if (items.status === "loading") return <p role="status">Loading…</p>;
  if (items.status === "error") {
    return (
      <>
        <p><Link to={`${base}/itineraries`}>← Itineraries</Link></p>
        <p className="admin-error" role="alert">{items.error}</p>
      </>
    );
  }

  return (
    <>
      <p><Link to={`${base}/itineraries`}>← Itineraries</Link></p>
      <h1>{trip ? `${trip.title} itinerary` : "Itinerary"}</h1>
      {trip && <p className="admin-muted">{trip.schoolName}{trip.schoolBranch ? ` · ${trip.schoolBranch}` : ""}{trip.academicYear ? ` · ${trip.academicYear}` : ""}</p>}

      <section className="admin-card" aria-labelledby="itinerary-items">
        <h2 id="itinerary-items">Itinerary</h2>
        {items.data.length === 0 ? (
          <p className="admin-muted">Nothing added yet. Add the first item below.</p>
        ) : (
          <ol className="admin-itinerary">
            {items.data.map((it) => (
              <li key={it.id}>
                {editing?.id === it.id ? (
                  <form onSubmit={save} noValidate className="admin-form-grid" aria-label={`Edit day ${it.dayNumber}`}>
                    <div>
                      <label htmlFor={`edit-day-${it.id}`}>Day</label>
                      <input id={`edit-day-${it.id}`} className="admin-input" inputMode="numeric" value={editing.dayNumber} maxLength={3} aria-invalid={Boolean(editErrors.dayNumber)} onChange={(e) => { setEditing({ ...editing, dayNumber: e.target.value }); setEditErrors({}); setEditError(""); }} />
                      {editErrors.dayNumber && <p className="admin-error">{editErrors.dayNumber}</p>}
                    </div>
                    <div>
                      <label htmlFor={`edit-title-${it.id}`}>Title</label>
                      <input id={`edit-title-${it.id}`} className="admin-input" value={editing.title} maxLength={200} aria-invalid={Boolean(editErrors.title)} onChange={(e) => { setEditing({ ...editing, title: e.target.value }); setEditErrors({}); setEditError(""); }} />
                      {editErrors.title && <p className="admin-error">{editErrors.title}</p>}
                    </div>
                    <div className="admin-full">
                      <label htmlFor={`edit-details-${it.id}`}>Details (optional)</label>
                      <textarea id={`edit-details-${it.id}`} className="admin-input" rows={3} maxLength={2000} value={editing.details} onChange={(e) => setEditing({ ...editing, details: e.target.value })} />
                    </div>
                    <div className="admin-full">
                      {editError && <p className="admin-error" role="alert">{editError}</p>}
                      <div className="admin-row">
                        <button type="submit" className="admin-button admin-button-primary" disabled={busy}>Save changes</button>
                        <button type="button" className="admin-button" onClick={() => { setEditing(null); setEditErrors({}); setEditError(""); }}>Cancel</button>
                      </div>
                    </div>
                  </form>
                ) : (
                  <div className="admin-itinerary-item">
                    <div>
                      <strong>Day {it.dayNumber}: {it.title}</strong>
                      {it.details && <p className="admin-itinerary-details">{it.details}</p>}
                    </div>
                    <button type="button" className="admin-button" aria-label={`Edit day ${it.dayNumber}: ${it.title}`} onClick={() => { setEditing({ id: it.id, dayNumber: String(it.dayNumber), title: it.title, details: it.details ?? "" }); setEditErrors({}); setEditError(""); }}>Edit</button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="admin-card" aria-labelledby="itinerary-add">
        <h2 id="itinerary-add">Add an item</h2>
        <form onSubmit={add} noValidate className="admin-form-grid" aria-busy={busy}>
          <div>
            <label htmlFor="item-day">Day</label>
            <input id="item-day" className="admin-input" inputMode="numeric" value={values.dayNumber} maxLength={3} placeholder="1" aria-invalid={Boolean(errors.dayNumber)} onChange={(e) => set("dayNumber", e.target.value)} disabled={busy} />
            {errors.dayNumber && <p className="admin-error">{errors.dayNumber}</p>}
          </div>
          <div>
            <label htmlFor="item-title">Title</label>
            <input id="item-title" className="admin-input" value={values.title} maxLength={200} placeholder="e.g. Arrive in Jaipur" aria-invalid={Boolean(errors.title)} onChange={(e) => set("title", e.target.value)} disabled={busy} />
            {errors.title && <p className="admin-error">{errors.title}</p>}
          </div>
          <div className="admin-full">
            <label htmlFor="item-details">Details (optional)</label>
            <textarea id="item-details" className="admin-input" rows={3} maxLength={2000} value={values.details} onChange={(e) => set("details", e.target.value)} disabled={busy} />
          </div>
          <div className="admin-full">
            {formError && <p className="admin-error" role="alert">{formError}</p>}
            <button type="submit" className="admin-button admin-button-primary" disabled={busy}>Add to itinerary</button>
          </div>
        </form>
      </section>
    </>
  );
}
