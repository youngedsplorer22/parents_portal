/**
 * School logos (migration 015). The address uses the school's fixed address words, never an id; `v` changes when the
 * logo does, so a browser fetches the new image straight away.
 */
export const logoUrl = (schoolSlug, branchSlug, version) =>
  version === null || version === undefined || !schoolSlug ? null : `/api/school-logos/${schoolSlug}/${branchSlug}?v=${version}`;

export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const LOGO_MAX_BYTES = 512 * 1024;

/** The real type of an image from its first bytes (never from a name or a header the client sent), or null. */
export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
