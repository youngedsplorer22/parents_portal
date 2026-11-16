import { Navigate, Route, Routes, useParams } from "react-router-dom";
import App from "./App.jsx";
import StaffApp from "./admin/StaffApp.jsx";
import JoinContinue from "./join/JoinContinue.jsx";
import JoinPage from "./join/JoinPage.jsx";
import RetiredLink from "./join/RetiredLink.jsx";
import NotFound from "./components/NotFound.jsx";

/**
 * The URL map: three separate experiences.
 *   Admin portal    /admin/login, /admin/dashboard, /admin/schools[/new|/:id[/trips/new]], /admin/trips[/:id[/links]],
 *                   /admin/staff, /admin/password                                  (admin accounts only)
 *   Sales portal    /sales/login, /sales/dashboard, /sales/schools[/new|/:id[/trips/new]], /sales/trips[/:id[/links]],
 *                   /sales/password                                                 (sales accounts only)
 *   Parent portal   /parent and /parent/login (register or log in), /parent/registrations/:id (one of their own),
 *                   /join/:school/:branch/:trip[/continue] (a trip's registration link, shared by Sales)
 *   /               the Sales portal (redirects to /sales: its login, or its dashboard when signed in). The parent
 *                   app is never rendered at /, whatever parent session the browser has.
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

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/admin/*" element={<StaffApp key="admin" portal="admin" />} />
      <Route path="/sales/*" element={<StaffApp key="sales" portal="sales" />} />
      {/* The root is the Sales portal: /sales decides between its login and its dashboard. Parents never land here. */}
      <Route path="/" element={<Navigate to="/sales" replace />} />
      <Route path="/parent" element={<App />} />
      <Route path="/parent/login" element={<App initialTab="login" />} />
      <Route path="/parent/registrations/:enrolmentId" element={<RegistrationRoute />} />
      <Route path="/join/:school/:branch/:trip" element={<JoinPage />} />
      <Route path="/join/:school/:branch/:trip/continue" element={<JoinContinue />} />
      <Route path="/join/:token" element={<RetiredLink />} />
      <Route path="/join/:token/continue" element={<RetiredLink />} />
      <Route path="/registrations" element={<Navigate to="/parent" replace />} />
      <Route path="/registrations/:enrolmentId" element={<OldRegistrationRedirect />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
