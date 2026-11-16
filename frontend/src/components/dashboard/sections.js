import { CreditCard, MapPinned, Route, ShieldCheck, Ticket, UserRound } from "lucide-react";

/**
 * The dashboard's sections, in the order they appear in the sidebar. To add real content to one later, give it a
 * `component` (a React component that receives the dashboard's data) and drop its `placeholder`; nothing else in the
 * dashboard changes. `id` is the word in the address (#payment-status) that opens it.
 *
 * Personal Details and Live Tracking have content (Live Tracking for a trip registration; a registration without a trip
 * keeps its placeholder). The others show one quiet sentence and deliberately nothing else: no amounts, dates, documents
 * or reference numbers, because none exist yet.
 */
export const DASHBOARD_SECTIONS = [
  { id: "personal-details", label: "Personal Details", icon: UserRound },
  { id: "payment-status", label: "Payment Status", icon: CreditCard, placeholder: "Payment information will be available here soon." },
  { id: "itinerary", label: "Itinerary", icon: Route, placeholder: "Your trip itinerary will be available here soon." },
  { id: "insurance", label: "Insurance", icon: ShieldCheck, placeholder: "Insurance information will be available here soon." },
  { id: "tickets", label: "Train / Flight Tickets", icon: Ticket, placeholder: "Your travel tickets will be available here soon." },
  { id: "live-tracking", label: "Live Tracking", icon: MapPinned, placeholder: "Live tracking is available for registrations made through a school's trip link." },
];

export const DEFAULT_SECTION = DASHBOARD_SECTIONS[0].id;

/** The section named by an address hash such as "#insurance". Anything else (including junk) is the first section. */
export function sectionFromHash(hash) {
  const id = String(hash ?? "").replace(/^#/, "");
  return DASHBOARD_SECTIONS.some((s) => s.id === id) ? id : DEFAULT_SECTION;
}
