-- Rollback of 019_registration_variant_columns.sql. Removes the three added columns, their constraints and the trigger.
-- The answers (data) and every other column are untouched.
BEGIN;
DROP TRIGGER IF EXISTS onboarding_forms_fill_trip ON onboarding_forms;
DROP FUNCTION IF EXISTS onboarding_forms_fill_trip();
DROP INDEX IF EXISTS onboarding_forms_school_idx;
DROP INDEX IF EXISTS onboarding_forms_trip_idx;
ALTER TABLE onboarding_forms
    DROP COLUMN IF EXISTS school_id,   -- also drops the constraints that mention it
    DROP COLUMN IF EXISTS trip_id,
    DROP COLUMN IF EXISTS variant;
ALTER TABLE trips
    DROP CONSTRAINT IF EXISTS trips_id_school_key,
    DROP CONSTRAINT IF EXISTS trips_id_template_key;
DELETE FROM schema_migrations WHERE name = '019_registration_variant_columns.sql';
COMMIT;
