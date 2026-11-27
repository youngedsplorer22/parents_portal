import { createHash } from "node:crypto";
import { withTransaction } from "../../db/transaction.js";
import { forbiddenError } from "../staff/errors.js";
import { AppError } from "../email-otp/errors.js";
import { folderName } from "../pdf-storage/service.js";
import { DriveError } from "../pdf-storage/drive-client.js";
import { UUID } from "../itinerary/validation.js";
import { LOGO_MAX_BYTES, logoUrl as buildLogoUrl, sniffImageType } from "../catalog/logo.js";
// Minimal magic-byte check: returns true if bytes start with the expected signature for the MIME type.
const matchesBytes = (mimeType, buf) => {
  if (mimeType === "application/pdf") return buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x25, 0x50, 0x44, 0x46])); // %PDF
  const sniffed = sniffImageType(buf);
  return sniffed === mimeType;
};
import { logoInvalidError } from "../catalog/errors.js";
import { SINGLE_DOC_TYPES } from "./validation.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const docView = (r) => ({
  id: r.id,
  tripId: r.trip_id,
  documentType: r.document_type,
  displayName: r.display_name,
  mimeType: r.mime_type,
  sizeBytes: r.size_bytes,
  uploadedAt: r.uploaded_at,
});

const driveUnavailableError = () => new AppError(503, "DRIVE_NOT_CONFIGURED", "Document storage is not configured.");
const documentNotFoundError = () => new AppError(404, "DOCUMENT_NOT_FOUND", "Document not found.");

/**
 * Trip document upload and management, for Sales.
 * Authorization: same portal_deployments gate as the itinerary service.
 * Drive: uses the same Google Drive account as registration PDFs, under a "Trip Documents" folder.
 */
export function createTripDocumentsService({ db, drive, deploymentTemplateKey = null, rootName = "Young Edsplorer" }) {
  const configured = Boolean(drive);

  async function resolveDeploymentTrip(q, portalTemplateKey = null) {
    const templateKey = portalTemplateKey ?? deploymentTemplateKey;
    if (!templateKey) return null;
    const { rows } = await q.query("SELECT trip_id FROM portal_deployments WHERE template_key = $1", [templateKey]);
    return rows[0]?.trip_id ?? null;
  }

  async function authorizeTrip(q, actor, tripId, portalTemplateKey = null) {
    if (actor?.role !== "sales" || typeof tripId !== "string" || !UUID.test(tripId)) throw forbiddenError();
    const deployedTripId = await resolveDeploymentTrip(q, portalTemplateKey);
    if (!deployedTripId || deployedTripId !== tripId) throw forbiddenError();
  }

  // --- Drive folder management -----------------------------------------------------------------------------------
  let accountVerified = false;
  async function verifyAccountOnce() {
    if (accountVerified) return;
    await drive.verifyAccount();
    accountVerified = true;
  }

  async function cachedFolderId({ key, name, parentId }) {
    const destination = drive.account;
    const cached = await db.query("SELECT drive_folder_id FROM drive_folders WHERE destination = $1 AND folder_key = $2", [destination, key]);
    if (cached.rows[0]) return cached.rows[0].drive_folder_id;
    const id = await drive.findOrCreateFolder(name, parentId, key);
    await db.query("INSERT INTO drive_folders (destination, folder_key, drive_folder_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [destination, key, id]);
    return (await db.query("SELECT drive_folder_id FROM drive_folders WHERE destination = $1 AND folder_key = $2", [destination, key])).rows[0].drive_folder_id;
  }

  async function ensureTripFolder(schoolId, schoolName, schoolBranch, tripId, tripTitle, rootName) {
    const root = await cachedFolderId({ key: "root", name: folderName(rootName, "Young Edsplorer"), parentId: null });
    const docs = await cachedFolderId({ key: "td:docs", name: "Trip Documents", parentId: root });
    const schoolKey = `td:school:${schoolId}`;
    const schoolLabel = schoolBranch ? `${schoolName} · ${schoolBranch}` : schoolName;
    const school = await cachedFolderId({ key: schoolKey, name: folderName(schoolLabel, "School"), parentId: docs });
    return cachedFolderId({ key: `td:trip:${tripId}`, name: folderName(tripTitle, "Trip"), parentId: school });
  }

  // --- public API ------------------------------------------------------------------------------------------------
  async function listDocuments(actor, tripId, portalTemplateKey = null) {
    await authorizeTrip(db, actor, tripId, portalTemplateKey);
    const { rows } = await db.query(
      "SELECT * FROM trip_documents WHERE trip_id = $1 ORDER BY document_type, uploaded_at DESC, id",
      [tripId],
    );
    return rows.map(docView);
  }

  async function uploadDocument(actor, tripId, { type, displayName, mimeType, bytes }, portalTemplateKey = null) {
    if (!configured) throw driveUnavailableError();
    await authorizeTrip(db, actor, tripId, portalTemplateKey);

    // Server-side content sniffing: reject files whose actual bytes don't match the declared MIME type.
    if (!matchesBytes(mimeType, bytes)) {
      throw new AppError(400, "INVALID_FILE_TYPE", `The file content does not match the declared type ${mimeType}.`);
    }

    const { rows: tripRows } = await db.query(
      "SELECT t.title, s.id AS school_id, s.name AS school_name, s.branch AS school_branch FROM trips t JOIN schools s ON s.id = t.school_id WHERE t.id = $1",
      [tripId],
    );
    if (!tripRows[0]) throw forbiddenError();
    const { title, school_id: schoolId, school_name: schoolName, school_branch: schoolBranch } = tripRows[0];

    await verifyAccountOnce();
    const folderId = await ensureTripFolder(schoolId, schoolName, schoolBranch, tripId, title, rootName);
    const checksum = sha256(bytes);

    let driveFileId;
    try {
      ({ id: driveFileId } = await drive.uploadFile({
        name: displayName,
        mimeType,
        parentId: folderId,
        bytes,
        appProperties: { ye_key: `td:${tripId}:${type}` },
      }));
    } catch (err) {
      const code = err instanceof DriveError ? err.code : "INTERNAL";
      throw new AppError(503, "DRIVE_UPLOAD_FAILED", `Could not upload the document (${code}).`);
    }

    let oldDriveFileId = null;
    const doc = await withTransaction(db, async (client) => {
      if (SINGLE_DOC_TYPES.has(type)) {
        const { rows } = await client.query(
          "DELETE FROM trip_documents WHERE trip_id = $1 AND document_type = $2 RETURNING drive_file_id",
          [tripId, type],
        );
        if (rows[0]) oldDriveFileId = rows[0].drive_file_id;
      }
      const { rows } = await client.query(
        `INSERT INTO trip_documents (trip_id, document_type, display_name, mime_type, size_bytes, drive_file_id, drive_account, sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [tripId, type, displayName, mimeType, bytes.length, driveFileId, drive.account, checksum, actor.id],
      );
      return docView(rows[0]);
    });

    if (oldDriveFileId) {
      drive.deleteFile(oldDriveFileId).catch(() => {});
    }

    return doc;
  }

  async function deleteDocument(actor, tripId, documentId, portalTemplateKey = null) {
    if (!configured) throw driveUnavailableError();
    await authorizeTrip(db, actor, tripId, portalTemplateKey);

    if (typeof documentId !== "string" || !UUID.test(documentId)) throw documentNotFoundError();

    const { rows } = await db.query(
      "DELETE FROM trip_documents WHERE id = $1 AND trip_id = $2 RETURNING drive_file_id",
      [documentId, tripId],
    );
    if (!rows[0]) throw documentNotFoundError();

    drive.deleteFile(rows[0].drive_file_id).catch(() => {});
  }

  async function downloadDocument(actor, tripId, documentId, portalTemplateKey = null) {
    if (!configured) throw driveUnavailableError();
    await authorizeTrip(db, actor, tripId, portalTemplateKey);

    if (typeof documentId !== "string" || !UUID.test(documentId)) throw documentNotFoundError();

    const { rows } = await db.query(
      "SELECT drive_file_id, mime_type, display_name FROM trip_documents WHERE id = $1 AND trip_id = $2",
      [documentId, tripId],
    );
    if (!rows[0]) throw documentNotFoundError();

    let bytes;
    try {
      bytes = await drive.downloadFile(rows[0].drive_file_id);
    } catch (err) {
      const code = err instanceof DriveError ? err.code : "INTERNAL";
      throw new AppError(503, "DRIVE_DOWNLOAD_FAILED", `Could not retrieve the document (${code}).`);
    }
    return { bytes, mimeType: rows[0].mime_type, displayName: rows[0].display_name };
  }

  async function getSchoolLogoInfo(actor, tripId, portalTemplateKey = null) {
    await authorizeTrip(db, actor, tripId, portalTemplateKey);
    const { rows } = await db.query(
      `SELECT s.slug, s.branch_slug,
              floor(extract(epoch FROM l.updated_at) * 1000)::bigint AS logo_version
         FROM trips t
         JOIN schools s ON s.id = t.school_id
         LEFT JOIN school_logos l ON l.school_id = s.id
        WHERE t.id = $1`,
      [tripId],
    );
    if (!rows[0]) return { logoUrl: null };
    const { slug, branch_slug, logo_version } = rows[0];
    return { logoUrl: buildLogoUrl(slug, branch_slug, logo_version) };
  }

  async function uploadSchoolLogo(actor, tripId, bytes, portalTemplateKey = null) {
    await authorizeTrip(db, actor, tripId, portalTemplateKey);
    const type = sniffImageType(bytes);
    if (!type) throw logoInvalidError("Upload a PNG, JPEG or WebP image.");
    if (bytes.length > LOGO_MAX_BYTES) throw logoInvalidError("The logo can be at most 512 KB.");
    const { rows: tripRows } = await db.query(
      "SELECT t.school_id, s.slug, s.branch_slug FROM trips t JOIN schools s ON s.id = t.school_id WHERE t.id = $1",
      [tripId],
    );
    if (!tripRows[0]) throw forbiddenError();
    const { school_id: schoolId, slug, branch_slug: branchSlug } = tripRows[0];
    let version;
    await withTransaction(db, async (client) => {
      await client.query(
        `INSERT INTO school_logos (school_id, content_type, data, updated_by, updated_at) VALUES ($1, $2, $3, $4, clock_timestamp())
         ON CONFLICT (school_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data,
                                               updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [schoolId, type, bytes, actor.id],
      );
      const { rows } = await client.query(
        "SELECT floor(extract(epoch FROM updated_at) * 1000)::bigint AS v FROM school_logos WHERE school_id = $1",
        [schoolId],
      );
      version = rows[0]?.v ?? null;
    });
    return { logoUrl: buildLogoUrl(slug, branchSlug, version) };
  }

  return { configured, listDocuments, uploadDocument, deleteDocument, downloadDocument, getSchoolLogoInfo, uploadSchoolLogo };
}
