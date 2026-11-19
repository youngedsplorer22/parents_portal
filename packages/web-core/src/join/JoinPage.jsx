import { Link, useParams } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import PortalHeader from "../components/PortalHeader.jsx";
import { ClosedLink, NotSetUp } from "../portal/PortalNotice.jsx";
import { isOldToken, pagePath } from "./address.js";
import RetiredLink from "./RetiredLink.jsx";
import { brandedInfo, useDeploymentGuard } from "./useDeploymentGuard.js";
import { usePublicTrip } from "./usePublicTrip.js";

const TOUR_LABEL = { domestic: "Domestic tour", international: "International tour" };

/**
 * A trip's public registration page (/join/:school/:branch/:trip). The Young Edsplorer branding comes first and the
 * school name sits directly underneath it. Everything shown comes from the server; nothing here can be typed or chosen
 * by the parent, and no personal data is shown before logging in.
 *
 * "Register or log in" goes to /join/:school/:branch/:trip/continue: the same portal screens, with the trip still in
 * the address, so a refresh or a new tab keeps it and a new or returning parent is tied to this trip.
 */
export default function JoinPage() {
  const { school, branch, trip } = useParams();
  const address = { school, branch, trip };
  const guard = useDeploymentGuard(address);
  // A portal customised for another school or trip (or for none) never asks the server about this address.
  const current = usePublicTrip(guard.state === "free" || guard.state === "bound" ? address : null);
  const info = brandedInfo(current.status === "ready" ? current.info : null, guard.deployment);

  // /join/<school>/<trip>/<old token> from the retired links has the same shape: explain it, look nothing up.
  if (isOldToken(trip)) return <RetiredLink />;
  if (guard.state === "unset") return <NotSetUp />;
  if (guard.state === "closed") return <ClosedLink />;

  return (
    <main className="parent-portal">
      <section className="glass-card" aria-label="Young Edsplorer trip registration">
        <div className="auth-content join-page">
          <PortalHeader schoolName={info?.school.name ?? ""} schoolLogo={info?.school.logo ?? null} />
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
          {info && (
            <div className="join-body">
              <dl className="join-trip">
                <div><dt>Trip</dt><dd>{info.trip.title}</dd></div>
                {info.trip.destination && <div><dt>Destination</dt><dd>{info.trip.destination}</dd></div>}
                <div><dt>Type</dt><dd>{TOUR_LABEL[info.trip.tourType] ?? info.trip.tourType}</dd></div>
              </dl>
              {info.registrationOpen ? (
                <>
                  <div className="status-message success" role="status"><span>Registration is open for this trip.</span></div>
                  <Link className="primary-button join-action" to={`${pagePath(address)}/continue`}>Register or log in</Link>
                </>
              ) : (
                <div className="status-message info" role="status">
                  <span>Registration isn't open for this trip right now. Please check with your school.</span>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
