import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { KeyRound, LayoutDashboard, LoaderCircle, LogOut, Plane, School, ShieldAlert, Users } from "lucide-react";
import { adminErrorMessage, getStaffSession, staffLogout } from "./adminApi.js";
import AdminLogin from "./AdminLogin.jsx";
import ChangePasswordPage from "./ChangePasswordPage.jsx";
import DashboardPage from "./DashboardPage.jsx";
import NewSchoolPage from "./NewSchoolPage.jsx";
import NewTripPage from "./NewTripPage.jsx";
import SchoolPage from "./SchoolPage.jsx";
import SchoolsPage from "./SchoolsPage.jsx";
import StaffAuthLayout from "./StaffAuthLayout.jsx";
import StaffPage from "./StaffPage.jsx";
import StaffPasswordFlow from "./StaffPasswordFlow.jsx";
import { PORTALS, StaffContext, homeOf, useStaff } from "./staffContext.js";
import TripLinksPage from "./TripLinksPage.jsx";
import TripPage from "./TripPage.jsx";
import TripsPage from "./TripsPage.jsx";

/**
 * One staff portal: the Admin portal (/admin/...) or the Sales portal (/sales/...). Each has its own sign-in page and
 * dashboard. Staff have their own login and session (a parent's session does nothing here). After signing in, a
 * person always lands in THEIR role's portal; opening the other portal shows "this isn't your portal" with a link back.
 * What the screens show follows the role, but the server enforces every permission and every school/trip ownership
 * again: this is a convenience, never the protection.
 */
export default function StaffApp({ portal }) {
  const info = PORTALS[portal];
  const [session, setSession] = useState({ status: "loading", staff: null });


  useEffect(() => {
    const controller = new AbortController();
    getStaffSession({ signal: controller.signal })
      .then((staff) => setSession(staff ? { status: "in", staff } : { status: "out", staff: null }))
      .catch((err) => {
        if (err?.name !== "AbortError") setSession({ status: "out", staff: null, error: adminErrorMessage(err) });
      });
    return () => controller.abort();
  }, []);

  const expire = useCallback(() => setSession({ status: "out", staff: null, notice: "Your session has ended. Please log in again." }), []);
  const value = useMemo(() => ({ staff: session.staff, expire, portal, base: info.base }), [session.staff, expire, portal, info.base]);
  const loading = <div className="admin"><Loading /></div>;

  return (
    <Routes>
      <Route
        path="login"
        element={
          session.status === "in" ? <Navigate to={homeOf(session.staff.role)} replace />
            : session.status === "loading" ? loading
            : <AdminLogin portal={portal} notice={session.notice ?? session.error} onSignedIn={(staff) => setSession({ status: "in", staff })} />
        }
      />
      {/* First-time setup / forgot password: its own address, so Back returns to the login and a refresh restarts. */}
      <Route
        path="login/setup"
        element={session.status === "in" ? <Navigate to={homeOf(session.staff.role)} replace /> : session.status === "loading" ? loading : <StaffSetupPage base={info.base} />}
      />
      <Route
        path="*"
        element={
          session.status === "loading" ? loading
            : session.status !== "in" ? <Navigate to={`${info.base}/login`} replace />
            : session.staff.role !== portal ? <div className="admin"><WrongPortal portal={portal} role={session.staff.role} /></div>
            : (
              <div className={`admin admin-portal-${portal}`}>
                <StaffContext.Provider value={value}>
                  <Shell onSignedOut={() => setSession({ status: "out", staff: null, notice: "You have been logged out." })} />
                </StaffContext.Provider>
              </div>
            )
        }
      />
    </Routes>
  );
}

function StaffSetupPage({ base }) {
  const navigate = useNavigate();
  return (
    <StaffAuthLayout>
      <StaffPasswordFlow onBackToLogin={(address) => navigate(`${base}/login`, { state: address ? { email: address } : undefined })} />
    </StaffAuthLayout>
  );
}

/** Signed in, but this is the other role's portal: say so, show nothing of it, and link to the right one. */
function WrongPortal({ portal, role }) {
  return (
    <main className="admin-main">
      <section className="admin-card admin-denied" role="alert" aria-labelledby="denied-title">
        <ShieldAlert size={28} aria-hidden="true" />
        <h1 id="denied-title">This isn't your portal</h1>
        <p>
          You're signed in with a {role === "admin" ? "Admin" : "Sales"} account. The {PORTALS[portal].name} is for {portal === "admin" ? "administrators" : "the sales team"} only.
        </p>
        <Link className="admin-button admin-button-primary" to={homeOf(role)}>Go to the {PORTALS[role]?.name ?? "staff portal"}</Link>
      </section>
    </main>
  );
}

function Loading() {
  return (
    <p className="admin-loading" role="status">
      <LoaderCircle size={18} className="spin" aria-hidden="true" /> Loading…
    </p>
  );
}

/** One link in the top bar; current on its own path and under `also` (a school's page still counts as "Schools"). */
function SectionLink({ to, also = [], icon: Icon, children }) {
  const { pathname } = useLocation();
  const current = pathname === to || also.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return (
    <Link to={to} aria-current={current ? "page" : undefined}>
      <Icon size={16} aria-hidden="true" /> {children}
    </Link>
  );
}

function Shell({ onSignedOut }) {
  const { staff, portal, base } = useStaff();
  const { pathname } = useLocation();
  const [busy, setBusy] = useState(false);
  const info = PORTALS[portal];

  const logOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await staffLogout();
    } catch {
      /* the server session may already be gone; the browser side is cleared either way */
    }
    onSignedOut();
  };

  return (
    <>
      <header className="admin-header">
        <div className="admin-header-bar">
          <Link to={`${base}/dashboard`} className="admin-brand">
            {/* The official full logo (the same file as the sign-in screens), at its own aspect ratio. */}
            <img className="admin-brand-logo" src="/company_logo.png" alt="Young Edsplorer" width="1487" height="455" />
            <span className="admin-brand-sub">{info.name}</span>
          </Link>
          <nav aria-label={`${info.name} sections`} className="admin-nav">
            <SectionLink to={`${base}/dashboard`} icon={LayoutDashboard}>Dashboard</SectionLink>
            <SectionLink to={`${base}/schools`} also={[`${base}/schools`]} icon={School}>{portal === "sales" ? "My schools" : "Schools"}</SectionLink>
            <SectionLink to={`${base}/trips`} also={[`${base}/trips`]} icon={Plane}>{portal === "sales" ? "My trips" : "Trips"}</SectionLink>
            {portal === "admin" && <SectionLink to={`${base}/staff`} icon={Users}>Manage staff</SectionLink>}
          </nav>
          <div className="admin-account" role="group" aria-label="Your account">
            <div className="admin-who">
              <span className="admin-name" title={staff.name || staff.email}>{staff.name || staff.email}</span>
              <em className={`admin-role admin-role-${staff.role}`}>{staff.role}</em>
            </div>
            <Link to={`${base}/password`} className="admin-account-link" aria-current={pathname === `${base}/password` ? "page" : undefined}>
              <KeyRound size={15} aria-hidden="true" /> Change password
            </Link>
            <button type="button" className="admin-button" onClick={logOut} disabled={busy}>
              <LogOut size={16} aria-hidden="true" /> Log out
            </button>
          </div>
        </div>
      </header>
      <main className="admin-main">
        <Routes>
          <Route index element={<Navigate to={`${base}/dashboard`} replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="schools" element={<SchoolsPage />} />
          <Route path="schools/new" element={<NewSchoolPage />} />
          <Route path="schools/:schoolId" element={<SchoolPage />} />
          <Route path="schools/:schoolId/trips/new" element={<NewTripPage />} />
          <Route path="trips" element={<TripsPage />} />
          <Route path="trips/:tripId" element={<TripPage />} />
          <Route path="trips/:tripId/links" element={<TripLinksPage />} />
          <Route path="password" element={<ChangePasswordPage />} />
          {portal === "admin" && <Route path="staff" element={<StaffPage />} />}
          <Route path="*" element={<NotFound base={base} />} />
        </Routes>
      </main>
    </>
  );
}

function NotFound({ base }) {
  return (
    <section className="admin-card" role="alert" aria-labelledby="not-found-title">
      <h1 id="not-found-title">Page not found</h1>
      <p className="admin-muted">There's nothing at this address in this portal.</p>
      <Link className="admin-button" to={`${base}/dashboard`}>Back to the dashboard</Link>
    </section>
  );
}
