import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { DriveError, createDriveClient } from "../src/modules/pdf-storage/drive-client.js";
import { startFakeDrive } from "./fake-drive.js";

let fake;
let drive;
const PDF = Buffer.concat([Buffer.from("%PDF-1.3\n"), Buffer.from([0, 1, 2, 255, 254, 13, 10, 13, 10]), Buffer.from("\n%%EOF\n")]);

beforeEach(async () => {
  fake = await startFakeDrive({ account: "dest@example.com" });
  drive = createDriveClient({ ...fake.options, timeoutMs: 1500 });
});
afterEach(() => fake.close());
after(() => {});

const rejects = (promise, code) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof DriveError, `${err}`);
    assert.equal(err.code, code, err.message);
    return true;
  });

describe("folders and files", () => {
  it("creates a folder once and finds it again by its key (no duplicates, even across clients)", async () => {
    const a = await drive.findOrCreateFolder("Young Edsplorer", null, "root");
    const b = await drive.findOrCreateFolder("Young Edsplorer", null, "root");
    const other = createDriveClient({ ...fake.options });
    const c = await other.findOrCreateFolder("Young Edsplorer", null, "root");
    assert.equal(a, b);
    assert.equal(a, c);
    assert.equal(fake.folders().length, 1);
    assert.deepEqual(fake.folders()[0][1].parents, ["root"]);
  });

  it("nests folders under their parent and keeps same-named folders under different parents apart", async () => {
    const root = await drive.findOrCreateFolder("Young Edsplorer", null, "root");
    const x = await drive.findOrCreateFolder("School", root, "school:1");
    const y = await drive.findOrCreateFolder("School", root, "school:2");
    assert.notEqual(x, y);
    assert.equal(fake.folders().length, 3);
  });

  it("folder names with quotes and backslashes are escaped in the search, never breaking it", async () => {
    const root = await drive.findOrCreateFolder("Young Edsplorer", null, "root");
    const id = await drive.findOrCreateFolder("St. Mary's \\ Co' and name = 'x'", root, "school:o'brien");
    assert.equal(await drive.findOrCreateFolder("St. Mary's \\ Co' and name = 'x'", root, "school:o'brien"), id);
    assert.equal(fake.folders().length, 2);
  });

  it("uploads a PDF byte for byte, private (no sharing request), and finds it again by its form key", async () => {
    const folder = await drive.findOrCreateFolder("F", null, "f");
    const up = await drive.uploadPdf({ name: "YE-1A2B3C4D.pdf", parentId: folder, bytes: PDF, appProperties: { ye_form: "form-1" } });
    assert.match(up.id, /^[a-z0-9]+$/);
    assert.deepEqual(fake.uploads()[0].bytes, PDF);
    assert.equal(fake.uploads()[0].mimeType, "application/pdf");
    assert.deepEqual(fake.uploads()[0].parents, [folder]);
    assert.ok(!fake.requests.some((r) => /permissions/.test(r.path)), "nothing is ever shared");
    assert.deepEqual(await drive.findFile(folder, "ye_form", "form-1"), { id: up.id, size: PDF.length });
    assert.equal(await drive.findFile(folder, "ye_form", "form-2"), null);
    assert.deepEqual(await drive.downloadFile(up.id), PDF);
  });

  it("a file in the bin or one that doesn't exist reads as NOT_FOUND", async () => {
    await rejects(drive.downloadFile("doesnotexist"), "NOT_FOUND");
    const folder = await drive.findOrCreateFolder("F", null, "f");
    const up = await drive.uploadPdf({ name: "a.pdf", parentId: folder, bytes: PDF, appProperties: { ye_form: "x" } });
    fake.files.get(up.id).trashed = true;
    await rejects(drive.downloadFile(up.id), "NOT_FOUND");
    assert.equal(await drive.findFile(folder, "ye_form", "x"), null);
  });
});

describe("sign-in to Google", () => {
  it("fetches one access token and reuses it; asks again after it expires", async () => {
    await drive.findOrCreateFolder("A", null, "a");
    await drive.findOrCreateFolder("B", null, "b");
    assert.equal(fake.state.tokenIssued, 1);
    let now = Date.now();
    const timed = createDriveClient({ ...fake.options, now: () => now });
    await timed.findOrCreateFolder("C", null, "c");
    now += 3600 * 1000; // an hour later (the token is renewed a minute before it expires)
    await timed.findOrCreateFolder("D", null, "d");
    assert.equal(fake.state.tokenIssued, 3);
  });

  it("concurrent calls share one token request", async () => {
    await Promise.all([1, 2, 3, 4, 5].map((i) => drive.findOrCreateFolder(`F${i}`, null, `f${i}`)));
    assert.equal(fake.state.tokenIssued, 1);
  });

  it("a token that stopped working is replaced once and the call succeeds", async () => {
    await drive.findOrCreateFolder("A", null, "a");
    fake.expireTokens();
    await drive.findOrCreateFolder("B", null, "b");
    assert.equal(fake.state.tokenIssued, 2);
  });

  it("revoked access (invalid_grant) is AUTH_REVOKED, with no retry storm", async () => {
    fake.revoke();
    await rejects(drive.findOrCreateFolder("A", null, "a"), "AUTH_REVOKED");
    assert.equal(fake.requests.filter((r) => r.path === "/token").length, 1);
  });

  it("a wrong client id or secret is AUTH_CONFIG", async () => {
    const bad = createDriveClient({ ...fake.options, clientSecret: "wrong" });
    await rejects(bad.findOrCreateFolder("A", null, "a"), "AUTH_CONFIG");
  });

  it("the destination account is checked: a token for a different Google account is refused before anything is stored", async () => {
    await drive.verifyAccount(); // matches
    fake.state.account = "someone.else@example.com";
    const fresh = createDriveClient({ ...fake.options });
    await rejects(fresh.verifyAccount(), "ACCOUNT_MISMATCH");
    assert.equal(fake.uploads().length, 0);
  });

  it("the account comparison ignores case and surrounding spaces", async () => {
    await createDriveClient({ ...fake.options, account: "  DEST@Example.com " }).verifyAccount();
  });
});

describe("failures are classified into safe codes", () => {
  const cases = [
    ["storage full", { status: 403, reason: "storageQuotaExceeded" }, "QUOTA_FULL", false],
    ["rate limited (403)", { status: 403, reason: "userRateLimitExceeded" }, "RATE_LIMITED", true],
    ["rate limited (429)", { status: 429, reason: "rateLimitExceeded" }, "RATE_LIMITED", true],
    ["no permission", { status: 403, reason: "insufficientFilePermissions" }, "PERMISSION", false],
    ["Google is down (503)", { status: 503, reason: "backendError" }, "DRIVE_ERROR", true],
    ["Google is down (500)", { status: 500, reason: "internalError" }, "DRIVE_ERROR", true],
    ["a bad request", { status: 400, reason: "badRequest" }, "DRIVE_ERROR", false],
  ];
  for (const [name, fault, code, retryable] of cases) {
    it(`${name} -> ${code}${retryable ? " (retryable)" : ""}`, async () => {
      fake.fail(/POST \/upload/, fault);
      const folder = await drive.findOrCreateFolder("F", null, "f");
      await assert.rejects(drive.uploadPdf({ name: "a.pdf", parentId: folder, bytes: PDF, appProperties: { ye_form: "x" } }), (err) => {
        assert.equal(err.code, code);
        assert.equal(err.retryable, retryable);
        return true;
      });
      assert.equal(fake.uploads().length, 0);
    });
  }

  it("a slow Google is TIMEOUT (retryable), not a hung request", async () => {
    fake.fail(/GET \/drive\/v3\/files$/, { status: 200, delayMs: 3000, rawBody: "{}" });
    const t0 = Date.now();
    await assert.rejects(drive.findOrCreateFolder("A", null, "a"), (err) => err.code === "TIMEOUT" && err.retryable === true);
    assert.ok(Date.now() - t0 < 2800);
  });

  it("a dropped connection is NETWORK (retryable)", async () => {
    fake.fail(/GET \/drive\/v3\/files$/, { drop: true });
    await assert.rejects(drive.findOrCreateFolder("A", null, "a"), (err) => err.code === "NETWORK" && err.retryable === true);
  });

  it("Google not reachable at all is NETWORK", async () => {
    const dead = createDriveClient({ ...fake.options, tokenUrl: "http://127.0.0.1:1/token" });
    await assert.rejects(dead.findOrCreateFolder("A", null, "a"), (err) => err.code === "NETWORK");
  });

  it("an HTML or garbage reply is DRIVE_ERROR, never a crash", async () => {
    fake.fail(/GET \/drive\/v3\/files$/, { status: 200, rawBody: "<html>proxy</html>" });
    await rejects(drive.findOrCreateFolder("A", null, "a"), "DRIVE_ERROR");
  });

  it("error messages never contain tokens, secrets, file ids or response bodies", async () => {
    fake.fail(/POST \/upload/, { status: 403, reason: "storageQuotaExceeded" });
    const folder = await drive.findOrCreateFolder("F", null, "f");
    let caught;
    try {
      await drive.uploadPdf({ name: "a.pdf", parentId: folder, bytes: PDF, appProperties: { ye_form: "x" } });
    } catch (err) {
      caught = err;
    }
    const text = `${caught.message} ${caught.stack} ${JSON.stringify(caught)}`;
    for (const secret of ["good-refresh-token", "test-secret", "Bearer", "at-", folder]) assert.ok(!text.includes(secret), secret);
  });
});

describe("construction", () => {
  it("refuses to be built without every credential (so a half-set configuration can never half-work)", () => {
    for (const missing of ["clientId", "clientSecret", "refreshToken", "account"]) {
      assert.throws(() => createDriveClient({ ...fake.options, [missing]: "" }), (err) => err instanceof DriveError && err.code === "NOT_CONFIGURED" && !err.message.includes("test-secret"));
    }
  });

  it("only talks to Google's own hosts unless a test passes its own addresses", async () => {
    const real = createDriveClient({ clientId: "a", clientSecret: "b", refreshToken: "c", account: "d@e.com" });
    assert.deepEqual(real.hosts, ["https://oauth2.googleapis.com", "https://www.googleapis.com"]);
  });
});
