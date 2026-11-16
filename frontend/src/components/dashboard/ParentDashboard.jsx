import { Menu } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import LiveTrackingSection from "./LiveTrackingSection.jsx";
import PersonalDetailsSection from "./PersonalDetailsSection.jsx";
import PlaceholderSection from "./PlaceholderSection.jsx";
import { DASHBOARD_SECTIONS, sectionFromHash } from "./sections.js";

/**
 * The parent's page once the registration is submitted: a sidebar of sections and the chosen section beside it (on a
 * phone the sidebar is a drawer opened by the Menu button). The section is kept in the address (#insurance), so a
 * refresh, a bookmark and the browser's Back button all land where the parent was. The server's word is final on
 * everything shown here; nothing on this page changes the registration.
 */
export default function ParentDashboard({ data, pdfPollMs, pdfMaxPolls, onSessionEnded, liveRefreshMs }) {
  const [active, setActive] = useState(() => sectionFromHash(window.location.hash));
  const [open, setOpen] = useState(false);
  const headingRef = useRef(null);
  const menuRef = useRef(null);
  const activeLinkRef = useRef(null);
  const firstRender = useRef(true);

  // Follow the address (Back, Forward, a typed or pasted link).
  useEffect(() => {
    const onHash = () => setActive(sectionFromHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // A new section: focus its heading, so keyboard and screen-reader users start at the top of what changed.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [active]);

  const closeDrawer = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) menuRef.current?.focus();
  }, []);

  // Open drawer: focus the current section; Escape closes it and puts focus back on Menu.
  useEffect(() => {
    if (!open) return undefined;
    activeLinkRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") closeDrawer(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closeDrawer]);

  function choose(event, id) {
    event.preventDefault();
    setActive(id);
    if (window.location.hash !== `#${id}`) window.history.pushState(null, "", `#${id}`); // a Back entry; Back/Forward then fire hashchange
    setOpen(false);
  }

  const section = DASHBOARD_SECTIONS.find((s) => s.id === active) ?? DASHBOARD_SECTIONS[0];
  const { form, definitions, trip, declaration, account, pdf, enrolmentId } = data;

  return (
    <div className="dashboard">
      <div className="dashboard-bar">
        <button
          type="button"
          ref={menuRef}
          className="dashboard-menu-button"
          aria-expanded={open}
          aria-controls="dashboard-sidebar"
          onClick={() => setOpen((v) => !v)}
        >
          <Menu size={18} aria-hidden="true" /> Menu
        </button>
        <span className="dashboard-bar-title" aria-hidden="true">{section.label}</span>
      </div>
      <div className={`dashboard-backdrop ${open ? "is-open" : ""}`} onClick={() => closeDrawer()} aria-hidden="true" />
      <aside id="dashboard-sidebar" className={`dashboard-sidebar ${open ? "is-open" : ""}`}>
        <nav className="dashboard-nav" aria-label="Dashboard sections">
          <ul>
            {DASHBOARD_SECTIONS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  ref={id === active ? activeLinkRef : undefined}
                  aria-current={id === active ? "page" : undefined}
                  onClick={(e) => choose(e, id)}
                >
                  <Icon size={19} aria-hidden="true" />
                  <span>{label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="dashboard-main">
        {section.id === "personal-details" ? (
          <PersonalDetailsSection
            headingRef={headingRef}
            form={form}
            definition={definitions[form.tourType]}
            trip={trip}
            declaration={declaration}
            account={account}
            pdf={pdf}
            enrolmentId={enrolmentId}
            pdfPollMs={pdfPollMs}
            pdfMaxPolls={pdfMaxPolls}
          />
        ) : section.id === "live-tracking" && enrolmentId ? (
          <LiveTrackingSection section={section} headingRef={headingRef} enrolmentId={enrolmentId} onSessionEnded={onSessionEnded} refreshMs={liveRefreshMs} />
        ) : (
          <PlaceholderSection section={section} headingRef={headingRef} />
        )}
      </div>
    </div>
  );
}
