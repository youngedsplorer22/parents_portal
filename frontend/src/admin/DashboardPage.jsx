import { Link } from "react-router-dom";
import { Link2, Plane, Plus, School, Users } from "lucide-react";
import { listSchools, listTrips } from "./adminApi.js";
import { PORTALS, useStaff } from "./staffContext.js";
import { useAdminData } from "./useAdminData.js";

/**
 * The landing page of each staff portal. Numbers come from the same APIs as the lists, so a salesperson sees only
 * their own schools and trips (the server decides that), and an admin sees everything.
 */
export default function DashboardPage() {
  const { portal, base } = useStaff();
  const schools = useAdminData((o) => listSchools(o), []);
  const trips = useAdminData((o) => listTrips(o), []);
  const sales = portal === "sales";
  const count = (d) => (d.status === "ready" ? d.data.length : d.status === "loading" ? "…" : "—");
  const live = trips.status === "ready" ? trips.data.filter((t) => t.status === "active" && t.publicRegistration).length : null;

  return (
    <>
      <h1>{PORTALS[portal].dashboard}</h1>

      {sales && (
        <section className="admin-card" aria-labelledby="workflow">
          <h2 id="workflow">Set up a trip registration link</h2>
          <ol className="admin-steps">
            <li><Link to={`${base}/schools/new`}>Add a school</Link> (or open one of <Link to={`${base}/schools`}>your schools</Link>).</li>
            <li>On the school's page, choose <strong>Create a trip</strong>.</li>
            <li>On the trip, open <strong>Registration link</strong>, turn it on, and copy the link to share with parents.</li>
          </ol>
          <Link className="admin-button admin-button-primary" to={`${base}/schools/new`}><Plus size={16} aria-hidden="true" /> Add a school</Link>
        </section>
      )}

      <div className="admin-stats">
        <Link className="admin-stat" to={`${base}/schools`}>
          <School size={20} aria-hidden="true" />
          <span className="admin-stat-value">{count(schools)}</span>
          <span className="admin-stat-label">{sales ? "Your schools" : "Schools"}</span>
        </Link>
        <Link className="admin-stat" to={`${base}/trips`}>
          <Plane size={20} aria-hidden="true" />
          <span className="admin-stat-value">{count(trips)}</span>
          <span className="admin-stat-label">{sales ? "Your trips" : "Trips"}</span>
        </Link>
        <Link className="admin-stat" to={`${base}/trips`}>
          <Link2 size={20} aria-hidden="true" />
          <span className="admin-stat-value">{live ?? "…"}</span>
          <span className="admin-stat-label">Registration links live</span>
        </Link>
        {!sales && (
          <Link className="admin-stat" to={`${base}/staff`}>
            <Users size={20} aria-hidden="true" />
            <span className="admin-stat-value">→</span>
            <span className="admin-stat-label">Manage staff</span>
          </Link>
        )}
      </div>
      {(schools.status === "error" || trips.status === "error") && <p className="admin-error" role="alert">{schools.error || trips.error}</p>}
    </>
  );
}
