import { createContext, useContext } from "react";

/**
 * Everything under a signed-in staff portal: { staff: { email, name, role }, expire(), portal: "admin" | "sales",
 * base: "/admin" | "/sales" }. Pages build their links from `base`, so the same page works in either portal.
 */
export const StaffContext = createContext(null);
export const useStaff = () => useContext(StaffContext);

export const PORTALS = {
  admin: { base: "/admin", name: "Admin portal", login: "Admin log in", dashboard: "Admin dashboard" },
  sales: { base: "/sales", name: "Sales portal", login: "Sales log in", dashboard: "Sales dashboard" },
};
/** Where a signed-in staff member belongs: their own portal's dashboard, decided by the role the server returned. */
export const homeOf = (role) => `${PORTALS[role]?.base ?? "/admin"}/dashboard`;
