import { Link } from "react-router-dom";
import { ListChecks, Plane } from "lucide-react";
import { listItineraryTrips } from "./adminApi.js";
import { PORTALS, useStaff } from "./staffContext.js";
import { useAdminData } from "./useAdminData.js";

/**
 * The Sales portal's landing page: about itineraries only, for the trip the deployment is configured for. The count comes
 * from the API; the server decides which trip is accessible.
 */
export default function DashboardPage() {
  const { base } = useStaff();
  const trips = useAdminData((o) => listItineraryTrips(o), []);
  return (
    <>
      <h1>{PORTALS.sales.dashboard}</h1>
      <section className="admin-card" aria-labelledby="workflow">
        <h2 id="workflow">Keep the itinerary for this portal's trip</h2>
        <ol className="admin-steps">
          <li>Open the trip below.</li>
          <li>Add the days of the itinerary, and edit them when plans change.</li>
        </ol>
        <Link className="admin-button admin-button-primary" to={`${base}/itineraries`}><ListChecks size={16} aria-hidden="true" /> My itineraries</Link>
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
