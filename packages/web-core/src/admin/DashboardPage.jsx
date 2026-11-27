import { Link } from "react-router-dom";
import { Briefcase, Plane } from "lucide-react";
import { listItineraryTrips } from "./adminApi.js";
import { PORTALS, useStaff } from "./staffContext.js";
import { useAdminData } from "./useAdminData.js";

/**
 * The Sales portal's landing page. The count comes from the API; the server decides which trip is accessible.
 */
export default function DashboardPage() {
  const { base } = useStaff();
  const trips = useAdminData((o) => listItineraryTrips(o), []);
  return (
    <>
      <h1>{PORTALS.sales.dashboard}</h1>
      <section className="admin-card" aria-labelledby="workflow">
        <h2 id="workflow">Manage this portal's trip</h2>
        <p className="admin-muted">Upload school logo, itinerary, insurance and transport documents for the trip configured for this portal.</p>
        <Link className="admin-button admin-button-primary" to={`${base}/manage`}><Briefcase size={16} aria-hidden="true" /> Manage trip</Link>
      </section>
      <div className="admin-stats">
        <Link className="admin-stat" to={`${base}/itineraries`}>
          <Plane size={20} aria-hidden="true" />
          <span className="admin-stat-value">{trips.status === "ready" ? trips.data.length : trips.status === "loading" ? "…" : "—"}</span>
          <span className="admin-stat-label">Configured trips</span>
        </Link>
      </div>
      {trips.status === "error" && <p className="admin-error" role="alert">{trips.error}</p>}
    </>
  );
}
