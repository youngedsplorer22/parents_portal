import { useEffect, useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import { getItinerary, getTripDocuments, tripDocumentDownloadUrl } from "../../api/enrolmentApi.js";

/**
 * Dashboard > Itinerary. Read-only: the trip's itinerary as the Sales team keeps it, for THIS registration's trip only (the
 * server finds the trip from the registration). It is asked for again whenever the section is opened and whenever the page
 * becomes visible again, so a Sales update shows up without a new login. It stays available after the trip is closed.
 * When Sales uploads an itinerary PDF, it appears here as a download link above the day-by-day entries.
 */
export default function ItinerarySection({ section, headingRef, enrolmentId, onSessionEnded = () => {} }) {
  const [items, setItems] = useState({ status: "loading", data: null });
  const [pdf, setPdf] = useState({ status: "loading", docs: [] });
  const [tick, setTick] = useState(0); // bumped when the page becomes visible again, to ask the server again

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getItinerary(enrolmentId, { signal: controller.signal })
      .then((data) => setItems({ status: "ready", data }))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        if (err?.code === "UNAUTHENTICATED") onSessionEnded();
        else setItems((s) => (s.status === "ready" ? s : { status: "error", data: null }));
      });
    getTripDocuments(enrolmentId, "itinerary", { signal: controller.signal })
      .then((docs) => setPdf({ status: "ready", docs }))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        setPdf({ status: "ready", docs: [] }); // PDF fetch failure is non-fatal; still show manual items
      });
    return () => controller.abort();
  }, [enrolmentId, tick, onSessionEnded]);

  const loading = items.status === "loading" || pdf.status === "loading";
  const hasItems = items.status === "ready" && items.data?.items.length > 0;
  const hasPdf = pdf.status === "ready" && pdf.docs.length > 0;
  const hasAnything = hasItems || hasPdf;

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-title">
      <h1 id="dashboard-title" className="dashboard-title" ref={headingRef} tabIndex={-1}>{section.label}</h1>
      {loading && <p className="dashboard-placeholder" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" /> Loading your itinerary…</p>}
      {!loading && items.status === "error" && <p className="dashboard-placeholder" role="alert">We couldn't load the itinerary just now. Please try again in a moment.</p>}
      {!loading && !hasAnything && items.status !== "error" && (
        <p className="dashboard-placeholder">Your trip itinerary will be available here soon.</p>
      )}
      {!loading && hasAnything && (
        <>
          {items.status === "ready" && items.data?.trip?.title && (
            <p className="dashboard-placeholder">{items.data.trip.title}{items.data.trip.destination ? ` · ${items.data.trip.destination}` : ""}</p>
          )}
          {hasPdf && (
            <ul className="trip-doc-list" aria-label="Itinerary documents">
              {pdf.docs.map((doc) => (
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
          {hasItems && (
            <ol className="itinerary-list" aria-label="Trip itinerary">
              {items.data.items.map((item) => (
                <li key={item.id} className="itinerary-item">
                  <h2 className="itinerary-day">Day {item.dayNumber}: {item.title}</h2>
                  {item.details && <p className="itinerary-details">{item.details}</p>}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
