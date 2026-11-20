-- 020_itinerary_assignments_portal_binding.sql
-- Depends on 007 (staff_users), 008 (schools, trips). Independent of 019: it can be applied with or without it.
--
-- ADDITIVE ONLY: three new tables, no existing table or row is changed or deleted.
--
--  * staff_trip_assignments: which trips a salesperson may keep an itinerary for. A salesperson reaches ONLY the trips an
--    admin assigned here; no assignment means no access. Assigning and revoking are admin actions (checked in the API).
--  * trip_itinerary_items: the itinerary of a trip, one row per item. Sales and admin add and edit items; nothing deletes
--    them through the API. A trip that is closed or archived keeps its itinerary (ON DELETE RESTRICT: a trip with an
--    itinerary can never be deleted by accident).
--  * portal_deployments: which ONE trip each of the four registration templates (trips.template_key) is deployed for right
--    now. When a template has a row here, the API accepts NEW registrations only for that trip, so an older school's trip
--    (or a different school's) can't be joined through a redeployed portal even by calling the API directly. Older trips
--    and every record they hold stay exactly as they are.

CREATE TABLE staff_trip_assignments (
    staff_id    uuid        NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
    trip_id     uuid        NOT NULL REFERENCES trips (id) ON DELETE RESTRICT,
    assigned_by uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT staff_trip_assignments_pkey PRIMARY KEY (staff_id, trip_id)
);
CREATE INDEX staff_trip_assignments_trip_idx ON staff_trip_assignments (trip_id);

CREATE TABLE trip_itinerary_items (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id    uuid        NOT NULL REFERENCES trips (id) ON DELETE RESTRICT,
    day_number integer     NOT NULL,
    position   integer     NOT NULL DEFAULT 0,
    title      text        NOT NULL,
    details    text,
    created_by uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
    updated_by uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT trip_itinerary_day_chk CHECK (day_number BETWEEN 1 AND 366),
    CONSTRAINT trip_itinerary_position_chk CHECK (position BETWEEN 0 AND 999),
    CONSTRAINT trip_itinerary_title_chk
        CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 200 AND title !~ '[[:cntrl:]]'),
    CONSTRAINT trip_itinerary_details_chk CHECK (details IS NULL OR char_length(details) <= 2000)
);
CREATE INDEX trip_itinerary_items_trip_idx ON trip_itinerary_items (trip_id, day_number, position);

CREATE TABLE portal_deployments (
    template_key text        PRIMARY KEY,
    trip_id      uuid        NOT NULL REFERENCES trips (id) ON DELETE RESTRICT,
    bound_by     uuid        REFERENCES staff_users (id) ON DELETE SET NULL,
    bound_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT portal_deployments_template_chk
        CHECK (template_key IN ('domestic_payment', 'domestic_none', 'international_payment', 'international_none'))
);
CREATE INDEX portal_deployments_trip_idx ON portal_deployments (trip_id);
