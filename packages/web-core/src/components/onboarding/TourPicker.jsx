import { ArrowRight, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { onboardingErrorMessage } from "../../api/onboardingApi.js";
import { ROLE_LABELS } from "../../onboarding/formEngine.js";

const TOURS = [
  { id: "domestic", description: "Travel within India." },
  { id: "international", description: "Travel abroad. Passport and PAN details are needed." },
];

/** First step: choose which core sheet to fill in. The choice is saved with the draft. */
export default function TourPicker({ role, definitions, trip = null, onChoose }) {
  // A parent who came through a school's trip link has no choice: the trip decides the form.
  const fixed = trip?.tourType ?? null;
  const [tour, setTour] = useState(fixed ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!tour) {
      setError("Choose Domestic Tours or International Tours to continue.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onChoose(tour);
    } catch (err) {
      setError(onboardingErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="tour-picker" onSubmit={submit} noValidate>
      <fieldset className="tour-fieldset" aria-describedby={error ? "tour-error" : undefined}>
        <legend className="tour-legend">{fixed ? "Your school's trip" : "Which tour is this for?"}</legend>
        {fixed && (
          <p className="tour-note">
            <strong>{trip.title}</strong>{trip.destination ? ` · ${trip.destination}` : ""}. The form below follows this trip.
          </p>
        )}
        <p className="tour-note">
          You registered as <strong>{ROLE_LABELS[role] ?? role}</strong>, so you'll see the {ROLE_LABELS[role] ?? role} columns of the core sheet.
        </p>
        <div className="tour-grid">
          {TOURS.filter((t) => !fixed || t.id === fixed).map((t) => (
            <label key={t.id} className={`tour-card ${tour === t.id ? "selected" : ""}`}>
              <input type="radio" name="tour" value={t.id} checked={tour === t.id} disabled={Boolean(fixed)} onChange={() => { setTour(t.id); setError(""); }} />
              <span className="tour-title">{definitions[t.id].title}</span>
              <span className="tour-desc">{t.description}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p id="tour-error" className="field-error" role="alert">{error}</p>}
      <button className="primary-button tour-continue" type="submit" disabled={busy}>
        {busy ? (<><LoaderCircle size={18} className="spin" /> Starting…</>) : (<>Continue <ArrowRight size={18} /></>)}
      </button>
    </form>
  );
}
