-- 013_school_branch.sql
-- A school can have branches ("Greenfield Public School", "Kolkata Branch"). Applied by src/db/migrate.js in a single
-- transaction. Depends on 008.
--
-- ADDITIVE and backward compatible:
--  * schools.branch: optional, trimmed, 1-100 characters. Existing schools get NULL ("no branch recorded") and keep
--    working exactly as before; staff can add a branch later.
--  * schools.branch_normalized: the lower-cased, whitespace-collapsed copy used for uniqueness ('' when there is no
--    branch), filled by the application like name_normalized.
--  * Uniqueness moves from "name" to "name + branch", so two branches of the same school can exist, while the same
--    school and branch still cannot be added twice. The constraint keeps its old name (schools_name_key), and for every
--    existing row (branch_normalized = '') it enforces exactly what it enforced before.
-- No existing value is changed.

ALTER TABLE schools
    ADD COLUMN branch text,
    ADD COLUMN branch_normalized text NOT NULL DEFAULT '',
    ADD CONSTRAINT schools_branch_chk
        CHECK (branch IS NULL OR (branch = btrim(branch) AND char_length(branch) BETWEEN 1 AND 100 AND branch !~ '[[:cntrl:]]')),
    ADD CONSTRAINT schools_branch_normalized_chk
        CHECK (branch_normalized = lower(btrim(branch_normalized)) AND char_length(branch_normalized) <= 100
               AND ((branch IS NULL) = (branch_normalized = '')));

ALTER TABLE schools DROP CONSTRAINT schools_name_key;
ALTER TABLE schools ADD CONSTRAINT schools_name_key UNIQUE (name_normalized, branch_normalized);
