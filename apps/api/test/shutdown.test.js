import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { describe, it } from "node:test";
import { createShutdown } from "../src/shutdown.js";

const listening = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => r(s)); });
const quietLog = { log() {}, error() {} };

describe("graceful shutdown", () => {
  it("flags readiness first, lets an in-flight request finish, then closes the pool and exits 0", async () => {
    const order = [];
    const server = await listening((req, res) => setTimeout(() => res.end("done"), 150));
    const port = server.address().port;
    const inflight = fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 30));
    let code;
    const shutdown = createShutdown({
      server, graceMs: 2000, log: quietLog,
      health: { beginShutdown: () => order.push("health") },
      db: { end: async () => { order.push("db"); } },
      timers: [setInterval(() => {}, 1000)],
      exit: (c) => { code = c; },
    });
    await shutdown("SIGTERM");
    assert.equal(await inflight, "done", "in-flight request completed");
    assert.deepEqual(order, ["health", "db"]);
    assert.equal(code, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), "no new connections after shutdown");
  });

  it("runs once even if the signal arrives twice", async () => {
    const server = await listening((req, res) => res.end("x"));
    let ends = 0;
    const exits = [];
    const shutdown = createShutdown({ server, graceMs: 1000, log: quietLog, health: { beginShutdown() {} }, db: { end: async () => { ends++; } }, exit: (c) => exits.push(c) });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    assert.equal(ends, 1);
    assert.deepEqual(exits, [0]);
  });

  it("after the grace period it drops a stuck connection and exits 1", async () => {
    const server = await listening((req, res) => { /* never answers */ });
    const port = server.address().port;
    const sock = net.connect(port, "127.0.0.1");
    sock.on("error", () => {});
    sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    await new Promise((r) => setTimeout(r, 50));
    let code;
    const t = Date.now();
    await createShutdown({ server, graceMs: 200, log: quietLog, health: { beginShutdown() {} }, db: { end: async () => {} }, exit: (c) => { code = c; } })("SIGTERM");
    assert.equal(code, 1);
    assert.ok(Date.now() - t < 2000);
    sock.destroy();
  });

  it("does not hang if the pool will not close", async () => {
    const server = await listening((req, res) => res.end("x"));
    let code;
    const t = Date.now();
    await createShutdown({ server, graceMs: 200, log: quietLog, health: { beginShutdown() {} }, db: { end: () => new Promise(() => {}) }, exit: (c) => { code = c; } })("SIGTERM");
    assert.equal(code, 1);
    assert.ok(Date.now() - t < 2000);
  });
});
