import { withTransaction } from "../../db/transaction.js";
import { recordAudit } from "../staff/audit.js";
import { invalidFixError, notFoundError, notSharingError, notTeamLeadError, notTeamLeaderEnrolmentError, tooFrequentError, tripNotActiveError } from "./errors.js";

/**
 * Live location of a trip's team lead, for that trip's parents (see 018_trip_live_location.sql).
 *
 *   staff (sales managing the trip, or admin) choose the team lead: one of the trip's enrolments registered as "Team Leader"
 *   the team lead starts sharing, sends a position about every 5 minutes, and stops
 *   parents enrolled in that trip read the latest position
 *
 * Every rule is checked here against the signed-in identity (req.auth / req.staff). The browser only ever names one of
 * ITS OWN enrolments; the trip, the role and the permission are looked up from that. Only the latest position is kept.
 */
export const DEFAULT_LIVE_LOCATION_POLICY = Object.freeze({
  updateIntervalSeconds: 300, // the team lead's phone sends a position this often; parents' pages refresh this often
  staleAfterSeconds: 720, // older than this, a position is shown as "may be out of date" (two missed updates plus slack)
  minUpdateGapSeconds: 45, // the server refuses updates closer together than this (a broken or abusive client)
  maxFutureSkewSeconds: 120, // a capture time this far in the future is refused (phone clock wrong, or forged)
  maxFixAgeSeconds: 900, // a capture time older than this is refused (a stale or replayed reading)
  retentionSeconds: 86400, // sharing with no update for this long is ended and its position wiped (housekeeping)
});

const TEAM_LEADER_ROLE = "Team Leader";
const seconds = (a, b) => (a.getTime() - b.getTime()) / 1000;

export function createLiveLocationService({ db, catalog, policy: overrides = {} }) {
  const policy = { ...DEFAULT_LIVE_LOCATION_POLICY, ...overrides };
  const nowFrom = async (q) => (await q.query("SELECT clock_timestamp() AS now")).rows[0].now;

  /**
   * What a reader may know right now, from the joined row. A position is only ever returned while sharing is genuinely
   * on: the trip is active, the sharing sign-in is still valid, and the position isn't past the retention limit.
   */
  function stateOf(r, now) {
    if (r.trip_status !== "active") return { state: "ended", location: null };
    if (r.status !== "sharing") return { state: r.stopped_at ? "stopped" : "not_started", location: null };
    const sessionValid = r.session_revoked_at === null && r.session_expires_at !== null && r.session_expires_at > now;
    if (!sessionValid) return { state: "stopped", location: null };
    const lastActivity = r.received_at ?? r.started_at;
    if (seconds(now, lastActivity) > policy.retentionSeconds) return { state: "stopped", location: null };
    if (r.latitude === null) return { state: "waiting", location: null };
    const location = {
      latitude: r.latitude,
      longitude: r.longitude,
      accuracyM: r.accuracy_m === null ? null : Math.round(r.accuracy_m),
      capturedAt: r.captured_at,
      receivedAt: r.received_at,
    };
    return { state: seconds(now, r.captured_at) > policy.staleAfterSeconds ? "stale" : "live", location };
  }

  const JOINED = `
      LEFT JOIN trip_live_locations l ON l.trip_id = t.id
      LEFT JOIN auth_sessions a ON a.id = l.sharing_session_id`;
  const LIVE_COLUMNS = `
      t.id AS trip_id, t.title, t.destination, t.status AS trip_status, s.name AS school, s.branch,
      l.tracker_enrolment_id, l.status, l.sharing_session_id, l.started_at, l.stopped_at, l.latitude, l.longitude,
      l.accuracy_m, l.captured_at, l.received_at, a.revoked_at AS session_revoked_at, a.expires_at AS session_expires_at`;

  /** The caller's OWN enrolment and its trip's live location; anyone else's enrolment is "not found". */
  async function loadForParent(q, auth, enrolmentId, { lock = false } = {}) {
    const { rows } = await q.query(
      `SELECT e.id AS enrolment_id, r.role, ${LIVE_COLUMNS}
         FROM trip_enrolments e
         JOIN parent_registrations r ON r.id = e.registration_id
         JOIN trips t ON t.id = e.trip_id
         JOIN schools s ON s.id = t.school_id
         ${JOINED}
        WHERE e.id = $1 AND e.registration_id = $2
        ${lock ? "FOR UPDATE OF e" : ""}`,
      [enrolmentId, auth.registrationId],
    );
    if (!rows[0]) throw notFoundError();
    return rows[0];
  }

  const tripBody = (r) => ({ title: r.title, destination: r.destination, school: r.school, branch: r.branch, status: r.trip_status });

  /** GET for a parent (or the team lead): the trip, the state, and the latest position when there is one to show. */
  async function view(auth, enrolmentId) {
    const r = await loadForParent(db, auth, enrolmentId);
    const now = await nowFrom(db);
    const { state, location } = stateOf(r, now);
    const isTeamLead = r.tracker_enrolment_id === r.enrolment_id;
    return {
      trip: tripBody(r),
      state,
      location,
      sharingSince: ["live", "stale", "waiting"].includes(state) ? r.started_at : null,
      teamLead: isTeamLead
        ? {
            canShare: r.trip_status === "active",
            // sharing from THIS sign-in (another device of the same person would have its own)
            sharingHere: r.status === "sharing" && r.sharing_session_id === auth.sessionId && ["live", "stale", "waiting"].includes(state),
          }
        : null,
      policy: { updateIntervalSeconds: policy.updateIntervalSeconds, staleAfterSeconds: policy.staleAfterSeconds },
      serverTime: now,
    };
  }

  /** The row for the team lead's own trip, locked; refuses anyone who isn't the chosen team lead of an active trip. */
  async function lockAsTeamLead(q, auth, enrolmentId) {
    const r = await loadForParent(q, auth, enrolmentId);
    if (r.tracker_enrolment_id !== r.enrolment_id) throw notTeamLeadError();
    await q.query("SELECT 1 FROM trip_live_locations WHERE trip_id = $1 FOR UPDATE", [r.trip_id]);
    const fresh = await loadForParent(q, auth, enrolmentId); // re-read after taking the lock
    if (fresh.tracker_enrolment_id !== fresh.enrolment_id) throw notTeamLeadError();
    if (fresh.trip_status !== "active") throw tripNotActiveError();
    return fresh;
  }

  /** Start Live Location. Sharing belongs to the sign-in that started it; starting on another device takes it over. */
  async function start(auth, enrolmentId) {
    await withTransaction(db, async (q) => {
      const r = await lockAsTeamLead(q, auth, enrolmentId);
      const alreadyHere = r.status === "sharing" && r.sharing_session_id === auth.sessionId;
      if (alreadyHere) return;
      await q.query(
        `UPDATE trip_live_locations
            SET status = 'sharing', sharing_session_id = $2, started_at = clock_timestamp(), stopped_at = NULL, stop_reason = NULL,
                latitude = NULL, longitude = NULL, accuracy_m = NULL, captured_at = NULL, received_at = NULL,
                updated_at = clock_timestamp()
          WHERE trip_id = $1`,
        [r.trip_id, auth.sessionId],
      );
    });
    return view(auth, enrolmentId);
  }

  /** One position from the team lead's phone. Replaces the previous one; nothing older is kept. */
  async function update(auth, { enrolmentId, latitude, longitude, accuracy = null, capturedAt }) {
    if (latitude === 0 && longitude === 0) throw invalidFixError("That location isn't valid.");
    await withTransaction(db, async (q) => {
      const r = await lockAsTeamLead(q, auth, enrolmentId);
      const now = await nowFrom(q);
      if (r.status !== "sharing" || r.sharing_session_id !== auth.sessionId) throw notSharingError();
      if (stateOf(r, now).state === "stopped") throw notSharingError();
      const captured = new Date(capturedAt);
      if (seconds(captured, now) > policy.maxFutureSkewSeconds) throw invalidFixError("The location's time is in the future. Check the phone's date and time.");
      if (seconds(now, captured) > policy.maxFixAgeSeconds) throw invalidFixError("That location is too old to share.");
      if (r.captured_at && captured < r.captured_at) throw invalidFixError("A newer location has already been shared.");
      if (r.received_at && seconds(now, r.received_at) < policy.minUpdateGapSeconds) {
        throw tooFrequentError(Math.ceil(policy.minUpdateGapSeconds - seconds(now, r.received_at)));
      }
      await q.query(
        `UPDATE trip_live_locations
            SET latitude = $2, longitude = $3, accuracy_m = $4, captured_at = $5, received_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE trip_id = $1`,
        [r.trip_id, latitude, longitude, accuracy, captured],
      );
    });
    return view(auth, enrolmentId);
  }

  const STOP = `
      UPDATE trip_live_locations
         SET status = 'off', stop_reason = $2, stopped_at = clock_timestamp(), sharing_session_id = NULL,
             latitude = NULL, longitude = NULL, accuracy_m = NULL, captured_at = NULL, received_at = NULL,
             updated_at = clock_timestamp()
       WHERE trip_id = $1 AND status = 'sharing'`;

  /** Stop Live Location (the team lead). The position is wiped at once. Stopping twice is harmless. */
  async function stop(auth, enrolmentId) {
    await withTransaction(db, async (q) => {
      const r = await loadForParent(q, auth, enrolmentId);
      if (r.tracker_enrolment_id !== r.enrolment_id) throw notTeamLeadError();
      await q.query(STOP, [r.trip_id, "team_lead_stopped"]);
    });
    return view(auth, enrolmentId);
  }

  /**
   * The trips the signed-in person has been CHOSEN by staff to share for (the mobile app's trip list). Registering as
   * "Team Leader" alone puts nothing here. Each entry is the same view a parent gets, plus the caller's enrolment id.
   */
  async function assignedTrips(auth) {
    const { rows } = await db.query(
      `SELECT e.id FROM trip_live_locations l
         JOIN trip_enrolments e ON e.id = l.tracker_enrolment_id AND e.trip_id = l.trip_id
         JOIN trips t ON t.id = l.trip_id
        WHERE e.registration_id = $1
        ORDER BY (t.status = 'active') DESC, t.created_at DESC`,
      [auth.registrationId],
    );
    return Promise.all(rows.map(async (r) => ({ enrolmentId: r.id, ...(await view(auth, r.id)) })));
  }

  // ------------------------------------------------------------------ staff

  /** For staff managing the trip: who may share (Team Leader enrolments), who is chosen, and the current state. */
  async function staffView(actor, tripId) {
    await catalog.getTrip(tripId, actor); // not found unless this person manages the trip
    const { rows } = await db.query(
      `SELECT ${LIVE_COLUMNS}
         FROM trips t JOIN schools s ON s.id = t.school_id ${JOINED}
        WHERE t.id = $1`,
      [tripId],
    );
    const r = rows[0];
    const { rows: candidates } = await db.query(
      `SELECT e.id, r.first_name, r.last_name, r.email_normalized
         FROM trip_enrolments e JOIN parent_registrations r ON r.id = e.registration_id
        WHERE e.trip_id = $1 AND r.role = $2
        ORDER BY e.created_at`,
      [tripId, TEAM_LEADER_ROLE],
    );
    const now = await nowFrom(db);
    const { state, location } = stateOf(r, now);
    return {
      state,
      location,
      sharingSince: ["live", "stale", "waiting"].includes(state) ? r.started_at : null,
      teamLeadEnrolmentId: r.tracker_enrolment_id ?? null,
      candidates: candidates.map((c) => ({ enrolmentId: c.id, name: `${c.first_name} ${c.last_name}`.trim(), email: c.email_normalized })),
      policy: { updateIntervalSeconds: policy.updateIntervalSeconds, staleAfterSeconds: policy.staleAfterSeconds },
      serverTime: now,
    };
  }

  /** Chooses (or clears) the trip's team lead. Changing it ends any sharing in progress and wipes the position. */
  async function assignTeamLead(actor, tripId, enrolmentId) {
    await catalog.getTrip(tripId, actor);
    await withTransaction(db, async (q) => {
      if (enrolmentId) {
        const { rows } = await q.query(
          `SELECT 1 FROM trip_enrolments e JOIN parent_registrations r ON r.id = e.registration_id
            WHERE e.id = $1 AND e.trip_id = $2 AND r.role = $3`,
          [enrolmentId, tripId, TEAM_LEADER_ROLE],
        );
        if (!rows[0]) throw notTeamLeaderEnrolmentError();
      }
      await q.query("INSERT INTO trip_live_locations (trip_id) VALUES ($1) ON CONFLICT (trip_id) DO NOTHING", [tripId]);
      const { rows } = await q.query("SELECT tracker_enrolment_id FROM trip_live_locations WHERE trip_id = $1 FOR UPDATE", [tripId]);
      if ((rows[0].tracker_enrolment_id ?? null) === (enrolmentId ?? null)) return;
      await q.query(STOP, [tripId, "team_lead_changed"]);
      await q.query(
        `UPDATE trip_live_locations SET tracker_enrolment_id = $2, assigned_by = $3, assigned_at = clock_timestamp(), updated_at = clock_timestamp()
          WHERE trip_id = $1`,
        [tripId, enrolmentId ?? null, actor.id ?? null],
      );
      await recordAudit(q, actor, "trip.team_lead_assign", "trip", tripId, { enrolmentId: enrolmentId ?? null });
    });
    return staffView(actor, tripId);
  }

  /**
   * Housekeeping (hourly): ends sharing that has had no update for the retention period, or whose sign-in has ended,
   * and wipes its position. Readers already treat those as stopped; this makes sure the coordinates are gone too.
   */
  async function purgeExpired() {
    return db.query(
      `UPDATE trip_live_locations l
          SET status = 'off', stop_reason = 'expired', stopped_at = clock_timestamp(), sharing_session_id = NULL,
              latitude = NULL, longitude = NULL, accuracy_m = NULL, captured_at = NULL, received_at = NULL,
              updated_at = clock_timestamp()
        WHERE l.status = 'sharing'
          AND (COALESCE(l.received_at, l.started_at) < clock_timestamp() - make_interval(secs => $1)
               OR NOT EXISTS (SELECT 1 FROM auth_sessions a
                               WHERE a.id = l.sharing_session_id AND a.revoked_at IS NULL AND a.expires_at > clock_timestamp()))`,
      [policy.retentionSeconds],
    );
  }

  return { policy, view, start, update, stop, assignedTrips, staffView, assignTeamLead, purgeExpired };
}
