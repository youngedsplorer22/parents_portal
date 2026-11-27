import assert from "node:assert/strict";
import http from "node:http";
import { networkInterfaces } from "node:os";
import { after, describe, it } from "node:test";
import { listen } from "../src/listen.js";

// Railway reaches the service on a non-loopback address, so a production server has to listen on every interface.
// Development keeps listening on this machine only. These tests open real sockets and ask from outside.

const lanAddress = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

const app = (req, res) => res.end("ok");
async function start(config) {
  const server = http.createServer(app);
  servers.push(server);
  // `listen` takes anything with an Express-style listen(); a plain http.Server has the same shape.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    listen(server, config, resolve);
  });
  return server.address().port;
}
const get = (host, port) =>
  new Promise((resolve) => {
    const req = http.get({ host, port, timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", (e) => resolve(e.code));
    req.on("timeout", () => {
      req.destroy();
      resolve("TIMEOUT");
    });
  });

describe("listen", () => {
  it("with no host (production) answers on loopback and on this machine's network address", async (t) => {
    const port = await start({ port: 0, host: null });
    assert.equal(await get("127.0.0.1", port), 200);
    if (!lanAddress) return t.skip("no network address on this machine");
    assert.equal(await get(lanAddress, port), 200, "reachable from outside loopback");
  });

  it("with a loopback host (development) is not reachable on the network address", async (t) => {
    if (!lanAddress) return t.skip("no network address on this machine");
    const port = await start({ port: 0, host: "127.0.0.1" });
    assert.equal(await get("127.0.0.1", port), 200);
    assert.equal(await get(lanAddress, port), "ECONNREFUSED");
  });

  it("with 0.0.0.0 answers on the network address", async (t) => {
    if (!lanAddress) return t.skip("no network address on this machine");
    const port = await start({ port: 0, host: "0.0.0.0" });
    assert.equal(await get(lanAddress, port), 200);
  });

  it("passes the callback through and returns the server", async () => {
    const server = http.createServer(app);
    servers.push(server);
    let called = false;
    const returned = listen(server, { port: 0, host: "127.0.0.1" }, () => {
      called = true;
    });
    await new Promise((r) => server.once("listening", r));
    assert.equal(returned, server);
    assert.equal(called, true);
  });
});
