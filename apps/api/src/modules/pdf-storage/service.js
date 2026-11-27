import { createHash } from "node:crypto";
import { AppError } from "../email-otp/errors.js";
import { DriveError } from "./drive-client.js";

/**
 * Keeps a copy of every submitted registration's PDF in a private Google Drive, and remembers where it is.
 *
 * The registration is already saved before anything here runs, so nothing in this file can lose or change it. What it
 * adds is a separate record per submitted form (registration_pdfs): pending -> stored, or failed with a short error
 * code and a time for the next automatic try. PostgreSQL holds only the Drive file id, the account, size and checksum,
 * never the PDF.
 *
 * Safety rules, each covered by tests:
 *  - one upload per form: a worker first "claims" the record (a lease), so a double click, a retry and the background
 *    sweep can never upload the same PDF twice; and before uploading it looks in the folder for a file it already put
 *    there, so a crash between "uploaded" and "recorded" doesn't create a second copy;
 *  - failures are recorded as codes (QUOTA_FULL, AUTH_REVOKED, TIMEOUT ...), never as messages, response bodies or
 *    secrets, and retries back off (30 s, 60 s ... up to an hour);
 *  - without credentials nothing is attempted and nothing is claimed to be stored ("not_configured");
 *  - a token for a different Google account than the configured destination is never used.
 */

const LEASE = "2 minutes";
const MAX_AUTOMATIC_ATTEMPTS = 12;
const MANUAL_COOLDOWN_SECONDS = 15;
const BASE_BACKOFF_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 3600;
const BACKGROUND_WORKERS = 2;
const MAX_QUEUED = 200;
// Failures that won't fix themselves in a minute: wait the full hour before the automatic retry.
const SLOW_TO_FIX = new Set(["AUTH_REVOKED", "AUTH_CONFIG", "ACCOUNT_MISMATCH", "QUOTA_FULL", "PERMISSION", "NOT_CONFIGURED", "PDF_INVALID"]);

/** The stored copy can't be read right now (or isn't there). `reason` is a fixed code for logs; clients only see 503. */
export class PdfUnavailableError extends AppError {
  constructor(reason) {
    super(503, "PDF_UNAVAILABLE", "We couldn't get your PDF just now. Please try again in a moment.", { retryAfterSeconds: 10 });
    this.reason = reason;
  }
}

/** A short, non-secret handle for log lines: the registration reference. */
export const referenceOfForm = (formId) => `YE-${String(formId).replace(/-/g, "").slice(0, 8).toUpperCase()}`;

/** A Drive folder name from free text: no slashes or control/direction characters, tidy spaces, at most 100 characters. */
export function folderName(text, fallback = "Untitled") {
  const cleaned = String(text ?? "")
    .replace(/[\\/\u0000-\u001f\u007f‪-‮⁦-⁩​-‏]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .trim();
  return cleaned || fallback;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function createPdfStorage({ db, drive, rootName = "Young Edsplorer", loadModel, render, logger = console, afterUploadHook = null }) {
  const configured = Boolean(drive);
  const destination = drive?.account ?? null;

  // --- records ---------------------------------------------------------------------------------------------------
  async function ensureRecord(formId) {
    await db.query("INSERT INTO registration_pdfs (form_id) VALUES ($1) ON CONFLICT (form_id) DO NOTHING", [formId]);
  }
  const getRow = async (formId) => (await db.query("SELECT * FROM registration_pdfs WHERE form_id = $1", [formId])).rows[0] ?? null;

  /** -> { status: "stored" | "pending" | "failed" | "not_configured" }. Nothing else: no ids, accounts or error text. */
  async function statusOf(formId) {
    if (!configured) return { status: "not_configured" };
    let row = await getRow(formId);
    if (!row) {
      await ensureRecord(formId);
      row = await getRow(formId);
    }
    if (row.status === "stored") return { status: row.destination === destination ? "stored" : "pending" }; // another account's copy
    return { status: row.status };
  }

  // --- one attempt -----------------------------------------------------------------------------------------------
  let accountVerified = false;
  async function verifyAccountOnce() {
    if (accountVerified) return;
    await drive.verifyAccount();
    accountVerified = true;
  }

  async function folderId({ key, name, parentId }) {
    const cached = await db.query("SELECT drive_folder_id FROM drive_folders WHERE destination = $1 AND folder_key = $2", [destination, key]);
    if (cached.rows[0]) return cached.rows[0].drive_folder_id;
    const id = await drive.findOrCreateFolder(name, parentId, key);
    await db.query("INSERT INTO drive_folders (destination, folder_key, drive_folder_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [destination, key, id]);
    return (await db.query("SELECT drive_folder_id FROM drive_folders WHERE destination = $1 AND folder_key = $2", [destination, key])).rows[0].drive_folder_id;
  }
  async function ensureFolders(folders) {
    const root = await folderId({ key: "root", name: folderName(rootName, "Young Edsplorer"), parentId: null });
    const registrations = await folderId({ key: "registrations", name: "Parent Registrations", parentId: root });
    const school = await folderId({ key: folders.school.key, name: folderName(folders.school.name, "Unassigned school"), parentId: registrations });
    return folderId({ key: folders.trip.key, name: folderName(folders.trip.name, "Unassigned trip"), parentId: school });
  }

  function codeOf(err, stage) {
    if (err instanceof DriveError) return err.code;
    return stage === "model" ? "PDF_INVALID" : stage === "render" ? "PDF_RENDER" : "INTERNAL";
  }

  async function claim(formId) {
    const { rows } = await db.query(
      `UPDATE registration_pdfs
          SET claimed_at = clock_timestamp(), attempts = attempts + 1, last_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE form_id = $1
          AND (status <> 'stored' OR destination IS DISTINCT FROM $2)
          AND (claimed_at IS NULL OR claimed_at < clock_timestamp() - interval '${LEASE}')
        RETURNING attempts`,
      [formId, destination],
    );
    return rows[0] ?? null;
  }

  async function recordFailure(formId, code, attempts) {
    const delay = SLOW_TO_FIX.has(code) ? MAX_BACKOFF_SECONDS : Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempts - 1));
    await db.query(
      `UPDATE registration_pdfs
          SET status = 'failed', last_error_code = $2, claimed_at = NULL, drive_file_id = NULL, sha256 = NULL, stored_at = NULL,
              next_retry_at = clock_timestamp() + make_interval(secs => $3), updated_at = clock_timestamp()
        WHERE form_id = $1`,
      [formId, code, delay],
    );
  }

  /** Stores the PDF if it needs storing and nobody else is doing it. Resolves to the status; expected failures are recorded, not thrown. */
  async function store(formId) {
    if (!configured) return { status: "not_configured" };
    await ensureRecord(formId);
    const claimed = await claim(formId);
    if (!claimed) return statusOf(formId);

    let stage = "account";
    try {
      await verifyAccountOnce();
      stage = "model";
      const { model, folders } = await loadModel(formId);
      stage = "render";
      const bytes = await render(model);
      stage = "drive";
      const parentId = await ensureFolders(folders);
      const name = `${model.reference}.pdf`;
      const existing = await drive.findFile(parentId, "ye_form", formId);
      let fileId;
      let stored = bytes;
      if (existing) {
        // Put there by an earlier attempt that never got recorded: adopt it (and checksum what is really in Drive).
        fileId = existing.id;
        stored = await drive.downloadFile(existing.id);
      } else {
        fileId = (await drive.uploadPdf({ name, parentId, bytes, appProperties: { ye_form: formId, ye_ref: model.reference } })).id;
      }
      if (afterUploadHook) await afterUploadHook();
      await db.query(
        `UPDATE registration_pdfs
            SET status = 'stored', destination = $2, drive_file_id = $3, file_name = $4, size_bytes = $5, sha256 = $6,
                stored_at = clock_timestamp(), claimed_at = NULL, last_error_code = NULL, next_retry_at = NULL, updated_at = clock_timestamp()
          WHERE form_id = $1`,
        [formId, destination, fileId, name, stored.length, sha256(stored)],
      );
    } catch (err) {
      const code = codeOf(err, stage);
      if (code === "NOT_FOUND") await db.query("DELETE FROM drive_folders WHERE destination = $1", [destination]); // a folder was deleted in Drive
      logger.error(`[pdf-storage] ${referenceOfForm(formId)}: could not store the PDF (${code}), attempt ${claimed.attempts}.`);
      await recordFailure(formId, code, claimed.attempts);
    }
    return statusOf(formId);
  }

  // --- background work -------------------------------------------------------------------------------------------
  const queue = [];
  const queued = new Set();
  const running = new Set();
  function pump() {
    while (running.size < BACKGROUND_WORKERS && queue.length > 0) {
      const formId = queue.shift();
      queued.delete(formId);
      const job = store(formId)
        .catch((err) => logger.error(`[pdf-storage] ${referenceOfForm(formId)}: background storing failed (${err?.code ?? "INTERNAL"}).`))
        .finally(() => {
          running.delete(job);
          pump();
        });
      running.add(job);
    }
  }
  /** Stores in the background (never throws, never blocks the caller). The sweep picks up anything dropped here. */
  function schedule(formId) {
    if (!configured || queued.has(formId) || queue.length >= MAX_QUEUED) return;
    queued.add(formId);
    queue.push(formId);
    pump();
  }
  async function drain() {
    while (queue.length > 0 || running.size > 0) await Promise.allSettled([...running]);
  }

  /** Queues up to `limit` forms that still need storing and are due: no record yet, or failed/pending and past their retry time. */
  async function sweep({ limit = 5 } = {}) {
    if (!configured) return 0;
    const { rows: due } = await db.query(
      `SELECT form_id FROM registration_pdfs
        WHERE (status <> 'stored' OR destination IS DISTINCT FROM $1)
          AND (claimed_at IS NULL OR claimed_at < clock_timestamp() - interval '${LEASE}')
          AND (next_retry_at IS NULL OR next_retry_at <= clock_timestamp())
          AND attempts < $2
        ORDER BY next_retry_at NULLS FIRST, created_at
        LIMIT $3`,
      [destination, MAX_AUTOMATIC_ATTEMPTS, limit],
    );
    const ids = due.map((r) => r.form_id);
    if (ids.length < limit) {
      const { rows } = await db.query(
        `SELECT f.id FROM onboarding_forms f LEFT JOIN registration_pdfs p ON p.form_id = f.id
          WHERE f.status = 'submitted' AND p.form_id IS NULL ORDER BY f.submitted_at LIMIT $1`,
        [limit - ids.length],
      );
      for (const r of rows) {
        await ensureRecord(r.id);
        ids.push(r.id);
      }
    }
    ids.forEach(schedule);
    return ids.length;
  }

  /** A parent's "try again": starts a new attempt in the background (at most one every 15 s), whatever the back-off says. */
  async function retry(formId) {
    if (!configured) return { status: "not_configured" };
    const current = await statusOf(formId);
    if (current.status === "stored") return current;
    const row = await getRow(formId);
    if (row.last_attempt_at) {
      const { rows } = await db.query("SELECT GREATEST(0, $2 - extract(epoch FROM clock_timestamp() - $1::timestamptz)) AS wait", [row.last_attempt_at, MANUAL_COOLDOWN_SECONDS]);
      const wait = Math.ceil(Number(rows[0].wait));
      if (wait > 0) throw new AppError(429, "RATE_LIMITED", "Please wait a few seconds before trying again.", { retryAfterSeconds: wait });
    }
    schedule(formId);
    return { status: "pending" };
  }

  // --- reading back ----------------------------------------------------------------------------------------------
  /** The stored bytes, checked against the checksum recorded when they were stored. Throws PdfUnavailableError. */
  async function fetchStored(formId) {
    if (!configured) throw new PdfUnavailableError("NOT_CONFIGURED");
    const row = await getRow(formId);
    if (!row || row.status !== "stored" || row.destination !== destination) throw new PdfUnavailableError("NOT_STORED");
    let bytes;
    try {
      bytes = await drive.downloadFile(row.drive_file_id);
    } catch (err) {
      const code = err instanceof DriveError ? err.code : "INTERNAL";
      logger.error(`[pdf-storage] ${referenceOfForm(formId)}: could not read the stored PDF (${code}).`);
      if (code === "NOT_FOUND") {
        // Deleted or binned in Drive: record that, so it is stored again.
        await db.query(
          `UPDATE registration_pdfs SET status = 'failed', last_error_code = 'NOT_FOUND', drive_file_id = NULL, sha256 = NULL, stored_at = NULL,
                  next_retry_at = clock_timestamp(), updated_at = clock_timestamp() WHERE form_id = $1 AND status = 'stored'`,
          [formId],
        );
      }
      throw new PdfUnavailableError(code);
    }
    if (sha256(bytes) !== row.sha256) {
      logger.error(`[pdf-storage] ${referenceOfForm(formId)}: the stored PDF no longer matches its checksum (integrity).`);
      throw new PdfUnavailableError("INTEGRITY");
    }
    return bytes;
  }

  return { configured, destination, ensureRecord, statusOf, store, schedule, drain, sweep, retry, fetchStored };
}
