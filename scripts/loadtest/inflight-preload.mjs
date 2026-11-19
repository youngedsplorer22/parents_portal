// TEST-ONLY probe. Loaded with `node --import`, it observes the API from the inside WITHOUT changing application code:
//   * true in-flight HTTP requests (counted from the server's own 'request' event to the response's 'close'),
//     including the time-weighted share of the run spent at or above THRESHOLD (default 100);
//   * pg pool size / idle / waiting, how long callers waited for a connection, and connection timeouts;
//   * every SQL statement's duration (percentiles, and the top statements by total time), measured at the driver;
//   * scrypt (password hashing) throughput, duration (includes waiting for a worker thread) and how many ran at once.
// Writes one JSON line per second to $PROBE_FILE (default loadtest-probe.jsonl) and a summary to $PROBE_FILE.summary.json on exit.
//
//   PROBE_FILE=run1-probe.jsonl node --import ./scripts/loadtest/inflight-preload.mjs apps/api/src/server.js
//
// It is only a measurement aid. Never preload it in production.
import http from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import pg from "pg";

const FILE = process.env.PROBE_FILE || "loadtest-probe.jsonl";
const THRESHOLD = Number(process.env.PROBE_THRESHOLD || 100);
const t0 = Date.now();
let inflight = 0, max = 0, last = performance.now(), msAtOrAbove = 0, weighted = 0, total = 0, completed = 0;
const pools = new Set();
const waits = [];            // pool connect waits in ms (bounded sample)
let scryptPeakPerSec = 0;
let connectErrors = 0, connectTimeouts = 0, maxWaiting = 0, maxPoolTotal = 0;

function tick(delta) {
  const now = performance.now(), dt = now - last;
  weighted += inflight * dt; total += dt;
  if (inflight >= THRESHOLD) msAtOrAbove += dt;
  last = now; inflight += delta; if (inflight > max) max = inflight;
}

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res, ...rest) {
  if (event === "request" && res) { tick(+1); res.once("close", () => { tick(-1); completed++; }); }
  return emit.call(this, event, req, res, ...rest);
};

const connect = pg.Pool.prototype.connect;
pg.Pool.prototype.connect = function (cb) {
  pools.add(this);
  const start = performance.now();
  const note = (err) => {
    if (err) { connectErrors++; if (/timeout/i.test(err.message)) connectTimeouts++; }
    else if (waits.length < 200000) waits.push(performance.now() - start);
  };
  if (typeof cb === "function") return connect.call(this, (err, ...a) => { note(err); cb(err, ...a); });
  return connect.call(this).then((c) => { note(); return c; }, (e) => { note(e); throw e; });
};

// SQL statement timing (driver level; Pool.query goes through Client.query).
const qStats = new Map(), qLat = [];
let qCount = 0, qErrors = 0;
const noteQuery = (text, ms, failed) => {
  qCount++; if (failed) qErrors++; if (qLat.length < 500000) qLat.push(ms);
  const key = String(text ?? "?").replace(/\s+/g, " ").trim().slice(0, 90);
  const e = qStats.get(key) ?? { n: 0, totalMs: 0, maxMs: 0 }; e.n++; e.totalMs += ms; if (ms > e.maxMs) e.maxMs = ms; qStats.set(key, e);
};
const clientQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const a0 = args[0];
  if (a0 && typeof a0 === "object" && typeof a0.submit === "function") return clientQuery.apply(this, args); // cursors etc.: untouched
  const text = typeof a0 === "string" ? a0 : a0?.text, start = performance.now();
  const last = args[args.length - 1];
  if (typeof last === "function") { args[args.length - 1] = function (err, ...r) { noteQuery(text, performance.now() - start, Boolean(err)); return last.call(this, err, ...r); }; return clientQuery.apply(this, args); }
  const out = clientQuery.apply(this, args);
  return out && typeof out.then === "function" ? out.then((v) => { noteQuery(text, performance.now() - start, false); return v; }, (e) => { noteQuery(text, performance.now() - start, true); throw e; }) : out;
};

// scrypt (the password hash): counts, durations, and concurrently running jobs.
let scryptRunning = 0, scryptMaxRunning = 0, scryptDone = 0, scryptDoneAtLastTick = 0;
const scryptMs = [];
const scryptOrig = crypto.scrypt;
crypto.scrypt = function (password, salt, keylen, options, cb) {
  if (typeof options === "function") { cb = options; options = undefined; }
  const start = performance.now(); scryptRunning++; if (scryptRunning > scryptMaxRunning) scryptMaxRunning = scryptRunning;
  const wrapped = (...r) => { scryptRunning--; scryptDone++; if (scryptMs.length < 200000) scryptMs.push(performance.now() - start); return cb(...r); };
  return options === undefined ? scryptOrig.call(crypto, password, salt, keylen, wrapped) : scryptOrig.call(crypto, password, salt, keylen, options, wrapped);
};
syncBuiltinESMExports(); // so `import { scrypt } from "node:crypto"` in the application sees the wrapper

const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)] : null);
const poolNow = () => { let total = 0, idle = 0, waiting = 0; for (const p of pools) { total += p.totalCount; idle += p.idleCount; waiting += p.waitingCount; } return { total, idle, waiting }; };

const timer = setInterval(() => {
  tick(0);
  const p = poolNow(); if (p.waiting > maxWaiting) maxWaiting = p.waiting; if (p.total > maxPoolTotal) maxPoolTotal = p.total;
  const sc = scryptDone - scryptDoneAtLastTick; scryptDoneAtLastTick = scryptDone; if (sc > scryptPeakPerSec) scryptPeakPerSec = sc;
  appendFileSync(FILE, JSON.stringify({ t: Math.round((Date.now() - t0) / 1000), inflight, maxInflight: max, completed, pool: p, connectErrors, scrypt: { running: scryptRunning, donePerSec: sc }, queries: qCount, rssMb: Math.round(process.memoryUsage().rss / 1048576) }) + "\n");
}, 1000);
timer.unref();

process.on("exit", () => {
  tick(0);
  writeFileSync(`${FILE}.summary.json`, JSON.stringify({
    seconds: Math.round(total / 1000), threshold: THRESHOLD, maxInflight: max, avgInflight: total ? +(weighted / total).toFixed(2) : 0,
    secondsAtOrAboveThreshold: +(msAtOrAbove / 1000).toFixed(1), requestsCompleted: completed,
    scrypt: { total: scryptDone, avgPerSec: total ? +(scryptDone / (total / 1000)).toFixed(2) : 0, peakPerSec: scryptPeakPerSec, maxRunning: scryptMaxRunning, durationMs: { p50: pct(scryptMs, 50), p95: pct(scryptMs, 95), p99: pct(scryptMs, 99) } },
    queries: { total: qCount, errors: qErrors, ms: { p50: pct(qLat, 50), p95: pct(qLat, 95), p99: pct(qLat, 99), max: qLat.length ? Math.max(...qLat) : null },
      topByTotalTime: [...qStats].sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, 12).map(([sql, e]) => ({ sql, calls: e.n, totalMs: Math.round(e.totalMs), avgMs: +(e.totalMs / e.n).toFixed(2), maxMs: Math.round(e.maxMs) })) },
    pool: { maxTotal: maxPoolTotal, maxWaiting, connectWaitMs: { p50: pct(waits, 50), p95: pct(waits, 95), p99: pct(waits, 99), max: waits.length ? Math.max(...waits) : null }, connectErrors, connectTimeouts },
  }, null, 2));
});
