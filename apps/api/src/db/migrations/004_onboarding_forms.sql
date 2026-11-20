-- 004_onboarding_forms.sql
-- The Domestic / International tour coresheet each registered person fills in.
-- Applied by src/db/migrate.js in a single transaction. Depends on 002.
--
-- Storage decision: the answers are one JSONB document, not one column per
-- spreadsheet column. The two workbooks have three variants each (student,
-- teacher, team leader) with different column sets, drafts are saved while
-- half-empty, and nothing queries individual answers. The field list, formats
-- and required-ness live in application code
-- (src/modules/onboarding/definitions.js) so a change needs no migration; this
-- table owns what must hold regardless of the app: ownership, lifecycle,
-- optimistic-concurrency version and immutability after submission.
--
-- One form per registration. The owner is always taken from the authenticated
-- session on the server, never from the request body.

CREATE TABLE onboarding_forms (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_id  uuid        NOT NULL
                                 REFERENCES parent_registrations (id) ON DELETE CASCADE,
    tour_type        text        NOT NULL,
    participant_role text        NOT NULL,   -- from the registration's role, chosen server-side
    status           text        NOT NULL DEFAULT 'draft',
    data             jsonb       NOT NULL DEFAULT '{}'::jsonb,
    current_section  text,                   -- where the user left off (section id or 'review')
    progress_percent smallint    NOT NULL DEFAULT 0,
    version          integer     NOT NULL DEFAULT 1,   -- bumped on every write; stale writes are refused
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    submitted_at     timestamptz,

    CONSTRAINT onboarding_forms_registration_key UNIQUE (registration_id),
    CONSTRAINT onboarding_forms_tour_chk CHECK (tour_type IN ('domestic', 'international')),
    CONSTRAINT onboarding_forms_role_chk CHECK (participant_role IN ('student', 'teacher', 'team_leader')),
    CONSTRAINT onboarding_forms_status_chk CHECK (status IN ('draft', 'submitted')),
    CONSTRAINT onboarding_forms_data_chk
        CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 65536),
    CONSTRAINT onboarding_forms_section_chk
        CHECK (current_section IS NULL OR current_section ~ '^[a-z][a-z-]{0,39}$'),
    CONSTRAINT onboarding_forms_progress_chk CHECK (progress_percent BETWEEN 0 AND 100),
    CONSTRAINT onboarding_forms_version_chk CHECK (version >= 1),
    -- A submitted form has a submission time and is complete; a draft has neither.
    CONSTRAINT onboarding_forms_submitted_chk
        CHECK ((status = 'submitted') = (submitted_at IS NOT NULL)),
    CONSTRAINT onboarding_forms_submitted_complete_chk
        CHECK (status <> 'submitted' OR progress_percent = 100)
);

-- Last line of defence for the "no edits after submission" policy: even a bug
-- in the application cannot change a submitted form.
CREATE FUNCTION onboarding_forms_lock_submitted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'onboarding form % is submitted and can no longer be changed', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'onboarding_forms_locked';
END;
$$;

CREATE TRIGGER onboarding_forms_lock_submitted
    BEFORE UPDATE ON onboarding_forms
    FOR EACH ROW
    WHEN (OLD.status = 'submitted')
    EXECUTE FUNCTION onboarding_forms_lock_submitted();
