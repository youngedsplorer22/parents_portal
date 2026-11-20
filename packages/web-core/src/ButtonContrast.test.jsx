import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cwd } from "node:process";
import { beforeAll, describe, expect, it } from "vitest";

// Renders each button style with the REAL stylesheet and measures the WCAG contrast of its label against its own
// background (or the white page behind a transparent button). jsdom resolves the cascade, so a rule that wins on
// specificity (like `.admin a`) shows up here exactly as it does in the browser.
const parse = (c) => {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a = "1"] = m[1].split(",").map((x) => x.trim());
  return { r: +r, g: +g, b: +b, a: +a };
};
const lum = ({ r, g, b }) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

function contrastOf(html, wrapper) {
  document.body.innerHTML = wrapper.replace("$", html);
  const el = document.body.querySelector("[data-probe]");
  const cs = getComputedStyle(el);
  const fg = parse(cs.color);
  let bg = parse(cs.backgroundColor);
  if (!bg || bg.a === 0) bg = WHITE;
  return { value: ratio(fg, bg), fg: cs.color, bg: cs.backgroundColor };
}

beforeAll(() => {
  let css = readFileSync(resolve(cwd(), "src/index.css"), "utf8").replace(/^@import[^\n]*\n/gm, "");
  // jsdom doesn't resolve custom properties: substitute the :root design tokens, as a browser would.
  const root = css.match(/:root\s*\{([^}]*)\}/)[1];
  const tokens = Object.fromEntries([...root.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  css = css.replace(/var\((--[\w-]+)\)/g, (m, name) => tokens[name] ?? m);
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
});

const STAFF = '<div class="admin"><main class="admin-main">$</main></div>';
const PARENT = '<main class="onboarding-screen"><div class="onboarding-shell">$</div></main>';

describe("button labels are readable everywhere (WCAG AA 4.5:1), as links and as buttons", () => {
  const cases = [
    ["Sales/Admin primary action as a LINK (Add a school, Create a trip, Registration link)", STAFF, '<a href="/x" data-probe class="admin-button admin-button-primary">Add a school</a>'],
    ["Sales/Admin primary action as a button", STAFF, '<button data-probe class="admin-button admin-button-primary">Save</button>'],
    ["Sales/Admin secondary action as a link", STAFF, '<a href="/x" data-probe class="admin-button">Back to the dashboard</a>'],
    ["Sales/Admin secondary action as a button", STAFF, '<button data-probe class="admin-button">Cancel</button>'],
    ["Sales/Admin danger action as a button", STAFF, '<button data-probe class="admin-button admin-button-danger">Remove</button>'],
    ["Sales/Admin danger action as a link", STAFF, '<a href="/x" data-probe class="admin-button admin-button-danger">Remove</a>'],
    ["an ordinary staff text link", STAFF, '<a href="/x" data-probe>Greenfield Public School</a>'],
    ["parent primary action as a link (Register or log in)", PARENT, '<a href="/x" data-probe class="primary-button">Register or log in</a>'],
    ["parent primary action as a button (Submit registration)", PARENT, '<button data-probe class="primary-button">Submit registration</button>'],
    ["parent secondary action as a link", PARENT, '<a href="/x" data-probe class="secondary-button">Resume</a>'],
    ["form Next button", PARENT, '<button data-probe class="step-button primary">Next</button>'],
    ["form Back button", PARENT, '<button data-probe class="step-button">Back</button>'],
    ["text button", PARENT, '<button data-probe class="text-button">Log out</button>'],
    ["the inactive Login / Register tab (found in a real browser at 3.95:1)", '<div class="auth-tabs">$</div>', '<button data-probe role="tab" class="auth-tab">Login</button>'],
    ["the active tab", '<div class="auth-tabs">$</div>', '<button data-probe role="tab" class="auth-tab active">Register</button>'],
    ["the empty school-logo placeholder text", '<div class="portal-brands">$</div>', '<span data-probe class="school-logo is-empty">School logo</span>'],
    ["the registration PDF button", PARENT, '<button data-probe class="secondary-button pdf-button">Download PDF</button>'],
  ];
  it.each(cases)("%s", (_name, wrapper, html) => {
    const c = contrastOf(html, wrapper);
    expect(c.value, `${c.fg} on ${c.bg}`).toBeGreaterThanOrEqual(4.5);
  });
});

describe("disabled buttons look disabled but stay legible (at least 3:1)", () => {
  const cases = [
    ["disabled parent primary button", PARENT, '<button disabled data-probe class="primary-button">Submitting…</button>'],
    ["disabled staff primary button", STAFF, '<button disabled data-probe class="admin-button admin-button-primary">Adding…</button>'],
    ["disabled staff secondary button", STAFF, '<button disabled data-probe class="admin-button">Cancel</button>'],
    ["disabled form Back button", PARENT, '<button disabled data-probe class="step-button">Back</button>'],
  ];
  it.each(cases)("%s", (_name, wrapper, html) => {
    const c = contrastOf(html, wrapper);
    const opacity = Number(getComputedStyle(document.body.querySelector("[data-probe]")).opacity || 1);
    expect(opacity, "no opacity fading that washes out the label").toBeGreaterThanOrEqual(1);
    expect(c.value, `${c.fg} on ${c.bg}`).toBeGreaterThanOrEqual(3);
  });

  it("a disabled primary button is visibly different from an enabled one", () => {
    const on = contrastOf('<button data-probe class="admin-button admin-button-primary">Save</button>', STAFF);
    const off = contrastOf('<button disabled data-probe class="admin-button admin-button-primary">Save</button>', STAFF);
    expect(off.bg).not.toBe(on.bg);
  });
});

describe("tap targets are large enough on phones AND tablets (WCAG 2.2: at least 24 px; we use 44 px)", () => {
  // A phone, a tablet (found at 820 px in a real browser) or any touch screen, whatever its width.
  const touch = () => {
    const css = readFileSync(resolve(cwd(), "src/index.css"), "utf8");
    return css.match(/@media \(max-width: 899px\), \(pointer: coarse\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  };
  it("text buttons, text links and tabs have a minimum height on touch screens and screens up to 899 px", () => {
    for (const sel of [".text-button", ".text-link", ".auth-tab"]) {
      expect(touch(), sel).toMatch(new RegExp(`${sel.replace(".", "\\.")}[^{]*\\{[^}]*min-height:\\s*44px`));
    }
  });
  it("a short word like \"Edit\" is still a 44 px-wide target", () => {
    expect(touch()).toMatch(/\.text-button[^{]*\{[^}]*min-width:\s*44px/);
  });
});

describe("focus is always visible", () => {
  it("staff and parent buttons and links declare a visible focus outline", () => {
    const css = readFileSync(resolve(cwd(), "src/index.css"), "utf8");
    for (const sel of [".admin-button:focus-visible", ".primary-button:focus-visible", ".secondary-button:focus-visible", ".step-button:focus-visible", ".password-toggle:focus-visible", ".text-link:focus-visible"]) {
      expect(css, sel).toMatch(new RegExp(`${sel.replace(/[.:]/g, (m) => `\\${m}`)}[^{]*\\{[^}]*outline:\\s*3px`));
    }
  });
});
