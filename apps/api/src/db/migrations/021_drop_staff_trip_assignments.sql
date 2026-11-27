-- Migration 021: drop staff_trip_assignments
--
-- Authorization was always governed by portal_deployments (which trip a template is bound to), not by rows in
-- staff_trip_assignments. This table was advisory-only and is no longer written or read by any runtime or CLI code.
-- Historical audit_log rows with action 'trip.assign_sales' / 'trip.unassign_sales' have no foreign key to this
-- table and are unaffected.
--
-- Rollback: see rollbacks/021_drop_staff_trip_assignments.down.sql

DROP TABLE staff_trip_assignments;
