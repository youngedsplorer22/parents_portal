import { useRef, useState } from "react";
import { Download, FileText, Image, ListChecks, Loader, Shield, Ticket, Trash2, Upload } from "lucide-react";
import {
  deleteTripDocument,
  getSchoolLogoInfo,
  listItineraryTrips,
  listTripDocuments,
  tripDocumentDownloadUrl,
  uploadSchoolLogo,
  uploadTripDocument,
} from "./adminApi.js";
import { useStaff } from "./staffContext.js";
import { attempt, useAdminData } from "./useAdminData.js";
import DocPreview from "../components/dashboard/DocPreview.jsx";

const TABS = [
  { key: "logo", label: "School logo", Icon: Image },
  { key: "itinerary", label: "Itinerary", Icon: ListChecks },
  { key: "insurance", label: "Insurance", Icon: Shield },
  { key: "transport", label: "Transport", Icon: Ticket },
];

const LOGO_MAX_BYTES = 512 * 1024;
const LOGO_ACCEPT = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";
const DOC_MAX_BYTES = 10 * 1024 * 1024;
const PDF_ACCEPT = ".pdf,application/pdf";
const DOC_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ManageTripPage() {
  const [tab, setTab] = useState("logo");
  const { expire } = useStaff();
  const trips = useAdminData((o) => listItineraryTrips(o), []);

  const trip = trips.status === "ready" ? (trips.data[0] ?? null) : null;

  if (trips.status === "loading") return <p role="status" className="admin-loading">Loading…</p>;
  if (trips.status === "error") return <p className="admin-error" role="alert">{trips.error}</p>;

  if (!trip) {
    return (
      <section className="admin-card" aria-labelledby="mt-no-trip">
        <h1 id="mt-no-trip">Manage trip</h1>
        <p className="admin-muted">No trip is configured for this portal yet. Contact the team that set up your account.</p>
      </section>
    );
  }

  return (
    <>
      <div className="admin-page-head">
        <h1>Manage trip</h1>
        <p className="admin-muted">{trip.title}{trip.schoolName ? ` · ${trip.schoolName}` : ""}{trip.schoolBranch ? ` · ${trip.schoolBranch}` : ""}</p>
      </div>
      <nav className="admin-tabs" aria-label="Manage trip sections">
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            className={`admin-tab${tab === key ? " is-active" : ""}`}
            aria-current={tab === key ? "true" : undefined}
            onClick={() => setTab(key)}
          >
            <Icon size={16} aria-hidden="true" /> {label}
          </button>
        ))}
      </nav>
      {tab === "logo" && <LogoSection tripId={trip.id} expire={expire} />}
      {tab === "itinerary" && <ItinerarySection tripId={trip.id} expire={expire} />}
      {tab === "insurance" && <DocumentSection tripId={trip.id} type="insurance" label="Insurance" expire={expire} multiple={false} accept={DOC_ACCEPT} />}
      {tab === "transport" && <DocumentSection tripId={trip.id} type="transport" label="Transport tickets" expire={expire} multiple={true} accept={DOC_ACCEPT} />}
    </>
  );
}

// ---- School logo ----

function LogoSection({ tripId, expire }) {
  const logoData = useAdminData((o) => getSchoolLogoInfo(tripId, o), [tripId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const fileRef = useRef();

  const upload = async (file) => {
    setError("");
    setSuccess("");
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("Upload a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError("The logo can be at most 512 KB.");
      return;
    }
    setBusy(true);
    let bytes;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      setError("Could not read the file. Please try again.");
      setBusy(false);
      return;
    }
    const result = await attempt(() => uploadSchoolLogo(tripId, bytes, file.type), { expire, setError });
    setBusy(false);
    if (result) {
      setSuccess("Logo updated.");
      logoData.reload();
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const logoUrl = logoData.status === "ready" ? logoData.data?.logoUrl ?? null : null;

  return (
    <section className="admin-card" aria-labelledby="mt-logo-heading">
      <h2 id="mt-logo-heading">School logo</h2>
      <p className="admin-muted">Shown on the parent portal and in generated PDFs. PNG, JPEG or WebP, max 512 KB.</p>
      {logoData.status === "loading" && <p role="status">Loading…</p>}
      {logoData.status === "error" && <p className="admin-error" role="alert">{logoData.error}</p>}
      {logoData.status === "ready" && (
        logoUrl
          ? <div className="admin-logo-preview"><img src={logoUrl} alt="Current school logo" /></div>
          : <p className="admin-muted admin-doc-empty">No logo uploaded yet.</p>
      )}
      {error && <p className="admin-error" role="alert">{error}</p>}
      {success && <p className="admin-success" role="status">{success}</p>}
      <div className="admin-row" style={{ marginTop: 14 }}>
        <label className="admin-upload-label">
          <input
            ref={fileRef}
            type="file"
            accept={LOGO_ACCEPT}
            className="admin-sr"
            disabled={busy}
            onChange={(e) => upload(e.target.files?.[0])}
          />
          <span className={`admin-button${busy ? " is-busy" : ""}`} aria-disabled={busy}>
            {busy ? <><Loader size={15} className="spin" aria-hidden="true" /> Uploading…</> : <><Upload size={15} aria-hidden="true" /> {logoUrl ? "Replace logo" : "Upload logo"}</>}
          </span>
        </label>
      </div>
    </section>
  );
}

// ---- Itinerary ----

function ItinerarySection({ tripId, expire }) {
  const docs = useAdminData((o) => listTripDocuments(tripId, o), [tripId]);
  const itineraryDocs = docs.status === "ready" ? docs.data.filter((d) => d.documentType === "itinerary") : [];

  return (
    <section className="admin-card" aria-labelledby="mt-itin-file">
      <h2 id="mt-itin-file">Itinerary PDF</h2>
      <p className="admin-muted">Upload an itinerary PDF. Uploading a new one replaces the previous file. Parents will see the latest version on their next page load.</p>
      <DocumentUploadSection
        tripId={tripId}
        type="itinerary"
        docs={itineraryDocs}
        docsStatus={docs.status}
        docsError={docs.error}
        reload={docs.reload}
        expire={expire}
        multiple={false}
        accept={PDF_ACCEPT}
        label="itinerary PDF"
      />
    </section>
  );
}

// ---- Single/multi document section ----

function DocumentSection({ tripId, type, label, expire, multiple, accept }) {
  const docs = useAdminData((o) => listTripDocuments(tripId, o), [tripId]);
  const typeDocs = docs.status === "ready" ? docs.data.filter((d) => d.documentType === type) : [];

  return (
    <section className="admin-card" aria-labelledby={`mt-${type}-heading`}>
      <h2 id={`mt-${type}-heading`}>{label}</h2>
      <DocumentUploadSection
        tripId={tripId}
        type={type}
        docs={typeDocs}
        docsStatus={docs.status}
        docsError={docs.error}
        reload={docs.reload}
        expire={expire}
        multiple={multiple}
        accept={accept}
        label={label.toLowerCase()}
      />
    </section>
  );
}

function DocumentUploadSection({ tripId, type, docs, docsStatus, docsError, reload, expire, multiple, accept, label }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null); // docId
  const fileRef = useRef();

  const upload = async (file) => {
    setError("");
    setSuccess("");
    if (!file) return;
    if (file.size > DOC_MAX_BYTES) {
      setError("The file can be at most 10 MB.");
      return;
    }
    setBusy(true);
    let bytes;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      setError("Could not read the file. Please try again.");
      setBusy(false);
      return;
    }
    const result = await attempt(
      () => uploadTripDocument(tripId, type, file.name, bytes, file.type),
      { expire, setError },
    );
    setBusy(false);
    if (result) {
      setSuccess("File uploaded.");
      reload();
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const doDelete = async (docId) => {
    setConfirmDelete(null);
    setError("");
    setSuccess("");
    setBusy(true);
    const result = await attempt(() => deleteTripDocument(tripId, docId), { expire, setError });
    setBusy(false);
    if (result !== null) {
      setSuccess("File deleted.");
      reload();
    }
  };

  return (
    <>
      {docsStatus === "loading" && <p role="status">Loading…</p>}
      {docsStatus === "error" && <p className="admin-error" role="alert">{docsError}</p>}
      {docsStatus === "ready" && (
        docs.length === 0
          ? <p className="admin-muted admin-doc-empty">No {label} uploaded yet.</p>
          : (
            <ul className="admin-doc-list" aria-label={`Uploaded ${label} files`}>
              {docs.map((doc) => (
                <li key={doc.id} className="admin-doc-item">
                  <FileText size={18} className="admin-doc-icon" aria-hidden="true" />
                  <div className="admin-doc-info">
                    <span className="admin-doc-name">{doc.displayName}</span>
                    <span className="admin-doc-meta">{doc.mimeType}{doc.sizeBytes ? ` · ${formatBytes(doc.sizeBytes)}` : ""}</span>
                  </div>
                  <div className="admin-doc-actions">
                    <a
                      href={tripDocumentDownloadUrl(tripId, doc.id)}
                      className="admin-button"
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Download ${doc.displayName}`}
                    >
                      <Download size={15} aria-hidden="true" /> Download
                    </a>
                    {confirmDelete === doc.id ? (
                      <span className="admin-doc-confirm">
                        Delete this file?{" "}
                        <button type="button" className="admin-button admin-button-danger" onClick={() => doDelete(doc.id)} disabled={busy}>Yes, delete</button>
                        <button type="button" className="admin-button" onClick={() => setConfirmDelete(null)}>Cancel</button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="admin-button admin-button-ghost-danger"
                        disabled={busy}
                        aria-label={`Delete ${doc.displayName}`}
                        onClick={() => setConfirmDelete(doc.id)}
                      >
                        <Trash2 size={15} aria-hidden="true" /> Delete
                      </button>
                    )}
                  </div>
                  <div className="admin-doc-preview">
                    <DocPreview
                      url={tripDocumentDownloadUrl(tripId, doc.id)}
                      mimeType={doc.mimeType}
                      displayName={doc.displayName}
                      showDownload={false}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )
      )}
      {error && <p className="admin-error" role="alert">{error}</p>}
      {success && <p className="admin-success" role="status">{success}</p>}
      {(multiple || docs.length === 0) && (
        <div className="admin-row" style={{ marginTop: 14 }}>
          <label className="admin-upload-label">
            <input
              ref={fileRef}
              type="file"
              accept={accept}
              className="admin-sr"
              disabled={busy}
              onChange={(e) => upload(e.target.files?.[0])}
            />
            <span className={`admin-button${busy ? " is-busy" : ""}`} aria-disabled={busy}>
              {busy ? <><Loader size={15} className="spin" aria-hidden="true" /> Uploading…</> : <><Upload size={15} aria-hidden="true" /> Upload {label}</>}
            </span>
          </label>
        </div>
      )}
      {!multiple && docs.length > 0 && (
        <div className="admin-row" style={{ marginTop: 14 }}>
          <label className="admin-upload-label">
            <input
              ref={fileRef}
              type="file"
              accept={accept}
              className="admin-sr"
              disabled={busy}
              onChange={(e) => upload(e.target.files?.[0])}
            />
            <span className={`admin-button${busy ? " is-busy" : ""}`} aria-disabled={busy}>
              {busy ? <><Loader size={15} className="spin" aria-hidden="true" /> Uploading…</> : <><Upload size={15} aria-hidden="true" /> Replace {label}</>}
            </span>
          </label>
        </div>
      )}
    </>
  );
}
