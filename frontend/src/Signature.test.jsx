import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { beforeAll, describe, expect, it } from "vitest";

// How the parent's signature looks on screen (the form's preview and the submitted registration): a simple, standard,
// BOLD font, never cursive, handwriting-style or italic, and styled apart from the "Digital Signature" label.
const css = readFileSync(resolve(cwd(), "src/index.css"), "utf8");

beforeAll(() => {
  // jsdom doesn't resolve custom properties: substitute the :root design tokens, as a browser would.
  const root = css.match(/:root\s*\{([^}]*)\}/)[1];
  const tokens = Object.fromEntries([...root.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const style = document.createElement("style");
  style.textContent = css.replace(/^@import[^\n]*\n/gm, "").replace(/var\((--[\w-]+)\)/g, (m, name) => tokens[name] ?? m);
  document.head.appendChild(style);
});

const SCRIPTY = /script|cursive|chancery|roundhand|brush|hand|comic|fantasy|italic/i;

describe("the signature's font", () => {
  for (const [where, html] of [
    ["the submitted registration (dashboard)", '<dl class="detail-grid"><div><dt>Digital Signature</dt><dd data-probe class="signature-value confirmation-signature">Meera Rao</dd></div></dl>'],
    ["the live preview under the signature field", '<div class="signature-preview"><span data-probe class="signature-value">Meera Rao</span></div>'],
  ]) {
    it(`${where}: bold, upright, a standard sans-serif family, and larger than its label`, () => {
      document.body.innerHTML = html;
      const el = document.querySelector("[data-probe]");
      const cs = getComputedStyle(el);
      expect(Number(cs.fontWeight)).toBeGreaterThanOrEqual(700);
      expect(cs.fontStyle).toBe("normal");
      expect(cs.fontFamily).not.toMatch(SCRIPTY);
      expect(cs.fontFamily).toMatch(/sans-serif/);
      expect(el.textContent).toBe("Meera Rao"); // shown exactly as entered
    });
  }

  it("on the dashboard it is larger than the other answers beside it (bold AND bigger, so it stands out clearly)", () => {
    document.body.innerHTML = '<dl class="detail-grid"><div><dt>Digital Signature</dt><dd data-probe class="signature-value confirmation-signature">Meera Rao</dd></div><div><dt>Declaration accepted</dt><dd data-other>26 October 2026</dd></div></dl>';
    const sig = getComputedStyle(document.querySelector("[data-probe]"));
    const other = getComputedStyle(document.querySelector("[data-other]"));
    expect(parseFloat(sig.fontSize)).toBeGreaterThan(parseFloat(other.fontSize));
    expect(Number(sig.fontWeight)).toBeGreaterThan(Number(other.fontWeight || 400));
  });

  it("no handwriting or cursive font is left anywhere in the stylesheet", () => {
    expect(css).not.toMatch(/font-family:[^;]*(cursive|Script|Chancery|Roundhand|Brush)/i);
    expect(css).not.toMatch(/\.signature-script\b/);
  });
});
