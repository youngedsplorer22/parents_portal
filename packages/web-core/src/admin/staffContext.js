import { createContext, useContext } from "react";

/**
 * Everything under the signed-in Sales portal: { staff: { email, name, role }, expire(), portal: "sales", base: "/sales" }.
 * There is no admin portal: schools, trips and Sales access are set up by developer commands, not on a website.
 */
export const StaffContext = createContext(null);
export const useStaff = () => useContext(StaffContext);

export const PORTALS = {
  sales: { base: "/sales", name: "Sales portal", login: "Sales log in", dashboard: "Sales dashboard" },
};
/** Where a signed-in Sales person lands. */
export const homeOf = () => `${PORTALS.sales.base}/dashboard`;
