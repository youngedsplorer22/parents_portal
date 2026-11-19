import { Eye, EyeOff } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

/**
 * A password field with its own show/hide button. Masked by default. The button is a real button (type="button", so it
 * never submits the form), named "Show password" / "Hide password" (or "... confirm password" via `toggleLabel`), with
 * aria-pressed and aria-controls. Toggling changes only the input's type: the value, autocomplete hint and the caret
 * position stay as they were, and focus stays on the button. Nothing about the value is logged or stored here.
 * Every other prop goes to the <input> unchanged.
 */
export default function PasswordInput({ id, toggleLabel = "password", ...inputProps }) {
  const [shown, setShown] = useState(false);
  const inputRef = useRef(null);
  const caret = useRef(null);

  const toggle = () => {
    const el = inputRef.current;
    // Remember the caret: changing an input's type can reset it in some browsers.
    caret.current = el && el.selectionStart !== null ? [el.selectionStart, el.selectionEnd] : null;
    setShown((s) => !s);
  };
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && caret.current) {
      try {
        el.setSelectionRange(caret.current[0], caret.current[1]);
      } catch {
        /* type without selection support */
      }
      caret.current = null;
    }
  }, [shown]);

  return (
    <>
      <input {...inputProps} id={id} ref={inputRef} type={shown ? "text" : "password"} />
      <button
        type="button"
        className="password-toggle"
        onClick={toggle}
        aria-label={`${shown ? "Hide" : "Show"} ${toggleLabel}`}
        aria-pressed={shown}
        aria-controls={id}
      >
        {shown ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
      </button>
    </>
  );
}
