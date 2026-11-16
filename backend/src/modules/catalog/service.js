import { withTransaction } from "../../db/transaction.js";
import { recordAudit } from "../staff/audit.js";
import { forbiddenError } from "../staff/errors.js";
import {
  invalidTransitionError,
  logoInvalidError,
  lookupRateLimitedError,
  notFoundError,
  publicTripNotFoundError,
  schoolArchivedError,
  schoolExistsError,
  tripLockedError,
  tripNotOpenError,
} from "./errors.js";
import { LOGO_MAX_BYTES, logoUrl, sniffImageType } from "./logo.js";
import { slugify } from "./slug.js";
import { SLUG, normalizeSchoolName } from "./validation.js";

const UNIQUE_VIOLATION = "23505";
/** The school's logo version (null without a logo), for logoUrl. Needs the school aliased as `s`. */
const LOGO_VERSION = "(SELECT floor(extract(epoch FROM l.updated_at) * 1000)::bigint FROM school_logos l WHERE l.school_id = s.id) AS logo_version";
/** The public page of a trip: /join/<school>/<branch>/<trip>. Words only, no secret: see resolvePublicTrip. */
export const publicPath = (r) => `/join/${r.school_slug}/${r.school_branch_slug}/${r.slug}`;

/**
 * What a staff role may do to a trip's status. Conservative default (needs the lead's approval):
 * sales can open a draft and close an active trip; only an admin can reopen, or archive.
 */
const TRANSITIONS = {
  draft: { active: ["admin", "sales"], archived: ["admin"] },
  active: { closed: ["admin", "sales"], archived: ["admin"] },
  closed: { active: ["admin"], archived: ["admin"] },
  archived: {},
};

const schoolRow = (r) => ({
  id: r.id,
  name: r.name,
  branch: r.branch ?? null,
  slug: r.slug,
  branchSlug: r.branch_slug,
  logoUrl: logoUrl(r.slug, r.branch_slug, r.logo_version),
  status: r.status,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
  tripCount: r.trip_count === undefined ? undefined : Number(r.trip_count),
});

const tripRow = (r) => ({
  id: r.id,
  schoolId: r.school_id,
  schoolName: r.school_name,
  schoolBranch: r.school_branch ?? null,
  title: r.title,
  tourType: r.tour_type,
  destination: r.destination,
  academicYear: r.academic_year,
  paymentMode: r.payment_mode,
  status: r.status,
  templateKey: r.template_key,
  slug: r.slug,
  publicRegistration: r.public_registration,
  publicPath: publicPath(r),
  opensAt: r.opens_at,
  closesAt: r.closes_at,
  createdAt: r.created_at,
});


const TRIP_SELECT = `
  SELECT t.*, s.name AS school_name, s.branch AS school_branch, s.slug AS school_slug, s.branch_slug AS school_branch_slug,
         s.created_by AS school_created_by
    FROM trips t JOIN schools s ON s.id = t.school_id`;

/**
 * The first free slug for `base`: base, base-2, base-3 ... among `taken`. The caller holds an advisory lock for the
 * scope, and the database's unique constraint is the final guarantee.
 */
function firstFree(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Schools, trips and their public registration pages. `actor` is always req.staff (never request input); changes
 * and their audit rows commit together.
 */
export function createCatalogService({ db, config }) {
  // The full address to copy, when PUBLIC_BASE_URL is set; otherwise the panel adds its own origin to publicPath.
  const toTrip = (r) => {
    const t = tripRow(r);
    return { ...t, publicUrl: config.publicBaseUrl ? `${config.publicBaseUrl}${t.publicPath}` : null };
  };
  /**
   * Ownership: an admin manages every school; a salesperson manages the schools THEY created (schools.created_by) and
   * every trip of those schools. Anything else is answered as "not found", so ids of other people's records reveal
   * nothing. Enforced here, on every read and write, whatever the client sends.
   */
  const mayManage = (actor, schoolOwner) => actor?.role === "admin" || (Boolean(schoolOwner) && schoolOwner === actor?.id);

  // ------------------------------------------------------------------ schools
  async function listSchools(actor, { includeArchived = false } = {}) {
    const where = [];
    const params = [];
    if (!includeArchived) where.push("s.status = 'active'");
    if (actor?.role !== "admin") {
      params.push(actor?.id ?? null);
      where.push(`s.created_by = $${params.length}`);
    }
    const { rows } = await db.query(
      `SELECT s.*, (SELECT count(*) FROM trips t WHERE t.school_id = s.id) AS trip_count, ${LOGO_VERSION}
         FROM schools s ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY s.name_normalized LIMIT 500`,
      params,
    );
    return rows.map(schoolRow);
  }

  async function createSchool(actor, { name, branch = null }) {
    return withTransaction(db, async (client) => {
      // The address words are fixed now and never change on a rename, so an address can't be moved to another school.
      const branchSlug = branch ? slugify(branch, "branch") : "main";
      const base = slugify(name, "school");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`school-slug:${base}:${branchSlug}`]);
      const { rows: taken } = await client.query(
        "SELECT slug FROM schools WHERE branch_slug = $1 AND (slug = $2 OR slug LIKE $2 || '-%')",
        [branchSlug, base],
      );
      const slug = firstFree(base, new Set(taken.map((r) => r.slug)));
      try {
        const { rows } = await client.query(
          `INSERT INTO schools (name, name_normalized, branch, branch_normalized, slug, branch_slug, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [name, normalizeSchoolName(name), branch, branch ? normalizeSchoolName(branch) : "", slug, branchSlug, actor.id],
        );
        await recordAudit(client, actor, "school.create", "school", rows[0].id, { name, branch });
        // a new school has no logo yet (logo_version is absent, so logoUrl is null)
        return schoolRow(rows[0]);
      } catch (err) {
        if (err?.code === UNIQUE_VIOLATION && err.constraint === "schools_name_key") throw schoolExistsError();
        throw err;
      }
    });
  }

  /** Renaming and archiving are admin-only. */
  async function updateSchool(actor, id, { name, branch, status }) {
    if (actor.role !== "admin") throw forbiddenError();
    return withTransaction(db, async (client) => {
      const { rows } = await client.query("SELECT * FROM schools WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) throw notFoundError();
      const school = rows[0];
      try {
        const next = await client.query(
          `UPDATE schools SET
              name = COALESCE($2, name),
              name_normalized = COALESCE($3, name_normalized),
              status = COALESCE($4, status),
              archived_at = CASE WHEN COALESCE($4, status) = 'archived' THEN COALESCE(archived_at, clock_timestamp()) ELSE NULL END,
              branch = CASE WHEN $5 THEN $6 ELSE branch END,
              branch_normalized = CASE WHEN $5 THEN $7 ELSE branch_normalized END,
              updated_at = clock_timestamp()
            WHERE id = $1 RETURNING *, ${LOGO_VERSION.replaceAll("s.id", "schools.id")}`,
          [id, name ?? null, name ? normalizeSchoolName(name) : null, status ?? null, branch !== undefined, branch ?? null, branch ? normalizeSchoolName(branch) : ""],
        );
        await recordAudit(client, actor, "school.update", "school", id, {
          name: name ?? undefined,
          previousName: name ? school.name : undefined,
          branch: branch !== undefined ? branch : undefined,
          previousBranch: branch !== undefined ? school.branch : undefined,
          status: status ?? undefined,
          previousStatus: status ? school.status : undefined,
        });
        return schoolRow(next.rows[0]);
      } catch (err) {
        if (err?.code === UNIQUE_VIOLATION && err.constraint === "schools_name_key") throw schoolExistsError();
        throw err;
      }
    });
  }

  // -------------------------------------------------------------------- trips
  async function listTrips(actor, { schoolId } = {}) {
    const where = [];
    const params = [];
    if (schoolId) {
      params.push(schoolId);
      where.push(`t.school_id = $${params.length}`);
    }
    if (actor?.role !== "admin") {
      params.push(actor?.id ?? null);
      where.push(`s.created_by = $${params.length}`);
    }
    const { rows } = await db.query(
      `${TRIP_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.created_at DESC LIMIT 500`,
      params,
    );
    return rows.map(toTrip);
  }

  /** One trip, if `actor` may manage it (no actor: internal use after a change the caller already authorised). */
  async function getTrip(id, actor = null) {
    const { rows } = await db.query(`${TRIP_SELECT} WHERE t.id = $1`, [id]);
    if (!rows[0] || (actor && !mayManage(actor, rows[0].school_created_by))) throw notFoundError();
    return toTrip(rows[0]);
  }

  /** Always created as a draft; the status and template are never taken from the client. */
  async function createTrip(actor, schoolId, input) {
    return withTransaction(db, async (client) => {
      const { rows: schools } = await client.query("SELECT id, status, created_by FROM schools WHERE id = $1 FOR SHARE", [schoolId]);
      if (!schools[0] || !mayManage(actor, schools[0].created_by)) throw notFoundError();
      if (schools[0].status !== "active") throw schoolArchivedError();
      // The trip's address word is fixed now (unique within the school) and never changes on a rename.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`trip-slug:${schoolId}`]);
      const base = slugify(input.title, "trip");
      const { rows: taken } = await client.query("SELECT slug FROM trips WHERE school_id = $1 AND (slug = $2 OR slug LIKE $2 || '-%')", [schoolId, base]);
      const slug = firstFree(base, new Set(taken.map((r) => r.slug)));
      const { rows } = await client.query(
        `INSERT INTO trips (school_id, title, tour_type, destination, academic_year, payment_mode, opens_at, closes_at, created_by, slug)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [schoolId, input.title, input.tourType, input.destination ?? null, input.academicYear ?? null, input.paymentMode, input.opensAt ?? null, input.closesAt ?? null, actor.id, slug],
      );
      await recordAudit(client, actor, "trip.create", "trip", rows[0].id, {
        title: input.title,
        tourType: input.tourType,
        paymentMode: input.paymentMode,
        academicYear: input.academicYear ?? null,
      });
      return rows[0].id;
    }).then(getTrip);
  }

  async function updateTrip(actor, id, patch) {
    await withTransaction(db, async (client) => {
      const { rows } = await client.query(
        "SELECT t.*, s.created_by AS school_created_by FROM trips t JOIN schools s ON s.id = t.school_id WHERE t.id = $1 FOR UPDATE OF t",
        [id],
      );
      const trip = rows[0];
      if (!trip || !mayManage(actor, trip.school_created_by)) throw notFoundError();
      if (trip.status === "archived") throw invalidTransitionError("archived", "edited");
      const changesKind =
        (patch.tourType !== undefined && patch.tourType !== trip.tour_type) ||
        (patch.paymentMode !== undefined && patch.paymentMode !== trip.payment_mode);
      if (changesKind && trip.status !== "draft") throw tripLockedError();

      const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
      const merged = {
        title: patch.title ?? trip.title,
        tourType: patch.tourType ?? trip.tour_type,
        paymentMode: patch.paymentMode ?? trip.payment_mode,
        destination: has("destination") ? patch.destination : trip.destination,
        academicYear: has("academicYear") ? patch.academicYear : trip.academic_year,
        opensAt: has("opensAt") ? patch.opensAt : trip.opens_at,
        closesAt: has("closesAt") ? patch.closesAt : trip.closes_at,
      };
      await client.query(
        `UPDATE trips SET title = $2, tour_type = $3, payment_mode = $4, destination = $5,
                          opens_at = $6, closes_at = $7, academic_year = $8, updated_at = clock_timestamp()
          WHERE id = $1`,
        [id, merged.title, merged.tourType, merged.paymentMode, merged.destination ?? null, merged.opensAt ?? null, merged.closesAt ?? null, merged.academicYear ?? null],
      );
      await recordAudit(client, actor, "trip.update", "trip", id, {
        title: merged.title,
        tourType: merged.tourType,
        paymentMode: merged.paymentMode,
      });
    });
    return getTrip(id);
  }

  async function changeTripStatus(actor, id, status) {
    await withTransaction(db, async (client) => {
      const { rows } = await client.query(
        "SELECT t.id, t.status, s.status AS school_status, s.created_by AS school_created_by FROM trips t JOIN schools s ON s.id = t.school_id WHERE t.id = $1 FOR UPDATE OF t",
        [id],
      );
      const trip = rows[0];
      if (!trip || !mayManage(actor, trip.school_created_by)) throw notFoundError();
      const allowedRoles = TRANSITIONS[trip.status]?.[status];
      if (!allowedRoles) throw invalidTransitionError(trip.status, status);
      if (!allowedRoles.includes(actor.role)) throw forbiddenError();
      if (status === "active" && trip.school_status !== "active") throw schoolArchivedError();
      await client.query("UPDATE trips SET status = $2, updated_at = clock_timestamp() WHERE id = $1", [id, status]);
      await recordAudit(client, actor, "trip.status_change", "trip", id, { from: trip.status, to: status });
    });
    return getTrip(id);
  }

  /**
   * Turns a trip's public page on or off. Any staff member who may manage the trip (admin or sales) may do it; an
   * archived trip can't be changed. Off by default; turning it on does NOT open a draft or closed trip by itself.
   */
  async function setPublicRegistration(actor, id, enabled) {
    await withTransaction(db, async (client) => {
      const { rows } = await client.query(
        "SELECT t.id, t.status, t.public_registration, s.created_by AS school_created_by FROM trips t JOIN schools s ON s.id = t.school_id WHERE t.id = $1 FOR UPDATE OF t",
        [id],
      );
      if (!rows[0] || !mayManage(actor, rows[0].school_created_by)) throw notFoundError();
      if (rows[0].status === "archived") throw invalidTransitionError("archived", "changed");
      if (rows[0].public_registration === enabled) return; // nothing to change, nothing to audit
      await client.query("UPDATE trips SET public_registration = $2, updated_at = clock_timestamp() WHERE id = $1", [id, enabled]);
      await recordAudit(client, actor, enabled ? "trip.public_on" : "trip.public_off", "trip", id, { publicRegistration: enabled });
    });
    return getTrip(id);
  }

  // ------------------------------------------------------------ school logos
  /**
   * Sets a school's logo (admin only, like other school changes). `bytes` is the raw upload; its type is decided from
   * the bytes themselves (PNG, JPEG or WebP; never SVG), whatever the request claimed. At most 512 KB.
   */
  async function setSchoolLogo(actor, id, bytes) {
    if (actor.role !== "admin") throw forbiddenError();
    const type = sniffImageType(bytes);
    if (!type) throw logoInvalidError("Upload a PNG, JPEG or WebP image.");
    if (bytes.length > LOGO_MAX_BYTES) throw logoInvalidError("The logo can be at most 512 KB.");
    await withTransaction(db, async (client) => {
      const { rows } = await client.query("SELECT id FROM schools WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) throw notFoundError();
      await client.query(
        `INSERT INTO school_logos (school_id, content_type, data, updated_by, updated_at) VALUES ($1, $2, $3, $4, clock_timestamp())
         ON CONFLICT (school_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data,
                                               updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [id, type, bytes, actor.id],
      );
      await recordAudit(client, actor, "school.logo_set", "school", id, { contentType: type, bytes: bytes.length });
    });
    return getSchool(id);
  }

  async function removeSchoolLogo(actor, id) {
    if (actor.role !== "admin") throw forbiddenError();
    await withTransaction(db, async (client) => {
      const { rows } = await client.query("SELECT id FROM schools WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) throw notFoundError();
      const { rowCount } = await client.query("DELETE FROM school_logos WHERE school_id = $1", [id]);
      if (rowCount) await recordAudit(client, actor, "school.logo_remove", "school", id, {});
    });
    return getSchool(id);
  }

  async function getSchool(id) {
    const { rows } = await db.query(`SELECT s.*, ${LOGO_VERSION} FROM schools s WHERE s.id = $1`, [id]);
    if (!rows[0]) throw notFoundError();
    return schoolRow(rows[0]);
  }

  /** Public: the logo image by the school's address words, or null. Logos are not secret (they appear on public pages). */
  async function schoolLogo(slug, branchSlug) {
    if (!SLUG.test(slug ?? "") || !SLUG.test(branchSlug ?? "")) return null;
    const { rows } = await db.query(
      "SELECT l.content_type, l.data FROM school_logos l JOIN schools s ON s.id = l.school_id WHERE s.slug = $1 AND s.branch_slug = $2",
      [slug, branchSlug],
    );
    return rows[0] ? { contentType: rows[0].content_type, data: rows[0].data } : null;
  }

  // ------------------------------------------------------------ public pages
  /** Per-IP limit: counts every lookup (valid or not) in the window, under a per-IP lock. */
  async function guardLookup(ip) {
    if (!ip) return; // no usable address (see README: trust proxy); nothing to limit on
    const { windowSeconds, max } = config.joinLookups;
    await withTransaction(db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`joinlookup:${ip}`]);
      const { rows } = await client.query(
        `SELECT count(*)::int AS n, min(created_at) AS oldest FROM trip_link_lookups
          WHERE request_ip = $1::inet AND created_at > clock_timestamp() - make_interval(secs => $2)`,
        [ip, windowSeconds],
      );
      if (rows[0].n >= max) {
        const wait = Math.max(1, Math.ceil((new Date(rows[0].oldest).getTime() + windowSeconds * 1000 - Date.now()) / 1000));
        throw lookupRateLimitedError(wait);
      }
      await client.query("INSERT INTO trip_link_lookups (request_ip) VALUES ($1)", [ip]);
      await client.query("DELETE FROM trip_link_lookups WHERE created_at < clock_timestamp() - interval '1 day'");
    });
  }

  const validSlugs = (p) => p && [p.school, p.branch, p.trip].every((v) => typeof v === "string" && SLUG.test(v));
  const PUBLIC_SELECT = `
    SELECT t.id AS trip_id, t.title, t.destination, t.academic_year, t.tour_type, t.status AS trip_status, t.public_registration,
           ((t.opens_at IS NULL OR t.opens_at <= clock_timestamp())
            AND (t.closes_at IS NULL OR t.closes_at > clock_timestamp())) AS in_window,
           s.name AS school_name, s.branch AS school_branch, s.status AS school_status,
           s.slug AS school_slug, s.branch_slug AS school_branch_slug, ${LOGO_VERSION}
      FROM schools s JOIN trips t ON t.school_id = s.id
     WHERE s.slug = $1 AND s.branch_slug = $2 AND t.slug = $3`;
  /**
   * A trip is visible on its public page only when its school is active, it is published (active or closed, not a draft
   * or archived) and staff have switched public registration ON. Everything else is the same "not available" answer.
   */
  const isPublished = (r) => r && r.school_status === "active" && r.public_registration && ["active", "closed"].includes(r.trip_status);

  /**
   * The public page: what a parent may see about a trip, found from the address words. The words are NOT a secret
   * and grant nothing by themselves: they only name a trip, and whether it takes registrations is decided here, on the
   * server, from the database. Returns no ids. Rate limited per IP.
   */
  async function resolvePublicTrip(slugs, ip) {
    await guardLookup(ip);
    if (!validSlugs(slugs)) throw publicTripNotFoundError();
    const { rows } = await db.query(PUBLIC_SELECT, [slugs.school, slugs.branch, slugs.trip]);
    const r = rows[0];
    if (!isPublished(r)) throw publicTripNotFoundError();
    const logo = logoUrl(r.school_slug, r.school_branch_slug, r.logo_version);
    return {
      school: { name: r.school_name, ...(r.school_branch ? { branch: r.school_branch } : {}), ...(logo ? { logo } : {}) },
      trip: { title: r.title, destination: r.destination, tourType: r.tour_type },
      registrationOpen: r.trip_status === "active" && r.in_window,
    };
  }

  /**
   * For registration and enrolment: the same check INSIDE the caller's transaction, with the trip row locked FOR SHARE so
   * it can't be closed or made private while this commits. Not published -> 404; published but not open -> 409.
   */
  async function resolvePublicTripForRegistration(client, slugs) {
    if (!validSlugs(slugs)) throw publicTripNotFoundError();
    const { rows } = await client.query(`${PUBLIC_SELECT} FOR SHARE OF t`, [slugs.school, slugs.branch, slugs.trip]);
    const r = rows[0];
    if (!isPublished(r)) throw publicTripNotFoundError();
    if (r.trip_status !== "active" || !r.in_window) throw tripNotOpenError();
    return {
      tripId: r.trip_id, schoolName: r.school_name, tourType: r.tour_type,
      title: r.title, destination: r.destination, academicYear: r.academic_year,
    };
  }

  return {
    listSchools, createSchool, updateSchool, setSchoolLogo, removeSchoolLogo, schoolLogo,
    listTrips, getTrip, createTrip, updateTrip, changeTripStatus, setPublicRegistration,
    resolvePublicTrip, resolvePublicTripForRegistration,
  };
}
