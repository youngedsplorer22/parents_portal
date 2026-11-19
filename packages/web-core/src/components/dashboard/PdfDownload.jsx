import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPdfStatus, fetchRegistrationPdf, pdfErrorMessage, retryPdfStorage, saveFile } from "../../api/onboardingApi.js";

const DOUBLE_CLICK_MS = 800;

/**
 * The parent's own copy of the submitted registration. NOTHING downloads by itself: not after submitting, not on a
 * refresh, not when this page opens. The file is saved only when the button is pressed, as often as they like.
 *
 * The PDF the server hands over is its stored copy. While that copy is still being saved the button is off and the page
 * says so, checking now and then; if saving failed it says that and offers "Try again" (no form is sent again).
 *   stored / not_configured  -> the button works     pending -> "saving", checked every few seconds
 *   failed                   -> "Try again"
 */
export default function PdfDownload({ enrolmentId, initialStatus, pollMs = 3000, maxPolls = 40 }) {
  const [status, setStatus] = useState(initialStatus);
  const [polls, setPolls] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  const lastStart = useRef(0);

  // While "pending": ask the server again every few seconds, up to a limit, then stop and offer "Check again".
  useEffect(() => {
    if (status !== "pending" || polls >= maxPolls) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const next = await fetchPdfStatus(enrolmentId, { signal: controller.signal });
        if (next.status === "pending") setPolls((n) => n + 1);
        else setStatus(next.status);
      } catch (err) {
        if (err?.name !== "AbortError") setPolls((n) => n + 1);
      }
    }, pollMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [status, polls, maxPolls, pollMs, enrolmentId]);

  const follow = (next) => {
    setStatus(next);
    setPolls(0);
  };

  const download = useCallback(async () => {
    // One at a time, and a second click within a moment of the first (a double click) does nothing.
    if (working.current || Date.now() - lastStart.current < DOUBLE_CLICK_MS) return;
    lastStart.current = Date.now();
    working.current = true;
    setBusy(true);
    setError("");
    setDone(false);
    try {
      const { blob, filename } = await fetchRegistrationPdf(enrolmentId);
      saveFile(blob, filename);
      setDone(true);
    } catch (err) {
      if (err?.code === "PDF_NOT_READY") follow(err.details?.status === "failed" ? "failed" : "pending"); // the server's word wins
      else setError(pdfErrorMessage(err));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }, [enrolmentId]);

  async function retry() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      follow((await retryPdfStorage(enrolmentId)).status);
    } catch (err) {
      setError(err?.code === "RATE_LIMITED" ? "Please wait a few seconds before trying again." : pdfErrorMessage(err));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function checkAgain() {
    try {
      follow((await fetchPdfStatus(enrolmentId)).status);
    } catch (err) {
      setError(pdfErrorMessage(err));
    }
  }

  const ready = status === "stored" || status === "not_configured";
  const giveUp = status === "pending" && polls >= maxPolls;
  return (
    <section className="confirmation-card pdf-card" aria-labelledby="dashboard-download">
      <h2 id="dashboard-download">Download your registration</h2>
      <p className="muted">A PDF copy of everything you submitted, to keep for your records. It downloads only when you press the button.</p>
      <button type="button" className="primary-button pdf-button" onClick={download} disabled={!ready || busy}>
        {busy && ready ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
        {busy && ready ? "Preparing PDF…" : "Download PDF"}
      </button>
      {status === "pending" && !giveUp && (
        <p className="pdf-status" role="status">
          <LoaderCircle size={14} className="spin" aria-hidden="true" /> We're saving your PDF. This usually takes a few seconds.
        </p>
      )}
      {giveUp && (
        <p className="pdf-status" role="status">
          This is taking longer than usual.{" "}
          <button type="button" className="text-button" onClick={checkAgain}><RefreshCw size={13} aria-hidden="true" /> Check again</button>
        </p>
      )}
      {status === "failed" && (
        <div className="status-message error" role="alert">
          <span>We couldn't save your PDF yet. Your registration is submitted and safe.</span>
          <button type="button" className="text-button" onClick={retry} disabled={busy}>Try again</button>
        </div>
      )}
      {done && <p className="pdf-status" role="status">Your registration PDF has been downloaded.</p>}
      {error && (
        <div className="status-message error" role="alert">
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}
