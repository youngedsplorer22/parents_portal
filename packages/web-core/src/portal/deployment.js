// What a public registration portal was customised for: ONE school and ONE trip, chosen by the developer in the portal's own
// folder (apps/portal-<variant>/src/deployment.config.js) and built into it. See DEPLOYMENT.md, "Preparing a portal for a school".
//
// The three words (school, branch, trip) are the trip's address words in the database. They are not secrets. The API checks them
// again on every registration against portal_deployments, so this file only decides what THIS website shows; it never decides
// who may register.
const WORD = /^(?=.{1,70}$)[a-z0-9]+(-[a-z0-9]+)*$/;
// A logo is a file built into this portal: its built address (/assets/<name>.<ext>) or a small inlined image. Never another site.
const LOGO = /^(\/assets\/[A-Za-z0-9._-]+\.(png|jpe?g|webp)|data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+)$/;
// A school's identity in the logo map: its first two address words, "<school>/<branch>" (the branch is "main" when it has none).
const SCHOOL_KEY = /^(?=.{3,141}$)[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/;
const goodLogo = (v) => typeof v === "string" && LOGO.test(v) && !v.includes("..");
const text = (v, max) => (typeof v === "string" && v.trim() !== "" && v.trim().length <= max ? v.trim() : null);

/**
 * -> { school, branch, trip, schoolName, tripTitle, destination, logo, schoolLogos } or null when the portal is not (fully) set up.
 * schoolLogos: the logo of EVERY school this portal has served, kept in the repository (never in the database). `logo` is this
 * deployment's own: the one named in the file, else its entry in schoolLogos.
 */
export function readDeployment(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { school, branch, trip } = raw;
  if (![school, branch, trip].every((w) => typeof w === "string" && WORD.test(w))) return null;
  const schoolName = text(raw.schoolName, 150);
  const tripTitle = text(raw.tripTitle, 150);
  if (!schoolName || !tripTitle) return null;
  const schoolLogos = {};
  if (raw.schoolLogos && typeof raw.schoolLogos === "object" && !Array.isArray(raw.schoolLogos)) {
    for (const [key, value] of Object.entries(raw.schoolLogos)) if (SCHOOL_KEY.test(key) && goodLogo(value)) schoolLogos[key] = value;
  }
  return {
    school, branch, trip, schoolName, tripTitle,
    destination: typeof raw.destination === "string" ? raw.destination.trim().slice(0, 100) : "",
    logo: (goodLogo(raw.logo) ? raw.logo : null) ?? schoolLogos[`${school}/${branch}`] ?? null,
    schoolLogos,
  };
}

/**
 * The logo for a registration's OWN school (its trip address, from the server), or null. Looked up by that school's identity,
 * never "whatever this portal shows now": after the portal is customised for another school, an earlier school's participants
 * still get their school's logo from schoolLogos, and the new school's logo can only ever be found under the new school's key.
 */
export function logoForSchool(deployment, address) {
  if (!deployment || !address?.school || !address?.branch) return null;
  return deployment.schoolLogos?.[`${address.school}/${address.branch}`] ?? (sameTrip(deployment, address) ? deployment.logo : null);
}

/** True only when the address names exactly the trip this portal was built for. */
export const sameTrip = (deployment, address) =>
  Boolean(deployment && address) && ["school", "branch", "trip"].every((k) => deployment[k] === address[k]);
