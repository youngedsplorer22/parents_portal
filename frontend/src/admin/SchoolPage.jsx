import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { LOGO_MAX_BYTES, LOGO_TYPES, listSchools, listTrips, removeSchoolLogo, updateSchool, uploadSchoolLogo } from "./adminApi.js";
import SchoolLogo from "../components/SchoolLogo.jsx";
import { useStaff } from "./staffContext.js";
import { PAYMENT_LABEL, TOUR_LABEL } from "./tripLabels.js";
import { attempt, useAdminData } from "./useAdminData.js";


export default function SchoolPage() {
  const { schoolId } = useParams();
  const { staff, expire, base } = useStaff();
  const schools = useAdminData((o) => listSchools({ includeArchived: true, ...o }), []);
  const trips = useAdminData((o) => listTrips({ schoolId, ...o }), [schoolId]);
  const school = schools.data?.find((s) => s.id === schoolId);

  const [rename, setRename] = useState(null);
  const [schoolError, setSchoolError] = useState("");
  const [logoError, setLogoError] = useState("");
  const [logoBusy, setLogoBusy] = useState(false);


  const changeSchool = async (patch) => {
    const done = await attempt(() => updateSchool(schoolId, patch), { expire, setError: setSchoolError });
    if (done) {
      setRename(null);
      schools.reload();
    }
  };

  // Checked here for a quick answer; the server checks the real type (from the bytes) and the size again.
  const pickLogo = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) return setLogoError("Choose a PNG, JPEG or WebP image.");
    if (file.size > LOGO_MAX_BYTES) return setLogoError("The logo can be at most 512 KB.");
    setLogoBusy(true);
    const done = await attempt(() => uploadSchoolLogo(schoolId, file), { expire, setError: setLogoError });
    setLogoBusy(false);
    if (done) {
      setLogoError("");
      schools.reload();
    }
  };
  const dropLogo = async () => {
    setLogoBusy(true);
    const done = await attempt(() => removeSchoolLogo(schoolId), { expire, setError: setLogoError });
    setLogoBusy(false);
    if (done) {
      setLogoError("");
      schools.reload();
    }
  };

  if (schools.status === "loading") return <p role="status">Loading…</p>;
  if (schools.status === "error") return <p className="admin-error" role="alert">{schools.error}</p>;
  if (!school) return <section className="admin-card" role="alert"><h1>School not found</h1><p className="admin-muted">It doesn't exist, or it isn't one of the schools you manage.</p><Link to={`${base}/schools`}>Back to schools</Link></section>;

  return (
    <>
      <p><Link to={`${base}/schools`}>← Schools</Link></p>
      <h1>{school.name} {school.status === "archived" && <span className="admin-tag">archived</span>}</h1>
      <p className="admin-muted">{school.branch ? `Branch: ${school.branch}` : "No branch recorded."}</p>

      {staff.role === "admin" && (
        <section className="admin-card" aria-labelledby="school-admin">
          <h2 id="school-admin">School settings</h2>
          {rename === null ? (
            <div className="admin-row">
              <button type="button" className="admin-button" onClick={() => setRename({ name: school.name, branch: school.branch ?? "" })}>Edit name and branch</button>
              <button type="button" className="admin-button" onClick={() => changeSchool({ status: school.status === "active" ? "archived" : "active" })}>
                {school.status === "active" ? "Archive school" : "Restore school"}
              </button>
            </div>
          ) : (
            <form
              className="admin-row"
              onSubmit={(e) => {
                e.preventDefault();
                // only what changed is sent; an emptied branch means "no branch"
                const patch = {};
                if (rename.name.trim() !== school.name) patch.name = rename.name;
                if (rename.branch.trim() !== (school.branch ?? "")) patch.branch = rename.branch.trim() ? rename.branch : null;
                if (Object.keys(patch).length === 0) return setRename(null);
                changeSchool(patch);
              }}
            >
              <div className="admin-grow">
                <label htmlFor="rename-school">School name</label>
                <input id="rename-school" className="admin-input" value={rename.name} maxLength={150} onChange={(e) => setRename({ ...rename, name: e.target.value })} />
              </div>
              <div className="admin-grow">
                <label htmlFor="rename-branch">Branch</label>
                <input id="rename-branch" className="admin-input" value={rename.branch} maxLength={100} placeholder="e.g. Kolkata Branch" onChange={(e) => setRename({ ...rename, branch: e.target.value })} />
              </div>
              <button type="submit" className="admin-button admin-button-primary">Save changes</button>
              <button type="button" className="admin-button" onClick={() => setRename(null)}>Cancel</button>
            </form>
          )}
          {schoolError && <p className="admin-error" role="alert">{schoolError}</p>}
        </section>
      )}

      <section className="admin-card" aria-labelledby="school-logo">
        <h2 id="school-logo">School logo</h2>
        {staff.role === "admin" && (
          <p className="admin-muted">Shown next to the Young Edsplorer logo on this school's registration pages. PNG, JPEG or WebP, up to 512 KB.</p>
        )}
        <div className="admin-logo-row">
          <SchoolLogo name={school.name} src={school.logoUrl} className="admin-logo-slot" />
          {staff.role === "admin" && (
            <div className="admin-row">
              <label className={`admin-button ${logoBusy ? "is-disabled" : ""}`} htmlFor="school-logo-file">
                {school.logoUrl ? "Replace logo" : "Upload logo"}
              </label>
              <input id="school-logo-file" className="admin-file" type="file" accept={LOGO_TYPES.join(",")} onChange={pickLogo} disabled={logoBusy} />
              {school.logoUrl && <button type="button" className="admin-button admin-button-danger" onClick={dropLogo} disabled={logoBusy}>Remove logo</button>}
            </div>
          )}
        </div>
        {logoError && <p className="admin-error" role="alert">{logoError}</p>}
      </section>

      <section className="admin-card" aria-labelledby="trip-list">
        <div className="admin-row admin-between">
          <h2 id="trip-list">Trips</h2>
          {school.status === "active" && <Link className="admin-button admin-button-primary" to={`${base}/schools/${school.id}/trips/new`}>Create a trip</Link>}
        </div>
        {trips.status === "loading" && <p role="status">Loading…</p>}
        {trips.status === "error" && <p className="admin-error" role="alert">{trips.error}</p>}
        {trips.status === "ready" && (trips.data.length === 0 ? (
          <p className="admin-muted">No trips for this school yet.{school.status === "active" ? " Create the first one to get a registration link." : ""}</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table admin-table-stack">
              <caption className="admin-sr">Trips for {school.name}</caption>
              <thead><tr><th scope="col">Trip</th><th scope="col">Type</th><th scope="col">Payment</th><th scope="col">Status</th><th scope="col">Public page</th></tr></thead>
              <tbody>
                {trips.data.map((t) => (
                  <tr key={t.id}>
                    <th scope="row"><Link to={`${base}/trips/${t.id}`}>{t.title}</Link></th>
                    <td data-label="Type">{TOUR_LABEL[t.tourType]}</td>
                    <td data-label="Payment">{PAYMENT_LABEL[t.paymentMode]}</td>
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
