// The typed digital signature on final submission. Same rule as the server (onboarding/routes.js): trimmed,
// 2 to 150 characters, any script, no control or text-direction characters. A typed acknowledgement, not a
// cryptographic signature.
export const SIGNATURE_MAX = 150;

export function signatureProblem(raw) {
  const v = String(raw ?? "").normalize("NFC").trim();
  if (v.length < 2) return "Type your full name as your signature.";
  if (v.length > SIGNATURE_MAX) return `Your signature can be at most ${SIGNATURE_MAX} characters.`;
  if (/[\p{Cc}‪-‮⁦-⁩]/u.test(v)) return "Your signature contains characters that aren't allowed.";
  return "";
}

/** Today's date as shown next to the signature, e.g. "23 October 2026". Display only: the server records the time. */
export const signatureDate = (now = new Date()) => now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
