-- 018_trip_live_location.sql
-- Live location for a trip: the team lead's LATEST position, shown to that trip's parents. Depends on 008, 011, 017.
--
-- One row per trip, overwritten on every update. There is deliberately NO route history: only the newest position is
-- ever stored, and it exists only while sharing is on. It is wiped when sharing stops, when the trip stops being active
-- (trigger below), when staff change the team lead, and by housekeeping 24 hours after the last update.
--
-- Who may share is decided by staff, not by the browser: tracker_enrolment_id is a trip enrolment (person x trip) that a
-- salesperson managing the trip, or an admin, assigned. The composite foreign key guarantees it is an enrolment OF THIS
-- trip. Adds a table, a unique constraint on trip_enrolments (id, trip_id) (id is already unique, so this cannot fail
-- or change any row), and a trigger. No existing data is changed.

ALTER TABLE trip_enrolments ADD CONSTRAINT trip_enrolments_id_trip_key UNIQUE (id, trip_id);

CREATE TABLE trip_live_locations (
    trip_id              uuid             PRIMARY KEY REFERENCES trips (id) ON DELETE CASCADE,
    -- the team lead allowed to share for this trip (assigned by staff)
    tracker_enrolment_id uuid,
    assigned_by          uuid             REFERENCES staff_users (id) ON DELETE SET NULL,
    assigned_at          timestamptz,
    -- 'sharing' only between the team lead's Start and Stop
    status               text             NOT NULL DEFAULT 'off',
    -- the team lead's sign-in that started sharing: when it ends (logout, password reset, expiry), sharing is over
    sharing_session_id   uuid             REFERENCES auth_sessions (id) ON DELETE SET NULL,
    started_at           timestamptz,
    stopped_at           timestamptz,
    stop_reason          text,
    -- the latest position (all four together, or none)
    latitude             double precision,
    longitude            double precision,
    accuracy_m           real,
    captured_at          timestamptz,     -- when the phone measured it (validated by the server)
    received_at          timestamptz,     -- when the server stored it
    updated_at           timestamptz      NOT NULL DEFAULT now(),

    CONSTRAINT trip_live_locations_tracker_fk
        FOREIGN KEY (tracker_enrolment_id, trip_id) REFERENCES trip_enrolments (id, trip_id),
    CONSTRAINT trip_live_locations_status_chk CHECK (status IN ('off', 'sharing')),
    CONSTRAINT trip_live_locations_sharing_chk
        CHECK (status <> 'sharing' OR (tracker_enrolment_id IS NOT NULL AND started_at IS NOT NULL)),
    CONSTRAINT trip_live_locations_stop_reason_chk CHECK (stop_reason IS NULL OR stop_reason ~ '^[a-z_]{3,40}$'),
    CONSTRAINT trip_live_locations_lat_chk CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90)),
    CONSTRAINT trip_live_locations_lng_chk CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180)),
    CONSTRAINT trip_live_locations_accuracy_chk CHECK (accuracy_m IS NULL OR (accuracy_m >= 0 AND accuracy_m <= 10000)),
    CONSTRAINT trip_live_locations_fix_chk
        CHECK ((latitude IS NULL) = (longitude IS NULL)
           AND (latitude IS NULL) = (captured_at IS NULL)
           AND (latitude IS NULL) = (received_at IS NULL)
           AND (latitude IS NOT NULL OR accuracy_m IS NULL)),
    -- a position is only ever kept while sharing is on
    CONSTRAINT trip_live_locations_fix_only_while_sharing_chk CHECK (latitude IS NULL OR status = 'sharing')
);

-- A trip that is no longer active (closed or archived) stops sharing at once and forgets the position, whatever path
-- changed its status (the staff screens, the command line, or SQL typed by IT).
CREATE FUNCTION trip_live_location_stop_on_trip_end() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE trip_live_locations
       SET status = 'off', stop_reason = CASE WHEN status = 'sharing' THEN 'trip_ended' ELSE stop_reason END,
           stopped_at = CASE WHEN status = 'sharing' THEN clock_timestamp() ELSE stopped_at END,
           sharing_session_id = NULL,
           latitude = NULL, longitude = NULL, accuracy_m = NULL, captured_at = NULL, received_at = NULL,
           updated_at = clock_timestamp()
     WHERE trip_id = NEW.id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trips_stop_live_location
    AFTER UPDATE OF status ON trips
    FOR EACH ROW
    WHEN (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'active')
    EXECUTE FUNCTION trip_live_location_stop_on_trip_end();
