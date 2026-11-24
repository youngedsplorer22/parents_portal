import { Link } from "react-router-dom";
import BrandLogo from "../components/BrandLogo.jsx";

/**
 * A plain page with the company logo and one message, for a public portal that cannot show a registration page: it is not set
 * up for any school yet, or the address is for another school's trip. It names no school and offers no registration form.
 */
export default function PortalNotice({ title, message }) {
  return (
    <main className="parent-portal">
      <section className="glass-card" aria-label="Young Edsplorer">
        <div className="auth-content join-page">
          <BrandLogo />
          <div className="join-body">
            <h1 className="join-school">{title}</h1>
            <div className="status-message info" role="status"><span>{message}</span></div>
            <p className="join-caption">Already registered? <Link to="/parent/login">Log in to continue</Link></p>
            <p className="portal-switch"><a href="/sales/login">Sales staff? Log in</a></p>
          </div>
        </div>
      </section>
    </main>
  );
}

export const ClosedLink = () => (
  <PortalNotice title="This link isn't available" message="This registration link is closed or no longer available. Please check with your school for the current link." />
);
export const NotSetUp = () => (
  <PortalNotice title="Registration isn't open" message="This registration portal isn't set up yet. Please check with your school for the registration link." />
);
