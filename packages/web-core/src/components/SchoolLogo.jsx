import { useState } from "react";

/**
 * A school's logo in a fixed slot. Today the logo comes from the server's own logo address (and, later, from the ERP);
 * until there is one, or if it fails to load, the slot shows a neutral empty placeholder: never a broken image, never a
 * made-up logo. The image keeps its aspect ratio inside the slot (see .school-logo in index.css).
 */
export default function SchoolLogo({ name = "", src = null, className = "" }) {
  const [failed, setFailed] = useState(null); // the address that failed, so a new address is tried again
  const label = name ? `${name} logo` : "School logo";
  if (!src || failed === src) {
    return (
      <span className={`school-logo is-empty ${className}`.trim()} role="img" aria-label={`${label} (not available yet)`}>
        <span aria-hidden="true">School logo</span>
      </span>
    );
  }
  return (
    <span className={`school-logo ${className}`.trim()}>
      <img src={src} alt={label} onError={() => setFailed(src)} />
    </span>
  );
}
