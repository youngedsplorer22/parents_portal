import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUpstreamHeaders, normalizeIp, parseClientIpSource, selectClientAddress } from "../src/client-ip.js";

describe("CLIENT_IP_SOURCE: only three exact forms, never guessed", () => {
  it("accepts xff:<n> for 1 to 8, x-real-ip and peer", () => {
    assert.deepEqual(parseClientIpSource("xff:1"), { mode: "xff", hops: 1 });
    assert.deepEqual(parseClientIpSource("xff:2"), { mode: "xff", hops: 2 });
    assert.deepEqual(parseClientIpSource("xff:8"), { mode: "xff", hops: 8 });
    assert.deepEqual(parseClientIpSource("x-real-ip"), { mode: "x-real-ip" });
    assert.deepEqual(parseClientIpSource("peer"), { mode: "peer" });
  });
  it("refuses everything else: empty, zero, too many, padded, other case, other words", () => {
    for (const bad of [undefined, null, "", " ", "xff", "xff:", "xff:0", "xff:9", "xff:10", "xff:-1", "xff:1.5", "xff:01", "xff: 1", " xff:1", "XFF:1", "Xff:1", "x-real-ip ", "X-Real-IP", "real-ip", "peer ", "PEER", "auto", "edge", "cloudflare", "true", "1", 1, {}, []]) {
      assert.equal(parseClientIpSource(bad), null, JSON.stringify(bad));
    }
  });
});

describe("addresses are validated with net.isIP and normalised", () => {
  it("accepts IPv4 and IPv6, and gives IPv4-mapped IPv6 as plain IPv4", () => {
    assert.equal(normalizeIp("203.0.113.9"), "203.0.113.9");
    assert.equal(normalizeIp("  203.0.113.9  "), "203.0.113.9");
    assert.equal(normalizeIp("::ffff:203.0.113.9"), "203.0.113.9");
    assert.equal(normalizeIp("::FFFF:203.0.113.9"), "203.0.113.9");
    assert.equal(normalizeIp("::ffff:cb00:7109"), "203.0.113.9");
    assert.equal(normalizeIp("2001:DB8::1"), "2001:db8::1");
    assert.equal(normalizeIp("::1"), "::1");
  });
  it("gives one canonical text for one IPv6 address, so spelling cannot make a second bucket", () => {
    const spellings = ["2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001", "2001:DB8:0:0:0:0:0:1", "2001:db8:0::1"];
    assert.equal(new Set(spellings.map(normalizeIp)).size, 1);
  });
  it("refuses anything that is not exactly one address", () => {
    for (const bad of [undefined, null, 5, {}, "", " ", "unknown", "localhost", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.4:5678", "[2001:db8::1]", "[2001:db8::1]:443", "fe80::1%eth0", "1.2.3.4, 5.6.7.8", "1.2.3.4 5.6.7.8", "1.2.3.4;x", "1.2.3.4\r\nX: y", "1.2.3.4\u0000", "::ffff:", "::ffff:999.1.1.1", "a".repeat(100), "1.2.3.4/24", "0x7f.0.0.1", "2130706433"]) {
      assert.equal(normalizeIp(bad), null, JSON.stringify(bad));
    }
  });
});

describe("choosing the client address from what the edge reported", () => {
  const peer = "100.64.0.7";
  const pick = (source, headers, p = peer) => selectClientAddress(parseClientIpSource(source), headers, p);

  it("peer: the connecting address, whatever the headers say", () => {
    assert.equal(pick("peer", { "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" }).address, peer);
    assert.equal(pick("peer", {}).address, peer);
  });

  it("xff:1 takes the rightmost entry, so an edge that appends or replaces works and a spoofed left side is ignored", () => {
    assert.equal(pick("xff:1", { "x-forwarded-for": "203.0.113.9" }).address, "203.0.113.9"); // edge replaced
    assert.equal(pick("xff:1", { "x-forwarded-for": "6.6.6.6, 203.0.113.9" }).address, "203.0.113.9"); // edge appended after a spoof
    assert.equal(pick("xff:1", { "x-forwarded-for": "6.6.6.6, 5.5.5.5, 4.4.4.4, 203.0.113.9" }).address, "203.0.113.9");
  });

  it("xff:2 takes the second from the right (an edge that adds one more hop after the client)", () => {
    assert.equal(pick("xff:2", { "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.5" }).address, "203.0.113.9");
    assert.equal(pick("xff:3", { "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.0.0.5, 10.0.0.6" }).address, "203.0.113.9");
  });

  it("xff:n with fewer entries than n never reaches for a caller-chosen entry: it falls back to the peer", () => {
    assert.equal(pick("xff:2", { "x-forwarded-for": "6.6.6.6" }).address, peer);
    assert.equal(pick("xff:3", { "x-forwarded-for": "6.6.6.6, 5.5.5.5" }).address, peer);
    assert.equal(pick("xff:1", {}).address, peer);
    assert.equal(pick("xff:1", { "x-forwarded-for": "" }).address, peer);
  });

  it("an invalid selected entry falls back to the peer; it never skips to another entry", () => {
    for (const bad of ["unknown", "1.2.3.4:80", "1.2.3.4, unknown", "6.6.6.6, , ", "6.6.6.6, 999.1.1.1", "6.6.6.6, [::1]", "6.6.6.6, ::ffff:", "6.6.6.6, 1.2.3.4 5.6.7.8"]) {
      const r = pick("xff:1", { "x-forwarded-for": bad });
      assert.equal(r.address, peer, bad);
      assert.equal(r.source, "peer-fallback", bad);
    }
    assert.equal(pick("xff:2", { "x-forwarded-for": "garbage, 6.6.6.6, 203.0.113.9" }).address, "6.6.6.6", "n picks by position only");
  });

  it("x-real-ip takes that header only when it is exactly one valid address", () => {
    assert.equal(pick("x-real-ip", { "x-real-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6" }).address, "203.0.113.9");
    assert.equal(pick("x-real-ip", { "x-real-ip": "::ffff:203.0.113.9" }).address, "203.0.113.9");
    for (const bad of [undefined, "", "unknown", "1.2.3.4, 5.6.7.8", "1.2.3.4:80", "example.com"]) {
      assert.equal(pick("x-real-ip", { "x-real-ip": bad, "x-forwarded-for": "6.6.6.6" }).address, peer, String(bad));
    }
  });

  it("the peer is normalised too, and a missing peer gives no address (the API then uses its own socket)", () => {
    assert.equal(pick("peer", {}, "::ffff:100.64.0.7").address, "100.64.0.7");
    assert.equal(pick("peer", {}, null).address, null);
    assert.equal(pick("xff:1", { "x-forwarded-for": "garbage" }, null).address, null);
  });

  it("reports which source produced the address", () => {
    assert.equal(pick("xff:1", { "x-forwarded-for": "203.0.113.9" }).source, "xff");
    assert.equal(pick("x-real-ip", { "x-real-ip": "203.0.113.9" }).source, "x-real-ip");
    assert.equal(pick("peer", {}).source, "peer");
  });
});

describe("the headers sent to the API", () => {
  const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"]);
  const incoming = {
    host: "portal.example",
    cookie: "a=b",
    origin: "https://portal.example",
    "content-type": "application/json",
    "content-length": "2",
    "user-agent": "t",
    "x-forwarded-for": "6.6.6.6, 203.0.113.9",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "http",
    "x-forwarded-port": "1",
    "x-forwarded-server": "evil",
    "x-forwarded-anything": "x",
    forwarded: "for=6.6.6.6;host=evil.example",
    "x-real-ip": "7.7.7.7",
    "x-client-ip": "8.8.8.8",
    "true-client-ip": "9.9.9.9",
    "cf-connecting-ip": "1.1.1.1",
    "fastly-client-ip": "2.2.2.2",
    "x-cluster-client-ip": "3.3.3.3",
    "x-original-forwarded-for": "4.4.4.4",
    via: "1.1 evil",
    "x-portal-key": "browser-chose-this",
    "x-portal-template": "domestic_none",
    "X-Portal-Other": "x",
    connection: "keep-alive",
  };
  const out = buildUpstreamHeaders(incoming, { hopByHop: HOP, portalSecret: "s".repeat(40), address: "203.0.113.9" });

  it("sends exactly one X-Forwarded-For address, the validated one", () => {
    assert.equal(out["x-forwarded-for"], "203.0.113.9");
  });
  it("removes every other forwarding or client-address header a browser could have set", () => {
    for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-forwarded-server", "x-forwarded-anything", "x-real-ip", "x-client-ip", "true-client-ip", "cf-connecting-ip", "fastly-client-ip", "x-cluster-client-ip", "x-original-forwarded-for", "via"]) {
      assert.equal(Object.keys(out).some((k) => k.toLowerCase() === name), false, name);
    }
  });
  it("replaces any browser x-portal-* header with the server's own key", () => {
    assert.equal(out["x-portal-key"], "s".repeat(40));
    assert.equal(Object.keys(out).filter((k) => k.toLowerCase().startsWith("x-portal-")).length, 1);
  });
  it("sends no portal key at all for a portal without a secret, and never a browser's", () => {
    const none = buildUpstreamHeaders(incoming, { hopByHop: HOP, portalSecret: null, address: "203.0.113.9" });
    assert.equal(Object.keys(none).some((k) => k.toLowerCase().startsWith("x-portal-")), false);
  });
  it("keeps what the API needs: Host, cookie, origin, content headers", () => {
    assert.equal(out.host, "portal.example");
    assert.equal(out.cookie, "a=b");
    assert.equal(out.origin, "https://portal.example");
    assert.equal(out["content-type"], "application/json");
    assert.equal(out["user-agent"], "t");
    assert.equal(out.connection, undefined, "hop-by-hop headers are dropped");
  });
  it("drops header names with an underscore, which some servers read as the hyphenated name", () => {
    const o = buildUpstreamHeaders({ host: "h", x_portal_key: "forged", x_forwarded_for: "6.6.6.6", "x-ok": "1" }, { hopByHop: HOP, portalSecret: null, address: "203.0.113.9" });
    assert.equal(o.x_portal_key, undefined);
    assert.equal(o.x_forwarded_for, undefined);
    assert.equal(o["x-ok"], "1");
    assert.equal(o["x-forwarded-for"], "203.0.113.9");
  });
  it("sends no X-Forwarded-For at all when there is no valid address (the API then uses its own socket)", () => {
    const none = buildUpstreamHeaders(incoming, { hopByHop: HOP, portalSecret: null, address: null });
    assert.equal(Object.keys(none).some((k) => k.toLowerCase() === "x-forwarded-for"), false);
  });
  it("does not change the object it was given", () => {
    assert.equal(incoming["x-forwarded-for"], "6.6.6.6, 203.0.113.9");
  });
});
