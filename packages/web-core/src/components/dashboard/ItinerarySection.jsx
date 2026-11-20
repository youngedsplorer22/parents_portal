import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { getItinerary } from "../../api/enrolmentApi.js";

/**
 * Dashboard > Itinerary. Read-only: the trip's itinerary as the Sales team keeps it, for THIS registration's trip only (the
 * server finds the trip from the registration). It is asked for again whenever the section is opened and whenever the page
 * becomes visible again, so a Sales update shows up without a new login. It stays available after the trip is closed.
 */
export default function ItinerarySection({ section, headingRef, enrolmentId, onSessionEnded = () => {} }) {
  const [state, setState] = useState({ status: "loading", data: null });
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
      .then((data) => setState({ status: "ready", data }))
      .catch((err) => {
        if (err?.name === "AbortError") return;
        if (err?.code === "UNAUTHENTICATED") onSessionEnded();
        else setState((s) => (s.status === "ready" ? s : { status: "error", data: null }));
      });
    return () => controller.abort();
  }, [enrolmentId, tick, onSessionEnded]);

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-title">
      <h1 id="dashboard-title" className="dashboard-title" ref={headingRef} tabIndex={-1}>{section.label}</h1>
      {state.status === "loading" && <p className="dashboard-placeholder" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" /> Loading your itinerary…</p>}
      {state.status === "error" && <p className="dashboard-placeholder" role="alert">We couldn't load the itinerary just now. Please try again in a moment.</p>}
      {state.status === "ready" && (state.data.items.length === 0 ? (
        <p className="dashboard-placeholder">Your trip itinerary will be available here soon.</p>
      ) : (
        <>
          <p className="dashboard-placeholder">{state.data.trip.title}{state.data.trip.destination ? ` · ${state.data.trip.destination}` : ""}</p>
          <ol className="itinerary-list" aria-label="Trip itinerary">
            {state.data.items.map((item) => (
              <li key={item.id} className="itinerary-item">
                <h2 className="itinerary-day">Day {item.dayNumber}: {item.title}</h2>
                {item.details && <p className="itinerary-details">{item.details}</p>}
              </li>
            ))}
          </ol>
        </>
      ))}
    </section>
  );
}
