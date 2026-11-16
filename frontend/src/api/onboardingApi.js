// Client for /api/onboarding (draft, autosave, final submit). The server decides who
// the user is from the session cookie; no user id or email is ever sent from here.
// Answers contain personal data, so nothing here logs them or writes them to browser storage.
import { ApiError, apiFetch, getJson, putJson, postJson } from "./http.js";

const BASE = "/api/onboarding";

const isForm = (f) => f && typeof f === "object" && typeof f.version === "number" && typeof f.data === "object" && f.data !== null;

const TOURS = ["domestic", "international"];
/** Only the server's own logo address is ever used as an image source. */
export const safeLogo = (v) => (typeof v === "string" && /^\/api\/school-logos\/[a-z0-9-]+\/[a-z0-9-]+\?v=\d+$/.test(v) ? v : null);
const asTrip = (t) =>
  t && typeof t.school === "string" && typeof t.title === "string" && TOURS.includes(t.tourType)
    ? {
        school: t.school,
        branch: typeof t.branch === "string" ? t.branch : "",
        schoolLogo: safeLogo(t.schoolLogo),
        title: t.title,
        destination: typeof t.destination === "string" ? t.destination : "",
        academicYear: typeof t.academicYear === "string" ? t.academicYear : "",
        tourType: t.tourType,
        // what the server says about payment, from its records only; anything unexpected reads as "not set up"
        payment: t.payment?.required === true ? { required: true, status: t.payment.status === "not_configured" ? "not_configured" : "unknown" } : { required: false, status: "not_required" },
      }
    : null;

const PDF_STATUSES = ["stored", "pending", "failed", "not_configured"];
/** Where the PDF stands, from the server. Anything unexpected reads as "pending" (never as stored). */
const asPdf = (p) => ({ status: PDF_STATUSES.includes(p?.status) ? p.status : "pending" });
/** The signed-in parent's own details (shown on the dashboard, only once submitted). */
const asAccount = (a) =>
  a && typeof a === "object"
    ? { name: String(a.name ?? ""), role: String(a.role ?? ""), email: String(a.email ?? ""), phone: String(a.phone ?? "") }
    : null;

/**
 * -> { role, definitions, form, trip, enrolmentId, account, pdf }. `enrolmentId` picks one of the parent's own registrations
 * (or "legacy" for a form from before trips); without it the server uses the newest one. The server checks that
 * the registration belongs to the signed-in parent.
 */
export async function loadOnboarding({ signal, enrolmentId } = {}) {
  const data = await getJson(enrolmentId ? `${BASE}?enrolment=${encodeURIComponent(enrolmentId)}` : BASE, signal);
  if (!data.definitions?.domestic?.sections || !data.definitions?.international?.sections) throw new ApiError("SERVER_ERROR");
  if (data.form !== null && !isForm(data.form)) throw new ApiError("SERVER_ERROR");
  const declaration =
    typeof data.declaration?.version === "string" && typeof data.declaration?.text === "string" ? { version: data.declaration.version, text: data.declaration.text } : null;
  const submitted = data.form?.status === "submitted";
  return {
    role: data.role,
    definitions: data.definitions,
    form: data.form,
    trip: asTrip(data.trip),
    declaration,
    enrolmentId: typeof data.enrolmentId === "string" ? data.enrolmentId : null,
    account: submitted ? asAccount(data.account) : null,
    pdf: submitted ? asPdf(data.pdf) : null,
  };
}

/** Creates (version null) or updates the draft. Resolves to the saved form, with its new version. */
export async function saveDraft({ tourType, data, currentSection, version, enrolmentId }, { signal } = {}) {
  const res = await putJson(BASE, { tourType, data, currentSection, version, ...(enrolmentId ? { enrolmentId } : {}) }, signal);
  if (!isForm(res.form) || res.form.status !== "draft") throw new ApiError("SERVER_ERROR");
  return res.form;
}

/**
 * Final submission, with the accepted declaration (its version) and the typed signature. The time of acceptance is
 * set by the server; none is sent from here. Resolves only if the server confirms the form is now submitted.
 */
export async function submitOnboarding(version, { signal, enrolmentId, declarationVersion, signatureName } = {}) {
  const body = { version, declarationAccepted: true, declarationVersion, signatureName, ...(enrolmentId ? { enrolmentId } : {}) };
  const res = await postJson(`${BASE}/submit`, body, signal);
  if (!isForm(res.form) || res.form.status !== "submitted" || !res.form.submittedAt) throw new ApiError("SERVER_ERROR");
  return res.form;
}

/** { fullName: "Full name is required." } from a FORM_INCOMPLETE / VALIDATION_ERROR response. */
export function fieldErrorsFrom(err) {
  const out = {};
  for (const { path, message } of Array.isArray(err?.details?.fields) ? err.details.fields : []) {
    const key = String(path).replace(/^data\./, "");
    if (typeof message === "string" && !out[key]) out[key] = message;
  }
  return out;
}

export function onboardingErrorMessage(err) {
  switch (err?.code) {
    case "FORM_INCOMPLETE":
      return "Some required answers are missing or invalid. Please check the highlighted sections.";
    case "VERSION_CONFLICT":
      return "This form was changed in another tab or device. Reload to see the latest version.";
    case "FORM_SUBMITTED":
    case "ALREADY_SUBMITTED":
      return "This form has already been submitted.";
    case "REGISTRATION_NOT_FOUND":
      return "That registration wasn't found in your account.";
    case "TOUR_FIXED_BY_TRIP":
      return "Your school's trip decides which form you fill in. Please reload the page.";
    case "NETWORK_ERROR":
      return "Can't reach the server. Your latest changes are not saved yet.";
    case "UNAUTHENTICATED":
      return "Your session has ended. Please log in again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

const PDF_NAME = /filename="(young-edsplorer-registration-YE-[0-9A-F]{8}\.pdf)"/;

/**
 * The submitted registration's PDF, made by the server from its saved record -> { blob, filename }. Only a real PDF
 * response is accepted (anything else, such as a proxy's error page, is an error). The server checks that the
 * registration belongs to the signed-in parent and is submitted.
 */
export async function fetchRegistrationPdf(enrolmentId, { signal } = {}) {
  let res;
  try {
    res = await apiFetch(enrolmentId ? `${BASE}/pdf?enrolment=${encodeURIComponent(enrolmentId)}` : `${BASE}/pdf`, {
      method: "GET",
      headers: { Accept: "application/pdf" },
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new ApiError("NETWORK_ERROR");
  }
  if (!res.ok) {
    let error = null;
    try {
      error = (await res.json())?.error;
    } catch {
      // not JSON
    }
    throw new ApiError(error?.code ?? "SERVER_ERROR", { status: res.status, details: error ?? {} });
  }
  if (!/^application\/pdf\b/i.test(res.headers.get("Content-Type") ?? "")) throw new ApiError("SERVER_ERROR", { status: res.status });
  const blob = await res.blob();
  if (blob.size === 0) throw new ApiError("SERVER_ERROR", { status: res.status });
  const filename = PDF_NAME.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "young-edsplorer-registration.pdf";
  return { blob, filename };
}

/** Where the PDF stands: { status: "stored" | "pending" | "failed" | "not_configured" }. */
export async function fetchPdfStatus(enrolmentId, { signal } = {}) {
  const data = await getJson(enrolmentId ? `${BASE}/pdf/status?enrolment=${encodeURIComponent(enrolmentId)}` : `${BASE}/pdf/status`, signal);
  return asPdf(data.pdf);
}

/** "Try again": asks the server to store the PDF again (in the background). No form is submitted. */
export async function retryPdfStorage(enrolmentId, { signal } = {}) {
  const data = await postJson(`${BASE}/pdf/retry`, enrolmentId ? { enrolmentId } : {}, signal);
  return asPdf(data.pdf);
}

/** Hands a file to the browser to save (a temporary link to the in-memory file; nothing is stored by the app). */
export function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** What went wrong with the PDF download. The submission itself is already saved, and every message says so. */
export function pdfErrorMessage(err) {
  const saved = "Your registration is submitted and saved.";
  switch (err?.code) {
    case "PDF_FAILED":
      return `We couldn't prepare the PDF just now. ${saved} Please try again.`;
    case "PDF_NOT_READY":
      return `Your PDF isn't ready yet. ${saved} It will be available in a moment.`;
    case "PDF_UNAVAILABLE":
      return `We couldn't get your PDF just now. ${saved} Please try again in a moment.`;
    case "RATE_LIMITED":
      return "Too many downloads in a short time. Please wait a moment and try again.";
    case "SERVER_BUSY":
      return `The server is busy right now. ${saved} Please try the download again in a few seconds.`;
    case "NETWORK_ERROR":
      return `Can't reach the server, so the PDF couldn't be downloaded. ${saved} Check your connection and try again.`;
    case "UNAUTHENTICATED":
      return "Your session has ended. Please log in again to download your PDF.";
    case "FORM_NOT_SUBMITTED":
      return "This registration hasn't been submitted yet, so there is no PDF.";
    default:
      return `We couldn't download the PDF. ${saved} Please try again.`;
  }
}
