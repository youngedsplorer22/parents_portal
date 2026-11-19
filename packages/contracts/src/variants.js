// The four public registration portals. They match what the database already stores on every trip:
// trips.tour_type ('domestic' | 'international') and trips.payment_mode ('none' | 'payment'), whose generated column
// trips.template_key is `${tour_type}_${payment_mode}`. A portal's variant is only a presentation choice: the API
// decides what a trip really is and refuses a form that does not match it.

export const TOUR_TYPES = ["domestic", "international"];
export const PAYMENT_MODES = ["none", "payment"];

/** variant id -> the trip values it serves. `templateKey` equals trips.template_key in the database. */
export const VARIANTS = Object.freeze({
  "domestic-paid": { id: "domestic-paid", label: "Domestic — With Payment", tourType: "domestic", paymentMode: "payment", templateKey: "domestic_payment" },
  "domestic-free": { id: "domestic-free", label: "Domestic — Without Payment", tourType: "domestic", paymentMode: "none", templateKey: "domestic_none" },
  "international-paid": { id: "international-paid", label: "International — With Payment", tourType: "international", paymentMode: "payment", templateKey: "international_payment" },
  "international-free": { id: "international-free", label: "International — Without Payment", tourType: "international", paymentMode: "none", templateKey: "international_none" },
});

export const VARIANT_IDS = Object.keys(VARIANTS);
/** The deployable portals: the four public variants and the staff portal (Sales and Admin). */
export const PORTAL_TARGETS = [...VARIANT_IDS, "staff"];
/** Values of trips.template_key / the registration `variant` column. */
export const TEMPLATE_KEYS = Object.values(VARIANTS).map((v) => v.templateKey);

export const getVariant = (id) => (Object.hasOwn(VARIANTS, id) ? VARIANTS[id] : null);

/** The variant that serves a trip, from its two database values; null when either is not recognised. */
export function variantForTrip({ tourType, paymentMode }) {
  return Object.values(VARIANTS).find((v) => v.tourType === tourType && v.paymentMode === paymentMode) ?? null;
}

/** True when a portal of `variantId` is the right place for a trip. Display only: the API still decides. */
export function portalMatchesTrip(variantId, trip) {
  const want = getVariant(variantId);
  return Boolean(want) && variantForTrip(trip)?.id === want.id;
}

export const isPaid = (variantId) => getVariant(variantId)?.paymentMode === "payment";
