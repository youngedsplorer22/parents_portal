-- 011_trip_enrolments.sql
-- One school stays one school; each year's trip is its own row; a person registers for each trip.
--
-- Identity: a parent_registrations row is the person (one per email, kept for good). Taking part
-- in a trip is a separate row in trip_enrolments (person x trip). The same person can therefore
-- take part again next year without a second identity, and every earlier enrolment and form is
-- left exactly as it was.
--
-- Existing data is not changed. What this migration does:
--   * trips.academic_year: a new optional column (existing trips keep NULL).
--   * trip_enrolments: a new table.
--   * onboarding_forms.enrolment_id: a new nullable column. A form with NULL is a "legacy" form
--     (an account with no trip, or one that registered before this migration) and behaves exactly
--     as before. The old UNIQUE (registration_id) is replaced by two partial unique indexes that
--     together say: one legacy form per person, and one form per enrolment. The first index keeps
--     the old constraint's name.
--   * A small backfill ADDS enrolment rows for accounts that registered through a trip link (010)
--     and have no form yet. Accounts that already have a form are left in legacy mode on purpose:
--     a submitted form cannot be updated, so it could not be re-pointed at an enrolment.

ALTER TABLE trips
    ADD COLUMN academic_year text,
    ADD CONSTRAINT trips_academic_year_chk
        CHECK (academic_year IS NULL OR academic_year ~ '^[0-9]{4}-[0-9]{2}$');

CREATE TABLE trip_enrolments (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_id uuid        NOT NULL REFERENCES parent_registrations (id) ON DELETE RESTRICT,
    trip_id         uuid        NOT NULL REFERENCES trips (id) ON DELETE RESTRICT,
    trip_link_id    uuid        REFERENCES trip_links (id) ON DELETE SET NULL,  -- how they arrived
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT trip_enrolments_person_trip_key UNIQUE (registration_id, trip_id)
);
CREATE INDEX trip_enrolments_trip_idx ON trip_enrolments (trip_id);

ALTER TABLE onboarding_forms
    ADD COLUMN enrolment_id uuid REFERENCES trip_enrolments (id) ON DELETE RESTRICT;

ALTER TABLE onboarding_forms DROP CONSTRAINT onboarding_forms_registration_key;
CREATE UNIQUE INDEX onboarding_forms_registration_key ON onboarding_forms (registration_id) WHERE enrolment_id IS NULL;
CREATE UNIQUE INDEX onboarding_forms_enrolment_key ON onboarding_forms (enrolment_id) WHERE enrolment_id IS NOT NULL;

INSERT INTO trip_enrolments (registration_id, trip_id, trip_link_id, created_at)
SELECT r.id, r.trip_id, r.trip_link_id, r.created_at
  FROM parent_registrations r
 WHERE r.trip_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM onboarding_forms f WHERE f.registration_id = r.id);
