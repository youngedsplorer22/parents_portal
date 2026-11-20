import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { checkApiTarget } from "../src/api-policy.js";
import { createWebServer } from "../src/server.js";

// Host-header validation and request-body safety. Everything here talks to the real server with raw sockets (a client library
// would tidy the request first) and a recording fake API, so "before any upstream request" is something the tests can see.
const KB = 1024;
const UUID = "123e4567-e89b-42d3-a456-426614174000";

/** A fake API that records each COMPLETE request, and the most body bytes any request (complete or aborted) delivered to it. */
async function recordingApi() {
  const calls = [];
  const partials = [];
  const server = http.createServer((req, res) => {
    let bytes = 0;
    req.on("data", (d) => (bytes += d.length));
    req.on("aborted", () => partials.push(bytes));
    req.on("close", () => partials.push(bytes));
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, bytes });
      res.setHeader("Content-Type", "application/json");
      res.end('{"fromApi":true}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { calls, partials, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

async function portal({ role = "public", ...options } = {}) {
  const upstream = await recordingApi();
  const dir = mkdtempSync(path.join(tmpdir(), "hard-"));
  writeFileSync(path.join(dir, "index.html"), "<html>shell</html>");
  const server = createWebServer({ staticDir: dir, apiUrl: upstream.url, role, portalSecret: role === "public" ? "k".repeat(40) : null, clientIpSource: { mode: "peer" }, ...options });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, upstream, port: server.address().port, close: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await upstream.close(); } };
}

/** Sends exactly these bytes, collects everything the server answers until it closes the socket (or `wait` ms pass). */
function exchange(port, payload, { wait = 1500, after: afterWrite } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(payload);
      afterWrite?.(sock);
    });
    let data = "";
    let closed = false;
    sock.on("data", (d) => (data += d));
    sock.on("close", () => { closed = true; });
    sock.on("error", () => {});
    setTimeout(() => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0);
      const [head, ...rest] = data.split("\r\n\r\n");
      let body = rest.join("\r\n\r\n");
      if (/transfer-encoding: chunked/i.test(head)) {
        // undo the chunk framing: <hex size>\r\n<data>\r\n ... 0\r\n\r\n
        let out = "";
        for (let i = 0; i < body.length; ) {
          const eol = body.indexOf("\r\n", i);
          const size = parseInt(body.slice(i, eol), 16);
          if (!size) break;
          out += body.slice(eol + 2, eol + 2 + size);
          i = eol + 2 + size + 2;
        }
        body = out;
      }
      sock.destroy();
      resolve({ status, data, body, closed });
    }, wait);
  });
}

const get = (host, version = "1.1", target = "/api/auth/session") => `GET ${target} HTTP/${version}\r\n${host}Connection: close\r\n\r\n`;

describe("Host header: exactly one, well formed, checked before anything else", () => {
  let p;
  before(async () => { p = await portal({}); });
  after(() => p.close());
  const calls = () => p.upstream.calls.length;

  for (const version of ["1.0", "1.1"]) {
    describe(`HTTP/${version}`, () => {
      it("rejects more than one Host header, whatever the values or the letter case, with 400 and no upstream call", async () => {
        const before = calls();
        for (const hosts of [
          "Host: a.example\r\nHost: b.example\r\n",
          "Host: a.example\r\nHost: a.example\r\n",
          "Host: a.example\r\nhost: a.example\r\n",
          "host: a.example\r\nHOST: b.example\r\n",
          "Host: a.example\r\nX-Other: 1\r\nHost: b.example\r\n",
          "Host: portal.example\r\nHost: \r\n",
          "Host: a.example\r\nHost: a.example\r\nHost: a.example\r\n",
        ]) {
          const r = await exchange(p.port, get(hosts, version), { wait: 250 });
          assert.equal(r.status, 400, JSON.stringify(hosts));
        }
        assert.equal(calls(), before, "nothing reached the API");
      });

      it("rejects a missing or empty Host, and a Host holding a comma, space or any other character a host name cannot have", async () => {
        const before = calls();
        for (const hosts of [
          "", "Host:\r\n", "Host: \r\n", "Host:    \r\n", "Host: a.example, b.example\r\n", "Host: a.example,b.example\r\n", "Host: a b\r\n", "Host: a.example evil\r\n",
          "Host: user@a.example\r\n", "Host: a.example/path\r\n", "Host: a.example\\\\b\r\n", "Host: a.example%2fb\r\n", "Host: a.example;x\r\n", "Host: a.example?x\r\n",
          "Host: a.example#x\r\n", "Host: http://a.example\r\n", "Host: a.example:\r\n", "Host: a.example:abc\r\n", "Host: a.example:80:80\r\n", "Host: a.example:99999\r\n",
          "Host: a.example:0123456\r\n", "Host: :80\r\n", "Host: .\r\n", "Host: a..example\r\n", "Host: -a.example\r\n", "Host: a-.example\r\n", "Host: a_b.example\r\n",
          "Host: [::1\r\n", "Host: ::1\r\n", "Host: [::1]x\r\n", "Host: []\r\n", "Host: [zz::1]\r\n", `Host: ${"a".repeat(300)}.example\r\n`, `Host: ${"a".repeat(64)}.example\r\n`,
          "Host: a.exampleé\r\n", "Host: а.example\r\n", "Host: a.example\t\r\n\tb\r\n",
        ]) {
          const r = await exchange(p.port, get(hosts, version), { wait: 250 });
          assert.equal(r.status, 400, JSON.stringify(hosts));
        }
        assert.equal(calls(), before, "nothing reached the API");
      });

      it("accepts an ordinary Host: a name, a name with a port, an IPv4 address, an IPv6 address in brackets", async () => {
        for (const hosts of ["Host: portal.example\r\n", "Host: portal.example:8080\r\n", "Host: parents-portal.up.railway.app\r\n", "Host: 127.0.0.1:3000\r\n", "Host: localhost\r\n", "Host: [::1]:3000\r\n", "Host: [2001:db8::7]\r\n", "Host: PORTAL.Example\r\n"]) {
          const r = await exchange(p.port, get(hosts, version), { wait: 300 });
          assert.equal(r.status, 200, JSON.stringify(hosts));
        }
      });
    });
  }

  it("also refuses a bad Host on the website's own pages, with the same JSON 400, and answers /healthz whatever the Host", async () => {
    const page = await exchange(p.port, "GET /join/a/b/c HTTP/1.1\r\nHost: a.example\r\nHost: b.example\r\nConnection: close\r\n\r\n", { wait: 250 });
    assert.equal(page.status, 400);
    assert.deepEqual(JSON.parse(page.body), { error: { code: "BAD_REQUEST", message: "Bad request." } });
    assert.equal((await exchange(p.port, "GET /healthz HTTP/1.0\r\n\r\n", { wait: 250 })).status, 200, "a health probe that sends no Host still passes");
    assert.equal((await exchange(p.port, "GET /healthz HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n", { wait: 250 })).status, 200);
  });

  it("the answer is a JSON 400 that closes the connection", async () => {
    const r = await exchange(p.port, get("Host: a.example\r\nHost: b.example\r\n"), { wait: 250 });
    assert.match(r.data, /content-type: application\/json/i);
    assert.match(r.data, /connection: close/i);
    assert.deepEqual(JSON.parse(r.body), { error: { code: "BAD_REQUEST", message: "Bad request." } });
  });

  it("a duplicate Host is refused on the Sales portal and in local development too", async () => {
    for (const opts of [{ role: "staff" }, { role: null }]) {
      const q = await portal(opts);
      try {
        const target = opts.role === "staff" ? "/api/admin/auth/session" : "/api/auth/session";
        assert.equal((await exchange(q.port, get("Host: a.example\r\nHost: b.example\r\n", "1.1", target), { wait: 250 })).status, 400);
        assert.equal(q.upstream.calls.length, 0);
      } finally {
        await q.close();
      }
    }
  });
});

describe("request bodies: the API's own limits, enforced before and while streaming", () => {
  let p;
  before(async () => { p = await portal({}); });
  after(() => p.close());

  const post = (target, body, extra = "") => `POST ${target} HTTP/1.1\r\nHost: portal.example\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}Connection: close\r\n\r\n${body}`;
  const chunked = (target, chunks, method = "POST") => `${method} ${target} HTTP/1.1\r\nHost: portal.example\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunks.map((c) => `${c.length.toString(16)}\r\n${c}\r\n`).join("")}0\r\n\r\n`;
  const filler = (n) => `{"x":"${"a".repeat(n - 8)}"}`; // valid JSON of exactly n bytes

  const LIMITS = [
    ["/api/email-otp/send", 2 * KB], ["/api/registrations", 4 * KB], ["/api/auth/login", 4 * KB], ["/api/auth/login/password", 4 * KB],
    ["/api/auth/password-reset/confirm", 4 * KB], ["/api/enrolments", 2 * KB], ["/api/live-location/start", 1 * KB], ["/api/onboarding/submit", 64 * KB],
  ];

  it("each route's limit is the one the policy states (the API's own: see apps/api/test/portal-proxy-integration.test.js)", () => {
    for (const [target, limit] of LIMITS) {
      const method = "POST";
      assert.equal(checkApiTarget("public", method, target).maxBody, limit, target);
    }
    assert.equal(checkApiTarget("public", "PUT", "/api/onboarding").maxBody, 64 * KB);
    assert.equal(checkApiTarget("staff", "POST", "/api/admin/auth/login").maxBody, 8 * KB);
    assert.equal(checkApiTarget("staff", "POST", `/api/admin/trips/${UUID}/itinerary`).maxBody, 8 * KB);
    assert.equal(checkApiTarget("staff", "PATCH", `/api/admin/trips/${UUID}/itinerary/${UUID}`).maxBody, 8 * KB);
    for (const [role, method, target] of [["public", "GET", "/api/auth/session"], ["public", "GET", "/api/onboarding/pdf"], ["public", "GET", "/api/live-location"], ["staff", "GET", "/api/admin/itinerary/trips"]]) {
      assert.equal(checkApiTarget(role, method, target).maxBody, 0, `${method} ${target} takes no body`);
    }
  });

  it("a body exactly at the limit goes through whole; one byte over is refused with 413 before the API hears of it", async () => {
    for (const [target, limit] of LIMITS) {
      const before = p.upstream.calls.length;
      const ok = await exchange(p.port, post(target, filler(limit)), { wait: 400 });
      assert.equal(ok.status, 200, `${target} at ${limit}`);
      assert.equal(p.upstream.calls.at(-1).bytes, limit, `${target}: the whole body arrived`);
      assert.equal(p.upstream.calls.length, before + 1);
      const over = await exchange(p.port, post(target, filler(limit + 1)), { wait: 400 });
      assert.equal(over.status, 413, `${target} at ${limit + 1}`);
      assert.deepEqual(JSON.parse(over.body), { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large." } });
      assert.equal(p.upstream.calls.length, before + 1, `${target}: the over-limit request never reached the API`);
    }
  });

  it("the Sales portal's limit is 8 KB", async () => {
    const q = await portal({ role: "staff" });
    try {
      assert.equal((await exchange(q.port, post("/api/admin/auth/login", filler(8 * KB)), { wait: 400 })).status, 200);
      assert.equal((await exchange(q.port, post("/api/admin/auth/login", filler(8 * KB + 1)), { wait: 400 })).status, 413);
      assert.equal(q.upstream.calls.length, 1);
    } finally {
      await q.close();
    }
  });

  it("an enormous declared length is refused at once, without reading a byte of the body", async () => {
    const before = p.upstream.calls.length;
    const r = await exchange(p.port, `POST /api/auth/login HTTP/1.1\r\nHost: portal.example\r\nContent-Length: 10000000000\r\nConnection: close\r\n\r\n{"a":1}`, { wait: 400 });
    assert.equal(r.status, 413);
    assert.equal(p.upstream.calls.length, before);
    assert.match(r.data, /connection: close/i);
  });

  it("a chunked body (no declared length) is counted as it streams and stopped at the limit; the API receives no more than the limit", async () => {
    const before = p.upstream.calls.length;
    p.upstream.partials.length = 0;
    const chunks = Array.from({ length: 200 }, () => "a".repeat(1024)); // 200 KB toward a 4 KB route
    const r = await exchange(p.port, chunked("/api/registrations", chunks), { wait: 600 });
    assert.equal(r.status, 413);
    assert.equal(p.upstream.calls.length, before, "the request never completed at the API");
    assert.ok(Math.max(0, ...p.upstream.partials) <= 4 * KB, `the API was handed at most the limit (${Math.max(0, ...p.upstream.partials)} bytes)`);
  });

  it("a chunked body within the limit goes through intact", async () => {
    const r = await exchange(p.port, chunked("/api/registrations", ["{\"a\":", "1}"]), { wait: 400 });
    assert.equal(r.status, 200);
    assert.equal(p.upstream.calls.at(-1).bytes, 7);
  });

  it("a stream far bigger than the limit never builds up in the server: the API is handed no more than the limit and the socket is closed", async () => {
    p.upstream.partials.length = 0;
    p.upstream.calls.length = 0;
    let written = 0;
    const r = await exchange(p.port, `POST /api/auth/login HTTP/1.1\r\nHost: portal.example\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`, {
      wait: 1500,
      after: (sock) => {
        const piece = `${(64 * KB).toString(16)}\r\n${"a".repeat(64 * KB)}\r\n`;
        const pump = () => { // 50 MB offered, as fast as the socket takes it
          while (written < 50 * 1024 * 1024) {
            if (!sock.write(piece)) return void sock.once("drain", pump);
            written += 64 * KB;
          }
        };
        pump();
      },
    });
    // The server answers 413 and closes. A client that is still pushing data may see the connection reset before it reads the
    // answer (status 0 here), which is the same refusal.
    assert.ok([413, 0].includes(r.status), `refused with 413 or a reset (got ${r.status})`);
    assert.equal(r.closed, true, "the connection was closed");
    assert.equal(p.upstream.calls.length, 0, "no request completed at the API");
    assert.ok(Math.max(0, ...p.upstream.partials) <= 4 * KB, "the API was handed at most the limit");
    assert.ok(written < 50 * 1024 * 1024, `the server stopped taking the upload (${Math.round(written / KB)} KB offered)`);
  });

  it("a GET carries no body: any body, declared or chunked, is refused", async () => {
    const before = p.upstream.calls.length;
    const declared = await exchange(p.port, `GET /api/auth/session HTTP/1.1\r\nHost: portal.example\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`, { wait: 300 });
    assert.equal(declared.status, 413);
    const withChunks = await exchange(p.port, chunked("/api/auth/session", ["{}"], "GET"), { wait: 300 });
    assert.equal(withChunks.status, 413);
    assert.equal(p.upstream.calls.length, before);
    assert.equal((await exchange(p.port, `GET /api/auth/session HTTP/1.1\r\nHost: portal.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, { wait: 300 })).status, 200, "an empty body is fine");
  });

  it("a blocked request with a huge body is answered at once and the connection closed, without waiting for the upload", async () => {
    const r = await exchange(p.port, `POST /api/admin/auth/login HTTP/1.1\r\nHost: portal.example\r\nContent-Length: 10000000000\r\n\r\n{"a":1}`, { wait: 700 });
    assert.equal(r.status, 404);
    assert.match(r.data, /connection: close/i);
    assert.equal(r.closed, true, "the server closed the connection instead of waiting for the rest of the body");
  });

  it("legitimate sizes are untouched: a 60 KB draft save and the PDF download (a response, not a request)", async () => {
    assert.equal((await exchange(p.port, `PUT /api/onboarding HTTP/1.1\r\nHost: portal.example\r\nContent-Type: application/json\r\nContent-Length: ${60 * KB}\r\nConnection: close\r\n\r\n${filler(60 * KB)}`, { wait: 500 })).status, 200);
    assert.equal((await exchange(p.port, `GET /api/onboarding/pdf HTTP/1.1\r\nHost: portal.example\r\nConnection: close\r\n\r\n`, { wait: 300 })).status, 200);
  });
});

describe("slow or stalled request bodies cannot hold a connection forever", () => {
  it("the server has explicit header and request timeouts (Node's defaults, written down so they cannot be set to 0)", async () => {
    const p = await portal({});
    try {
      assert.equal(p.server.requestTimeout, 300_000);
      assert.equal(p.server.headersTimeout, 60_000);
      assert.ok(p.server.headersTimeout <= p.server.requestTimeout);
    } finally {
      await p.close();
    }
  });

  it("a connection that starts a body and then stalls is closed by the request timeout, and nothing completes at the API", async () => {
    const p = await portal({ requestTimeoutMs: 400, headersTimeoutMs: 300, checkIntervalMs: 100 });
    try {
      const r = await exchange(p.port, `POST /api/auth/login HTTP/1.1\r\nHost: portal.example\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a":`, { wait: 2500 });
      assert.equal(r.closed, true, "the stalled connection was closed");
      assert.ok([408, 0].includes(r.status), `answered 408 or just closed (got ${r.status})`);
      assert.equal(p.upstream.calls.length, 0, "the unfinished request never completed at the API");
    } finally {
      await p.close();
    }
  });

  it("an upload abandoned half-way is dropped at the API at once, not left open until a timeout", async () => {
    const p = await portal({});
    try {
      p.upstream.partials.length = 0;
      await exchange(p.port, `POST /api/auth/login HTTP/1.1\r\nHost: portal.example\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a":`, {
        wait: 800,
        after: (sock) => setTimeout(() => sock.destroy(), 150), // the client gives up
      });
      assert.ok(p.upstream.partials.length > 0, "the API saw its request end as soon as the client left");
      assert.equal(p.upstream.calls.length, 0, "and it never completed");
    } finally {
      await p.close();
    }
  });

  it("a client that sends headers one byte at a time and never finishes is closed too", async () => {
    const p = await portal({ requestTimeoutMs: 500, headersTimeoutMs: 300, checkIntervalMs: 100 });
    try {
      const r = await exchange(p.port, "GET /api/auth/session HTTP/1.1\r\nHost: portal.exa", { wait: 2500 });
      assert.equal(r.closed, true);
      assert.equal(p.upstream.calls.length, 0);
    } finally {
      await p.close();
    }
  });

  it("an ordinary request on a server with the same short timeouts is unaffected", async () => {
    const p = await portal({ requestTimeoutMs: 2000, headersTimeoutMs: 1000, checkIntervalMs: 100 });
    try {
      assert.equal((await exchange(p.port, get("Host: portal.example\r\n"), { wait: 300 })).status, 200);
    } finally {
      await p.close();
    }
  });
});
