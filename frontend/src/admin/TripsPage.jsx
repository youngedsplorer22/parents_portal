import { useState } from "react";
import { Link } from "react-router-dom";
import { listTrips } from "./adminApi.js";
import { useStaff } from "./staffContext.js";
import { PAYMENT_LABEL, TOUR_LABEL } from "./tripLabels.js";
import { useAdminData } from "./useAdminData.js";

/**
 * The trips this person manages: every trip for an admin, the trips of their own schools for a salesperson (decided by
 * the server). It only lists and links: a trip is created from its school's page, and its registration link is managed
 * on the trip's Registration link page.
 */
export default function TripsPage() {
  const { portal, base } = useStaff();
  const [showArchived, setShowArchived] = useState(false);
  const { status, data, error } = useAdminData((o) => listTrips(o), []);
  const rows = status === "ready" ? data.filter((t) => showArchived || t.status !== "archived") : [];

  return (
    <>
      <h1>{portal === "sales" ? "My trips" : "Trips"}</h1>
      <p className="admin-muted">
        Open a trip to activate it or manage its registration link. To add a trip, open its school on the <Link to={`${base}/schools`}>{portal === "sales" ? "My schools" : "Schools"}</Link> page.
      </p>
      <section className="admin-card" aria-labelledby="all-trips">
        <div className="admin-row admin-between">
          <h2 id="all-trips">All trips</h2>
          <label className="admin-check">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
          </label>
        </div>
        {status === "loading" && <p role="status">Loading…</p>}
        {status === "error" && <p className="admin-error" role="alert">{error}</p>}
        {status === "ready" && (rows.length === 0 ? (
          <p className="admin-muted">No trips yet. Add one from a school's page.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table admin-table-stack">
              <caption className="admin-sr">All trips</caption>
              <thead>
                <tr><th scope="col">Trip</th><th scope="col">School</th><th scope="col">Type</th><th scope="col">Payment</th><th scope="col">Academic year</th><th scope="col">Status</th><th scope="col">Public page</th></tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <th scope="row"><Link to={`${base}/trips/${t.id}`}>{t.title}</Link></th>
                    <td data-label="School"><Link to={`${base}/schools/${t.schoolId}`}>{t.schoolName}</Link>{t.schoolBranch ? <span className="admin-muted"> · {t.schoolBranch}</span> : null}</td>
                    <td data-label="Type">{TOUR_LABEL[t.tourType] ?? t.tourType}</td>
                    <td data-label="Payment">{PAYMENT_LABEL[t.paymentMode] ?? t.paymentMode}</td>
                    <td data-label="Academic year">{t.academicYear || "—"}</td>
                    <td data-label="Status"><span className="admin-tag">{t.status}</span></td>
                    <td data-label="Public page">{t.publicRegistration ? "On" : "Off"}</td>
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
