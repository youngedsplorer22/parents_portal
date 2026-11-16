import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createTrip, listSchools } from "./adminApi.js";
import { useStaff } from "./staffContext.js";
import { academicYearProblem, toIso } from "./tripLabels.js";
import { attempt, useAdminData } from "./useAdminData.js";

const EMPTY = { title: "", tourType: "", destination: "", academicYear: "", paymentMode: "", opensAt: "", closesAt: "" };

/**
 * Create a trip for one school. The school must be one this person manages (the server checks it again and answers
 * "not found" otherwise). New trips start as a draft; afterwards the trip's page opens, where it can be activated and
 * its registration link turned on.
 */
export default function NewTripPage() {
  const { schoolId } = useParams();
  const { expire, base } = useStaff();
  const navigate = useNavigate();
  const schools = useAdminData((o) => listSchools({ includeArchived: true, ...o }), []);
  const school = schools.data?.find((s) => s.id === schoolId);
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (key, value) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: "" }));
    setFormError("");
  };

  const add = async (event) => {
    event.preventDefault();
    if (busy) return;
    const next = {};
    if (!values.title.trim()) next.title = "Enter a trip title.";
    if (!values.tourType) next.tourType = "Choose domestic or international.";
    if (!values.paymentMode) next.paymentMode = "Choose a payment mode.";
    const yearProblem = academicYearProblem(values.academicYear);
    if (yearProblem) next.academicYear = yearProblem;
    if (values.opensAt && values.closesAt && new Date(values.closesAt) <= new Date(values.opensAt)) next.closesAt = "Registration must close after it opens.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const created = await attempt(
      () => createTrip(schoolId, {
        title: values.title,
        tourType: values.tourType,
        destination: values.destination.trim() || null,
        ...(values.academicYear.trim() ? { academicYear: values.academicYear.trim() } : {}),
        paymentMode: values.paymentMode,
        opensAt: toIso(values.opensAt),
        closesAt: toIso(values.closesAt),
      }),
      { expire, setError: setFormError },
    );
    setBusy(false);
    if (created) navigate(`${base}/trips/${created.id}`); // next step: the trip, then its registration link
  };

  if (schools.status === "loading") return <p role="status">Loading…</p>;
  if (schools.status === "error") return <p className="admin-error" role="alert">{schools.error}</p>;
  if (!school) return <section className="admin-card" role="alert"><h1>School not found</h1><p className="admin-muted">It doesn't exist, or it isn't one of the schools you manage.</p><Link to={`${base}/schools`}>Back to schools</Link></section>;
  if (school.status !== "active") return <section className="admin-card" role="alert"><h1>{school.name}</h1><p>Trips can't be added to an archived school.</p><Link to={`${base}/schools/${school.id}`}>Back to the school</Link></section>;

  return (
    <>
      <p><Link to={`${base}/schools/${school.id}`}>← {school.name}</Link></p>
      <h1>Create a trip</h1>
      <p className="admin-muted">For {school.name}{school.branch ? ` · ${school.branch}` : ""}.</p>
      <section className="admin-card" aria-labelledby="add-trip">
        <h2 id="add-trip">Trip details</h2>
        <p className="admin-muted">New trips start as a draft. The form template is worked out from the tour type and payment mode.</p>
        <form onSubmit={add} noValidate className="admin-form-grid">
          <div>
            <label htmlFor="trip-title">Trip title</label>
            <input id="trip-title" className="admin-input" value={values.title} maxLength={150} onChange={(e) => set("title", e.target.value)} aria-invalid={Boolean(errors.title)} />
            {errors.title && <p className="admin-error">{errors.title}</p>}
          </div>
          <div>
            <label htmlFor="trip-type">Tour type</label>
            <select id="trip-type" className="admin-input" value={values.tourType} onChange={(e) => set("tourType", e.target.value)} aria-invalid={Boolean(errors.tourType)}>
              <option value="">Select…</option>
              <option value="domestic">Domestic</option>
              <option value="international">International</option>
            </select>
            {errors.tourType && <p className="admin-error">{errors.tourType}</p>}
          </div>
          <div>
            <label htmlFor="trip-destination">Destination (optional)</label>
            <input id="trip-destination" className="admin-input" value={values.destination} maxLength={100} onChange={(e) => set("destination", e.target.value)} />
          </div>
          <div>
            <label htmlFor="trip-year">Academic year (optional)</label>
            <input id="trip-year" className="admin-input" value={values.academicYear} maxLength={7} placeholder="2026-27" onChange={(e) => set("academicYear", e.target.value)} aria-invalid={Boolean(errors.academicYear)} />
            {errors.academicYear && <p className="admin-error">{errors.academicYear}</p>}
          </div>
          <div>
            <label htmlFor="trip-payment">Payment mode</label>
            <select id="trip-payment" className="admin-input" value={values.paymentMode} onChange={(e) => set("paymentMode", e.target.value)} aria-invalid={Boolean(errors.paymentMode)}>
              <option value="">Select…</option>
              <option value="none">No payment</option>
              <option value="payment">Payment</option>
            </select>
            {errors.paymentMode && <p className="admin-error">{errors.paymentMode}</p>}
          </div>
          <p id="trip-dates-help" className="admin-muted admin-full">These dates control when parents can register. They are not the trip travel dates.</p>
          <div>
            <label htmlFor="trip-opens">Registration opens (optional)</label>
            <input id="trip-opens" className="admin-input" type="datetime-local" value={values.opensAt} onChange={(e) => set("opensAt", e.target.value)} aria-describedby="trip-dates-help" />
          </div>
          <div>
            <label htmlFor="trip-closes">Registration closes (optional)</label>
            <input id="trip-closes" className="admin-input" type="datetime-local" value={values.closesAt} onChange={(e) => set("closesAt", e.target.value)} aria-describedby="trip-dates-help" aria-invalid={Boolean(errors.closesAt)} />
            {errors.closesAt && <p className="admin-error">{errors.closesAt}</p>}
          </div>
          <div className="admin-full">
            {formError && <p className="admin-error" role="alert">{formError}</p>}
            <button type="submit" className="admin-button admin-button-primary" disabled={busy}>{busy ? "Creating…" : "Create trip"}</button>
          </div>
        </form>
      </section>
    </>
  );
}
