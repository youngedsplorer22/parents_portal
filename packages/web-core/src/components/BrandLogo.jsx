export default function BrandLogo({ label = "Young Edsplorer Parent Portal" }) {
  return (
    <div className="brand" aria-label={label}>
      <div className="brand">
        <img
            src="/company_logo.png"
            alt="Young Edsplorer"
            className="brand-logo"
        />  
      </div>
    </div>
  );
}
