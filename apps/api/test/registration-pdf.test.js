import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getDefinition } from "../src/modules/onboarding/definitions.js";
import { answerSections, fontCoverage, renderRegistrationPdf } from "../src/modules/onboarding/pdf/registration-pdf.js";
import { declarationMarks, readPdf, textRuns } from "./pdf-text.js";

const PNG = readFileSync(new URL("../src/modules/onboarding/pdf/young-edsplorer-logo.png", import.meta.url));
const DOMESTIC = getDefinition("domestic", "student");
const ANSWERS = {
  fullName: "Asha Rao", gender: "Female", classSection: "4 - B", dateOfBirth: "2016-05-04", age: "10",
  nomineeName: "B Vijaya", nomineeRelation: "Mother", mealPreference: "Veg", allergy: "Peanuts", phone: "9876543210", remark: "Window seat please",
};
const model = (over = {}) => ({
  reference: "YE-1A2B3C4D",
  submittedAt: "2026-10-26T08:35:00.000Z",
  school: { name: "Greenwood International School", branch: "Kolkata" },
  schoolLogo: null,
  trip: { title: "Annual Trip 2027", destination: "Darjeeling", academicYear: "2026-27", tourType: "domestic" },
  tourType: "domestic",
  account: { name: "Asha Rao", role: "Student", email: "parent@example.com", phone: "9876543210" },
  sections: answerSections(DOMESTIC, ANSWERS, "2026-10-26"),
  declaration: { version: 1, text: "I confirm that the information I have given is true and complete.", signatureName: "Meera Rao", acceptedAt: "2026-10-26T08:35:00.000Z", accepted: true },
  ...over,
});

describe("registration PDF: contents", () => {
  it("is a real PDF that a viewer opens, with the brand, school, trip, reference, submission time and every answer", async () => {
    const buf = await renderRegistrationPdf(model());
    assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
    assert.match(buf.subarray(-8).toString(), /%%EOF/);
    const pdf = await readPdf(buf);
    for (const s of [
      "Young Edsplorer", "Trip registration", "Greenwood International School", "Kolkata", "Annual Trip 2027", "Darjeeling", "2026-27", "Domestic",
      "YE-1A2B3C4D", "26 October 2026, 14:05 IST", "Submitted",
      "Asha Rao", "Student", "parent@example.com", "9876543210",
      "Personal details", "Full name", "Female", "Class & section", "4 - B", "Date of birth", "4 May 2016",
      "Nominee", "B Vijaya", "Mother", "Meals & health", "Veg", "Peanuts", "Contact & remarks", "Phone number", "Window seat please",
      "Declaration and signature", "I confirm that the information I have given is true and complete.", "Meera Rao",
    ]) assert.ok(pdf.text.includes(s), `missing: ${s}`);
  });

  it("shows only the registration: no hidden age field, no internal ids, no tokens or session data", async () => {
    const pdf = await readPdf(await renderRegistrationPdf(model()));
    assert.ok(!/\bAge\b/.test(pdf.text), "the age is hidden on the form, the review and the submitted view, so here too");
    assert.ok(!/token|session|password|otp|uuid|version \d/i.test(pdf.text), pdf.text);
  });

  it("an empty optional answer says so instead of leaving a gap", async () => {
    const sections = answerSections(DOMESTIC, { ...ANSWERS, allergy: "", remark: undefined }, "2026-10-26");
    const pdf = await readPdf(await renderRegistrationPdf(model({ sections })));
    assert.match(pdf.text, /Allergy Not provided/);
    assert.match(pdf.text, /Remark Not provided/);
  });

  it("sets document metadata from the record (title with the reference, the submission time), with no personal data", async () => {
    const pdf = await readPdf(await renderRegistrationPdf(model()));
    assert.equal(pdf.info.Title, "Young Edsplorer trip registration YE-1A2B3C4D");
    assert.equal(pdf.info.Author, "Young Edsplorer");
    assert.ok(!JSON.stringify(pdf.info).includes("Asha"));
  });

  it("works for a registration with no school trip and one submitted before the declaration existed", async () => {
    const pdf = await readPdf(await renderRegistrationPdf(model({ school: null, trip: null, declaration: null })));
    assert.ok(pdf.text.includes("Domestic"));
    assert.ok(pdf.text.includes("submitted before the declaration and signature were introduced"));
  });

  it("draws the school's PNG or JPEG logo, and skips a WebP one (which PDF can't show) without failing", async () => {
    const withLogo = await renderRegistrationPdf(model({ schoolLogo: { contentType: "image/png", data: PNG } }));
    const without = await renderRegistrationPdf(model());
    assert.ok(withLogo.length > without.length + 5000, "the logo image is embedded");
    const webp = await renderRegistrationPdf(model({ schoolLogo: { contentType: "image/webp", data: Buffer.from("RIFF0000WEBPVP8 ") } }));
    assert.ok((await readPdf(webp)).text.includes("Greenwood International School"));
  });

  it("a damaged logo image never stops the PDF", async () => {
    const buf = await renderRegistrationPdf(model({ schoolLogo: { contentType: "image/png", data: Buffer.from("not really a png") } }));
    assert.ok((await readPdf(buf)).text.includes("YE-1A2B3C4D"));
  });
});

describe("registration PDF: the declaration checkbox", () => {
  it("is drawn in the file as a box with a tick inside it, next to the exact declaration wording", async () => {
    const buf = await renderRegistrationPdf(model());
    const marks = await declarationMarks(buf);
    assert.equal(marks.boxes.length, 1, "one box");
    assert.equal(marks.ticks.length, 1, "one tick");
    assert.equal(marks.checked.length, 1, "the tick is inside the box");
    const pdf = await readPdf(buf);
    assert.ok(pdf.text.includes("I confirm that the information I have given is true and complete."));
    assert.equal(marks.boxes[0].page, 1 + pdf.pageText.findIndex((t) => t.includes("I confirm that")), "the box is on the page where the wording starts");
  });

  it("the tick is a drawn shape, not a character from a font (so it can't turn into an empty square)", async () => {
    const pdf = await readPdf(await renderRegistrationPdf(model()));
    assert.ok(!/[\u2713\u2714\u2611\u2705]/.test(pdf.text));
  });

  it("without verified acceptance there is no PDF at all: an unverified declaration is never shown as accepted", async () => {
    for (const declaration of [
      { ...model().declaration, accepted: false },
      { ...model().declaration, accepted: undefined },
      { ...model().declaration, accepted: "true" },
      { ...model().declaration, accepted: 1 },
    ]) {
      await assert.rejects(renderRegistrationPdf(model({ declaration })), /not verified/);
    }
  });

  it("a registration submitted before the declaration existed shows no checkbox and says why", async () => {
    const buf = await renderRegistrationPdf(model({ declaration: null }));
    const marks = await declarationMarks(buf);
    assert.deepEqual([marks.boxes.length, marks.ticks.length], [0, 0]);
    assert.ok((await readPdf(buf)).text.includes("submitted before the declaration and signature were introduced"));
  });

  it("the box stays with its wording when the declaration is long and lands near the bottom of a page", async () => {
    const filler = Array.from({ length: 28 }, (_, i) => ({ label: `Line ${i}`, value: "x" }));
    for (let n = 18; n <= 34; n++) {
      const rows = filler.slice(0, n).length ? Array.from({ length: n }, (_, i) => ({ label: `Line ${i}`, value: "x" })) : filler;
      const buf = await renderRegistrationPdf(model({ sections: [{ title: "Filler", rows }], declaration: { ...model().declaration, text: "Long declaration. ".repeat(60) } }));
      const marks = await declarationMarks(buf);
      const pdf = await readPdf(buf);
      assert.equal(marks.checked.length, 1, `n=${n}`);
      assert.ok(pdf.pageText[marks.boxes[0].page - 1].includes("Long declaration."), `n=${n}: the box and the start of its wording share a page`);
    }
  });
});

describe("registration PDF: the Digital Signature", () => {
  it("is labelled \"Digital Signature\" and the words \"electronic signature\" appear nowhere", async () => {
    const pdf = await readPdf(await renderRegistrationPdf(model()));
    assert.ok(pdf.text.includes("Digital Signature"));
    assert.ok(!/electronic signature/i.test(pdf.text), "no 'electronic signature' in any case");
  });

  it("the signature itself is printed exactly as accepted, in the bold weight of the standard font, larger than the text around it", async () => {
    const runs = await textRuns(await renderRegistrationPdf(model()));
    const sig = runs.find((r) => r.text === "Meera Rao");
    const label = runs.find((r) => r.text === "Digital Signature");
    const otherValue = runs.find((r) => r.text === "parent@example.com");
    assert.ok(sig, "the signature text is drawn unchanged");
    assert.equal(sig.font, "NotoSans-Bold", "bold, and the same plain sans-serif family as the page (no script or italic face)");
    assert.equal(otherValue.font, "NotoSans-Regular");
    assert.equal(label.font, "NotoSans-Regular");
    assert.ok(sig.size > otherValue.size, `signature ${sig.size} pt is larger than other values (${otherValue.size} pt)`);
    assert.ok(!/italic|oblique|script|cursive|hand/i.test(sig.font));
  });

  it("a signature in another script is bold too (the bold font of that script is embedded)", async () => {
    const runs = await textRuns(await renderRegistrationPdf(model({ declaration: { ...model().declaration, signatureName: "अनन्या शर्मा" } })));
    const devanagari = runs.filter((r) => /[\u0900-\u097f]/.test(r.text));
    assert.ok(devanagari.length > 0);
    assert.ok(devanagari.every((r) => /Bold/.test(r.font)), JSON.stringify(devanagari.map((r) => r.font)));
  });

  it("a long signature wraps within its column and nothing is cut off", async () => {
    const long = "Maria Fernanda de los Ángeles Rodríguez-Montenegro Villalobos y Castañeda Pérez";
    const runs = await textRuns(await renderRegistrationPdf(model({ declaration: { ...model().declaration, signatureName: long } })));
    const signatureRuns = runs.filter((r) => r.font === "NotoSans-Bold" && r.size === 12.5);
    assert.ok(signatureRuns.length >= 2, "it wraps onto more than one line");
    assert.equal(signatureRuns.map((r) => r.text).join(" ").replace("- ", "-"), long, "every character is printed, in order, all bold");
  });
});

describe("registration PDF: long and multi-page registrations", () => {
  it("long answers wrap and flow onto further pages without being cut off; every page has the header and a numbered footer", async () => {
    const intl = getDefinition("international", "student");
    const long = (tag) => `${tag} ` + "This is a long answer that must wrap across several lines. ".repeat(14) + `ENDOF${tag}`; // no hyphen: a line may wrap after one
    const data = Object.fromEntries(intl.sections.flatMap((s) => s.fields).filter((f) => f.type !== "derived").map((f) => [f.key, f.type === "date" ? "2016-05-04" : f.type === "select" ? f.options[0] : f.type === "textarea" ? long(f.key) : "Value"]));
    const sections = answerSections(intl, data, "2026-10-26");
    // the declaration can be long too
    const declaration = { version: 1, text: "Declaration paragraph. ".repeat(120) + "ENDOFDECLARATION", signatureName: "Meera Rao", acceptedAt: "2026-10-26T08:35:00.000Z", accepted: true };
    const pdf = await readPdf(await renderRegistrationPdf(model({ tourType: "international", trip: { ...model().trip, tourType: "international" }, sections, declaration })));
    assert.ok(pdf.numPages >= 3, `pages: ${pdf.numPages}`);
    for (const f of intl.sections.flatMap((s) => s.fields).filter((x) => x.type === "textarea")) assert.ok(pdf.text.includes(`ENDOF${f.key}`), `cut off: ${f.key}`);
    assert.ok(pdf.text.includes("ENDOFDECLARATION"));
    assert.equal((pdf.text.match(/Declaration paragraph\./g) ?? []).length, 120, "no line of the declaration lost or repeated");
    pdf.pageText.forEach((t, i) => assert.ok(t.length > 300, `page ${i + 1} is not a near-empty spill-over page`));
    pdf.pageText.forEach((t, i) => {
      assert.ok(t.includes(`Page ${i + 1} of ${pdf.numPages}`), `footer on page ${i + 1}`);
      assert.ok(t.includes("YE-1A2B3C4D"), `reference on page ${i + 1}`);
    });
  });

  it("a section title is never left alone at the bottom of a page", async () => {
    // Every filler length from 20 to 50 rows, so one of them puts the heading right at the bottom of page 1.
    let crossedPages = false;
    for (let n = 20; n <= 50; n++) {
      const filler = Array.from({ length: n }, (_, i) => ({ label: `Line ${i}`, value: "x" }));
      const pdf = await readPdf(await renderRegistrationPdf(model({ sections: [{ title: "First", rows: filler }, { title: "Second section", rows: [{ label: "Only row", value: "y" }] }] })));
      const page = pdf.pageText.findIndex((t) => t.includes("Second section"));
      assert.ok(pdf.pageText[page].includes("Only row"), `n=${n}: the heading and its first row are on the same page`);
      if (page > 0) crossedPages = true;
    }
    assert.ok(crossedPages, "the test really reached a page boundary");
  });
});

describe("registration PDF: names in many scripts", () => {
  it("Latin with accents, Greek, Cyrillic and Vietnamese come out exactly as typed", async () => {
    const names = ["Zoë D’Souza", "José Ñúñez-O'Brien", "Νίκος Παπαδόπουλος", "Анна Иванова", "Nguyễn Văn An"];
    const pdf = await readPdf(await renderRegistrationPdf(model({ account: { ...model().account, name: names.join(" / ") } })));
    for (const n of names) assert.ok(pdf.text.includes(n), n);
    for (const n of names) assert.deepEqual(fontCoverage(n).missing, [], n);
  });

  it("Hindi (Devanagari) and Bengali names are drawn with fonts that have their characters, with nothing missing", async () => {
    for (const n of ["अनन्या शर्मा", "অনন্যা শর্মা", "श्री गणेश", "ক্ষত্রিয়"]) assert.deepEqual(fontCoverage(n).missing, [], n);
    assert.deepEqual(fontCoverage("अनन्या शर्मा").scripts, ["devanagari"]);
    assert.deepEqual(fontCoverage("অনন্যা শর্মা").scripts, ["bengali"]);
    assert.deepEqual(fontCoverage("Asha / अनन्या").scripts, ["latin", "devanagari"]);
    const buf = await renderRegistrationPdf(model({ account: { ...model().account, name: "अनन्या शर्मा / অনন্যা শর্মা" } }));
    assert.ok(/NotoSansBengali/.test(buf.toString("latin1")), "the Bengali font is embedded");
    assert.ok((await readPdf(buf)).text.includes("YE-1A2B3C4D"));
  });

  it("a script with no bundled font (e.g. Chinese) is reported as missing and still produces a PDF (known limitation)", async () => {
    assert.deepEqual(fontCoverage("李小龍").missing, [0x674e, 0x5c0f, 0x9f8d]);
    const pdf = await readPdf(await renderRegistrationPdf(model({ account: { ...model().account, name: "李小龍" } })));
    assert.ok(pdf.text.includes("YE-1A2B3C4D"));
  });
});

describe("answer formatting for the PDF", () => {
  it("follows the form: dates in words, hidden fields left out, passport validity worked out on the submission date", () => {
    const intl = getDefinition("international", "student");
    const rows = answerSections(intl, { dateOfBirth: "2012-02-29", passportExpiryDate: "2030-01-09" }, "2026-10-26").flatMap((s) => s.rows);
    const by = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    assert.equal(by["Date of birth"], "29 February 2012");
    assert.equal(by["Passport validity"], "3 years 2 months 14 days (on the submission date)");
    assert.equal(by["Age"], undefined);
    assert.equal(answerSections(intl, { passportExpiryDate: "2020-01-01" }, "2026-10-26").flatMap((s) => s.rows).find((r) => r.label === "Passport validity").value, "Expired on the submission date");
  });
});
