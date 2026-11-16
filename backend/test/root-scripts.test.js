import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Root-level orchestration for Railway: one build, one start, one health check, and local workflows untouched.
const root = new URL("../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const pkg = JSON.parse(read("package.json"));
const backend = JSON.parse(read("backend/package.json"));

describe("root package.json", () => {
  it("is private, ESM-free of dependencies, and declares the same Node range", () => {
    assert.equal(pkg.private, true);
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.engines.node, backend.engines.node);
  });

  it("build installs both apps (frontend with dev tools) and builds the frontend", () => {
    assert.match(pkg.scripts.build, /npm ci --prefix backend/);
    assert.match(pkg.scripts.build, /npm ci --include=dev --prefix frontend/);
    assert.match(pkg.scripts.build, /npm run build --prefix frontend/);
  });

  it("start runs the backend with the platform's environment and no .env file", () => {
    assert.equal(pkg.scripts.start, "npm start --prefix backend");
    assert.doesNotMatch(JSON.stringify(pkg.scripts), /env-file/);
  });

  it("offers dev, test, lint and bootstrap entry points that delegate to the apps", () => {
    for (const name of ["dev:backend", "dev:frontend", "test", "lint", "bootstrap:admin"]) assert.ok(pkg.scripts[name], name);
    assert.match(pkg.scripts["dev:backend"], /--prefix backend/);
    assert.match(pkg.scripts["dev:frontend"], /--prefix frontend/);
    assert.equal(pkg.scripts["bootstrap:admin"], "npm run bootstrap:admin --prefix backend");
  });
});

describe("Railway config", () => {
  const rail = existsSync(new URL("railway.json", root)) ? JSON.parse(read("railway.json")) : null;
  it("runs the root start command and checks READINESS, not liveness", () => {
    assert.ok(rail, "railway.json exists");
    assert.equal(rail.deploy.startCommand, "npm start");
    assert.equal(rail.deploy.healthcheckPath, "/api/health/ready");
    assert.ok(rail.deploy.healthcheckTimeout >= 30);
    assert.equal(rail.build.buildCommand, "npm run build");
  });
  it("holds no secrets or database settings", () => {
    assert.doesNotMatch(read("railway.json"), /DATABASE_URL|SECRET|PASSWORD|postgres/i);
  });
});

describe("backend scripts", () => {
  it("bootstrap:admin reads the platform environment, never a .env file", () => {
    assert.equal(backend.scripts["bootstrap:admin"], "node scripts/bootstrap-admin.js");
  });
  it("local workflows are unchanged", () => {
    assert.equal(backend.scripts.dev, "node --watch --env-file=.env src/server.js");
    assert.equal(backend.scripts.start, "node src/server.js");
  });
});

describe("Vite dev proxy", () => {
  it("still forwards /api to the local backend with the original Host header", () => {
    const cfg = read("frontend/vite.config.js");
    assert.match(cfg, /"\/api":\s*{[^}]*target:\s*"http:\/\/127\.0\.0\.1:4000"[^}]*changeOrigin:\s*false/s);
  });
});
