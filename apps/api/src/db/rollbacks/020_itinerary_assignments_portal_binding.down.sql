-- Rollback of 020_itinerary_assignments_portal_binding.sql. Drops the three tables it added (itinerary items, Sales trip
-- assignments, portal bindings). No school, trip, registration, enrolment or PDF record is touched. Itinerary text entered
-- since the migration is lost, so take a copy first if it matters.
BEGIN;
DROP TABLE IF EXISTS portal_deployments;
DROP TABLE IF EXISTS trip_itinerary_items;
DROP TABLE IF EXISTS staff_trip_assignments;
DELETE FROM schema_migrations WHERE name = '020_itinerary_assignments_portal_binding.sql';
COMMIT;
