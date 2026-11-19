// The stable registration record. Plain JSON so the Sales ERP can read it later; nothing here creates an ERP API.
// Searchable and relational facts are real fields (and database columns). The parent's form answers travel together
// as `answers`, stored in onboarding_forms.data (JSONB).
import { z } from "zod";
import { TEMPLATE_KEYS } from "./variants.js";

export const REGISTRATION_SCHEMA_VERSION = 1;
export const REGISTRATION_STATUSES = ["draft", "submitted"];

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T/);

export const registrationRecordSchema = z.object({
  schemaVersion: z.literal(REGISTRATION_SCHEMA_VERSION),
  registrationId: uuid, // onboarding_forms.id
  enrolmentId: uuid, // trip_enrolments.id
  schoolId: uuid,
  tripId: uuid,
  variant: z.enum(TEMPLATE_KEYS), // trips.template_key, e.g. "international_payment"
  tourType: z.enum(["domestic", "international"]),
  paymentMode: z.enum(["none", "payment"]),
  participantRole: z.enum(["student", "teacher", "team_leader"]),
  status: z.enum(REGISTRATION_STATUSES),
  progressPercent: z.number().int().min(0).max(100),
  answers: z.record(z.string(), z.string()), // the JSONB document: field key -> text answer
  createdAt: iso,
  updatedAt: iso,
  submittedAt: iso.nullable(),
});

/** Builds the contract object from the joined database row (column names as in onboarding_forms / trips). */
export function toRegistrationRecord(row) {
  const iso = (d) => (d === null || d === undefined ? null : new Date(d).toISOString());
  return registrationRecordSchema.parse({
    schemaVersion: REGISTRATION_SCHEMA_VERSION,
    registrationId: row.id,
    enrolmentId: row.enrolment_id,
    schoolId: row.school_id,
    tripId: row.trip_id,
    variant: row.variant,
    tourType: row.tour_type,
    paymentMode: row.payment_mode,
    participantRole: row.participant_role,
    status: row.status,
    progressPercent: row.progress_percent,
    answers: row.data,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    submittedAt: iso(row.submitted_at),
  });
}
