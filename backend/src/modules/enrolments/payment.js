/**
 * What the parent may be told about payment for a trip, from persisted records only.
 *
 * There is no payment gateway and no payment/order table yet, so nothing can ever be "paid" here. A future
 * integration should store its order against the trip_enrolments row (one person on one trip) and replace
 * "not_configured" with the verified result. Nothing in this module may report success on its own.
 */
export function paymentView(paymentMode) {
  if (paymentMode === "payment") return { required: true, status: "not_configured" };
  return { required: false, status: "not_required" };
}
