import { Navigate } from "react-router-dom";
import BrandLogo from "../components/BrandLogo.jsx";
import { getVariant } from "@pp/contracts/variants";
import { pagePath } from "../join/address.js";
import { NotSetUp } from "./PortalNotice.jsx";
import { usePortal } from "./PortalContext.jsx";

/**
 * The root of a public registration portal. A portal customised for a school and trip opens that trip's page; one that was not
 * customised says it is not set up (it never guesses a school). Only the combined app (target "all") has no trip of its own.
 */
export default function PublicLanding({ target }) {
  const variant = getVariant(target);
  const { deployment } = usePortal();
  if (variant && deployment) return <Navigate to={pagePath(deployment)} replace />;
  if (variant) return <NotSetUp />;
  return (
    <main className="parent-portal">
      <section className="glass-card" aria-label="Young Edsplorer">
        <div className="auth-content join-page">
          <BrandLogo />
          <div className="join-body">
            <h1 className="join-school">{variant ? `${variant.label} registration` : "Registration"}</h1>
            <p className="join-caption">Open the trip registration link your school sent you to register.</p>
            <p className="portal-switch"><a href="/parent/login">Already registered? Log in</a></p>
            <p className="portal-switch"><a href="/sales/login">Sales staff? Log in</a></p>
          </div>
        </div>
      </section>
    </main>
  );
}
