import { z } from "zod";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TEMPLATE_KEYS = ["domestic_payment", "domestic_none", "international_payment", "international_none"];

const CONTROL = /[\u0000-\u001f\u007f]/;
const dayNumber = z.number({ error: "Day must be a whole number from 1 to 366." }).int("Day must be a whole number from 1 to 366.").min(1, "Day must be a whole number from 1 to 366.").max(366, "Day must be a whole number from 1 to 366.");
const position = z.number({ error: "Position must be a whole number from 0 to 999." }).int().min(0, "Position must be from 0 to 999.").max(999, "Position must be from 0 to 999.");
const title = z
  .string({ error: "Title is required." })
  .trim()
  .min(1, "Title is required.")
  .max(200, "Title must be 200 characters or fewer.")
  .refine((s) => !CONTROL.test(s), "Title contains invalid characters.");
// Details may hold line breaks (a day's plan), never other control characters. Empty text is stored as nothing.
const details = z
  .string({ error: "Details must be text." })
  .max(2000, "Details must be 2000 characters or fewer.")
  .refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s), "Details contain invalid characters.")
  .transform((s) => (s.trim() === "" ? null : s.trim()))
  .nullable();

export const itemCreateSchema = z.strictObject({ dayNumber, title, details: details.optional(), position: position.optional() });
export const itemUpdateSchema = z
  .strictObject({ dayNumber: dayNumber.optional(), title: title.optional(), details: details.optional(), position: position.optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Send at least one field to change.");
