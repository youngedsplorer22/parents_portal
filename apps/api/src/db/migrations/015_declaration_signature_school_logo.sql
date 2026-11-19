-- 015_declaration_signature_school_logo.sql
-- Applied by src/db/migrate.js in a single transaction. Depends on 004, 008 and 011.
--
-- Additive only: no existing value is changed or deleted.
--
--  * declaration_texts: every wording of the final-submission declaration, by version. A row is written once and
--    never changed, so it is always possible to see exactly what a parent agreed to.
--  * onboarding_forms.declaration_version / declaration_accepted_at / signature_name: the parent's acceptance of the
--    declaration and their typed electronic signature (a typed acknowledgement, not a cryptographic signature). Set
--    only by the final submission, in the same UPDATE that marks the form submitted, with the SERVER's clock; never on
--    a draft. Forms submitted before this migration keep NULL here (they were submitted without a declaration). The
--    existing trigger already refuses any change to a submitted form, so these can't be altered afterwards.
--  * school_logos: an optional logo per school, shown next to the Young Edsplorer logo on the parent pages. A separate
--    table so that school lists never load image bytes. PNG, JPEG or WebP only (never SVG, which can carry script),
--    at most 512 KB; the type is checked from the file's own bytes by the application.

CREATE TABLE declaration_texts (
    version    text        PRIMARY KEY,
    body       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT declaration_texts_version_chk CHECK (version ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(version) <= 40),
    CONSTRAINT declaration_texts_body_chk CHECK (char_length(body) BETWEEN 1 AND 2000)
);
INSERT INTO declaration_texts (version, body) VALUES (
    '2026-10-v1',
    'I confirm that the information provided in this registration form is accurate and complete to the best of my knowledge. I understand that I should contact the school or Young Edsplorer if any correction is required.'
);

CREATE FUNCTION declaration_texts_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'declaration text % can not be changed or deleted; add a new version', OLD.version
        USING ERRCODE = 'check_violation', CONSTRAINT = 'declaration_texts_immutable';
END;
$$;
CREATE TRIGGER declaration_texts_immutable
    BEFORE UPDATE OR DELETE ON declaration_texts
    FOR EACH ROW EXECUTE FUNCTION declaration_texts_immutable();

ALTER TABLE onboarding_forms
    ADD COLUMN declaration_version     text REFERENCES declaration_texts (version) ON DELETE RESTRICT,
    ADD COLUMN declaration_accepted_at timestamptz,
    ADD COLUMN signature_name          text,
    -- All three together, and only on a submitted form.
    ADD CONSTRAINT onboarding_forms_acknowledgement_chk CHECK (
        (declaration_version IS NULL AND declaration_accepted_at IS NULL AND signature_name IS NULL)
        OR (status = 'submitted'
            AND declaration_version IS NOT NULL
            AND declaration_accepted_at IS NOT NULL
            AND signature_name IS NOT NULL
            AND signature_name = btrim(signature_name)
            AND char_length(signature_name) BETWEEN 2 AND 150
            AND signature_name !~ '[[:cntrl:]]')
    );

CREATE TABLE school_logos (
    school_id    uuid        PRIMARY KEY REFERENCES schools (id) ON DELETE CASCADE,
    content_type text        NOT NULL,
    data         bytea       NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_by   uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
    CONSTRAINT school_logos_type_chk CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
    CONSTRAINT school_logos_size_chk CHECK (octet_length(data) BETWEEN 16 AND 524288)
);
