import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, LoaderCircle, MapPin, Navigation, RefreshCw, Square } from "lucide-react";
import { getLiveLocation, liveLocationErrorMessage } from "../../api/liveLocationApi.js";
import { liveSharingSnapshot, sharingSupport, startLiveSharing, stopLiveSharing, subscribeLiveSharing } from "../../liveLocation/liveSharing.js";
import { LOW_ACCURACY_M } from "../../liveLocation/sharer.js";

// The map library is only downloaded when there is a position to show.
const LiveMap = lazy(() => import("../../liveLocation/LiveMap.jsx"));

const STATUS = {
  live: { label: "Live", tone: "live", text: "The team lead is sharing their location." },
  stale: { label: "Out of date", tone: "stale", text: null },
  waiting: { label: "Starting", tone: "info", text: "Sharing has started. Waiting for the first location from the team lead's phone." },
  not_started: { label: "Not sharing", tone: "off", text: "The team lead hasn't started sharing their location yet. This page will show it here once they do." },
  stopped: { label: "Sharing ended", tone: "off", text: "The team lead has stopped sharing their location. No location is shown." },
  ended: { label: "Trip ended", tone: "off", text: "This trip has ended, so its location is no longer shared." },
};

const when = (iso) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
function ago(seconds) {
  if (seconds < 60) return "just now";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? "" : "s"}${m % 60 ? ` ${m % 60} min` : ""} ago`;
}
const metres = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/**
 * Dashboard > Live Tracking. Parents of this trip see the team lead's latest shared position on a map; the team lead
 * chosen by staff also gets Start / Stop. The page asks the server again every 5 minutes while it is visible (not
 * while hidden), and straight away when it becomes visible again. Parents are never asked for their own location.
 */
export default function LiveTrackingSection({ section, headingRef, enrolmentId, onSessionEnded = () => {}, refreshMs }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [clock, setClock] = useState(() => Date.now());
  const [skew, setSkew] = useState(0); // server time minus this device's time, so ages don't depend on the phone's clock
  const [cooling, setCooling] = useState(false); // "Check now" rests 15 s after use
  const lastFetch = useRef(0);
  const inflight = useRef(null);

  const load = useCallback(async () => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    try {
      const v = await getLiveLocation(enrolmentId, { signal: controller.signal });
      if (!v) throw Object.assign(new Error("bad"), { code: "SERVER_ERROR" });
      if (v.serverTime) setSkew(Date.parse(v.serverTime) - Date.now());
      setClock(Date.now());
      setView(v);
      setError("");
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (err?.code === "UNAUTHENTICATED") return onSessionEnded();
      setError(err?.code === "NETWORK_ERROR" ? "Couldn't refresh: no internet connection. We'll try again automatically." : "Couldn't load the live location just now. We'll try again automatically.");
    } finally {
      if (inflight.current === controller) inflight.current = null;
      lastFetch.current = Date.now();
      setLoading(false);
    }
  }, [enrolmentId, onSessionEnded]);

  // Every 5 minutes (the server's interval) while visible; paused while hidden; immediately on return if due.
  const intervalMs = refreshMs ?? (view?.policy.updateIntervalSeconds ?? 300) * 1000;
  useEffect(() => {
    let timer = null;
    const due = () => Date.now() - lastFetch.current >= intervalMs - 1000;
    const plan = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      timer = setTimeout(async () => {
        await load();
        plan();
      }, Math.max(1000, intervalMs - (Date.now() - lastFetch.current)));
    };
    const onVisibility = async () => {
      if (document.visibilityState === "hidden") return clearTimeout(timer);
      if (due()) await load();
      plan();
    };
    if (lastFetch.current === 0) load().then(plan);
    else plan();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, intervalMs]);
  useEffect(() => () => inflight.current?.abort(), []);

  // "x minutes ago" and the stale check keep up between refreshes (a local clock only; no requests).
  useEffect(() => {
    const t = setInterval(() => document.visibilityState !== "hidden" && setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const nowServer = clock + skew;
  const location = view?.location ?? null;
  const ageSeconds = location ? Math.max(0, (nowServer - Date.parse(location.capturedAt)) / 1000) : null;
  // the server says "live", but if this page hasn't refreshed for a while the position may have aged past the limit
  const state = view ? (view.state === "live" && ageSeconds > view.policy.staleAfterSeconds ? "stale" : view.state) : null;
  const status = state ? STATUS[state] : null;
  const trip = view?.trip;

  return (
    <section className="dashboard-section" aria-labelledby="dashboard-title">
      <h1 id="dashboard-title" className="dashboard-title" ref={headingRef} tabIndex={-1}>{section.label}</h1>
      {trip && (
        <p className="live-trip">
          <strong>{trip.school}{trip.branch ? ` · ${trip.branch}` : ""}</strong>
          <span> · {trip.title}{trip.destination ? ` · ${trip.destination}` : ""}</span>
        </p>
      )}
      {loading && !view && <p role="status" className="live-loading"><LoaderCircle size={16} className="spin" aria-hidden="true" /> Loading the live location…</p>}
      {error && <div className="status-message error" role="alert"><span>{error}</span></div>}

      {view && (
        <>
          {view.teamLead && <TeamLeadPanel enrolmentId={enrolmentId} view={view} onChange={(v) => (v ? setView(v) : load())} onSessionEnded={onSessionEnded} />}

          <div className={`live-status live-status-${status.tone}`} role="status" aria-live="polite">
            <span className={`live-pill live-pill-${status.tone}`}>
              {state === "live" && <span className="live-pill-dot" aria-hidden="true" />}
              {status.label}
            </span>
            <span className="live-status-text">
              {state === "stale"
                ? `The last location is ${ago(ageSeconds)}. The team lead's phone may be offline or the page closed, so this is the last known position, not their live position.`
                : status.text}
            </span>
          </div>

          {location && (
            <div className="live-card">
              <dl className="live-facts">
                <div>
                  <dt>Last updated</dt>
                  <dd><time dateTime={location.capturedAt}>{when(location.capturedAt)}</time> <span className="live-ago">({ago(ageSeconds)})</span></dd>
                </div>
                {location.accuracyM !== null && (
                  <div>
                    <dt>Accuracy</dt>
                    <dd>{location.accuracyM > LOW_ACCURACY_M ? `Approximate (within about ${metres(location.accuracyM)})` : `Within about ${metres(location.accuracyM)}`}</dd>
                  </div>
                )}
              </dl>
              {state === "stale" && (
                <p className="live-stale-note"><AlertTriangle size={16} aria-hidden="true" /> Last known position, shown greyed out. It is not live.</p>
              )}
              <div className="live-map-wrap">
                <Suspense fallback={<div className="live-map live-map-loading">Loading map…</div>}>
                  <LiveMap location={location} stale={state === "stale"} label="Team lead" />
                </Suspense>
              </div>
              <div className="live-actions">
                <a className="live-link" href={`https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=16/${location.latitude}/${location.longitude}`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={15} aria-hidden="true" /> Open in OpenStreetMap
                </a>
              </div>
            </div>
          )}

          <p className="live-refresh">
            This page checks for a new location every {Math.round(view.policy.updateIntervalSeconds / 60)} minutes while it is open.
            <button type="button" className="text-button" onClick={() => { setCooling(true); setTimeout(() => setCooling(false), 15_000); load(); }} disabled={cooling}>
              <RefreshCw size={14} aria-hidden="true" /> Check now
            </button>
          </p>
        </>
      )}
    </section>
  );
}

const PHASE_TEXT = { locating: "Getting your location…", sending: "Sending your location…" };
const WARNING_TEXT = {
  offline: "No internet connection. Your location will be sent when you're back online.",
  unavailable: "Your phone couldn't find its location just now (GPS off or no signal). Trying again in a minute.",
  timeout: "Finding your location took too long. Trying again in a minute.",
  send_failed: "Your location couldn't be sent. Trying again in a minute.",
  low_accuracy: "Your location is only approximate. Turning on precise location or moving outdoors helps.",
};
const STOP_TEXT = {
  permission_denied: "Location permission was refused, so sharing stopped. Allow location for this site in your browser's settings, then press Start again.",
  server_stopped: "Sharing stopped: the trip ended, the team lead was changed, or sharing was started on another device.",
  signed_out: "Sharing stopped because you were signed out.",
};

/** The chosen team lead's controls: Start / Stop, what the phone is doing, and the browser's limits, said plainly. */
function TeamLeadPanel({ enrolmentId, view, onChange, onSessionEnded }) {
  const [s, setS] = useState(liveSharingSnapshot);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => subscribeLiveSharing(setS), []);
  const lastSent = useRef(null);
  useEffect(() => {
    if (s.lastSentAt && s.lastSentAt !== lastSent.current) {
      lastSent.current = s.lastSentAt;
      onChange(null); // a new position was stored: show it
    }
    if (s.stopReason === "signed_out") onSessionEnded();
  }, [s.lastSentAt, s.stopReason, onChange, onSessionEnded]);

  const here = s.enrolmentId === enrolmentId && !["idle", "stopped"].includes(s.phase);
  const support = sharingSupport();

  async function start() {
    setBusy(true);
    setProblem("");
    try {
      const v = await startLiveSharing(enrolmentId);
      if (v) onChange(v);
    } catch (err) {
      setProblem(liveLocationErrorMessage(err));
    }
    setBusy(false);
  }
  async function stop() {
    setBusy(true);
    setProblem("");
    try {
      const v = await stopLiveSharing({ notifyServer: true });
      onChange(v);
    } catch (err) {
      setProblem(liveLocationErrorMessage(err));
    }
    setBusy(false);
  }

  return (
    <div className="live-lead">
      <h2 className="live-lead-title"><Navigation size={18} aria-hidden="true" /> Share your location with parents</h2>
      <p className="live-lead-text">
        You're the team lead for this trip. While sharing is on, your phone sends its location about every 5 minutes and parents of this trip can see it on the map below.
      </p>
      {!view.teamLead.canShare && <p className="status-message info"><span>Sharing is only possible while the trip is active.</span></p>}
      {support === "insecure" && <p className="status-message error"><span>Location sharing needs a secure (https://) address. Open the portal through its https address.</span></p>}
      {support === "unsupported" && <p className="status-message error"><span>This browser can't share its location. Try Chrome or Safari on your phone.</span></p>}
      {view.teamLead.sharingHere && !here && (
        <p className="status-message info"><span>Sharing is on, but not from this page (it was started on another device, or this page was reloaded). Press Start to share from here.</span></p>
      )}
      {here ? (
        <>
          <div className="live-lead-state" role="status" aria-live="polite">
            <span className="live-pill live-pill-live"><span className="live-pill-dot" aria-hidden="true" /> Sharing</span>
            <span>
              {PHASE_TEXT[s.phase] ??
                (s.lastSentAt ? `Last sent ${new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(s.lastSentAt)}.` : "Waiting for your location…")}
              {s.nextAt && !PHASE_TEXT[s.phase] ? ` Next update around ${new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(s.nextAt)}.` : ""}
            </span>
          </div>
          {s.warning && <p className="status-message error" role="alert"><span>{WARNING_TEXT[s.warning]}</span></p>}
          <button type="button" className="secondary-button live-stop" onClick={stop} disabled={busy}>
            <Square size={15} aria-hidden="true" /> Stop Live Location
          </button>
          <p className="live-lead-note">
            <strong>Keep this page open with the screen on.</strong> Phones pause websites when the screen locks or you switch apps; updates then stop until you come back to this page.
            {s.wakeLock ? " The screen is being kept on while you share." : ""}
          </p>
        </>
      ) : (
        <>
          {s.stopReason && STOP_TEXT[s.stopReason] && <p className="status-message error" role="alert"><span>{STOP_TEXT[s.stopReason]}</span></p>}
          <button type="button" className="primary-button live-start" onClick={start} disabled={busy || !view.teamLead.canShare || support !== "ok"}>
            <MapPin size={17} aria-hidden="true" /> {busy ? "Starting…" : "Start Live Location"}
          </button>
          <p className="live-lead-note">Your browser will ask for permission to use your location. Parents never see your location until you press Start, and it is removed as soon as you stop.</p>
        </>
      )}
      {problem && <p className="status-message error" role="alert"><span>{problem}</span></p>}
    </div>
  );
}
