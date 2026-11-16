import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { listSchools } from "./adminApi.js";
import { useStaff } from "./staffContext.js";
import { useAdminData } from "./useAdminData.js";

/**
 * The schools this person manages: every school for an admin, the ones they created for a salesperson (server-side).
 * Only admins get "Show archived"; Sales sees its active schools. Archived schools are untouched either way.
 */
export default function SchoolsPage() {
  const { portal, base } = useStaff();
  const sales = portal === "sales";
  const [showArchived, setShowArchived] = useState(false);
  const includeArchived = !sales && showArchived;
  const { status, data, error } = useAdminData((o) => listSchools({ includeArchived, ...o }), [includeArchived]);
  const title = sales ? "My schools" : "Schools";

  return (
    <>
      <div className="admin-row admin-between admin-page-head">
        <h1>{title}</h1>
        <Link className="admin-button admin-button-primary" to={`${base}/schools/new`}><Plus size={16} aria-hidden="true" /> Add a school</Link>
      </div>
      <section className="admin-card" aria-labelledby="school-list">
        <div className="admin-row admin-between">
          <h2 id="school-list">{sales ? "Schools you manage" : "All schools"}</h2>
          {!sales && (
            <label className="admin-check">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
            </label>
          )}
        </div>
        {status === "loading" && <p role="status">Loading…</p>}
        {status === "error" && <p className="admin-error" role="alert">{error}</p>}
        {status === "ready" && (data.length === 0 ? (
          <p className="admin-muted">No schools yet. <Link to={`${base}/schools/new`}>Add the first one</Link>.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table admin-table-stack">
              <caption className="admin-sr">Schools</caption>
              <thead><tr><th scope="col">School</th><th scope="col">Branch</th><th scope="col">Status</th><th scope="col">Trips</th></tr></thead>
              <tbody>
                {data.map((s) => (
                  <tr key={s.id}>
                    <th scope="row"><Link to={`${base}/schools/${s.id}`}>{s.name}</Link></th>
                    <td data-label="Branch">{s.branch || <span className="admin-muted">No branch recorded</span>}</td>
                    <td data-label="Status"><span className="admin-tag">{s.status}</span></td>
                    <td data-label="Trips">{s.tripCount}</td>
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
