import { withTransaction } from "../../db/transaction.js";
import { AppError } from "../email-otp/errors.js";
import { definitionsFor, getDefinition, roleKey } from "./definitions.js";
import { applyComputed, checkDraft, computeProgress, sectionIds, todayIso, validateForm } from "./engine.js";
import {
  alreadySubmittedError,
  formIncompleteError,
  formNotSubmittedError,
  formSubmittedError,
  noDraftError,
  pdfFailedError,
  pdfNotReadyError,
  tourFixedByTripError,
  tourLockedError,
  versionConflictError,
} from "./errors.js";
import { LEGACY } from "./constants.js";
import * as repo from "./repository.js";
import { paymentView } from "../enrolments/payment.js";
import { logoUrl } from "../catalog/logo.js";
import { CURRENT_DECLARATION } from "./declaration.js";
import { answerSections, renderRegistrationPdf } from "./pdf/registration-pdf.js";
import { createHash } from "node:crypto";
import { createWorkGate } from "../auth/work-gate.js";
import { createPdfStorage } from "../pdf-storage/service.js";
import { serverBusyError } from "../auth/errors.js";

const REVIEW = "review";

/**
 * Draft and final submission of the onboarding form.
 *
 * `auth` is always the session's user (req.auth), never anything from the request:
 * every read and write is scoped to auth.registrationId, so one user can neither
 * see nor change another user's form.
 *
 * Lifecycle: draft (freely editable, autosaved) -> submitted (final).
 * POLICY: a submitted form is read-only. The service refuses changes and the
 * database trigger refuses them too. Changing a submitted form needs an
 * administrator; there is deliberately no "reopen" endpoint.
 */
export { LEGACY };
const registrationNotFoundError = () => new AppError(404, "REGISTRATION_NOT_FOUND", "That registration was not found.");

/** A short, stable reference for a registration, shown to the parent and on the PDF (not a secret, not a login). */
export const referenceOf = (formId) => `YE-${formId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

// Rendering a PDF keeps the server busy for a moment (about 0.3 s on a slow machine), so: one at a time with a short
// queue (beyond it, "busy, retry shortly"), and a small cache, because a submitted registration never changes.
const PDF_CACHE_SIZE = 50;
const PDF_CACHE_MS = 10 * 60 * 1000;

export function createOnboardingService({
  db,
  today = () => undefined,
  renderPdf = renderRegistrationPdf,
  logger = console,
  pdfRendering = { concurrency: 1, maxQueue: 8 },
  // The private Google Drive that keeps a copy of every submitted PDF: a drive client, or null when none is configured
  // (then PDFs are made on request and nothing is stored anywhere). See modules/pdf-storage.
  drive = null,
  driveRootName = "Young Edsplorer",
  pdfStorageNote = { mode: "disabled", missing: [] },
}) {
  const pdfGate = createWorkGate(pdfRendering);
  const pdfCache = new Map(); // fingerprint of the model -> { at, pdf: Promise<Buffer> }, oldest first
  const storage = createPdfStorage({ db, drive, rootName: driveRootName, logger, loadModel: (formId) => modelForForm(formId), render: (model) => cachedPdf(model, model.reference) });
  const toForm = (row) => {
    const def = getDefinition(row.tour_type, row.participant_role);
    return {
      tourType: row.tour_type,
      role: row.participant_role,
      status: row.status,
      data: row.data,
      currentSection: row.current_section,
      progress: computeProgress(def, row.data, today()),
      version: row.version,
      updatedAt: row.updated_at,
      submittedAt: row.submitted_at,
      reference: referenceOf(row.id),
      // Present only on forms submitted with the declaration (migration 015 onwards). The time is the server's.
      acknowledgement: row.declaration_accepted_at
        ? { declarationVersion: row.declaration_version, acceptedAt: row.declaration_accepted_at, signatureName: row.signature_name }
        : null,
    };
  };

  /**
   * Which registration a request is about:
   *   - an enrolment id: that person-on-a-trip, and only if it is the caller's own (else 404, never someone else's);
   *   - "legacy": the caller's form that belongs to no enrolment;
   *   - nothing: their newest enrolment, as before (older clients).
   * Returns { enrolment_id, ...trip fields } or null; trip fields are absent when there is no trip.
   */
  async function contextFor(q, auth, enrolmentId) {
    if (enrolmentId === undefined || enrolmentId === null) return repo.findContext(q, auth.registrationId);
    if (enrolmentId === LEGACY) {
      const legacy = await repo.findLegacyContext(q, auth.registrationId);
      return legacy.legacyWithoutTrip ? null : legacy;
    }
    const found = await repo.findEnrolmentContext(q, auth.registrationId, enrolmentId);
    if (!found) throw registrationNotFoundError();
    return found;
  }
  const tripView = (t) =>
    t && t.title
      ? {
          school: t.school_name,
          branch: t.school_branch ?? null,
          schoolLogo: logoUrl(t.school_slug, t.school_branch_slug, t.logo_version),
          title: t.title,
          destination: t.destination,
          academicYear: t.academic_year,
          tourType: t.tour_type,
          payment: paymentView(t.payment_mode),
        }
      : null;

  async function accountView(registrationId) {
    const a = await repo.findAccount(db, registrationId);
    return { name: `${a.first_name} ${a.last_name}`, role: a.role, email: a.email_normalized, phone: a.phone };
  }
  /**
   * Where the PDF stands. A copy that is "pending" (never attempted, in progress, or stored in another account) is
   * started right away when someone looks, instead of waiting for the next sweep; the claim means looking again and
   * again can't start it twice. A "failed" one is NOT retried by looking: its back-off and "Try again" decide that.
   */
  async function pdfStatusFor(formId) {
    try {
      const status = await storage.statusOf(formId);
      if (status.status === "pending") storage.schedule(formId);
      return status;
    } catch (err) {
      logger.error(`[pdf-storage] could not read the PDF status (${err?.code ?? "INTERNAL"}).`);
      return { status: "pending" };
    }
  }

  async function getState(auth, { enrolmentId } = {}) {
    const role = roleKey(auth.role);
    const trip = await contextFor(db, auth, enrolmentId);
    const row = await repo.findForContext(db, auth.registrationId, trip?.enrolment_id ?? null);
    const submitted = row?.status === "submitted";
    return {
      role,
      definitions: definitionsFor(role),
      form: row ? toForm(row) : null,
      // Only once submitted (the dashboard): the account holder's own details and where the PDF stands.
      ...(submitted ? { account: await accountView(auth.registrationId), pdf: await pdfStatusFor(row.id) } : {}),
      enrolmentId: trip?.enrolment_id ?? null,
      // Set only for registrations that belong to a school's trip. Display and tour lock.
      trip: tripView(trip),
      // The wording a parent accepts on final submission (sent back with the submission as its version).
      declaration: { version: CURRENT_DECLARATION.version, text: CURRENT_DECLARATION.text },
    };
  }

  /** Creates the draft (version null) or updates it (version = the one the client last saw). */
  async function saveDraft(auth, { tourType, data, currentSection, version, enrolmentId }) {
    const role = roleKey(auth.role);
    const def = getDefinition(tourType, role);
    // Only the parent's answers are accepted; the age is then worked out here from the date of birth.
    const clean = applyComputed(def, checkDraft(def, data), today() ?? todayIso());
    if (currentSection != null && currentSection !== REVIEW && !sectionIds(def).includes(currentSection)) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request.", {
        fields: [{ path: "currentSection", message: "Unknown section." }],
      });
    }
    const next = {
      data: clean,
      currentSection: currentSection ?? null,
      percent: computeProgress(def, clean, today()).percent,
    };

    return withTransaction(db, async (client) => {
      // A trip link decides the tour type: the form must match the trip, checked on the server.
      const trip = await contextFor(client, auth, enrolmentId);
      if (trip && trip.tour_type && trip.tour_type !== tourType) throw tourFixedByTripError(trip.tour_type);
      const formEnrolment = trip?.enrolment_id ?? null;
      const row = await repo.findForContext(client, auth.registrationId, formEnrolment, { lock: true });
      if (!row) {
        if (version !== null) throw versionConflictError(0);
        const created = await repo.insertDraft(client, { registrationId: auth.registrationId, enrolmentId: formEnrolment, tourType, role, ...next });
        if (!created) throw versionConflictError(1); // another tab created it first
        return toForm(created);
      }
      if (row.status === "submitted") throw formSubmittedError();
      if (row.tour_type !== tourType) throw tourLockedError();
      if (version !== row.version) throw versionConflictError(row.version);
      return toForm(await repo.updateDraft(client, row.id, next));
    });
  }

  /**
   * Validates the SAVED draft completely and marks it submitted, in one
   * transaction. The row is locked, so two concurrent submits cannot both win.
   * `version` makes sure the user is submitting what they last saw.
   * The declaration acceptance and typed signature are written in the same UPDATE, with the server's time.
   */
  async function submit(auth, { version, enrolmentId, declarationVersion, signatureName }) {
    if (declarationVersion !== CURRENT_DECLARATION.version || typeof signatureName !== "string" || !signatureName.trim()) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid request.", {
        fields: [{ path: "signatureName", message: "Accept the declaration and type your full name to submit." }],
      });
    }
    const committed = await withTransaction(db, async (client) => {
      const trip = await contextFor(client, auth, enrolmentId);
      const row = await repo.findForContext(client, auth.registrationId, trip?.enrolment_id ?? null, { lock: true });
      if (!row) throw noDraftError();
      if (row.status === "submitted") throw alreadySubmittedError(row.submitted_at);
      if (row.version !== version) throw versionConflictError(row.version);

      const def = getDefinition(row.tour_type, row.participant_role);
      const errors = validateForm(def, row.data, today());
      if (Object.keys(errors).length > 0) throw formIncompleteError(errors);

      // The age is recalculated with today's date, so the submitted answers carry the age on the day of submission.
      const finalData = applyComputed(def, row.data, today() ?? todayIso());
      const submitted = await repo.markSubmitted(client, row.id, { data: finalData, declarationVersion, signatureName: signatureName.trim() });
      return { form: toForm(submitted), formId: submitted.id };
    });
    // The submission is committed. Keeping a copy of the PDF in Drive happens afterwards, in the background: it never
    // delays the parent and nothing that goes wrong there can change or lose the registration.
    return { form: committed.form, pdf: await afterSubmit(committed.formId) };
  }

  async function afterSubmit(formId) {
    try {
      const status = await storage.statusOf(formId); // makes the record (pending) when storage is configured
      storage.schedule(formId);
      return status;
    } catch (err) {
      logger.error(`[pdf-storage] could not queue the PDF copy (${err?.code ?? "INTERNAL"}); the background retry will pick it up.`);
      return { status: storage.configured ? "pending" : "not_configured" };
    }
  }

  /** "Start over": deletes a DRAFT only. A submitted form is never deleted here. */
  async function discardDraft(auth, { enrolmentId } = {}) {
    return withTransaction(db, async (client) => {
      const trip = await contextFor(client, auth, enrolmentId);
      const row = await repo.findForContext(client, auth.registrationId, trip?.enrolment_id ?? null, { lock: true });
      if (row?.status === "submitted") throw formSubmittedError();
      if (row) await repo.deleteDraft(client, row.id);
    });
  }

  /**
   * Everything the PDF shows, from SAVED records only (never from a request): the submitted answers, the account, the
   * trip and school, the declaration wording that was accepted. Also the Drive folder names/keys for the stored copy.
   * The declaration counts as accepted ONLY if the form's own record proves it (version, time, signature and the exact
   * wording all present); anything less throws, so a PDF can never show an acceptance that did not happen.
   */
  async function buildPdfModel(row, trip) {
    const [account, declarationText, logo] = await Promise.all([
      repo.findAccount(db, row.registration_id),
      row.declaration_version ? repo.findDeclarationText(db, row.declaration_version) : null,
      trip?.logo_version ? repo.findSchoolLogo(db, trip.school_slug, trip.school_branch_slug) : null,
    ]);
    const submittedOn = new Date(row.submitted_at).toISOString();
    const reference = referenceOf(row.id);
    let declaration = null;
    if (row.declaration_version || row.declaration_accepted_at || row.signature_name) {
      const verified = row.declaration_version && row.declaration_accepted_at && row.signature_name?.trim() && declarationText;
      if (!verified) throw new Error("declaration acceptance could not be verified");
      declaration = { version: row.declaration_version, text: declarationText, signatureName: row.signature_name, acceptedAt: row.declaration_accepted_at, accepted: true };
    }
    const model = {
      reference,
      submittedAt: submittedOn,
      school: trip?.school_name ? { name: trip.school_name, branch: trip.school_branch ?? null } : null,
      schoolLogo: logo ? { contentType: logo.content_type, data: logo.data } : null,
      trip: trip?.title ? { title: trip.title, destination: trip.destination, academicYear: trip.academic_year, tourType: trip.tour_type } : null,
      tourType: row.tour_type,
      account: { name: `${account.first_name} ${account.last_name}`, role: account.role, email: account.email_normalized, phone: account.phone },
      sections: answerSections(getDefinition(row.tour_type, row.participant_role), row.data, submittedOn.slice(0, 10)),
      declaration,
    };
    const folders = trip?.school_id
      ? { school: { key: `school:${trip.school_id}`, name: [trip.school_name, trip.school_branch].filter(Boolean).join(" · ") }, trip: { key: `trip:${trip.trip_id}`, name: trip.title } }
      : { school: { key: "school:unassigned", name: "Unassigned" }, trip: { key: "trip:unassigned", name: "No trip" } };
    return { model, folders };
  }

  /** For the background storage, which has no session: the same model, found by form id. */
  async function modelForForm(formId) {
    const row = await repo.findFormById(db, formId);
    if (!row || row.status !== "submitted") throw new Error("form is not submitted");
    let trip = null;
    if (row.enrolment_id) trip = await repo.findEnrolmentContext(db, row.registration_id, row.enrolment_id);
    else {
      const legacy = await repo.findLegacyContext(db, row.registration_id);
      trip = legacy.legacyWithoutTrip ? null : legacy;
    }
    return buildPdfModel(row, trip);
  }

  /** The caller's own submitted form (404 for anyone else's registration, 409 for a draft): { row, trip }. */
  async function ownSubmittedForm(auth, enrolmentId) {
    const trip = await contextFor(db, auth, enrolmentId); // someone else's registration: 404
    const row = await repo.findForContext(db, auth.registrationId, trip?.enrolment_id ?? null);
    if (!row || row.status !== "submitted") throw formNotSubmittedError();
    return { row, trip };
  }

  /**
   * The registration's PDF for its owner: -> { filename, pdf }. With Drive storage configured it is the stored copy
   * (checked against its checksum); until that copy exists there is no download (PDF_NOT_READY) rather than a different
   * document. With no storage configured it is made on request from the saved record. A draft has no PDF.
   */
  async function submittedPdf(auth, { enrolmentId } = {}) {
    const { row, trip } = await ownSubmittedForm(auth, enrolmentId);
    const reference = referenceOf(row.id);
    const filename = `young-edsplorer-registration-${reference}.pdf`;
    if (storage.configured) {
      const { status } = await storage.statusOf(row.id);
      if (status !== "stored") throw pdfNotReadyError(status);
      return { filename, pdf: await storage.fetchStored(row.id) };
    }
    let model;
    try {
      ({ model } = await buildPdfModel(row, trip));
    } catch (err) {
      logger.error(`[pdf] could not prepare registration ${reference}: ${err?.message ?? err}`);
      throw pdfFailedError();
    }
    return { filename, pdf: await cachedPdf(model, reference) };
  }

  /** Where the owner's PDF stands: { status: "stored" | "pending" | "failed" | "not_configured" }. */
  async function pdfStatus(auth, { enrolmentId } = {}) {
    const { row } = await ownSubmittedForm(auth, enrolmentId);
    return pdfStatusFor(row.id);
  }

  /** The owner's "try again": starts a new storing attempt in the background (rate limited), without any new submission. */
  async function retryPdf(auth, { enrolmentId } = {}) {
    const { row } = await ownSubmittedForm(auth, enrolmentId);
    return storage.retry(row.id);
  }

  /** The same model (same record, trip, school and logo) gives the same document: rendered once, shared meanwhile. */
  async function cachedPdf(model, reference) {
    const logoHash = model.schoolLogo ? createHash("sha256").update(model.schoolLogo.data).digest("hex") : null;
    const key = createHash("sha256").update(JSON.stringify({ ...model, schoolLogo: logoHash })).digest("hex");
    const now = Date.now();
    for (const [k, v] of pdfCache) if (now - v.at > PDF_CACHE_MS) pdfCache.delete(k);
    const hit = pdfCache.get(key);
    if (hit) return hit.pdf;

    const ticket = pdfGate.reserve();
    if (!ticket) throw serverBusyError(pdfGate.retryAfterSeconds());
    const pdf = ticket
      .run(() => renderPdf(model))
      .catch((err) => {
        pdfCache.delete(key);
        // The message only (never the answers); the submission is untouched and the parent can simply try again.
        logger.error(`[pdf] could not render registration ${reference}: ${err?.message ?? err}`);
        throw pdfFailedError();
      })
      .finally(() => ticket.release());
    pdfCache.set(key, { at: now, pdf });
    while (pdfCache.size > PDF_CACHE_SIZE) pdfCache.delete(pdfCache.keys().next().value);
    return pdf;
  }

  return {
    getState,
    saveDraft,
    submit,
    discardDraft,
    submittedPdf,
    pdfStatus,
    retryPdf,
    // For the server's background timer and for tests.
    sweepPdfStorage: (opts) => storage.sweep(opts),
    drainPdfStorage: () => storage.drain(),
    pdfStorageInfo: () => ({ mode: pdfStorageNote.mode, configured: storage.configured, missing: pdfStorageNote.missing, ...(storage.configured ? { destination: storage.destination } : {}) }),
  };
}
