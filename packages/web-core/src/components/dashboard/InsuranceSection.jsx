import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { getTripDocuments, tripDocumentDownloadUrl } from "../../api/enrolmentApi.js";
import DocPreview from "./DocPreview.jsx";

/**
 * Dashboard > Insurance. Shows the insurance document uploaded by Sales for this trip.
 * Re-fetches on each section open and page-visibility change so Sales replacements appear immediately.
 */
export default function InsuranceSection({ section, headingRef, enrolmentId, onSessionEnded = () => {} }) {
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
    getTripDocuments(enrolmentId, "insurance", { signal: controller.signal })
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
      {state.status === "loading" && (
        <p className="dashboard-placeholder" role="status">
          <LoaderCircle size={16} className="spin" aria-hidden="true" /> Loading insurance information…
        </p>
      )}
      {state.status === "error" && (
        <p className="dashboard-placeholder" role="alert">We couldn't load the insurance information just now. Please try again in a moment.</p>
      )}
      {state.status === "ready" && state.docs.length === 0 && (
        <p className="dashboard-placeholder">Insurance information will be available here soon.</p>
      )}
      {state.status === "ready" && state.docs.length > 0 && (
        <ul className="trip-doc-list" aria-label="Insurance documents">
          {state.docs.map((doc) => (
            <li key={doc.id} className="trip-doc-item">
              <DocPreview
                url={tripDocumentDownloadUrl(enrolmentId, doc.id)}
                mimeType={doc.mimeType}
                displayName={doc.displayName}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
