import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Root-level orchestration for Railway: one build, one start, one health check, and local workflows untouched.
const root = new URL("../../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const pkg = JSON.parse(read("package.json"));
const backend = JSON.parse(read("apps/api/package.json"));

describe("root package.json", () => {
  it("is private, ESM-free of dependencies, and declares the same Node range", () => {
    assert.equal(pkg.private, true);
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.engines.node, backend.engines.node);
  });

  it("build installs the workspaces (with dev tools) and builds the combined web app", () => {
    assert.match(pkg.scripts.build, /npm ci --include=dev/);
    assert.match(pkg.scripts.build, /npm run build -w @pp\/web-core/);
  });

  it("start runs the backend with the platform's environment and no .env file", () => {
    assert.equal(pkg.scripts.start, "npm start -w @pp/api");
    assert.doesNotMatch(JSON.stringify(pkg.scripts), /env-file/);
  });

  it("offers dev, test, lint and ops entry points that delegate to the apps", () => {
    for (const name of ["dev:backend", "dev:frontend", "test", "lint", "ops"]) assert.ok(pkg.scripts[name], name);
    assert.match(pkg.scripts["dev:backend"], /-w @pp\/api/);
    assert.match(pkg.scripts["dev:frontend"], /-w @pp\/web-core/);
    assert.equal(pkg.scripts.ops, "npm run ops -w @pp/api --");
    assert.equal(pkg.scripts["bootstrap:admin"], undefined, "there is no admin to bootstrap");
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
  it("ops reads your local .env (it refuses a live database unless every safeguard is set), and there is no bootstrap:admin", () => {
    assert.equal(backend.scripts.ops, "node --env-file=.env scripts/ops.js");
    assert.equal(backend.scripts["bootstrap:admin"], undefined);
  });
  it("local workflows are unchanged", () => {
    assert.equal(backend.scripts.dev, "node --watch --env-file=.env src/server.js");
    assert.equal(backend.scripts.start, "node src/server.js");
  });
});

describe("Vite dev proxy", () => {
  it("still forwards /api to the local backend with the original Host header", () => {
    const cfg = read("packages/web-core/vite.config.js");
    assert.match(cfg, /"\/api":\s*{[^}]*target:\s*"http:\/\/127\.0\.0\.1:4000"[^}]*changeOrigin:\s*false/s);
  });
});

describe("Railway config per service: the API serves no website, each portal serves its own", () => {
  const cfg = (name) => JSON.parse(read(`railway/${name}.json`));
  const PORTALS = { "portal-domestic-paid": "public", "portal-domestic-free": "public", "portal-international-paid": "public", "portal-international-free": "public", "portal-staff": "staff" };

  it("the API service explicitly turns the frontend off and builds no frontend", () => {
    const api = cfg("api");
    assert.match(api.deploy.startCommand, /^SERVE_FRONTEND=false npm start -w @pp\/api$/);
    assert.doesNotMatch(api.build.buildCommand, /portal-|web-core|npm run build\b/, "the API build makes no frontend");
    assert.equal(api.deploy.healthcheckPath, "/api/health/ready");
    assert.ok(!/DATABASE_URL|SECRET|PASSWORD/i.test(read("railway/api.json")), "no secrets in the file");
  });

  it("each of the five frontend services builds and serves its own folder through the web server, and never starts the API", () => {
    for (const [name, role] of Object.entries(PORTALS)) {
      const c = cfg(name);
      assert.ok(c.build.buildCommand.includes(`npm run build -w @pp/${name}`), `${name} builds itself`);
      assert.equal(c.deploy.startCommand, `PORTAL_ROLE=${role} STATIC_DIR=apps/${name}/dist node apps/web-server/src/server.js`, name);
      assert.doesNotMatch(c.deploy.startCommand, /SERVE_FRONTEND|npm start/, "a frontend service never runs the API");
      assert.equal(c.deploy.healthcheckPath, "/healthz", name);
      assert.ok(!/DATABASE_URL|SECRET|PASSWORD/i.test(read(`railway/${name}.json`)), `no secrets in ${name}`);
    }
    assert.deepEqual(Object.keys(PORTALS).length, 5);
  });

  it("the only service whose start command is the API is the API service", () => {
    for (const name of ["api", ...Object.keys(PORTALS)]) {
      assert.equal(/@pp\/api/.test(cfg(name).deploy.startCommand), name === "api", name);
    }
  });
});
