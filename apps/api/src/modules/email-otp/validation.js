import { z } from "zod";
import { AppError } from "./errors.js";

export const PURPOSE = "registration";
export const PURPOSES = ["registration", "login"];

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  // Plain addresses only: no comments, quotes, groups, lists or brackets. They are never needed for real addresses,
  // and an address parser could split them into extra recipients.
  .regex(/^[^\s@()<>,;:"[\]\\]+@[^\s@()<>,;:"[\]\\]+\.[^\s@()<>,;:"[\]\\]+$/, "Enter a valid email address.");

export const emailSchema = email;

const purpose = z.enum(PURPOSES);

export const sendSchema = z.strictObject({ email, purpose });
export const resendSchema = sendSchema;
export const verifySchema = z.strictObject({
  email,
  purpose,
  code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
});

/** Same normalisation the schemas apply, for callers outside the HTTP layer. */
export const normalizeEmail = (value) => String(value).trim().toLowerCase();

export function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new AppError(400, "VALIDATION_ERROR", "Invalid request.", {
    fields: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}
