// Which address the API should treat as the visitor's, and which headers the API may receive.
//
// A portal's web server is the only thing that talks to the private API. The API trusts exactly ONE hop (TRUST_PROXY_HOPS=1):
// this server. So this server sends the API exactly one validated address in X-Forwarded-For, chosen from what Railway's edge
// told it, and removes every other header a browser could use to claim an address. How the edge reports the visitor is not
// known from the repository, so the choice is an explicit setting that production requires (CLIENT_IP_SOURCE) and never guesses:
//
//   xff:<n>     the n-th entry from the RIGHT of X-Forwarded-For (1 = rightmost). Safe against a spoofed left side whether the
//               edge appends to or replaces the header; n counts the entries the edge itself adds after the visitor's.
//   x-real-ip   the X-Real-IP header, when it holds exactly one valid address.
//   peer        the connecting address (the edge's own). Safe but coarse: every visitor shares one address for per-IP limits.
//
// Anything that is not exactly one valid address falls back to the connecting address. It never skips to a different entry.
import { isIP } from "node:net";

const XFF_SOURCE = /^xff:([1-8])$/;

/** "xff:<n>" | "x-real-ip" | "peer" -> { mode, hops? }, or null for anything else (no trimming, no case folding, no default). */
export function parseClientIpSource(value) {
  if (typeof value !== "string") return null;
  const m = XFF_SOURCE.exec(value);
  if (m) return { mode: "xff", hops: Number(m[1]) };
  if (value === "x-real-ip") return { mode: "x-real-ip" };
  if (value === "peer") return { mode: "peer" };
  return null;
}

/** One valid IP address in canonical text (IPv4-mapped IPv6 as plain IPv4), or null. */
export function normalizeIp(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || s.length > 45 || /[\s,%[\]/;]/.test(s)) return null;
  const family = isIP(s);
  if (family === 0) return null;
  if (family === 4) return s;
  let canonical;
  try {
    canonical = new URL(`http://[${s}]/`).hostname.slice(1, -1); // the standard form: lower case, zeros compressed
  } catch {
    return null;
  }
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(canonical);
  if (dotted) return isIP(dotted[1]) === 4 ? dotted[1] : null;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return canonical;
}

/** -> { address: string | null, source: "xff" | "x-real-ip" | "peer" | "peer-fallback" } */
export function selectClientAddress(source, headers, peerAddress) {
  const peer = normalizeIp(peerAddress);
  let picked = null;
  if (source.mode === "peer") return { address: peer, source: "peer" };
  if (source.mode === "x-real-ip") {
    picked = normalizeIp(headers["x-real-ip"]);
  } else if (source.mode === "xff") {
    const value = headers["x-forwarded-for"];
    if (typeof value === "string") {
      const parts = value.split(",");
      if (parts.length >= source.hops) picked = normalizeIp(parts[parts.length - source.hops]);
    }
  }
  return picked ? { address: picked, source: source.mode } : { address: peer, source: "peer-fallback" };
}

// Headers that carry or claim a client address, forwarding details or a portal identity. None of them is passed on: the one
// address this server chose is set again below, and the portal key is this server's own.
const DROP_EXACT = new Set([
  "forwarded", "via", "x-real-ip", "x-client-ip", "true-client-ip", "cf-connecting-ip", "fastly-client-ip", "x-cluster-client-ip",
  "x-original-forwarded-for", "x-envoy-external-address", "x-azure-clientip",
]);
const DROP_PREFIX = ["x-forwarded-", "x-portal-"];

/** The headers for the API call: the browser's own minus anything above, then the chosen address and this portal's key. */
export function buildUpstreamHeaders(incoming, { hopByHop, portalSecret, address }) {
  const out = {};
  for (const [name, value] of Object.entries(incoming)) {
    const k = name.toLowerCase();
    // A name with an underscore is dropped too: some servers read x_portal_key as x-portal-key, so it would be a spoof there.
    if (hopByHop.has(k) || k === "x-forwarded-for" || k.includes("_") || DROP_EXACT.has(k) || DROP_PREFIX.some((p) => k.startsWith(p))) continue;
    out[k] = value;
  }
  if (address) out["x-forwarded-for"] = address;
  if (portalSecret) out["x-portal-key"] = portalSecret;
  return out;
}
