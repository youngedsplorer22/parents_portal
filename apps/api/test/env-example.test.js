import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const value = (key) => (example.match(new RegExp(`^${key}=(.*)$`, "m")) ?? [])[1]?.trim() ?? "";

describe(".env.example holds no usable secret", () => {
  it("OTP_HMAC_SECRET is an obvious placeholder that the config refuses, so a copied example can never run with a known key", () => {
    const v = value("OTP_HMAC_SECRET");
    assert.match(v, /^replace-with-/);
    assert.doesNotMatch(v, /^[0-9a-fA-F]{64,}$/, "must not pass the config's hex check");
  });

  it("no SMTP password or other secret value is filled in", () => {
    for (const key of ["SMTP_PASSWORD", "SMTP_USER"]) {
      const v = value(key);
      assert.ok(v === "" || /^replace-with-|^your-|example/i.test(v), `${key} must be empty or a placeholder`);
    }
  });
});

describe("Google Drive settings in the example file", () => {
  const lines = example.split("\n");
  const active = (key) => lines.filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1).trim());
  const documented = (key) => lines.some((l) => new RegExp(`^#?\\s*${key}=`).test(l));

  it("documents every setting, and none is switched on with a real value", () => {
    for (const key of ["PDF_STORAGE", "GOOGLE_DRIVE_ACCOUNT", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_DRIVE_REFRESH_TOKEN", "GOOGLE_DRIVE_ROOT_FOLDER_NAME"]) {
      assert.ok(documented(key), `${key} is documented`);
    }
    for (const key of ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_DRIVE_REFRESH_TOKEN"]) {
      for (const v of active(key)) assert.match(v, /^CHANGE_ME|^replace-with-|^$/, `${key} must stay a placeholder in the example`);
    }
    assert.ok(!/GOCSPX-|1\/\/0[0-9A-Za-z_-]{20,}|ya29\.|\.apps\.googleusercontent\.com\s*$/m.test(example.replace(/CHANGE_ME[^\n]*googleusercontent\.com/g, "")), "no Google client secret, refresh token or client id in the example");
  });

  it("storage is off unless someone chooses it", () => {
    for (const v of active("PDF_STORAGE")) assert.equal(v, "disabled");
  });

  it("Git ignores .env files and the credential files Google lets you download", () => {
    const ignore = readFileSync(new URL("../../../.gitignore", import.meta.url), "utf8");
    for (const pattern of [".env", ".env.*", "client_secret*.json", "credentials*.json", "service-account*.json"]) assert.ok(ignore.split("\n").includes(pattern), `.gitignore lists ${pattern}`);
  });
});
