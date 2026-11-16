/**
 * The declaration a parent accepts on final submission. The same text is stored, by version, in the
 * declaration_texts table (migration 015), which never changes a written row; a test checks the two match.
 * To change the wording: add a NEW version in a migration and point CURRENT_DECLARATION at it.
 */
export const CURRENT_DECLARATION = Object.freeze({
  version: "2026-10-v1",
  text: "I confirm that the information provided in this registration form is accurate and complete to the best of my knowledge. I understand that I should contact the school or Young Edsplorer if any correction is required.",
});

/** The typed digital signature: a full name. Trimmed; 2 to 150 characters; any script; no control characters. */
export const SIGNATURE_MIN = 2;
export const SIGNATURE_MAX = 150;
