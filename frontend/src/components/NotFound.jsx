import BrandLogo from "./BrandLogo.jsx";

/** Any address that isn't a portal page or a trip registration link. Never the parent app by default. */
export default function NotFound() {
  return (
    <main className="parent-portal">
      <section className="glass-card" aria-label="Young Edsplorer">
        <div className="auth-content join-page">
          <BrandLogo />
          <div className="join-body">
            <h1 className="join-school">Page not found</h1>
            <p className="join-caption">There's nothing at this address. Choose where you want to go:</p>
            <p className="portal-switch">
              <a href="/sales">Sales portal</a> · <a href="/admin">Admin portal</a> · <a href="/parent/login">Parent log in</a>
            </p>
            <p className="join-caption">Parents: open the trip registration link your school sent you.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
