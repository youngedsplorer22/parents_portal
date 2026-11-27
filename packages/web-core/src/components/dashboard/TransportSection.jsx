import { useEffect, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { getTripDocuments, tripDocumentDownloadUrl } from "../../api/enrolmentApi.js";

/**
 * Dashboard > Train / Flight Tickets. Shows transport documents uploaded by Sales for this trip.
 * Multiple documents are supported (Sales may upload several). Re-fetches on section open and
 * page-visibility change so newly uploaded or deleted documents appear without a new login.
 */
export default function TransportSection({ section, headingRef, enrolmentId, onSessionEnded = () => {} }) {
  const [state, setState] = useState({ status: "loading", docs: [] });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getTripDocuments(enrolmentId, "transport", { signal: controller.signal })
      .then((docs) => setState({ status: "ready", docs }))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        if (err?.code === "UNAUTHENTICATED") onSessionEnded();
        else setState((s) => (s.status === "ready" ? s : { status: "error", docs: [] }));
      });
    return () => controller.abort();
  }, [enrolmentId, tick, onSessionEnded]);

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-title">
      <h1 id="dashboard-title" className="dashboard-title" ref={headingRef} tabIndex={-1}>{section.label}</h1>
      {state.status === "loading" && <p className="dashboard-placeholder" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" /> Loading travel tickets…</p>}
      {state.status === "error" && <p className="dashboard-placeholder" role="alert">We couldn't load the travel tickets just now. Please try again in a moment.</p>}
      {state.status === "ready" && state.docs.length === 0 && (
        <p className="dashboard-placeholder">Your travel tickets will be available here soon.</p>
      )}
      {state.status === "ready" && state.docs.length > 0 && (
        <ul className="trip-doc-list" aria-label="Travel tickets">
          {state.docs.map((doc) => (
            <li key={doc.id} className="trip-doc-item">
              <a
                href={tripDocumentDownloadUrl(enrolmentId, doc.id)}
                className="trip-doc-link"
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Download ${doc.displayName}`}
              >
                <Download size={15} aria-hidden="true" />
                <span>{doc.displayName}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
