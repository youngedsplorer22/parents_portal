/**
 * A readable URL word made from a school, branch or trip name: "St. Xavier's School, Noida" -> "st-xaviers-school-noida".
 *
 * Used only when a school or trip is CREATED: the result is stored (schools.slug / branch_slug, trips.slug), made
 * unique with "-2", "-3" ..., and never recomputed, so renaming never moves a public address to another trip.
 */
export function slugify(text, fallback = "link") {
  const s = String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop accents: "é" -> "e"
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "") // "xavier's" -> "xaviers"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || fallback;
}
