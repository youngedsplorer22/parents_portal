-- Searchable, relational facts on every registration form (the answers themselves stay together in onboarding_forms.data,
-- JSONB): which school, which trip, which variant. ADDITIVE ONLY: three nullable columns, constraints, one trigger.
-- No row is deleted, no existing column changes, the JSONB document is untouched.
--
-- The values are filled by the DATABASE from the enrolment's trip, never from anything the browser sends, so a form can
-- not claim another school's trip. Forms with no enrolment (older, trip-less registrations) keep NULLs.
-- `variant` is trips.template_key: domestic_none | domestic_payment | international_none | international_payment.

ALTER TABLE trips
    ADD CONSTRAINT trips_id_school_key UNIQUE (id, school_id),
    ADD CONSTRAINT trips_id_template_key UNIQUE (id, template_key);

ALTER TABLE onboarding_forms
    ADD COLUMN school_id uuid,
    ADD COLUMN trip_id   uuid,
    ADD COLUMN variant   text;

-- Existing records: copy from the trip the enrolment belongs to.
-- Submitted forms are locked by the trigger onboarding_forms_lock_submitted (migration 004), which refuses every UPDATE.
-- Only that trigger is switched off, only for this one backfill, and inside this transaction: it is switched back on
-- right after, and if anything fails the whole migration (including this) is rolled back. The backfill touches ONLY the
-- three new columns; answers, status, version, signature and timestamps are not written. A guard below proves it.
-- Fingerprint of every pre-existing column (the whole row as JSON, minus the three new ones).
CREATE TEMP TABLE _onboarding_forms_before ON COMMIT DROP AS
    SELECT id, md5((to_jsonb(f) - 'school_id' - 'trip_id' - 'variant')::text) AS fingerprint
      FROM onboarding_forms f;

ALTER TABLE onboarding_forms DISABLE TRIGGER onboarding_forms_lock_submitted;

UPDATE onboarding_forms f
   SET trip_id = e.trip_id, school_id = t.school_id, variant = t.template_key
  FROM trip_enrolments e
  JOIN trips t ON t.id = e.trip_id
 WHERE f.enrolment_id = e.id;

ALTER TABLE onboarding_forms ENABLE TRIGGER onboarding_forms_lock_submitted;

-- Guard: no existing column of any form changed, and no form was added or lost.
DO $$
BEGIN
    IF (SELECT count(*) FROM _onboarding_forms_before) <> (SELECT count(*) FROM onboarding_forms)
       OR EXISTS (
            SELECT 1 FROM _onboarding_forms_before b
              JOIN onboarding_forms f USING (id)
             WHERE b.fingerprint <> md5((to_jsonb(f) - 'school_id' - 'trip_id' - 'variant')::text))
    THEN
        RAISE EXCEPTION 'migration 019 backfill changed existing registration data; rolled back';
    END IF;
END $$;

-- New and changed rows: the database fills the three values from the enrolment.
CREATE FUNCTION onboarding_forms_fill_trip() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.enrolment_id IS NULL THEN
        NEW.trip_id := NULL; NEW.school_id := NULL; NEW.variant := NULL;
    ELSE
        SELECT e.trip_id, t.school_id, t.template_key
          INTO NEW.trip_id, NEW.school_id, NEW.variant
          FROM trip_enrolments e JOIN trips t ON t.id = e.trip_id
         WHERE e.id = NEW.enrolment_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER onboarding_forms_fill_trip
    BEFORE INSERT OR UPDATE OF enrolment_id ON onboarding_forms
    FOR EACH ROW EXECUTE FUNCTION onboarding_forms_fill_trip();

ALTER TABLE onboarding_forms
    ADD CONSTRAINT onboarding_forms_variant_chk
        CHECK (variant IS NULL OR variant IN ('domestic_none', 'domestic_payment', 'international_none', 'international_payment')),
    ADD CONSTRAINT onboarding_forms_trip_all_or_none_chk
        CHECK ((trip_id IS NULL) = (school_id IS NULL) AND (trip_id IS NULL) = (variant IS NULL)),
    ADD CONSTRAINT onboarding_forms_enrolment_needs_trip_chk
        CHECK (enrolment_id IS NULL OR trip_id IS NOT NULL),
    ADD CONSTRAINT onboarding_forms_school_fk
        FOREIGN KEY (school_id) REFERENCES schools (id) ON DELETE RESTRICT,
    -- the form's trip, school and variant must all belong to ONE trip row, and the trip to the enrolment
    ADD CONSTRAINT onboarding_forms_trip_school_fk
        FOREIGN KEY (trip_id, school_id) REFERENCES trips (id, school_id) ON DELETE RESTRICT,
    ADD CONSTRAINT onboarding_forms_trip_variant_fk
        FOREIGN KEY (trip_id, variant) REFERENCES trips (id, template_key) ON DELETE RESTRICT,
    ADD CONSTRAINT onboarding_forms_enrolment_trip_fk
        FOREIGN KEY (enrolment_id, trip_id) REFERENCES trip_enrolments (id, trip_id) ON DELETE RESTRICT;

CREATE INDEX onboarding_forms_school_idx ON onboarding_forms (school_id, variant) WHERE school_id IS NOT NULL;
CREATE INDEX onboarding_forms_trip_idx ON onboarding_forms (trip_id) WHERE trip_id IS NOT NULL;
