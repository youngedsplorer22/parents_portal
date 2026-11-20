import { z } from "zod";

export const TOUR_TYPES = ["domestic", "international"];
export const PAYMENT_MODES = ["none", "payment"];
export const TRIP_STATUSES = ["draft", "active", "closed", "archived"];

const noControlChars = (s) => !/[\u0000-\u001f\u007f]/.test(s);
const collapse = (s) => s.replace(/\s+/g, " ");

const text = (label, max) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be ${max} characters or fewer.`)
    .refine(noControlChars, `${label} contains invalid characters.`)
    .transform(collapse);

const optionalText = (label, max) => z.union([text(label, max), z.null()]).optional();

// "2026-27": the year the school's trip belongs to. Sales choose it; parents never see a field for it.
const academicYear = z
  .string({ error: "Academic year must look like 2026-27." })
  .trim()
  .regex(/^[0-9]{4}-[0-9]{2}$/, "Academic year must look like 2026-27.")
  .refine((v) => Number(v.slice(5)) === (Number(v.slice(0, 4)) + 1) % 100, "Academic year must be consecutive years, like 2026-27.");
const optionalAcademicYear = z.union([academicYear, z.null()]).optional();

const isoDate = (label) =>
  z
    .string({ error: `${label} must be a date and time.` })
    .refine((v) => /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v)), `${label} must be a date and time.`)
    .transform((v) => new Date(v));
const optionalDate = (label) => z.union([isoDate(label), z.null()]).optional();

const window = (v, ctx) => {
  if (v.opensAt && v.closesAt && v.closesAt <= v.opensAt) {
    ctx.addIssue({ code: "custom", path: ["closesAt"], message: "Closing time must be after the opening time." });
  }
};

// Branch: optional (older schools have none), the same text rules as the name. An empty value means "no branch".
const branch = z
  .union([z.literal("").transform(() => null), text("Branch", 100), z.null()])
  .optional();
export const schoolCreateSchema = z.strictObject({ name: text("School name", 150), branch });
export const schoolUpdateSchema = z
  .strictObject({ name: text("School name", 150).optional(), branch, status: z.enum(["active", "archived"], { error: "Invalid status." }).optional() })
  .refine((v) => v.name !== undefined || v.branch !== undefined || v.status !== undefined, "Nothing to change.");

export const tripCreateSchema = z
  .strictObject({
    title: text("Trip title", 150),
    tourType: z.enum(TOUR_TYPES, { error: "Choose domestic or international." }),
    destination: optionalText("Destination", 100),
    academicYear: optionalAcademicYear,
    paymentMode: z.enum(PAYMENT_MODES, { error: "Choose no payment or payment." }),
    opensAt: optionalDate("Opening time"),
    closesAt: optionalDate("Closing time"),
  })
  .superRefine(window);

export const tripUpdateSchema = z
  .strictObject({
    title: text("Trip title", 150).optional(),
    tourType: z.enum(TOUR_TYPES, { error: "Choose domestic or international." }).optional(),
    destination: optionalText("Destination", 100),
    academicYear: optionalAcademicYear,
    paymentMode: z.enum(PAYMENT_MODES, { error: "Choose no payment or payment." }).optional(),
    opensAt: optionalDate("Opening time"),
    closesAt: optionalDate("Closing time"),
  })
  .superRefine(window)
  .refine((v) => Object.keys(v).length > 0, "Nothing to change.");

export const tripStatusSchema = z.strictObject({ status: z.enum(TRIP_STATUSES, { error: "Invalid status." }) });

export const publicRegistrationSchema = z.strictObject({ enabled: z.boolean({ error: "Choose on or off." }) });

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One word of a public page address (same rule as the database CHECK). */
export const SLUG = /^(?=.{1,70}$)[a-z0-9]+(-[a-z0-9]+)*$/;
/** The address of a trip's public page, as sent by the registration and enrolment forms. */
export const publicTripSchema = z.strictObject({
  school: z.string().regex(SLUG, "Invalid address."),
  branch: z.string().regex(SLUG, "Invalid address."),
  trip: z.string().regex(SLUG, "Invalid address."),
});

/** What uniqueness compares: case-insensitive, whitespace-collapsed. */
export const normalizeSchoolName = (name) => collapse(name.normalize("NFKC").trim()).toLowerCase();
