// Turns the artefacts of ONE run into a pass/fail table against the criteria. Prints; changes nothing.
//
//   node scripts/loadtest/evaluate.mjs <registration|login|combined|concurrency|burst|capacity|integrity|ratelimit> \
//        --k6 run.summary.json [--probe probe.jsonl.summary.json] [--sink sink-stats.json] [--sample sample.csv]
//
// [CONFIRMED] = the lead's requirement (100 in flight, 100 RPS). [PROPOSED] = my suggestion, needs lead approval; change the
// numbers in CRITERIA only after approval, never silently. A run with an INVALID check is neither a pass nor a fail:
// fix the test (identities, rate-limit spread, seeded data) and run it again.
import { readFileSync, existsSync } from "node:fs";

const CRITERIA = {
  confirmed: { inflight: 100, rps: 100 },
  proposed: {
    minSecondsAtInflight: 120, rpsTolerance: 0.99,
    flowFailurePct: 0.5,            // valid flows that failed for any reason other than a deliberate 503, percent
    busy503Pct: 1,                  // deliberate SERVER_BUSY, percent of API requests at target load
    p95: { join: 300, session: 300, onboarding: 300, refresh: 500, logout: 500, otp_send: 1500, otp_verify: 500, login_otp: 500, register: 2000, login_pw: 1500 },
    p99: { join: 1000, session: 1000, onboarding: 1000, otp_send: 3000, otp_verify: 1500, login_otp: 1500, register: 4000, login_pw: 3000 },
    concurrencyBusy503Pct: 5, concurrencyP99Ms: 10000,
    poolWaitP95Ms: 100, connectTimeouts: 0, scryptP95Ms: 1500, smtpCodeWaitP95Ms: 100,
    dbConnPctOfMax: 80, cpuAvgPct: 70, rssGrowthPct: 10,
  },
};
const args = process.argv.slice(2), test = args[0];
const flag = (n) => { const i = args.indexOf(`--${n}`); return i > 0 ? args[i + 1] : null; };
const load = (f) => (f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
const k = load(flag("k6"))?.metrics, probe = load(flag("probe")), sink = load(flag("sink"));
if (!test || !k) { console.error("usage: evaluate.mjs <test> --k6 run.summary.json [--probe ...] [--sink ...] [--sample ...]"); process.exit(2); }
const v = (m, f) => k[m]?.[f] ?? k[m]?.values?.[f] ?? null;
const cnt = (m) => v(m, "count") ?? 0;
const P = CRITERIA.proposed, C = CRITERIA.confirmed, rows = [];
const row = (req, name, value, ok, note = "") => rows.push({ req, name, value, result: ok === null ? "n/a" : ok === "INVALID" ? "INVALID" : ok ? "PASS" : "FAIL", note });
const perf = ["registration", "login", "combined", "concurrency", "burst", "capacity"].includes(test);
const steady = ["registration", "login", "combined"].includes(test);
const api = cnt("api_requests"), pct = (n) => (api ? (n / api) * 100 : 0);

// Validity: a run that tripped its own test limits measures the limits, not the system.
if (perf) {
  row("[VALIDITY]", "429 rate-limit responses == 0 (identities spread; controls still ON)", cnt("resp_429_rate_limited"), cnt("resp_429_rate_limited") === 0 ? true : "INVALID", "429 means a per-IP/per-email limit was hit: see README 'Avoiding self-inflicted limits'");
  row("[VALIDITY]", "seeded identity pool not exhausted", cnt("test_identity_pool_exhausted"), cnt("test_identity_pool_exhausted") === 0 ? true : "INVALID", "seed more with seed.mjs");
  row("[VALIDITY]", "every OTP mail reached the sink", cnt("smtp_code_missing"), cnt("smtp_code_missing") === 0 ? true : "INVALID");
}
if (test === "concurrency" || test === "combined") {
  row("[CONFIRMED]", `max in flight >= ${C.inflight} (server probe)`, probe?.maxInflight ?? "no probe", probe ? probe.maxInflight >= C.inflight : null);
  row("[PROPOSED]", `seconds at >= ${C.inflight} in flight >= ${P.minSecondsAtInflight}`, probe?.secondsAtOrAboveThreshold ?? "no probe", probe ? probe.secondsAtOrAboveThreshold >= P.minSecondsAtInflight : null, probe ? `avg in flight ${probe.avgInflight}` : "");
}
if (steady) {
  const rps = v("api_requests", "rate"), dropped = cnt("dropped_iterations");
  row("[CONFIRMED]", `achieved API RPS >= ${C.rps}`, rps?.toFixed?.(1), rps != null && rps >= C.rps * P.rpsTolerance, `API requests only (sink polls excluded); tolerance ${P.rpsTolerance} PROPOSED; rate is over the whole run incl. ramp-up`);
  row("[PROPOSED]", "dropped iterations == 0", dropped, dropped === 0);
}
if (perf) {
  const u = cnt("resp_5xx_unexpected"), b = cnt("resp_503_busy");
  row("[PROPOSED]", "5xx other than deliberate 503, and timeouts/resets, == 0", u, u === 0);
  if (test === "concurrency") { // R1 run: queueing is expected, so only survival criteria apply (latency criteria belong to the steady 100 RPS tests)
    row("[PROPOSED]", `503 SERVER_BUSY <= ${P.concurrencyBusy503Pct}% of API requests`, pct(b).toFixed(2) + "%", pct(b) <= P.concurrencyBusy503Pct);
    for (const e of Object.keys(P.p95)) { const p99 = v(`latency_${e}`, "p(99)"); if (p99 != null) row("[PROPOSED]", `${e} p99 <= ${P.concurrencyP99Ms} ms (inside the request timeout)`, Math.round(p99), p99 <= P.concurrencyP99Ms); }
  }
  if (steady) {
    row("[PROPOSED]", `503 SERVER_BUSY <= ${P.busy503Pct}% of API requests`, pct(b).toFixed(2) + "%", pct(b) <= P.busy503Pct);
    let ok = 0, failed = 0; for (const f of ["R", "L", "O", "J", "sreg", "slogin", "sotp", "sprobe"]) { ok += cnt(`flow_ok_${f}`); failed += cnt(`flow_failed_${f}`); }
    const fp = ok + failed ? (failed / (ok + failed)) * 100 : 0;
    row("[PROPOSED]", `valid flows failed <= ${P.flowFailurePct}% (incl. busy)`, fp.toFixed(2) + "%", ok + failed ? fp <= P.flowFailurePct + P.busy503Pct : null, "failed = any step not returning its expected status");
    row("[INFO]", "rejections: validation 400/422 | auth 401/403 | conflict 409 | busy 503", `${cnt("resp_400_validation")} | ${cnt("resp_401_403_unexpected")} | ${cnt("resp_409_unexpected")} | ${b}`, null, "all must be explained; a valid flow should produce none except deliberate 503");
    for (const e of Object.keys(P.p95)) {
      const p95 = v(`latency_${e}`, "p(95)"), p99 = v(`latency_${e}`, "p(99)"); if (p95 == null) continue;
      row("[PROPOSED]", `${e} p95 <= ${P.p95[e]} ms` + (P.p99[e] ? `, p99 <= ${P.p99[e]} ms` : ""), `${Math.round(p95)} / ${Math.round(p99)}`, p95 <= P.p95[e] && (!P.p99[e] || p99 <= P.p99[e]), `p50 ${Math.round(v(`latency_${e}`, "med"))} ms`);
    }
  }
  if (probe) {
    const s = probe.scrypt;
    row("[INFO]", "scrypt hashes completed / avg per s / peak per s / max at once", `${s.total} / ${s.avgPerSec} / ${s.peakPerSec} / ${s.maxRunning}`, null, `compare with registrations 201 (${cnt("resp_register_201")}) + password logins 200 (${cnt("resp_login_pw_200")}); max at once is the effective hash concurrency`);
    row("[PROPOSED]", `scrypt p95 duration <= ${P.scryptP95Ms} ms (includes waiting for a worker thread)`, Math.round(s.durationMs.p95 ?? 0), (s.durationMs.p95 ?? 0) <= P.scryptP95Ms);
    row("[PROPOSED]", `pool connect wait p95 <= ${P.poolWaitP95Ms} ms`, probe.pool.connectWaitMs.p95?.toFixed?.(1), probe.pool.connectWaitMs.p95 <= P.poolWaitP95Ms, `max waiting callers ${probe.pool.maxWaiting}, max pool size ${probe.pool.maxTotal}`);
    row("[PROPOSED]", "pool connection timeouts == 0", probe.pool.connectTimeouts, probe.pool.connectTimeouts === P.connectTimeouts);
    row("[INFO]", "SQL statements: total / p50 / p95 / p99 / max (ms)", `${probe.queries.total} / ${probe.queries.ms.p50?.toFixed(1)} / ${probe.queries.ms.p95?.toFixed(1)} / ${probe.queries.ms.p99?.toFixed(1)} / ${probe.queries.ms.max?.toFixed(0)}`, null, "top statements by total time are in the probe summary file");
  }
  if (sink) {
    const sent = cnt("resp_otp_send_200");
    row("[PROPOSED]", "OTP mails delivered to sink == OTP sends answered 200", `${sink.messages} vs ${sent}`, sink.messages >= sent, "a send is 200 only if the API's own delivery succeeded; resends and 'alreadySent' answers send no mail, so >= is expected");
    row("[INFO]", "sink: max concurrent SMTP connections / delivery p50 p95 p99 ms / failed", `${sink.connectionsMax} / ${sink.deliveryMs.p50} ${sink.deliveryMs.p95} ${sink.deliveryMs.p99} / ${sink.failed}`, null, "no SMTP pooling today: one connection per mail");
    const w = v("smtp_code_wait", "p(95)"); if (w != null) row("[PROPOSED]", `code readable at sink within ${P.smtpCodeWaitP95Ms} ms p95 of the API answer`, Math.round(w), w <= P.smtpCodeWaitP95Ms, "API waits for delivery today, so this should be about 0; a queue would make it grow");
  }
  const sample = flag("sample");
  if (sample && existsSync(sample)) {
    const r = readFileSync(sample, "utf8").trim().split("\n").slice(1).map((l) => l.split(",").map(Number)).filter((x) => x.length >= 9 && !x.some(Number.isNaN));
    if (r.length) {
      const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length, cpu = avg(r.map((x) => x[1])), maxConn = Math.max(...r.map((x) => x[3])), maxC = r[0][8], n10 = Math.max(1, Math.floor(r.length / 10));
      const growth = ((avg(r.slice(-n10).map((x) => x[2])) - avg(r.slice(0, n10).map((x) => x[2]))) / avg(r.slice(0, n10).map((x) => x[2]))) * 100;
      row("[PROPOSED]", `API CPU average <= ${P.cpuAvgPct}% (of ONE core per ps; divide by cores)`, cpu.toFixed(0) + "%", null, "ps %cpu is per core: compare with vCPU count yourself");
      row("[PROPOSED]", `DB connections <= ${P.dbConnPctOfMax}% of max_connections`, `${maxConn} of ${maxC}`, maxConn <= (maxC * P.dbConnPctOfMax) / 100);
      row("[PROPOSED]", `RSS growth first vs last 10% <= ${P.rssGrowthPct}%`, growth.toFixed(1) + "%", growth <= P.rssGrowthPct);
    }
  }
}
if (test === "integrity") {
  const g = (n) => cnt(n);
  row("[PROPOSED]", "dup-email: 201s <= groups (default 50)", g("dup_email_201"), null, "compare with groups seeded");
  row("[PROPOSED]", "token-reuse: 201s == groups (default 50)", g("token_reuse_201"), null);
  row("[PROPOSED]", "OTP verify 200s == groups (default 25)", g("otp_verify_200"), null);
  row("[PROPOSED]", "same-account login: 200 / 429 / other (no 5xx)", `${g("login_race_200")} / ${g("login_race_429")} / ${g("login_race_other")}`, g("login_race_other") === 0 && g("resp_5xx_unexpected") === 0);
  row("[PROPOSED]", "same-session refresh: 200 == groups, 409 for the rest", `${g("refresh_race_200")} / ${g("refresh_race_409")} / ${g("refresh_race_other")}`, null, "exactly one 200 per group (default 25 groups)");
  row("[PROPOSED]", "verify.sql: every violations value 0", "see output", null, "run scripts/loadtest/verify.sql");
}
if (test === "ratelimit") {
  const t = (m) => v(m, "avg");
  row("[CONTROL]", "per-email limit answered 429 on attempt # (default limit 5 -> 6)", t("rl_email_first429_attempt") ?? "never", t("rl_email_first429_attempt") != null, "controls must stay ON");
  row("[CONTROL]", "per-IP limit answered 429 on attempt # (default limit 20 -> 21)", t("rl_ip_first429_attempt") ?? "never", t("rl_ip_first429_attempt") != null);
  row("[CONTROL]", "resend inside the cooldown answered (429 expected)", t("rl_resend_status") ?? "n/a", t("rl_resend_status") === 429);
}
const codes = Object.keys(k).filter((m) => /^resp_[a-z_]+_\d+$/.test(m) && cnt(m)).map((m) => `${m.slice(5)}=${cnt(m)}`).join(" ");
console.log(`\nTest: ${test}   API requests: ${api}\nStatus counts by endpoint: ${codes}\n`);
console.log("| Requirement | Check | Measured | Result | Note |\n|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.req} | ${r.name} | ${r.value} | ${r.result} | ${r.note} |`);
const failed = rows.filter((r) => r.result === "FAIL").length, invalid = rows.filter((r) => r.result === "INVALID").length;
console.log(`\n${invalid ? `INVALID run (${invalid} validity check(s) failed): fix the test and repeat. ` : ""}${failed ? `${failed} check(s) FAILED` : "No check failed"}. n/a = judge by hand or not measured.`);
process.exit(invalid ? 3 : failed ? 1 : 0);
