-- Rollback for migration 021: re-create staff_trip_assignments
--
-- This recreates the table structure. Historical row data is not restored by this rollback;
-- if you need historical assignment data, restore it from a database backup taken before 021 was applied.

CREATE TABLE staff_trip_assignments (
    staff_id    uuid        NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
    trip_id     uuid        NOT NULL REFERENCES trips (id) ON DELETE RESTRICT,
    assigned_by uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_trip_assignments_pkey PRIMARY KEY (staff_id, trip_id)
);

CREATE INDEX staff_trip_assignments_trip_idx ON staff_trip_assignments (trip_id);
