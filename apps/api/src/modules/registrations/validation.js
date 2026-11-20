import { z } from "zod";
import { emailSchema } from "../email-otp/validation.js";
import { checkPasswordNotEmail, passwordSchema } from "../auth/password.js";
import { PHONE_DIGITS, PHONE_MAX_LENGTH, personNameError, phoneError } from "../validation/rules.js";
import { publicTripSchema } from "../catalog/validation.js";

// Keep in sync with the options in frontend/src/App.jsx (ROLES).
// There is deliberately no school here: the school will be assigned by the
// sales team's trip link (a later phase), never typed or chosen by the parent.
export const ROLES = ["Student", "Teacher", "Team Leader"];

const hasNoControlChars = (s) => !/[\u0000-\u001f\u007f]/.test(s);
const collapse = (s) => s.replace(/\s+/g, " ");

const required = (label) => ({ error: `${label} is required.` });

const name = (label) =>
  z
    .string(required(label))
    .trim()
    .min(1, `${label} is required.`)
    .max(100, `${label} must be 100 characters or fewer.`)
    .refine(hasNoControlChars, `${label} contains invalid characters.`)
    .transform(collapse)
    .superRefine((v, ctx) => {
      const problem = personNameError(label, v);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    });

export const registrationSchema = z
  .strictObject({
    firstName: name("First name"),
    lastName: name("Last name"),
    role: z.enum(ROLES, { error: "Please select your role." }),
    // Exactly 10 digits, no country code (validation/rules.js), stored as entered: the same form as existing records.
    phone: z
      .string(required("Phone number"))
      .trim()
      .min(1, "Phone number is required.")
      .max(PHONE_MAX_LENGTH, `That's too many digits. Enter your ${PHONE_DIGITS}-digit mobile number without the country code.`)
      .superRefine((v, ctx) => {
        const problem = phoneError(v);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
    email: emailSchema,
    password: passwordSchema,
    verificationToken: z
      .string(required("Email verification"))
      .min(1, "Email verification is required.")
      .max(200, "Email verification is invalid."),
    // Optional: the address words of the trip's public page. The server finds the trip and decides whether it is
    // public and open; the parent never sends a school name or an id.
    publicTrip: publicTripSchema.optional(),
  })
  .superRefine(checkPasswordNotEmail);
