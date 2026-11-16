import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import App from "../App.jsx";
import BrandLogo from "../components/BrandLogo.jsx";
import { isOldToken } from "./address.js";
import RetiredLink from "./RetiredLink.jsx";
import { usePublicTrip } from "./usePublicTrip.js";

/**
 * /join/:school/:branch/:trip/continue: the normal parent portal (register, log in, the form) for ONE trip.
 *
 * The trip stays in the address, so a refresh, a new tab or the browser's Back button keeps the same trip. It is
 * checked with the server first: an unknown, private, archived or closed trip shows a clear message and no forms, so
 * it can never become a registration for some other trip. The server checks again, in the same transaction, on
 * registration and enrolment; nothing here sends a trip or school id.
 */
export default function JoinContinue() {
  const { school, branch, trip } = useParams();
  const current = usePublicTrip({ school, branch, trip });
  const info = current.status === "ready" ? current.info : null;

  // One stable object per trip page, so the portal's effects don't re-run on every render.
  const join = useMemo(
    () =>
      info?.registrationOpen
        ? { address: { school, branch, trip }, school: info.school.branch ? `${info.school.name} (${info.school.branch})` : info.school.name, trip: info.trip }
        : null,
    [info, school, branch, trip],
  );

  if (isOldToken(trip)) return <RetiredLink />;
  if (join) return <App join={join} />;

  return (
    <main className="parent-portal">
      <section className="glass-card" aria-label="Young Edsplorer trip registration">
        <div className="auth-content join-page">
          <BrandLogo />
          {current.status === "loading" && (
            <p className="onboarding-loading" role="status"><LoaderCircle size={18} className="spin" /> Opening the registration page…</p>
          )}
          {current.status === "error" && (
            <div className="join-body">
              <h1 className="join-school">This page can't be opened</h1>
              <div className="status-message error" role="alert"><span>{current.message}</span></div>
              <p className="join-caption">Already registered? <Link to="/parent/login">Log in to continue</Link></p>
            </div>
          )}
          {info && !info.registrationOpen && (
            <div className="join-body">
              <h1 className="join-school">{info.school.name}</h1>
              <div className="status-message info" role="status">
                <span>Registration isn't open for this trip right now. Please check with your school.</span>
              </div>
              <p className="join-caption">Already registered? <Link to="/parent/login">Log in to continue</Link></p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
