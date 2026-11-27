// Proves the Google Drive connection works, end to end, with a harmless test file.
//
//   npm run drive:check
//
// Signs in with the saved authorisation, confirms it is the configured destination account, creates (or reuses)
// "Young Edsplorer / Connection checks" and uploads a one-page test PDF there, reads it back and compares it.
// The test file holds no registration data. It is left in the Drive so you can see it; delete it whenever you like.
import { createRequire } from "node:module";
import { ConfigError, loadConfig } from "../src/config.js";
import { DriveError, createDriveClient } from "../src/modules/pdf-storage/drive-client.js";

const require = createRequire(import.meta.url);
const PDFDocument = require("pdfkit");

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : "The configuration could not be read.");
  process.exit(1);
}
const { mode, drive: credentials, missing, rootName } = config.pdfStorage;
if (!credentials) {
  console.error(
    mode !== "google-drive"
      ? "PDF_STORAGE is not set to google-drive in backend/.env, so there is nothing to check yet. See GOOGLE_DRIVE_SETUP.md."
      : `These settings are missing in backend/.env: ${missing.join(", ")}. See GOOGLE_DRIVE_SETUP.md.`,
  );
  process.exit(1);
}

function testPdf(stamp) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", info: { Title: "Young Edsplorer Google Drive connection check" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.fontSize(20).text("Young Edsplorer", { align: "left" }).moveDown(0.5);
    doc.fontSize(12).text("Google Drive connection check").moveDown();
    doc.fontSize(10).text(`Created ${stamp}. This file contains no registration data and can be deleted.`);
    doc.end();
  });
}

const stamp = new Date().toISOString();
try {
  const drive = createDriveClient(credentials);
  await drive.verifyAccount();
  console.log(`OK  Signed in as ${drive.account}, the configured destination account.`);
  const root = await drive.findOrCreateFolder(rootName, null, "root");
  const checks = await drive.findOrCreateFolder("Connection checks", root, "connection-checks");
  console.log(`OK  Folder: ${rootName} / Connection checks`);
  const bytes = await testPdf(stamp);
  const name = `connection-check-${stamp.replace(/[:.]/g, "-")}.pdf`;
  const file = await drive.uploadPdf({ name, parentId: checks, bytes, appProperties: { ye_check: "1" } });
  console.log(`OK  Uploaded ${name} (${file.size} bytes).`);
  const back = await drive.downloadFile(file.id);
  if (!back.equals(bytes)) throw new Error("the file read back from Drive is not identical to the one uploaded");
  console.log("OK  Read it back: identical.");
  console.log(`\nThe Google Drive connection works. Open Google Drive as ${drive.account} and look in "${rootName} / Connection checks" to see the test file.`);
} catch (err) {
  console.error(`\nFAILED: ${err instanceof DriveError ? `${err.code}: ${err.message}` : err.message}`);
  if (err instanceof DriveError && err.code === "AUTH_REVOKED") console.error("Run  npm run drive:authorize  again and replace GOOGLE_DRIVE_REFRESH_TOKEN in backend/.env.");
  if (err instanceof DriveError && err.code === "ACCOUNT_MISMATCH") console.error("The saved authorisation belongs to a different Google account than GOOGLE_DRIVE_ACCOUNT.");
  process.exit(1);
}
