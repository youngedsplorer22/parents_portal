import { Link } from "react-router-dom";
import { listItineraryTrips } from "./adminApi.js";
import { TOUR_LABEL } from "./tripLabels.js";
import { useStaff } from "./staffContext.js";
import { useAdminData } from "./useAdminData.js";

/**
 * The trips whose itinerary this person may keep: the trip the current deployment is configured for (the server decides).
 * Nothing here creates or changes a school or a trip.
 */
export default function ItineraryListPage() {
  const { base } = useStaff();
  const { status, data, error } = useAdminData((o) => listItineraryTrips(o), []);
  return (
    <>
      <h1>My itineraries</h1>
      <p className="admin-muted">Add and edit the itinerary for the trip below.</p>
      <section className="admin-card" aria-labelledby="itinerary-trips">
        <h2 id="itinerary-trips">Trips</h2>
        {status === "loading" && <p role="status">Loading…</p>}
        {status === "error" && <p className="admin-error" role="alert">{error}</p>}
        {status === "ready" && (data.length === 0 ? (
          <p className="admin-muted">No trip is configured for this portal yet. Contact the team that set up your account.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table admin-table-stack">
              <caption className="admin-sr">Trips with an itinerary</caption>
              <thead>
                <tr><th scope="col">Trip</th><th scope="col">School</th><th scope="col">Type</th><th scope="col">Academic year</th><th scope="col">Status</th><th scope="col">Itinerary items</th></tr>
              </thead>
              <tbody>
                {data.map((t) => (
                  <tr key={t.id}>
                    <th scope="row"><Link to={`${base}/itineraries/${t.id}`}>{t.title}</Link></th>
                    <td data-label="School">{t.schoolName}{t.schoolBranch ? <span className="admin-muted"> · {t.schoolBranch}</span> : null}</td>
                    <td data-label="Type">{TOUR_LABEL[t.tourType] ?? t.tourType}</td>
                    <td data-label="Academic year">{t.academicYear || "—"}</td>
                    <td data-label="Status"><span className="admin-tag">{t.status}</span></td>
                    <td data-label="Itinerary items">{t.itineraryCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>
    </>
  );
}
