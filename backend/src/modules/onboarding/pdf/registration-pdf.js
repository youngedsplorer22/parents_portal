import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import PDFDocument from "pdfkit";
import { normalizeValue } from "../engine.js";

/**
 * The submitted registration as a PDF. Everything drawn comes from the `model`, which the onboarding service builds
 * only from saved database records (never from the request). See buildPdfModel in ../service.js.
 *
 * Fonts: Noto Sans, bundled from the @fontsource packages, one file per script (Latin, Latin Extended, Vietnamese,
 * Greek, Cyrillic, Devanagari, Bengali). Each run of text is drawn with a font that really has its characters, so names
 * in those scripts come out right. Other scripts (e.g. Chinese, Japanese, Korean, Arabic) have no bundled font: they
 * show as empty boxes. fontCoverage() reports them. WOFF (not WOFF2): fontkit 2.0.4 fails to subset these WOFF2 files.
 */

const require = createRequire(import.meta.url);
const SCRIPTS = [
  ["latin", "@fontsource/noto-sans", "noto-sans-latin"],
  ["latin-ext", "@fontsource/noto-sans", "noto-sans-latin-ext"],
  ["vietnamese", "@fontsource/noto-sans", "noto-sans-vietnamese"],
  ["greek", "@fontsource/noto-sans", "noto-sans-greek"],
  ["greek-ext", "@fontsource/noto-sans", "noto-sans-greek-ext"],
  ["cyrillic", "@fontsource/noto-sans", "noto-sans-cyrillic"],
  ["cyrillic-ext", "@fontsource/noto-sans", "noto-sans-cyrillic-ext"],
  ["devanagari", "@fontsource/noto-sans", "noto-sans-devanagari"],
  ["bengali", "@fontsource/noto-sans-bengali", "noto-sans-bengali-bengali"],
];
const WEIGHTS = { regular: 400, bold: 700 };

let fonts; // loaded once: { [script]: { regular: Buffer, bold: Buffer, glyphs: fontkit font } }
function loadFonts() {
  if (fonts) return fonts;
  fonts = {};
  for (const [script, pkg, base] of SCRIPTS) {
    const file = (w) => readFileSync(require.resolve(`${pkg}/files/${base}-${w}-normal.woff`));
    const regular = file(WEIGHTS.regular);
    fonts[script] = { regular, bold: file(WEIGHTS.bold), glyphs: fontkit.create(regular) };
  }
  return fonts;
}
// A plain path (not a URL object), loaded on first use.
let logo;
const brandLogo = () => (logo ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), "young-edsplorer-logo.png")));

// Characters that belong with the text around them (spaces, joiners, combining marks): kept in the current font.
const STICKY = /[\s‌‍\p{M}]/u;
const has = (script, cp) => loadFonts()[script].glyphs.hasGlyphForCodePoint(cp);

/** Splits text into runs that one font can draw. Unknown characters stay in the current run (and are reported). */
function runsOf(text) {
  const runs = [];
  const missing = [];
  let cur = null;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    let script = cur && (STICKY.test(ch) || has(cur.script, cp)) ? cur.script : SCRIPTS.find(([s]) => has(s, cp))?.[0];
    if (!script) {
      missing.push(cp);
      script = cur?.script ?? "latin";
    }
    if (!cur || cur.script !== script) runs.push((cur = { script, text: "" }));
    cur.text += ch;
  }
  return { runs, missing };
}

/** Which characters of `text` no bundled font can draw (code points), and which script fonts draw the rest. */
export function fontCoverage(text) {
  const { runs, missing } = runsOf(String(text));
  return { missing, scripts: [...new Set(runs.map((r) => r.script))] };
}

// ------------------------------------------------------------------------------------------------ formatting

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
/** "26 October 2026, 14:05 IST": India time, the time zone of the schools and the company. */
export function dateTimeIst(value) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(value))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} IST`;
}
const isIso = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function between(fromIso, toIso) {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  let years = ty - fy;
  let months = tm - fm;
  let days = td - fd;
  if (days < 0) {
    months -= 1;
    days += new Date(Date.UTC(ty, tm - 1, 0)).getUTCDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years, months, days };
}

const NOT_PROVIDED = "Not provided";

/**
 * The form's answers as titled sections of { label, value } rows, in the form's own order. Hidden fields (the age,
 * which the date of birth already says) are left out, as on the review and the submitted view. A derived value
 * (passport validity) is worked out on `asOf`, the submission date, so a later download says what was true then.
 */
export function answerSections(def, data, asOf) {
  return def.sections.map((section) => ({
    title: section.title,
    rows: section.fields
      .filter((f) => !f.hidden)
      .map((f) => {
        if (f.type === "derived") {
          const from = normalizeValue({ type: "date" }, data[f.derive.from]);
          if (!isIso(from)) return { label: f.label, value: NOT_PROVIDED };
          if (from <= asOf) return { label: f.label, value: "Expired on the submission date" };
          const { years, months, days } = between(asOf, from);
          return { label: f.label, value: `${plural(years, "year")} ${plural(months, "month")} ${plural(days, "day")} (on the submission date)` };
        }
        const value = normalizeValue(f, data[f.key]);
        if (value === "") return { label: f.label, value: NOT_PROVIDED };
        return { label: f.label, value: f.type === "date" && isIso(value) ? longDate(value) : value };
      }),
  }));
}

// ------------------------------------------------------------------------------------------------ drawing

const TICK = "#0a7d3b"; // the declaration tick: a green used for nothing else in the document
const C = { brand: "#1f4fbf", ink: "#1b2333", muted: "#5b6577", line: "#d9dee8", band: "#eef3fc", card: "#f6f8fb" };
const PAGE = { margin: 50, top: 104, bottom: 64 };
const TOUR = { domestic: "Domestic", international: "International" };

/** model -> Buffer (a complete PDF). Throws only on a programming error; a bad school logo is simply left out. */
export async function renderRegistrationPdf(model) {
  const f = loadFonts();
  const submitted = dateTimeIst(model.submittedAt);
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: PAGE.top, bottom: PAGE.bottom, left: PAGE.margin, right: PAGE.margin },
    bufferPages: true,
    info: {
      Title: `Young Edsplorer trip registration ${model.reference}`,
      Author: "Young Edsplorer",
      Subject: "Trip registration",
      CreationDate: new Date(model.submittedAt),
      ModDate: new Date(model.submittedAt),
    },
  });
  for (const [script] of SCRIPTS) {
    doc.registerFont(`${script}-regular`, f[script].regular);
    doc.registerFont(`${script}-bold`, f[script].bold);
  }
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });

  const width = doc.page.width - 2 * PAGE.margin;
  const bottom = () => doc.page.height - PAGE.bottom;

  /** Draws text that may mix scripts, at (x, y) or at the cursor, wrapping within `w`. */
  function write(text, { x, y, w = width, size = 10, bold = false, color = C.ink, align = "left", gap = 2 } = {}) {
    const { runs } = runsOf(String(text));
    doc.fontSize(size).fillColor(color);
    runs.forEach((run, i) => {
      doc.font(`${run.script}-${bold ? "bold" : "regular"}`);
      const opts = { width: w, align, lineGap: gap, continued: i < runs.length - 1 };
      if (i === 0 && x !== undefined) doc.text(run.text, x, y ?? doc.y, opts);
      else doc.text(run.text, opts);
    });
  }
  /** Height `text` will take (measured with the font of its first run; scripts share Noto's metrics closely). */
  function heightOf(text, { w = width, size = 10, bold = false, gap = 2 } = {}) {
    const first = runsOf(String(text)).runs[0]?.script ?? "latin";
    doc.font(`${first}-${bold ? "bold" : "regular"}`).fontSize(size);
    return doc.heightOfString(String(text) || " ", { width: w, lineGap: gap });
  }
  const ensure = (needed) => {
    if (doc.y + needed > bottom()) doc.addPage();
  };

  /** A 12 x 12 box with a tick drawn inside it as lines (not a font character, which could come out as an empty square). */
  function drawCheckedBox(x, y) {
    doc.roundedRect(x, y, 12, 12, 2).lineWidth(1).fillAndStroke("#ffffff", C.brand);
    doc.rect(x, y, 12, 12).lineWidth(0.01).strokeOpacity(0).stroke().strokeOpacity(1); // (the exact square, for tools that look for it)
    doc.moveTo(x + 2.6, y + 6.4).lineTo(x + 5, y + 9).lineTo(x + 9.6, y + 3).lineWidth(1.9).lineJoin("round").lineCap("round").strokeColor(TICK).stroke();
  }

  function header() {
    doc.image(brandLogo(), PAGE.margin, 34, { height: 40 });
    if (model.schoolLogo && ["image/png", "image/jpeg"].includes(model.schoolLogo.contentType)) {
      try {
        doc.image(model.schoolLogo.data, doc.page.width - PAGE.margin - 130, 32, { fit: [130, 44], align: "right", valign: "center" });
      } catch {
        // A damaged image is left out; the school's name is printed below anyway.
      }
    }
    doc.moveTo(PAGE.margin, 86).lineTo(doc.page.width - PAGE.margin, 86).lineWidth(0.75).strokeColor(C.line).stroke();
    doc.x = PAGE.margin;
    doc.y = PAGE.top;
  }
  header();
  doc.on("pageAdded", header);

  // Title
  write("Trip registration", { size: 22, bold: true, color: C.ink });
  if (model.school) write([model.school.name, model.school.branch].filter(Boolean).join(" · "), { size: 12, color: C.muted });
  doc.moveDown(0.8);

  // Summary card
  const summary = [
    ["Reference", model.reference],
    ["Status", "Submitted"],
    ["Submitted on", submitted],
    ["Trip type", TOUR[model.trip?.tourType ?? model.tourType] ?? model.tourType],
    ...(model.trip ? [["Trip", model.trip.title], ["Destination", model.trip.destination], ["Academic year", model.trip.academicYear]] : []),
    ...(model.school ? [["School", [model.school.name, model.school.branch].filter(Boolean).join(" · ")]] : []),
  ].filter(([, v]) => v);
  const colW = (width - 32) / 2;
  const cellH = (pair) => Math.max(heightOf(pair[1], { w: colW, size: 10.5, bold: true }), 13) + 14;
  const rowsOfTwo = [];
  for (let i = 0; i < summary.length; i += 2) rowsOfTwo.push(summary.slice(i, i + 2));
  const cardH = rowsOfTwo.reduce((h, r) => h + Math.max(...r.map(cellH)), 0) + 20;
  const cardTop = doc.y;
  doc.roundedRect(PAGE.margin, cardTop, width, cardH, 6).fill(C.card);
  let cy = cardTop + 12;
  for (const pair of rowsOfTwo) {
    pair.forEach(([label, value], i) => {
      const x = PAGE.margin + 16 + i * (colW + 0);
      write(label.toUpperCase(), { x, y: cy, w: colW - 8, size: 7.5, color: C.muted, bold: true });
      write(value, { x, y: cy + 11, w: colW - 8, size: 10.5, bold: true });
    });
    cy += Math.max(...pair.map(cellH));
  }
  doc.x = PAGE.margin;
  doc.y = cardTop + cardH + 18;

  // Sections of label / value rows
  // Text boxes of a row; measured and drawn with exactly the same widths, so a row never spills onto the next page.
  const labelW = width * 0.36 - 10;
  const valueX = PAGE.margin + width * 0.36 + 12;
  const valueW = width - (valueX - PAGE.margin) - 10;
  const rowHeight = ({ label, value, valueStyle = {} }) =>
    Math.max(heightOf(label, { w: labelW, size: 9.5 }), heightOf(value, { w: valueW, size: valueStyle.size ?? 10, bold: valueStyle.bold ?? false })) + 9;
  function sectionTitle(title) {
    const h = 22;
    doc.rect(PAGE.margin, doc.y, width, h).fill(C.band);
    write(title, { x: PAGE.margin + 10, y: doc.y + 6, w: width - 20, size: 11, bold: true, color: C.brand });
    doc.x = PAGE.margin;
    doc.y += 8;
  }
  function row(r) {
    const h = rowHeight(r);
    ensure(h);
    const top = doc.y;
    write(r.label, { x: PAGE.margin + 10, y: top + 4, w: labelW, size: 9.5, color: C.muted });
    const style = r.valueStyle ?? {};
    write(r.value, { x: valueX, y: top + (style.size ? 3 : 4), w: valueW, size: style.size ?? 10, bold: style.bold ?? false, color: r.value === NOT_PROVIDED ? C.muted : C.ink });
    const end = Math.max(doc.y, top + h);
    doc.moveTo(PAGE.margin, end).lineTo(PAGE.margin + width, end).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.x = PAGE.margin;
    doc.y = end;
  }
  function section(title, rows) {
    // Keep the heading with its first row: never a heading alone at the bottom of a page.
    ensure(22 + 8 + (rows[0] ? rowHeight(rows[0]) : 0) + 4);
    sectionTitle(title);
    rows.forEach(row);
    doc.y += 16;
  }

  section("Registered by", [
    { label: "Name", value: model.account.name },
    { label: "Role", value: model.account.role },
    { label: "Email address", value: model.account.email },
    { label: "Phone number", value: model.account.phone },
  ]);
  for (const s of model.sections) section(s.title, s.rows);

  // Declaration and signature
  ensure(22 + 8 + 60);
  sectionTitle("Declaration and signature");
  doc.y += 4;
  if (model.declaration) {
    // The PDF only ever shows the declaration as accepted when the server verified the acceptance (see the service).
    // Anything else is refused outright: a form that did not accept it must never look as if it did.
    if (model.declaration.accepted !== true) throw new Error("declaration acceptance not verified");
    // A checked box, then the exact wording beside it. The box and the first lines stay together on one page; a long
    // wording then continues onto the next page (pdfkit redraws the header there).
    const boxX = PAGE.margin + 10;
    const textX = boxX + 26;
    const textW = width - 20 - 26;
    ensure(Math.min(heightOf(model.declaration.text, { w: textW, size: 9.5, gap: 3 }), 48) + 4);
    const top = doc.y;
    drawCheckedBox(boxX, top + 1);
    write(model.declaration.text, { x: textX, y: top, w: textW, size: 9.5, gap: 3 });
    doc.x = PAGE.margin;
    doc.y += 10;
    // The signature exactly as accepted, in the bold weight of the same plain font (Noto Sans Bold, embedded, with a bold
    // face for every bundled script), larger than the values around it. Never a script or italic face.
    row({ label: "Digital Signature", value: model.declaration.signatureName, valueStyle: { bold: true, size: 12.5 } });
    row({ label: "Declaration accepted", value: dateTimeIst(model.declaration.acceptedAt) });
  } else {
    write("This registration was submitted before the declaration and signature were introduced.", { x: PAGE.margin + 10, w: width - 20, size: 9.5, color: C.muted });
  }

  // Footer on every page (drawn last, when the page count is known; bottom margin lifted so it doesn't add pages).
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    const y = doc.page.height - 42;
    doc.moveTo(PAGE.margin, y - 8).lineTo(doc.page.width - PAGE.margin, y - 8).lineWidth(0.5).strokeColor(C.line).stroke();
    write(`Young Edsplorer · Trip registration · Reference ${model.reference}`, { x: PAGE.margin, y, w: width * 0.7, size: 8, color: C.muted });
    write(`Page ${i - range.start + 1} of ${range.count}`, { x: PAGE.margin + width * 0.7, y, w: width * 0.3, size: 8, color: C.muted, align: "right" });
    doc.page.margins.bottom = PAGE.bottom;
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
