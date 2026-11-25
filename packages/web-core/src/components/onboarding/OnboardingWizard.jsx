import { AlertCircle, ArrowLeft, ArrowRight, Check, CircleDot, LoaderCircle, PenLine } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fieldErrorsFrom, onboardingErrorMessage, submitOnboarding } from "../../api/onboardingApi.js";
import {
  answerFields,
  computeProgress,
  deriveValue,
  displayValue,
  validateForm,
} from "../../onboarding/formEngine.js";
import { greetingFor, layoutFields } from "../../onboarding/greetings.js";
import { guidanceFor } from "../../onboarding/guidance.js";
import { SIGNATURE_MAX, signatureDate, signatureProblem } from "../../onboarding/signature.js";
import { useAutosave } from "../../onboarding/useAutosave.js";
import FieldControl from "./FieldControl.jsx";

const REVIEW = "review";
const STATUS_TEXT = { complete: "complete", attention: "needs attention", incomplete: "not complete" };
const SAVE_TEXT = {
  idle: "Your answers are saved automatically.",
  saving: "Saving…",
  saved: "All changes saved",
  error: "We couldn't save your latest changes.",
  conflict: "Changes are not being saved.",
};

/** Only answers go to the server: known keys, empty ones dropped. */
const toPayload = (def, answers) =>
  Object.fromEntries(answerFields(def).map((f) => [f.key, answers[f.key] ?? ""]).filter(([, v]) => v !== ""));

function StepIcon({ status, current }) {
  if (status === "complete") return <Check size={14} aria-hidden="true" />;
  if (status === "attention") return <AlertCircle size={14} aria-hidden="true" />;
  return current ? <CircleDot size={14} aria-hidden="true" /> : <span className="step-dot" aria-hidden="true" />;
}

/**
 * The form itself: progress bar, section navigation, fields, review and submit.
 * `form` is the draft as the server last stored it. Every change is autosaved to the
 * server (debounced); success after Submit is shown only once the server confirms it.
 */
export default function OnboardingWizard({
  definition: def,
  form,
  autosaveDelayMs,
  flushRef,
  onSubmitted,
  onReload,
  onUnauthenticated,
  enrolmentId = null, // which of the parent's registrations this form belongs to (checked by the server)
  destination = "", // the trip's destination, from the server (empty when there is none)
  declaration = null, // { version, text } from the server: what the parent accepts on submission
}) {
  const sectionIds = def.sections.map((s) => s.id);
  const [answers, setAnswers] = useState(form.data);
  const [section, setSection] = useState(sectionIds.includes(form.currentSection) || form.currentSection === REVIEW ? form.currentSection : sectionIds[0]);
  const [touched, setTouched] = useState({});
  const [blocked, setBlocked] = useState(null); // { section, count, first } after a refused Next
  const [serverErrors, setServerErrors] = useState({});
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [conflict, setConflict] = useState(false);
  // The declaration and signature live only in this page until the final submission: a draft never carries them,
  // so an unsubmitted draft is never an acknowledgement. Never pre-filled.
  const [declared, setDeclared] = useState(false);
  const [signature, setSignature] = useState("");
  const submitGuard = useRef(false);
  const headingRef = useRef(null);
  const firstRender = useRef(true);

  const autosave = useAutosave({
    initialVersion: form.version,
    delayMs: autosaveDelayMs,
    onConflict: () => setConflict(true),
    onFormSubmitted: () => onReload(),
    onUnauthenticated,
  });
  useEffect(() => {
    if (flushRef) flushRef.current = autosave.flush;
  });

  const progress = useMemo(() => computeProgress(def, answers), [def, answers]);
  const clientErrors = useMemo(() => validateForm(def, answers), [def, answers]);
  const stepById = Object.fromEntries(progress.sections.map((s) => [s.id, s]));
  const steps = [...def.sections, { id: REVIEW, title: "Review & submit" }];
  const index = steps.findIndex((s) => s.id === section);
  const current = steps[index];

  // Move focus to the new section's heading so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [section]);

  useEffect(() => {
    if (blocked) document.getElementById(`onb-${blocked.first}`)?.focus();
  }, [blocked]);

  const queue = (nextAnswers, nextSection) =>
    autosave.queue({ tourType: def.tourType, data: toPayload(def, nextAnswers), currentSection: nextSection, ...(enrolmentId ? { enrolmentId } : {}) });

  const change = (key, value) => {
    // The age is not an answer: the server works it out from the date of birth on every save.
    const next = { ...answers, [key]: value };
    setAnswers(next);
    setServerErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    queue(next, section);
  };
  const blur = (key) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  const errorFor = (key) => (touched[key] || attempted ? serverErrors[key] ?? clientErrors[key] ?? "" : serverErrors[key] ?? "");

  const goTo = (id) => {
    if (id === section) return;
    setBlocked(null);
    setSection(id);
    queue(answers, id);
    autosave.flush(); // persist the new position right away
  };

  // Going forward needs every section before the target to be complete and valid (Back and Edit are never blocked).
  // The first section that is not is shown with its field errors, and the parent stays there. The server checks the whole
  // form again on submit, so this is the helpful half of the rule, not the only one.
  const tryGoTo = (id) => {
    const target = steps.findIndex((s) => s.id === id);
    if (target <= index) return goTo(id);
    for (let i = 0; i < target; i += 1) {
      const sec = def.sections[i];
      const bad = sec.fields.filter((f) => f.type !== "derived" && (clientErrors[f.key] || serverErrors[f.key]));
      if (bad.length === 0) continue;
      setTouched((t) => ({ ...t, ...Object.fromEntries(bad.map((f) => [f.key, true])) }));
      setBlocked({ section: sec.id, count: bad.length, first: bad[0].key });
      if (sec.id !== section) {
        setSection(sec.id);
        queue(answers, sec.id);
        autosave.flush();
      }
      return undefined;
    }
    return goTo(id);
  };

  const submit = async () => {
    if (submitGuard.current) return;
    setAttempted(true);
    setSubmitError("");
    const problems = Object.keys(clientErrors).length;
    if (problems > 0) {
      setSubmitError(`${problems} ${problems === 1 ? "answer needs" : "answers need"} attention before you can submit. Use the Edit buttons to fix them.`);
      return;
    }
    if (!declaration || !declared || signatureProblem(signature)) {
      setSubmitError(!declaration ? "Please reload the page before submitting." : "Please confirm the declaration and type your full name to sign before submitting.");
      return;
    }
    submitGuard.current = true;
    setSubmitting(true);
    try {
      if (!(await autosave.flush())) {
        setSubmitError("We couldn't save your latest changes, so the form was not submitted. Please try again.");
        return;
      }
      const submitted = await submitOnboarding(autosave.version(), {
        enrolmentId: enrolmentId ?? undefined,
        declarationVersion: declaration.version,
        signatureName: signature.normalize("NFC").trim(),
      });
      onSubmitted(submitted); // only now: the server has committed the submission
    } catch (err) {
      if (err?.code === "FORM_INCOMPLETE") {
        setServerErrors(fieldErrorsFrom(err));
        setSubmitError(onboardingErrorMessage(err));
      } else if (err?.code === "ALREADY_SUBMITTED" || err?.code === "FORM_SUBMITTED") {
        onReload();
      } else if (err?.code === "VERSION_CONFLICT") {
        setConflict(true);
      } else if (err?.code === "UNAUTHENTICATED") {
        onUnauthenticated();
      } else if (err?.code === "VALIDATION_ERROR") {
        setSubmitError(fieldErrorsFrom(err).signatureName ?? fieldErrorsFrom(err).declarationVersion ?? "Please check the declaration and your signature, then try again.");
      } else {
        setSubmitError(onboardingErrorMessage(err));
      }
    } finally {
      submitGuard.current = false;
      setSubmitting(false);
    }
  };

  const greeting = greetingFor(destination);
  const declarationError = attempted && !declared ? "Please confirm the declaration to submit." : "";
  const signatureError = attempted ? signatureProblem(signature) : "";
  const showConflict = conflict || autosave.status === "conflict";
  const sectionBad = (sec) => sec.fields.filter((f) => f.type !== "derived" && (clientErrors[f.key] || serverErrors[f.key]));
  const sectionHasError = (s) => s.fields.some((f) => f.type !== "derived" && (clientErrors[f.key] || serverErrors[f.key]));

  return (
    <div className="onboarding">
      <section className="greeting" aria-label="Welcome message">
        <p className="greeting-salutation">{greeting.salutation}</p>
        {greeting.paragraphs.map((text) => <p key={text}>{text}</p>)}
        <p className="greeting-signoff">
          {greeting.signoff[0]}
          <br />
          {greeting.signoff[1]}
        </p>
      </section>

      <div className="progress">
        <div
          className="progress-track"
          role="progressbar"
          aria-label="Form completion"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress.percent}
          aria-valuetext={`${progress.percent}% complete`}
        >
          <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
        </div>
        <span className="progress-value" aria-hidden="true">{progress.percent}%</span>
      </div>
      <p className="progress-caption">
        {progress.requiredDone} of {progress.requiredTotal} required answers complete
      </p>

      {showConflict && (
        <div className="status-message error" role="alert">
          <span>{onboardingErrorMessage({ code: "VERSION_CONFLICT" })}</span>
          <button type="button" className="text-button" onClick={onReload}>Reload latest</button>
        </div>
      )}

      <div className="onboarding-body">
        <nav className="step-nav" aria-label="Form sections">
          <ol>
            {steps.map((s, i) => {
              const info = stepById[s.id];
              const status = s.id === REVIEW ? (progress.percent === 100 ? "complete" : "incomplete") : info.status;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`step-item ${status} ${s.id === section ? "current" : ""}`}
                    aria-current={s.id === section ? "step" : undefined}
                    onClick={() => tryGoTo(s.id)}
                  >
                    <span className="step-marker"><StepIcon status={status} current={s.id === section} /></span>
                    <span className="step-label">
                      <span className="step-number">Step {i + 1}</span> {s.title}
                      <span className="sr-only">, {STATUS_TEXT[status]}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <section className="step-panel" aria-labelledby="step-heading">
          <h2 id="step-heading" ref={headingRef} tabIndex={-1} className="step-heading">{current.title}</h2>

          {section !== REVIEW && blocked && blocked.section === section && sectionBad(current).length > 0 && (
            <div className="status-message error" role="alert">
              <span>
                {sectionBad(current).length} {sectionBad(current).length === 1 ? "answer needs" : "answers need"} attention before you can continue.
                Required fields are marked *.
              </span>
            </div>
          )}
          {section !== REVIEW ? (
            <div className="form-grid">
              {layoutFields(current).map((field) => (
                <FieldControl
                  key={field.key}
                  field={field}
                  value={answers[field.key]}
                  error={field.type === "derived" ? "" : errorFor(field.key)}
                  derived={field.type === "derived" ? deriveValue(field, answers) : undefined}
                  guidance={guidanceFor(def.tourType, field.key)}
                  onChange={change}
                  onBlur={blur}
                />
              ))}
            </div>
          ) : (
            <div className="review">
              <p className="review-lead">Check your answers. You can still edit anything until you submit.</p>
              {def.sections.map((s) => (
                <section key={s.id} className="review-section">
                  <div className="review-head">
                    <h3>{s.title}</h3>
                    <span className={`review-status ${sectionHasError(s) ? "attention" : stepById[s.id].status}`}>
                      {sectionHasError(s) ? "Needs attention" : stepById[s.id].status === "complete" ? "Complete" : "Not complete"}
                    </span>
                    <button type="button" className="text-button" aria-label={`Edit ${s.title}`} onClick={() => goTo(s.id)}>Edit</button>
                  </div>
                  <dl className="summary-list" aria-label={`${s.title} answers`}>
                    {layoutFields(s).map((f) => {
                      const message = f.type === "derived" ? "" : errorFor(f.key);
                      return (
                        <div className="summary-row" key={f.key}>
                          <dt>{f.label}</dt>
                          <dd>
                            {displayValue(f, answers)}
                            {message && <span className="summary-error">{message}</span>}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </section>
              ))}
              <section className="acknowledgement" aria-labelledby="declaration-heading">
                <h3 id="declaration-heading">Declaration</h3>
                <div className={`declaration ${declarationError ? "has-error" : ""}`}>
                  <input
                    id="declaration-check"
                    type="checkbox"
                    checked={declared}
                    onChange={(e) => setDeclared(e.target.checked)}
                    aria-required="true"
                    aria-invalid={declarationError ? "true" : undefined}
                    aria-describedby={declarationError ? "declaration-error" : undefined}
                    disabled={!declaration}
                  />
                  <label htmlFor="declaration-check">{declaration?.text ?? "The declaration could not be loaded. Please reload the page."}</label>
                </div>
                {declarationError && <p id="declaration-error" className="field-error">{declarationError}</p>}

                <div className="signature">
                  <h3 className="signature-heading"><PenLine size={17} aria-hidden="true" /> Digital Signature</h3>
                  <p className="signature-help" id="signature-help">Type your full legal name as your digital signature to confirm this submission.</p>
                  <label htmlFor="signature-name" className="field-label">
                    Full name (Digital Signature) <span className="required-mark" aria-hidden="true">*</span>
                  </label>
                  <div className={`input-wrap ${signatureError ? "has-error" : ""}`}>
                    <input
                      id="signature-name"
                      type="text"
                      value={signature}
                      maxLength={SIGNATURE_MAX + 20}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setSignature(e.target.value)}
                      aria-required="true"
                      aria-invalid={signatureError ? "true" : undefined}
                      aria-describedby={["signature-help", signatureError && "signature-error"].filter(Boolean).join(" ")}
                    />
                  </div>
                  {signatureError && <p id="signature-error" className="field-error">{signatureError}</p>}
                  <div className="signature-preview" aria-hidden="true">
                    <span className="signature-value">{signature.trim() || "\u00a0"}</span>
                    <span className="signature-line" />
                  </div>
                  <p className="signature-date">Date: <strong>{signatureDate()}</strong></p>
                  <p className="signature-note">
                    Typing your name and accepting the declaration records your electronic acknowledgement of this form. The time is recorded
                    by Young Edsplorer's system when you submit.
                  </p>
                </div>
              </section>

              {submitError && (
                <div className="status-message error" role="alert">
                  <span>{submitError}</span>
                </div>
              )}
              <button className="primary-button submit-button" type="button" onClick={submit} disabled={submitting}>
                {submitting ? (<><LoaderCircle size={18} className="spin" /> Submitting…</>) : "Submit registration"}
              </button>
            </div>
          )}

          <div className="step-actions">
            <button type="button" className="step-button" onClick={() => goTo(steps[index - 1].id)} disabled={index === 0} aria-label="Previous section">
              <ArrowLeft size={18} />
              <span>Back</span>
            </button>
            {section !== REVIEW && (
              <button type="button" className="step-button primary" onClick={() => tryGoTo(steps[index + 1].id)} aria-label="Next section" disabled={sectionBad(current).length > 0}>
                <span>{index === steps.length - 2 ? "Review" : "Next"}</span>
                <ArrowRight size={18} />
              </button>
            )}
          </div>
        </section>
      </div>

      <div className="onboarding-footer">
        <p className={`save-status ${autosave.status}`} role="status" aria-live="polite">
          {SAVE_TEXT[autosave.status]}
          {autosave.status === "error" && (
            <button type="button" className="text-button" onClick={() => autosave.retry()}>Retry</button>
          )}
        </p>
      </div>
    </div>
  );
}
