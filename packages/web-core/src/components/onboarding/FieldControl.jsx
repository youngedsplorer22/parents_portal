import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { nextPhoneValue } from "../../validation/phoneInput.js";

/**
 * One form field, rendered from its definition. Label, required marker, error and
 * hint are wired with htmlFor / aria-required / aria-invalid / aria-describedby so
 * screen readers and keyboard users get the same information as sighted users.
 */
export default function FieldControl({ field, value, error, derived, guidance, onChange, onBlur }) {
  const id = `onb-${field.key}`;
  const [showExample, setShowExample] = useState(false); // collapsed by default; the image is not loaded until opened
  // The guidance hint is hidden only while this field's example is open. Errors, focus, edits and
  // other fields never hide it; an error is shown in addition to it.
  const guidanceHint = guidance?.hint && !(guidance.example && showExample) ? guidance.hint : null;
  const hint = field.hint ?? guidanceHint;
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(" ") || undefined;
  const common = {
    id,
    value: value ?? "",
    // A phone field stops at 10 as you type, but a paste is never cut down (validation/phoneInput.js).
    onChange: (e) => onChange(field.key, field.rule === "phone" ? nextPhoneValue(value ?? "", e.target.value) : e.target.value),
    onBlur: () => onBlur(field.key),
    "aria-required": field.required ? "true" : undefined,
    "aria-invalid": error ? "true" : undefined,
    "aria-describedby": describedBy,
  };
  const wide = field.type === "textarea";

  let control;
  if (field.type === "derived") {
    control = (
      <div className="input-wrap derived">
        <output id={id} aria-describedby={`${id}-hint`}>{derived || "—"}</output>
      </div>
    );
  } else if (field.type === "select") {
    control = (
      <div className={`input-wrap select-wrap ${error ? "has-error" : ""}`}>
        <select {...common}>
          <option value="">Select</option>
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <ChevronDown size={18} className="select-icon" aria-hidden="true" />
      </div>
    );
  } else if (field.type === "textarea") {
    control = (
      <div className={`input-wrap textarea-wrap ${error ? "has-error" : ""}`}>
        <textarea {...common} rows={3} maxLength={field.max * 2} />
      </div>
    );
  } else {
    control = (
      <div className={`input-wrap ${error ? "has-error" : ""}`}>
        <input
          {...common}
          type={field.type === "date" ? "date" : field.type === "phone" ? "tel" : "text"}
          inputMode={field.type === "phone" ? "numeric" : field.inputMode}
          placeholder={field.placeholder}
          autoComplete={field.autocomplete ?? "off"}
          spellCheck={false}
          maxLength={field.type === "date" || field.rule === "phone" ? undefined : field.max * 2}
        />
      </div>
    );
  }

  return (
    <div className={`field ${wide ? "field-wide" : ""}`}>
      <label className="field-label" id={`${id}-label`} htmlFor={id}>
        {field.label}
        {field.required && <span className="required" aria-hidden="true">*</span>}
      </label>
      {control}
      {error && <p id={`${id}-error`} className="field-error">{error}</p>}
      {field.type === "derived" ? (
        <p id={`${id}-hint`} className="field-hint">Calculated automatically.</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="field-hint">{hint}</p>
      ) : null}
      {guidance?.example && (
        <div className="field-example">
          <button
            type="button"
            className="text-button example-toggle"
            aria-expanded={showExample}
            aria-controls={`${id}-example`}
            aria-describedby={`${id}-label`}
            onClick={() => setShowExample((v) => !v)}
          >
            {showExample ? "Hide example" : "See example"}
          </button>
          {showExample && (
            <figure id={`${id}-example`} className="example-figure">
              <img src={guidance.example.src} alt={guidance.example.alt} loading="lazy" decoding="async" />
            </figure>
          )}
        </div>
      )}
    </div>
  );
}
