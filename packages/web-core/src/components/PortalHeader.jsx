import SchoolLogo from "./SchoolLogo.jsx";

/**
 * The parent-facing header: [Young Edsplorer] × [school logo]. The × is a quiet typographic separator (hidden from
 * screen readers, which hear "Young Edsplorer in partnership with <school>" instead). Both slots share one height, so a
 * square crest and a wide wordmark sit in balance; nothing is stretched. With no school (e.g. a page that isn't about a
 * school), only the Young Edsplorer logo is shown.
 */
export default function PortalHeader({ schoolName = "", schoolLogo = null, children = null }) {
  const withSchool = Boolean(schoolName);
  return (
    <header className="portal-header">
      <div
        className="portal-brands"
        role={withSchool ? "group" : undefined}
        aria-label={withSchool ? `Young Edsplorer in partnership with ${schoolName}` : undefined}
      >
        <img src="/company_logo.png" alt="Young Edsplorer" className="portal-logo" />
        {withSchool && (
          <>
            <span className="portal-cross" aria-hidden="true">×</span>
            <SchoolLogo name={schoolName} src={schoolLogo} />
          </>
        )}
      </div>
      {children && <div className="portal-header-actions">{children}</div>}
    </header>
  );
}
