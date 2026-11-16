// @vitest-environment node
//
// Regression test for "This request was blocked" on staff login in local development.
// It starts a REAL Vite dev server with the project's own proxy settings, in front of a stub
// backend that runs the REAL staff same-site check, and sends a browser-like login request.
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer, loadConfigFromFile } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { sameOriginForWrites } from "../../backend/src/modules/staff/middleware.js";

const configFile = fileURLToPath(new URL("../vite.config.js", import.meta.url));
const closers = [];
afterEach(async () => {
  while (closers.length) await closers.pop()();
});

/** A stand-in backend: the real same-site middleware, then 200 with the Host it received. */
async function startStubBackend() {
  const seen = [];
  const server = createHttpServer((req, res) => {
    seen.push(req.headers.host);
    sameOriginForWrites(req, res, (err) => {
      res.writeHead(err ? err.status : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(err ? { error: { code: err.code } } : { ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** A Vite dev server whose /api proxy is `proxyEntry`, pointed at the stub. */
async function startVite(proxyEntry) {
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, strictPort: false, proxy: { "/api": proxyEntry }, hmr: false, watch: null },
  });
  await vite.listen();
  closers.push(() => vite.close());
  return `http://127.0.0.1:${vite.httpServer.address().port}`;
}

// What a browser on the Vite page sends for the staff login.
const browserLogin = (origin) =>
  fetch(`${origin}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: "admin@example.com", password: "x" }),
  });

describe("Vite dev proxy and the staff same-site check", () => {
  it("the project's proxy points /api at the local backend and keeps the browser's Host", async () => {
    const { config } = await loadConfigFromFile({ command: "serve", mode: "development" }, configFile);
    const api = config.server.proxy["/api"];
    expect(api).toEqual({ target: "http://127.0.0.1:4000", changeOrigin: false });
  });

  it("a staff login through the project's proxy settings is NOT blocked", async () => {
    const { config } = await loadConfigFromFile({ command: "serve", mode: "development" }, configFile);
    const backend = await startStubBackend();
    const origin = await startVite({ ...config.server.proxy["/api"], target: backend.url });
    const res = await browserLogin(origin);
    expect(res.status).toBe(200);
    expect(backend.seen).toEqual([new URL(origin).host]);
  });

  it("documents the cause: the string shorthand rewrites Host, so the same request IS blocked", async () => {
    const backend = await startStubBackend();
    const origin = await startVite(backend.url); // "/api": "http://..." => changeOrigin: true
    const res = await browserLogin(origin);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("CROSS_SITE_REQUEST");
    expect(backend.seen).toEqual([new URL(backend.url).host]);
  });

  it("the protection still works: a request from another site through the proxy is blocked", async () => {
    const { config } = await loadConfigFromFile({ command: "serve", mode: "development" }, configFile);
    const backend = await startStubBackend();
    const origin = await startVite({ ...config.server.proxy["/api"], target: backend.url });
    const res = await fetch(`${origin}/api/admin/schools`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});
