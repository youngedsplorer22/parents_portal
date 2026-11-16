export const TOUR_LABEL = { domestic: "Domestic", international: "International" };
export const PAYMENT_LABEL = { none: "No payment", payment: "Payment" };
export const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
/** <input type="datetime-local"> value <-> ISO string (or null when empty). */
export const toIso = (local) => (local ? new Date(local).toISOString() : null);
export const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "" is fine (the year is optional); otherwise it must look like 2026-27 with consecutive years. */
export function academicYearProblem(value) {
  const v = value.trim();
  if (!v) return "";
  if (!/^[0-9]{4}-[0-9]{2}$/.test(v)) return "Use the form 2026-27.";
  return Number(v.slice(5)) === (Number(v.slice(0, 4)) + 1) % 100 ? "" : "The two years must follow each other, like 2026-27.";
}
