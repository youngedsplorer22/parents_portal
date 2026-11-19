import BrandLogo from "../components/BrandLogo.jsx";

/**
 * The page around the staff sign-in, first-time setup and forgot-password screens. It is the SAME
 * structure the parents' sign-in and the school link page use (portal background, frosted-glass card,
 * logo), and it is rendered OUTSIDE the `.admin` wrapper so the internal panel's own element rules
 * (headings, labels, links) can never restyle it. Signed-in admin pages are unchanged.
 */
export default function StaffAuthLayout({ children }) {
  return (
    <main className="parent-portal">
      <section className="glass-card" aria-label="Young Edsplorer staff sign in">
        <div className="auth-content">
          <BrandLogo label="Young Edsplorer staff" />
          {children}
        </div>
      </section>
    </main>
  );
}

/** Label, control and message, laid out like the parent portal's fields. */
export function Field({ id, label, error, hint, children }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {children}
      {error ? <p className="field-error" id={`${id}-error`}>{error}</p> : hint ? <p className="field-hint" aria-live="polite">{hint}</p> : null}
    </div>
  );
}
