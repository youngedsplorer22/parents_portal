// The greeting at the top of the registration form. Presentation only: the destination is the trip's own, as stored
// by the sales team and sent by the server. React escapes it like any other text. Nothing is invented when a trip
// has no destination (or the form belongs to no trip): the wording then simply leaves the place out.

export const TOUR_HEADINGS = { domestic: "Domestic Tour", international: "International Tour" };

/** -> { salutation, paragraphs, signoff } */
export function greetingFor(destination) {
  const place = typeof destination === "string" ? destination.trim() : "";
  return {
    salutation: "Dear Parents,",
    paragraphs: [
      "Greetings from Young Edsplorer!",
      place
        ? `Thank you for your interest in the upcoming trip to ${place}. Please complete the required information below to proceed with the registration.`
        : "Thank you for your interest in the upcoming trip. Please complete the required information below to proceed with the registration.",
    ],
    signoff: ["Regards,", "Young Edsplorer"],
  };
}

/**
 * The order fields are LAID OUT in, two per row on wide screens. The stored data and the definitions (which follow
 * the core sheet's column order) are unchanged; only the display order differs. Fields not listed keep their place
 * after the listed ones.
 */
const LAYOUT = { personal: ["fullName", "firstName", "lastName", "dateOfBirth", "gender", "classSection", "age"] };
export function layoutFields(section) {
  // Hidden fields (today AGE: the server works it out from the date of birth) are never shown.
  const fields = section.fields.filter((f) => !f.hidden);
  const order = LAYOUT[section.id];
  if (!order) return fields;
  const rank = (f) => (order.includes(f.key) ? order.indexOf(f.key) : order.length);
  return [...fields].map((f, i) => [f, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([f]) => f);
}
