/** A section that has no content yet: its heading and one sentence, nothing else. */
export default function PlaceholderSection({ section, headingRef }) {
  return (
    <section className="dashboard-section" aria-labelledby="dashboard-title">
      <h1 id="dashboard-title" className="dashboard-title" ref={headingRef} tabIndex={-1}>{section.label}</h1>
      <p className="dashboard-placeholder">{section.placeholder}</p>
    </section>
  );
}
