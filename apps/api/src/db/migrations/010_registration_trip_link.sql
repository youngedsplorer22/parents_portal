-- 010_registration_trip_link.sql
-- A parent who registers through a school's trip link is tied to that trip, so the school
-- comes from the sales team's configuration, never from the parent.
--
-- ADDITIVE ONLY: two nullable columns, a CHECK and a partial index. No existing row, column or
-- constraint is changed. Accounts created before this migration (and accounts created without a
-- link) keep trip_id NULL and school 'Unassigned'.
--
-- trip_id uses RESTRICT: a trip that has registrations cannot be deleted by accident.
-- trip_link_id uses SET NULL: deleting a link row must not touch the registration.

ALTER TABLE parent_registrations
    ADD COLUMN trip_id      uuid REFERENCES trips (id) ON DELETE RESTRICT,
    ADD COLUMN trip_link_id uuid REFERENCES trip_links (id) ON DELETE SET NULL,
    ADD CONSTRAINT parent_registrations_link_needs_trip_chk
        CHECK (trip_link_id IS NULL OR trip_id IS NOT NULL);

CREATE INDEX parent_registrations_trip_idx ON parent_registrations (trip_id) WHERE trip_id IS NOT NULL;
