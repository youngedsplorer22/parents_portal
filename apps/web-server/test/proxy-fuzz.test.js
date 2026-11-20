import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { isIP } from "node:net";
import { checkApiTarget } from "../src/api-policy.js";
import { createWebServer } from "../src/server.js";

// A seeded, repeatable attack run against the real server. The invariant is simple: whatever bytes a browser sends, the only
// thing the (recording) API can ever see is an exactly allowlisted call, with one valid address and no forged header.
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const BASES = [
  "/api/auth/login", "/api/auth/session", "/api/registrations", "/api/email-otp/send", "/api/onboarding", "/api/onboarding/pdf", "/api/onboarding/submit",
  "/api/live-location", "/api/live-location/start", `/api/enrolments/${UUID}/itinerary`, "/api/join/a-school/main/a-trip", "/api/school-logos/a-school/main",
  "/api/admin/auth/login", "/api/admin/auth/session", "/api/admin/itinerary/trips", `/api/admin/trips/${UUID}/itinerary`, `/api/admin/trips/${UUID}/itinerary/${UUID}`,
  "/api/admin/schools", "/api/admin/staff", "/api/admin/audit", `/api/admin/trips/${UUID}/live-location/team-lead`, "/api/mobile/auth/login", "/api/mobile/me",
  "/api/health", "/api/health/ready", "/api/enrolments", "/api/auth/password", "/api",
];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
const MUTATIONS = [
  (p) => p,
  (p) => p.toUpperCase(),
  (p) => p.replace("/api", "/API"),
  (p) => p.replace("/api", "/Api"),
  (p) => `${p}/`,
  (p) => `${p}//`,
  (p) => p.replace("/api/", "/api//"),
  (p) => `/${p}`,
  (p) => p.replace(/\//g, "//"),
  (p) => `${p}%00`,
  (p) => `${p}%0d%0a`,
  (p) => `${p}%20`,
  (p) => `${p};x=1`,
  (p) => p.replace("/api", "/api;x"),
  (p) => p.replace("/api/", "/api\\"),
  (p) => p.replace(/\//g, "\\"),
  (p) => p.replace("/api", "/%61pi"),
  (p) => p.replace("/api", "/%41PI"),
  (p) => p.replace("/api/", "/api%2f"),
  (p) => p.replace(/\//g, "%2f"),
  (p) => p.replace(/\//g, "%2F"),
  (p) => p.replace("/api/", "/api/%2e%2e/api/"),
  (p) => p.replace("/api/", "/api/../api/"),
  (p) => p.replace("/api/", "/api/./"),
  (p) => `/api/auth/..${p.slice(4)}`,
  (p) => `/x/..${p}`,
  (p) => `/.%2e${p}`,
  (p) => `/%2e%2e${p}`,
  (p) => `/%252e%252e${p}`,
  (p) => `${p}?x=1`,
  (p) => `${p}?`,
  (p) => `${p}?enrolment=${UUID}`,
  (p) => `${p}?enrolment=${UUID}&enrolment=${UUID}`,
  (p) => `${p}?enrolment=${UUID}%00`,
  (p) => `${p}?v=1&v=2`,
  (p) => `${p}#frag`,
  (p) => `${p}\t`,
  (p) => `${p}é`,
  (p) => p.replace("a", "а"),
  (p) => p.replace(/-/g, "%2d"),
  (p) => `http://evil.example${p}`,
  (p) => `//evil.example${p}`,
  (p) => p.split("").map((c, i) => (i % 3 === 0 ? c.toUpperCase() : c)).join(""),
  (p) => p.replace(/[a-z]/, (c) => `%${c.charCodeAt(0).toString(16)}`),
];

let seed = 20261120;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pickOne = (a) => a[Math.floor(rnd() * a.length)];

/** Writes the request line exactly as given; resolves with the status line's code (0 if the server just closed the socket). */
function raw(port, method, target, headers = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      const lines = [`${method} ${target} HTTP/1.1`, "Host: portal.example", "Connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      sock.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
    sock.on("error", () => resolve(0));
    sock.setTimeout(4000, () => sock.destroy());
  });
}

// One recording API per portal, so a slow run of one portal can never leak requests into the other's record.
const sites = {};
before(async () => {
  for (const role of ["public", "staff"]) {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const dir = mkdtempSync(path.join(tmpdir(), "fuzz-"));
    writeFileSync(path.join(dir, "index.html"), "<html>shell</html>");
    const server = createWebServer({ staticDir: dir, apiUrl: `http://127.0.0.1:${upstream.address().port}`, role, portalSecret: role === "public" ? "k".repeat(40) : null, clientIpSource: { mode: "xff", hops: 1 } });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    sites[role] = { server, upstream, seen, port: server.address().port };
  }
});
after(async () => {
  for (const s of Object.values(sites)) {
    s.server.close();
    await new Promise((r) => s.upstream.close(r));
  }
});

describe("path attacks: only exactly allowlisted calls ever reach the API", () => {
  for (const role of ["public", "staff"]) {
    it(`${role} portal: ${BASES.length} targets x ${MUTATIONS.length} spellings x methods`, async () => {
      const { seen } = sites[role];
      seen.length = 0;
      let sent = 0;
      for (const base of BASES) {
        for (const mutate of MUTATIONS) {
          for (const method of [pickOne(METHODS), pickOne(METHODS), "GET", "POST"]) {
            let target;
            try {
              target = mutate(base);
            } catch {
              continue;
            }
            if (/[\r\n]/.test(target)) continue; // those can only be sent encoded; the encoded forms are in the list
            await raw(sites[role].port, method, target);
            sent++;
          }
        }
      }
      assert.ok(sent > 3000, `sent ${sent}`);
      for (const call of seen) {
        const verdict = checkApiTarget(role, call.method, call.url);
        assert.ok(verdict.ok && verdict.target === call.url, `${role}: the API was handed ${call.method} ${JSON.stringify(call.url)}`);
      }
    });
  }
});

describe("header attacks: the API only ever sees one valid address and no forged header", () => {
  const NAMES = ["X-Forwarded-For", "X-Real-IP", "Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Forwarded-Port", "X-Client-IP", "True-Client-IP", "CF-Connecting-IP", "X-Portal-Key", "X-Portal-Template", "X-PORTAL-KEY", "x-portal-other", "Via", "X-Original-Forwarded-For"];
  const VALUES = ["6.6.6.6", "6.6.6.6, 7.7.7.7", "::1", "::ffff:6.6.6.6", "unknown", "", " ", "1.2.3.4:80", "[::1]:80", "999.1.1.1", "for=6.6.6.6", "a".repeat(300), "1.1.1.1, ".repeat(40), "k".repeat(40), "evil.example", "é", "1.2.3.4\u0000"];
  it("holds for 300 random header sets per portal (xff:1 mode; the other modes are covered in server.test.js)", async () => {
    for (const role of ["public", "staff"]) {
      const { seen } = sites[role];
      seen.length = 0;
      const okTarget = role === "public" ? ["POST", "/api/auth/login"] : ["POST", "/api/admin/auth/login"];
      for (let i = 0; i < 300; i++) {
        const headers = {};
        for (let j = 0, n = 1 + Math.floor(rnd() * 6); j < n; j++) {
          const value = pickOne(VALUES);
          if (/[\r\n\u0000]/.test(value) || /[^\x20-\x7e]/.test(value)) continue; // not sendable as a header value
          headers[pickOne(NAMES)] = value;
        }
        await raw(sites[role].port, okTarget[0], okTarget[1], headers);
      }
      assert.ok(seen.length > 100, `${role}: ${seen.length} reached the API`);
      for (const call of seen) {
        const h = call.headers;
        const xff = h["x-forwarded-for"];
        assert.ok(xff === undefined || (isIP(xff) !== 0 && !/[,\s]/.test(xff)), `${role}: x-forwarded-for ${JSON.stringify(xff)}`);
        for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", "x-client-ip", "true-client-ip", "cf-connecting-ip", "via", "x-original-forwarded-for", "x-portal-template", "x-portal-other"]) {
          assert.equal(h[name], undefined, `${role}: ${name} reached the API`);
        }
        if (role === "public") assert.equal(h["x-portal-key"], "k".repeat(40), "only the portal's own key");
        else assert.equal(h["x-portal-key"], undefined, "the Sales portal never has one");
      }
    }
  });
});
