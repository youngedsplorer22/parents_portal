-- Rollback of 018_trip_live_location.sql. Removes the live-location table (it holds only the latest position of trips
-- that are sharing right now, and staff assignments of team leads) and the trigger. Nothing else is touched.
BEGIN;
DROP TRIGGER IF EXISTS trips_stop_live_location ON trips;
DROP FUNCTION IF EXISTS trip_live_location_stop_on_trip_end();
DROP TABLE IF EXISTS trip_live_locations;
ALTER TABLE trip_enrolments DROP CONSTRAINT IF EXISTS trip_enrolments_id_trip_key;
DELETE FROM schema_migrations WHERE name = '018_trip_live_location.sql';
COMMIT;
