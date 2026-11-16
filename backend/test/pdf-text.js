// Test helper: reads a PDF the way a viewer would (pdfjs) and returns its pages' text, so tests check what a person
// would actually see in the downloaded file, not just that some bytes came back.
export async function readPdf(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join(""));
  }
  const info = (await doc.getMetadata()).info;
  // Anything active inside the file: document JavaScript, or link / form / action annotations on any page.
  const jsActions = await doc.getJSActions();
  let annotations = 0;
  for (let i = 1; i <= doc.numPages; i++) annotations += (await (await doc.getPage(i)).getAnnotations()).length;
  await task.destroy();
  // Line breaks inside wrapped values don't matter to a reader: compare with all whitespace collapsed.
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  return { numPages: pages.length, pages, text: flat(pages.join(" ")), pageText: pages.map(flat), info, jsActions, annotations };
}

export const TICK_COLOUR = "#0a7d3b"; // used for nothing else in the document
/**
 * Reads the drawing instructions of the PDF itself (not the text) and reports the declaration checkbox:
 *   boxes  - 12 x 12 square outlines found, as { page, x, y }
 *   ticks  - tick marks (a 3-point line in the tick colour), as { page, points: [[x, y] x 3] }
 *   checked - ticks that lie inside a box
 * so a test can prove the box is drawn AND ticked in the generated file, in a place where a reader will see it.
 */
export async function declarationMarks(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const boxes = [];
  const ticks = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const ops = await (await doc.getPage(p)).getOperatorList();
    let stroke = null;
    ops.fnArray.forEach((fn, i) => {
      const args = ops.argsArray[i];
      if (fn === pdfjs.OPS.setStrokeRGBColor) stroke = args[0];
      if (fn !== pdfjs.OPS.constructPath) return;
      const flat = Object.values(args[1][0]);
      // pdfkit's path: [op, x, y, op, x, y, ...] with op 0 = moveTo, 1 = lineTo, 4 = closePath
      const pts = [];
      for (let k = 0; k + 2 < flat.length; k += 3) if (flat[k] === 0 || flat[k] === 1) pts.push([flat[k + 1], flat[k + 2]]);
      if (stroke === TICK_COLOUR && pts.length === 3) ticks.push({ page: p, points: pts });
      const xs = pts.map((q) => q[0]);
      const ys = pts.map((q) => q[1]);
      if (pts.length === 4 && Math.abs(Math.max(...xs) - Math.min(...xs) - 12) < 0.01 && Math.abs(Math.max(...ys) - Math.min(...ys) - 12) < 0.01) boxes.push({ page: p, x: Math.min(...xs), y: Math.min(...ys) });
    });
  }
  await task.destroy();
  const checked = ticks.filter((t) => boxes.some((b) => b.page === t.page && t.points.every(([x, y]) => x > b.x && x < b.x + 12 && y > b.y && y < b.y + 12)));
  return { boxes, ticks, checked };
}

/**
 * Every run of text as drawn, with the embedded font's real name and the size: [{ page, text, font, size }]. Lets a test
 * prove HOW something is printed (e.g. the signature in a bold font), not just that the words are there.
 */
export async function textRuns(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, verbosity: 0, fontExtraProperties: true });
  const doc = await task.promise;
  const runs = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const ops = await page.getOperatorList();
    let font = null;
    let size = null;
    ops.fnArray.forEach((fn, i) => {
      const a = ops.argsArray[i];
      if (fn === pdfjs.OPS.setFont) [font, size] = a;
      if (fn === pdfjs.OPS.showText) runs.push({ page: p, fontId: font, size, text: a[0].map((g) => (g && typeof g === "object" ? g.unicode : "")).join("") });
    });
    for (const r of runs.filter((x) => x.page === p)) r.font = page.commonObjs.get(r.fontId).name.replace(/^[A-Z]{6}\+/, "");
  }
  await task.destroy();
  return runs.map(({ page, text, font, size }) => ({ page, text, font, size }));
}
