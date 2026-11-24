import { Suspense, lazy } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import NotFound from "./components/NotFound.jsx";
import { readDeployment } from "./portal/deployment.js";
import { PortalProvider } from "./portal/PortalContext.jsx";
import PublicLanding from "./portal/PublicLanding.jsx";

// Build-time switches (vite-config.js "define"). In a public portal build HAS_STAFF is the literal `false`, so the
// import() below is removed from the bundle and no staff chunk is emitted; in the staff build HAS_PARENT is `false`.
// This only keeps code out of the wrong website. Every permission is still enforced by the API.
/* global __HAS_STAFF__, __HAS_PARENT__ */
const HAS_STAFF = typeof __HAS_STAFF__ === "undefined" ? true : __HAS_STAFF__;
const HAS_PARENT = typeof __HAS_PARENT__ === "undefined" ? true : __HAS_PARENT__;
const StaffApp = HAS_STAFF ? lazy(() => import("./admin/StaffApp.jsx")) : null;
const App = HAS_PARENT ? lazy(() => import("./App.jsx")) : null;
const JoinContinue = HAS_PARENT ? lazy(() => import("./join/JoinContinue.jsx")) : null;
const JoinPage = HAS_PARENT ? lazy(() => import("./join/JoinPage.jsx")) : null;
const RetiredLink = HAS_PARENT ? lazy(() => import("./join/RetiredLink.jsx")) : null;

/**
 * The URL map: three separate experiences, coexisting on the same host in every public portal build.
 *   Sales portal    /sales/login, /sales/dashboard, /sales/itineraries[/:tripId], /sales/password   (sales accounts only;
 *                   itinerary only, and only for trips a developer assigned to them). There is no admin portal.
 *   Parent portal   /parent and /parent/login (register or log in), /parent/registrations/:id (one of their own),
 *                   /join/:school/:branch/:trip[/continue] (a trip's registration link, shared by Sales)
 *   /               parent portal builds (and combined builds): the parent landing page. Staff-only build: redirects
 *                   to /sales. When both run together the parent landing page is at / and /sales is a separate entry.
 *   anything else   "Page not found", with links to each portal
 * The canonical parent registration link stays /join/<school>/<branch>/<trip>: readable, token-free (the project lead's
 * decision) and already shared, so existing links keep working. Old addresses redirect: /registrations -> /parent,
 * /registrations/:id -> /parent/registrations/:id; retired token links explain themselves. Every permission is
 * enforced again by the server.
 */
/** Older /registrations/<id> addresses go to the canonical parent address. */
function OldRegistrationRedirect() {
  const { enrolmentId } = useParams();
  return <Navigate to={`/parent/registrations/${encodeURIComponent(enrolmentId)}`} replace />;
}

/** One of the parent's own registrations (the server checks it belongs to them; anyone else's id is "not found"). */
function RegistrationRoute() {
  const { enrolmentId } = useParams();
  // An address only ever opens a registration that already exists; it never starts a new, trip-less one.
  return <App key={enrolmentId} enrolmentId={enrolmentId} existingOnly />;
}

/**
 * `target` picks which part of the URL map a deployment serves:
 *   "all"      everything (the combined app, as before)
 *   "staff"    only the Sales portal; "/" is the Sales portal
 *   a variant  only the parent routes (/parent*, /join/*); staff addresses are not served there ("Page not found"),
 *              so a public registration website never carries the staff screens
 */
export default function AppRoutes({ target = "all", deployment = null }) {
  // What this build can serve is limited by what it contains; the target narrows it further.
  // Staff routes are present in every build (HAS_STAFF is always true; see vite-config.js).
  // The staff-only build has HAS_PARENT=false, so parent routes are absent there.
  const staff = HAS_STAFF;
  const parent = HAS_PARENT && (target === "all" || target !== "staff");
  return (
    <PortalProvider value={{ target, deployment: readDeployment(deployment) }}>
      <Suspense fallback={null}>
      <Routes>
        {staff && <Route path="/sales/*" element={<StaffApp key="sales" portal="sales" />} />}
        {/* Root is the parent landing page when parent routes are present (every public portal). The staff-only build
            has no parent routes, so / redirects to /sales there. Sales staff reach /sales/login from the parent page. */}
        {staff && !parent && <Route path="/" element={<Navigate to="/sales" replace />} />}
        {parent && <Route path="/" element={<PublicLanding target={target} />} />}
        {parent && <Route path="/parent" element={<App />} />}
        {parent && <Route path="/parent/login" element={<App initialTab="login" />} />}
        {parent && <Route path="/parent/registrations/:enrolmentId" element={<RegistrationRoute />} />}
        {parent && <Route path="/join/:school/:branch/:trip" element={<JoinPage />} />}
        {parent && <Route path="/join/:school/:branch/:trip/continue" element={<JoinContinue />} />}
        {parent && <Route path="/join/:token" element={<RetiredLink />} />}
        {parent && <Route path="/join/:token/continue" element={<RetiredLink />} />}
        {parent && <Route path="/registrations" element={<Navigate to="/parent" replace />} />}
        {parent && <Route path="/registrations/:enrolmentId" element={<OldRegistrationRedirect />} />}
        <Route path="*" element={<NotFound />} />
      </Routes>
      </Suspense>
    </PortalProvider>
  );
}
