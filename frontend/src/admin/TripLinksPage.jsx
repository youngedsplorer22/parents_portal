import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Copy } from "lucide-react";
import { getTrip, publicAddress, setPublicRegistration } from "./adminApi.js";
import { useStaff } from "./staffContext.js";
import { attempt, useAdminData } from "./useAdminData.js";

/**
 * A trip's registration link: the trip's public page address (school, branch and trip words; no secret token, by the
 * project lead's decision), its on/off switch, and Copy link. Only staff who manage the trip reach it (the server
 * answers "not found" for anyone else's trip). Parents still register or log in before seeing any personal data.
 */
export default function TripLinksPage() {
  const { tripId } = useParams();
  const { expire, base } = useStaff();
  const trip = useAdminData((o) => getTrip(tripId, o), [tripId]);
  const [publicError, setPublicError] = useState("");
  const [copied, setCopied] = useState("");

  if (trip.status === "loading") return <p role="status">Loading…</p>;
  if (trip.status === "error") return <p className="admin-error" role="alert">{trip.error}</p>;
  const t = trip.data;
  const takesRegistrations = t.publicRegistration && t.status === "active";

  const togglePublic = async (enabled) => {
    setCopied("");
    const done = await attempt(() => setPublicRegistration(tripId, enabled), { expire, setError: setPublicError });
    if (done) {
      setPublicError("");
      trip.reload();
    }
  };

  // The address is not a secret (it is the trip's public page), so it can be shown and copied at any time.
  const address = publicAddress(t);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied("Copied.");
    } catch {
      setCopied("Couldn't copy automatically. Select the address above and copy it.");
    }
  };

  return (
    <>
      <p><Link to={`${base}/trips/${t.id}`}>← {t.title}</Link></p>
      <h1>Registration link</h1>
      <p className="admin-muted">{t.schoolName}{t.schoolBranch ? ` · ${t.schoolBranch}` : ""} · {t.title}</p>
      {t.status === "draft" && <p className="admin-notice">This trip is still a draft. Activate it on the <Link to={`${base}/trips/${t.id}`}>trip page</Link> so parents can register.</p>}
      <section className="admin-card" aria-labelledby="trip-public">
        <h2 id="trip-public">Public registration page</h2>
        <p>
          <strong>{t.publicRegistration ? "On" : "Off"}</strong>
          {" — "}
          {takesRegistrations && "parents can open this page and register (within the opening and closing times, if set)."}
          {t.publicRegistration && t.status === "draft" && "the page will take registrations once the trip is activated."}
          {t.publicRegistration && t.status === "closed" && "the page is shown, but registration is closed."}
          {!t.publicRegistration && "the page isn't available and no one can register from it."}
        </p>
        <p className="admin-muted">
          This page is public: anyone with the address can see the school and trip name. Parents still need to register or log in
          (with an email code) before they can see or enter any personal details.
        </p>
        <label htmlFor="trip-public-address">Registration page address</label>
        <input id="trip-public-address" className="admin-input" readOnly value={address} onFocus={(e) => e.target.select()} />
        <div className="admin-row admin-top">
          <button type="button" className="admin-button" onClick={copy}><Copy size={16} aria-hidden="true" /> Copy link</button>
          {t.status !== "archived" &&
            (t.publicRegistration ? (
              <button type="button" className="admin-button admin-button-danger" onClick={() => togglePublic(false)}>Turn off public registration</button>
            ) : (
              <button type="button" className="admin-button admin-button-primary" onClick={() => togglePublic(true)}>Turn on public registration</button>
            ))}
        </div>
        {copied && <p role="status">{copied}</p>}
        {publicError && <p className="admin-error" role="alert">{publicError}</p>}
        {t.status === "archived" && <p className="admin-muted">An archived trip's public page can't be changed.</p>}
      </section>
    </>
  );
}
