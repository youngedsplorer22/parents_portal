import { Link } from "react-router-dom";
import BrandLogo from "../components/BrandLogo.jsx";

/**
 * An address from the retired secret-link system (/join/<token>, /join/<school>/<trip>/<token>). Those links no longer
 * open a registration. Nothing is looked up and the old token is never sent anywhere. A parent who already registered
 * keeps everything: logging in opens their registration.
 */
export default function RetiredLink() {
  return (
    <main className="parent-portal">
      <section className="glass-card" aria-label="Young Edsplorer registration">
        <div className="auth-content join-page">
          <BrandLogo />
          <div className="join-body">
            <h1 className="join-school">This older link no longer works</h1>
            <div className="status-message info" role="status">
              <span>Registration links have changed. Please ask your school for the trip's registration page.</span>
            </div>
            <p className="join-caption">Already registered? Your saved and submitted registrations are safe.</p>
            <Link className="primary-button join-action" to="/parent/login">Log in to continue</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
