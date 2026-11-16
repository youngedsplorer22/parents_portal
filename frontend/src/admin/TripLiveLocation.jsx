import { lazy, Suspense, useState } from "react";
import { MapPinned } from "lucide-react";
import { assignTeamLead, getTripLiveLocation } from "../api/liveLocationApi.js";
import { useStaff } from "./staffContext.js";
import { attempt, useAdminData } from "./useAdminData.js";

const LiveMap = lazy(() => import("../liveLocation/LiveMap.jsx"));

const STATE_LABEL = {
  not_started: "Not sharing", waiting: "Started, waiting for the first location", live: "Live", stale: "Out of date",
  stopped: "Sharing ended", ended: "Trip not active",
};
const when = (iso) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/**
 * Trip page > Live location. Staff who manage the trip choose its team lead: one of the people who registered for THIS
 * trip as "Team Leader" (choosing someone is what allows them to share; registering as Team Leader alone does not).
 * Changing or clearing the team lead ends any sharing in progress. Also shows what parents currently see.
 */
export default function TripLiveLocation({ tripId, tripStatus }) {
  const { expire } = useStaff();
  const live = useAdminData((o) => getTripLiveLocation(tripId, o), [tripId]);
  const [choice, setChoice] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");

  if (live.status === "loading") return <section className="admin-card" aria-labelledby="trip-live"><h2 id="trip-live">Live location</h2><p role="status">Loading…</p></section>;
  if (live.status === "error") return <section className="admin-card" aria-labelledby="trip-live"><h2 id="trip-live">Live location</h2><p className="admin-error" role="alert">{live.error}</p></section>;
  const d = live.data;
  const selected = choice ?? d.teamLeadEnrolmentId ?? "";
  const lead = d.candidates.find((c) => c.enrolmentId === d.teamLeadEnrolmentId);

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setSaved("");
    const done = await attempt(() => assignTeamLead(tripId, selected || null), { expire, setError });
    setBusy(false);
    if (done) {
      setChoice(null);
      setSaved(selected ? "Team lead saved." : "Team lead removed.");
      live.reload();
    }
  }

  return (
    <section className="admin-card" aria-labelledby="trip-live">
      <h2 id="trip-live"><MapPinned size={18} aria-hidden="true" className="admin-h2-icon" /> Live location</h2>
      <p className="admin-muted">
        The team lead can share their phone's location with this trip's parents, about every 5 minutes, from their Parent
        Dashboard (Live Tracking). Only the person chosen here can share, and only while the trip is active.
      </p>
      <p>
        <strong>Now:</strong> {STATE_LABEL[d.state] ?? d.state}
        {d.location ? ` · last updated ${when(d.location.capturedAt)}` : ""}
        {lead ? ` · team lead ${lead.name}` : ""}
      </p>
      {d.candidates.length === 0 ? (
        <p className="admin-muted">Nobody has registered for this trip as a Team Leader yet. Ask the team lead to register through the trip's link and choose the role "Team Leader".</p>
      ) : (
        <form onSubmit={save} className="admin-row">
          <div className="admin-grow">
            <label htmlFor="trip-team-lead">Team lead</label>
            <select id="trip-team-lead" className="admin-input" value={selected} onChange={(e) => { setChoice(e.target.value); setSaved(""); }}>
              <option value="">No one (sharing off)</option>
              {d.candidates.map((c) => <option key={c.enrolmentId} value={c.enrolmentId}>{c.name} ({c.email})</option>)}
            </select>
          </div>
          <button type="submit" className="admin-button admin-button-primary" disabled={busy || selected === (d.teamLeadEnrolmentId ?? "")}>{busy ? "Saving…" : "Save team lead"}</button>
        </form>
      )}
      {tripStatus !== "active" && <p className="admin-muted">Sharing becomes possible once the trip is active, and stops automatically when the trip is closed.</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}
      {saved && <p className="admin-success" role="status">{saved}</p>}
      {d.location && (
        <div className="live-map-wrap admin-live-map">
          <Suspense fallback={<div className="live-map live-map-loading">Loading map…</div>}>
            <LiveMap location={d.location} stale={d.state === "stale"} />
          </Suspense>
        </div>
      )}
    </section>
  );
}
