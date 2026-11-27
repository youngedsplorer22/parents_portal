import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { getTripDocuments, tripDocumentDownloadUrl } from "../../api/enrolmentApi.js";
import DocPreview from "./DocPreview.jsx";

/**
 * Dashboard > Itinerary. Shows the itinerary PDF uploaded by Sales for this registration's trip.
 * Manual itinerary entries and the trip title banner are intentionally not shown here.
 * Re-fetches on each section open and page-visibility change so Sales replacements appear without a re-login.
 */
export default function ItinerarySection({ section, headingRef, enrolmentId, onSessionEnded = () => {} }) {
  const [pdf, setPdf] = useState({ status: "loading", docs: [] });
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
    getTripDocuments(enrolmentId, "itinerary", { signal: controller.signal })
      .then((docs) => setPdf({ status: "ready", docs }))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        if (err?.code === "UNAUTHENTICATED") onSessionEnded();
        else setPdf((s) => (s.status === "ready" ? s : { status: "error", docs: [] }));
      });
    return () => controller.abort();
  }, [enrolmentId, tick, onSessionEnded]);

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-title">
      <h1 id="dashboard-title" className="dashboard-title" ref={headingRef} tabIndex={-1}>{section.label}</h1>
      {pdf.status === "loading" && (
        <p className="dashboard-placeholder" role="status">
          <LoaderCircle size={16} className="spin" aria-hidden="true" /> Loading your itinerary…
        </p>
      )}
      {pdf.status === "error" && (
        <p className="dashboard-placeholder" role="alert">We couldn't load the itinerary just now. Please try again in a moment.</p>
      )}
      {pdf.status === "ready" && pdf.docs.length === 0 && (
        <p className="dashboard-placeholder">Your trip itinerary will be available here soon.</p>
      )}
      {pdf.status === "ready" && pdf.docs.length > 0 && (
        <ul className="trip-doc-list" aria-label="Itinerary documents">
          {pdf.docs.map((doc) => (
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
