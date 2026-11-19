import { CheckCircle2 } from "lucide-react";
import { displayValue } from "../../onboarding/formEngine.js";
import { TOUR_HEADINGS, layoutFields } from "../../onboarding/greetings.js";
import PdfDownload from "./PdfDownload.jsx";

const longDate = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/**
 * The submitted registration, exactly as the server saved it (read back after submitting; never from the form on the
 * screen). Read-only by policy: nothing here can be edited, and it shows only what the form actually collected, plus the
 * parent's own account details, the trip, the signature and the PDF download at the very end.
 */
export default function PersonalDetailsSection({ headingRef, form, definition, trip, declaration, account, pdf, enrolmentId, pdfPollMs, pdfMaxPolls }) {
  const ack = form.acknowledgement;
  return (
    <div className="dashboard-section">
      <h1 id="dashboard-title" className="dashboard-title" ref={headingRef} tabIndex={-1}>Personal Details</h1>

      <section className="confirmation-hero" aria-labelledby="dashboard-submitted">
        <CheckCircle2 className="confirmation-icon" size={30} aria-hidden="true" />
        <div>
          <h2 id="dashboard-submitted" className="confirmation-title">Registration submitted</h2>
          <p className="confirmation-lead">
            Thank you. Your registration was received{form.submittedAt ? ` on ${longDate(form.submittedAt)}` : ""}. It can no longer be edited
            here; if anything needs to change, please contact the school or Young Edsplorer.
          </p>
        </div>
      </section>

      <section className="confirmation-card" aria-labelledby="dashboard-trip">
        <h2 id="dashboard-trip">Trip details</h2>
        <dl className="detail-grid">
          {trip ? (
            <>
              <div><dt>School</dt><dd>{trip.school}{trip.branch ? ` · ${trip.branch}` : ""}</dd></div>
              <div><dt>Trip</dt><dd>{trip.title}</dd></div>
              {trip.destination && <div><dt>Destination</dt><dd>{trip.destination}</dd></div>}
              <div><dt>Trip type</dt><dd>{TOUR_HEADINGS[trip.tourType] ?? trip.tourType}</dd></div>
              {trip.academicYear && <div><dt>Academic year</dt><dd>{trip.academicYear}</dd></div>}
            </>
          ) : (
            <div><dt>Trip type</dt><dd>{TOUR_HEADINGS[form.tourType] ?? definition.title}</dd></div>
          )}
          <div><dt>Status</dt><dd><span className="status-pill success">Submitted</span></dd></div>
          {form.reference && <div><dt>Reference</dt><dd>{form.reference}</dd></div>}
          {form.submittedAt && <div><dt>Submitted on</dt><dd>{longDate(form.submittedAt)}</dd></div>}
        </dl>
      </section>

      {account && (
        <section className="confirmation-card" aria-labelledby="dashboard-account">
          <h2 id="dashboard-account">Registered by</h2>
          <dl className="detail-grid">
            <div><dt>Name</dt><dd>{account.name}</dd></div>
            <div><dt>Role</dt><dd>{account.role}</dd></div>
            <div><dt>Email address</dt><dd>{account.email}</dd></div>
            <div><dt>Phone number</dt><dd>{account.phone}</dd></div>
          </dl>
        </section>
      )}

      <section className="confirmation-card" aria-labelledby="dashboard-answers">
        <h2 id="dashboard-answers">Your submitted answers</h2>
        <div className="review-sections">
          {definition.sections.map((section) => (
            <div key={section.id} className="review-section">
              <h3>{section.title}</h3>
              <dl className="summary-list" aria-label={`${section.title} answers`}>
                {layoutFields(section).map((f) => (
                  <div className="summary-row" key={f.key}>
                    <dt>{f.label}</dt>
                    <dd>{displayValue(f, form.data)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>

      <section className="confirmation-card" aria-labelledby="dashboard-ack">
        <h2 id="dashboard-ack">Declaration and signature</h2>
        {ack ? (
          <>
            <dl className="detail-grid">
              <div><dt>Digital Signature</dt><dd className="signature-value confirmation-signature">{ack.signatureName}</dd></div>
              <div><dt>Declaration accepted</dt><dd>{ack.acceptedAt ? longDate(ack.acceptedAt) : "Yes"}</dd></div>
            </dl>
            {declaration && declaration.version === ack.declarationVersion ? (
              <blockquote className="confirmation-declaration">{declaration.text}</blockquote>
            ) : (
              <p className="muted">Declaration version {ack.declarationVersion}.</p>
            )}
          </>
        ) : (
          <p className="muted">This registration was submitted before the declaration and signature were introduced.</p>
        )}
      </section>

      <PdfDownload enrolmentId={enrolmentId} initialStatus={pdf?.status ?? "pending"} pollMs={pdfPollMs} maxPolls={pdfMaxPolls} />
    </div>
  );
}
