/**
 * The full address of a trip's public registration page. The path (`/join/<school>/<branch>/<trip>`) is decided by the
 * trip and never changes; only the HOST depends on the trip's template key, because each of the four template keys
 * (domestic_none, domestic_payment, international_none, international_payment) is served by its own portal deployment.
 *
 * `publicBaseUrls` maps a template key to that portal's origin (each optional). A template key with no origin of its own
 * uses `publicBaseUrl` (PUBLIC_BASE_URL), exactly as before; with neither, the result is null and the staff panel adds its
 * own origin. A trailing slash on the host never produces a double slash.
 */
export function publicUrlFor({ publicBaseUrl = null, publicBaseUrls = {} } = {}, templateKey, publicPath) {
  const own = typeof templateKey === "string" && Object.hasOwn(publicBaseUrls ?? {}, templateKey) ? publicBaseUrls[templateKey] : null;
  const base = own || publicBaseUrl;
  return base ? `${base.replace(/\/+$/, "")}${publicPath}` : null;
}

/** The four existing template keys: tour type + "_" + payment mode (the trips.template_key values). */
export const TEMPLATE_KEYS = Object.freeze(["domestic_none", "domestic_payment", "international_none", "international_payment"]);

/**
 * The template keys that would get NO usable host, but only for a PARTIAL setup: at least one per-variant host is set,
 * there is no PUBLIC_BASE_URL fallback, and some key has neither. For such a key the API would return no address and the
 * staff panel would fall back to its own (staff) origin, a link that does not work. Setups that were always valid return
 * an empty list: only PUBLIC_BASE_URL, or nothing at all (one site, where the panel's own address is the right one).
 */
export function missingLinkHosts({ publicBaseUrl = null, publicBaseUrls = {} } = {}) {
  if (publicBaseUrl) return [];
  const has = (key) => Object.hasOwn(publicBaseUrls ?? {}, key) && Boolean(publicBaseUrls[key]);
  if (!TEMPLATE_KEYS.some(has)) return [];
  return TEMPLATE_KEYS.filter((key) => !has(key));
}
