import { useState } from "react";
import { Download } from "lucide-react";

/**
 * Inline preview for a trip document. PDF → scrollable iframe (browser native viewer).
 * Image → constrained img with correct aspect ratio. showDownload=false omits the
 * download link (the Sales portal has its own download button in the doc action row).
 */
export default function DocPreview({ url, mimeType, displayName, showDownload = true }) {
  const [imgError, setImgError] = useState(false);
  const isPdf = mimeType === "application/pdf";
  const isImage = mimeType?.startsWith("image/");
  return (
    <div className="doc-preview-wrap">
      {isPdf && (
        <>
          <iframe
            src={url}
            title={displayName}
            className="doc-preview-frame"
            aria-label={`Preview of ${displayName}`}
          />
          <p className="doc-preview-fallback">
            Preview not loading?{" "}
            <a href={url} target="_blank" rel="noopener noreferrer">Open in new tab</a>.
          </p>
        </>
      )}
      {isImage && !imgError && (
        <div className="doc-preview-img-wrap">
          <img
            src={url}
            alt={displayName}
            className="doc-preview-img"
            onError={() => setImgError(true)}
          />
        </div>
      )}
      {isImage && imgError && (
        <p className="doc-preview-fallback">Image could not be loaded.</p>
      )}
      {showDownload && (
        <a
          href={url}
          className="trip-doc-link"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Download ${displayName}`}
        >
          <Download size={15} aria-hidden="true" />
          <span>{displayName}</span>
        </a>
      )}
    </div>
  );
}
