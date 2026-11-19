import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// What Railway runs must not depend on a local .env file, and what a developer runs must keep loading it.
// Node must stay inside the range every tool in the project supports (Vite 8, Vitest 5, jsdom 30, ESLint 10).

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const backend = read("../package.json");
const frontend = read("../../../packages/web-core/package.json");
const nodeVersion = readFileSync(new URL("../../../.node-version", import.meta.url), "utf8").trim();

describe("backend scripts", () => {
  it("start (what Railway runs) reads the real environment and no .env file", () => {
    assert.equal(backend.scripts.start, "node src/server.js");
    assert.ok(!/env-file/.test(backend.scripts.start));
  });

  it("local scripts keep loading backend/.env", () => {
    for (const name of ["dev", "start:local", "migrate", "test", "staff", "mail:check", "drive:authorize", "drive:check", "catalog:cleanup"]) {
      assert.match(backend.scripts[name], /--env-file=\.env/, name);
    }
    assert.match(backend.scripts.dev, /--watch/);
    assert.match(backend.scripts["start:local"], /src\/server\.js/);
  });

  it("the production migration is its own script: explicit flag, no .env file", () => {
    assert.equal(backend.scripts["migrate:production"], "node src/db/migrate.js --production");
  });

  it("the local migration and the test run are unchanged and carry no production flag", () => {
    assert.equal(backend.scripts.migrate, "node --env-file=.env src/db/migrate.js");
    assert.ok(!/--production/.test(backend.scripts.migrate));
    assert.ok(!/--production/.test(backend.scripts.test));
  });
});

describe("Node version", () => {
  const supported = (v) => {
    const [major, minor, patch] = v.split(".").map(Number);
    return (major === 22 && (minor > 22 || (minor === 22 && (patch ?? 0) >= 2))) || (major === 24 && minor >= 15) || major >= 26;
  };

  it("backend and frontend declare the same engine range", () => {
    assert.ok(backend.engines?.node, "backend declares a Node range");
    assert.equal(frontend.engines?.node, backend.engines.node);
    assert.equal(backend.engines.node, "^22.22.2 || ^24.15.0");
  });

  it(".node-version is a major Railway can resolve, inside that range", () => {
    assert.match(nodeVersion, /^\d+(\.\d+){0,2}$/);
    assert.ok(supported(nodeVersion.includes(".") ? nodeVersion : `${nodeVersion}.99`), `.node-version ${nodeVersion} is supported`);
  });

  it("the Node running these tests is inside the range", () => {
    assert.ok(supported(process.versions.node), `running on ${process.versions.node}`);
  });
});
