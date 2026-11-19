import { createContext, useContext } from "react";

/**
 * Which deployed portal this page belongs to: "all" (the combined legacy app), one of the four variant ids
 * ("domestic-paid", "domestic-free", "international-paid", "international-free"), or "staff".
 * Presentation only. The API decides what a trip really is and what a person may see.
 */
const PortalContext = createContext({ target: "all", deployment: null });
export const PortalProvider = PortalContext.Provider;
// eslint-disable-next-line react-refresh/only-export-components -- a hook next to its provider is fine here
export const usePortal = () => useContext(PortalContext);
