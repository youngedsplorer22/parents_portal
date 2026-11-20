// Fake SMTP sink for load tests: no mail ever leaves this machine. Accepts any message after an optional delay, and
// answers an HTTP admin port so tests can read the one-time codes and the sink's own load.
//
//   SMTP_PORT=2525 ADMIN_PORT=2526 DELAY_MS=500 node scripts/loadtest/fake-smtp.mjs
//   API env: OTP_DELIVERY=smtp SMTP_HOST=localhost SMTP_PORT=2525 SMTP_SECURE=false SMTP_USER=x SMTP_PASSWORD=y SMTP_FROM=no-reply@loadtest.example.org
//   GET :2526/stats        -> { connectionsNow, connectionsMax, messages, queueDelayMs..., }
//   GET :2526/code?email=[&consume=1]  -> { code } (the newest 6-digit code mailed to that address; consume=1 forgets it)
import net from "node:net";
import http from "node:http";

const SMTP_PORT = Number(process.env.SMTP_PORT || 2525), ADMIN_PORT = Number(process.env.ADMIN_PORT || 2526), DELAY = Number(process.env.DELAY_MS || 0);
const FAIL_RATE = Number(process.env.FAIL_RATE || 0); // 0..1: answer "451" to simulate a provider outage
let now = 0, maxNow = 0, messages = 0, failed = 0;
const codes = new Map();
const delays = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

net.createServer((sock) => {
  now++; if (now > maxNow) maxNow = now;
  let buf = "", data = null, to = "";
  const w = (s) => sock.write(s + "\r\n");
  w("220 fake-smtp ready");
  sock.on("close", () => { now--; });
  sock.on("error", () => {});
  sock.on("data", async (chunk) => {
    buf += chunk.toString("utf8");
    for (;;) {
      if (data !== null) {
        data += buf; buf = ""; // the end marker can span two network chunks, so search the whole message so far
        const end = data.indexOf("\r\n.\r\n");
        if (end < 0) { if (data.length > 1e6) sock.destroy(); return; }
        const body = data.slice(0, end); buf = data.slice(end + 5); data = null;
        const started = Date.now();
        if (DELAY) await sleep(DELAY);
        if (Math.random() < FAIL_RATE) { failed++; w("451 try later"); continue; }
        const m = /verification code is (\d{6})/.exec(body.replace(/=\r?\n/g, ""));
        if (m && to) codes.set(to, m[1]);
        messages++; if (delays.length < 100000) delays.push(Date.now() - started);
        w("250 queued"); continue;
      }
      const nl = buf.indexOf("\r\n"); if (nl < 0) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO") { sock.write("250-fake-smtp\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n"); }
      else if (cmd === "HELO") w("250 fake-smtp");
      else if (cmd === "AUTH") w("235 ok");
      else if (cmd === "MAIL") w("250 ok");
      else if (cmd === "RCPT") { to = /<([^>]+)>/.exec(line)?.[1]?.toLowerCase() ?? ""; w("250 ok"); }
      else if (cmd === "DATA") { data = ""; w("354 go"); }
      else if (cmd === "RSET") { to = ""; w("250 ok"); }
      else if (cmd === "QUIT") { w("221 bye"); sock.end(); return; }
      else w("250 ok");
    }
  });
}).listen(SMTP_PORT, "127.0.0.1", () => console.log(`fake SMTP on 127.0.0.1:${SMTP_PORT}, delay ${DELAY} ms, fail rate ${FAIL_RATE}`));

const pct = (p) => (delays.length ? [...delays].sort((a, b) => a - b)[Math.min(delays.length - 1, Math.ceil((p / 100) * delays.length) - 1)] : null);
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("Content-Type", "application/json");
  if (u.pathname === "/stats") return res.end(JSON.stringify({ connectionsNow: now, connectionsMax: maxNow, messages, failed, deliveryMs: { p50: pct(50), p95: pct(95), p99: pct(99) } }));
  if (u.pathname === "/code") { // ?consume=1 removes it, so a reused address can never read a stale code
    const k = (u.searchParams.get("email") || "").toLowerCase(), c = codes.get(k);
    if (c && u.searchParams.get("consume") === "1") codes.delete(k);
    res.statusCode = c ? 200 : 404; return res.end(JSON.stringify({ code: c ?? null }));
  }
  res.statusCode = 404; res.end("{}");
}).listen(ADMIN_PORT, "127.0.0.1");
