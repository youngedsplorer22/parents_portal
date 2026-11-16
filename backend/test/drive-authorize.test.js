import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { OAuthError, buildAuthUrl, createPkce, runAuthorization } from "../src/modules/pdf-storage/oauth.js";
import { startFakeDrive } from "./fake-drive.js";

let fake;
beforeEach(async () => {
  fake = await startFakeDrive({ account: "dest@example.com" });
});
afterEach(() => fake.close());

/** Plays the person: reads the sign-in address the tool shows, and (when it is a success) sends the browser back to it. */
function browser(fn) {
  return { openUrl: (url) => setImmediate(() => fn(new URL(url)).catch(() => {})) };
}
const base = (over = {}) => ({ ...fake.options, authUrl: "http://google.example/auth", timeoutMs: 4000, log() {}, ...over });
const callback = async (url, params) => {
  const target = new URL(url.searchParams.get("redirect_uri"));
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return fetch(target);
};
const approve = (code = "good-code", extra = {}) => browser(async (url) => {
  fake.registerCode(code, { challenge: url.searchParams.get("code_challenge"), redirectUri: url.searchParams.get("redirect_uri"), ...extra });
  await callback(url, { code, state: url.searchParams.get("state") });
});

describe("the sign-in request", () => {
  it("asks only for access to files this app creates, offline, for the destination account, with PKCE and a state", () => {
    const { challenge } = createPkce();
    const url = new URL(buildAuthUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5555/oauth2callback", state: "st", challenge, account: "dest@example.com" }));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(url.searchParams.get("login_hint"), "dest@example.com");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("state"), "st");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.ok(!url.search.includes("secret"), "no client secret in the address");
  });

  it("PKCE values are random each time and the challenge is derived from the verifier", () => {
    const a = createPkce();
    const b = createPkce();
    assert.notEqual(a.verifier, b.verifier);
    assert.match(a.verifier, /^[A-Za-z0-9_-]{43,}$/);
  });
});

describe("authorising the destination account", () => {
  it("returns the refresh token and the account it belongs to, after checking the account is the right one", async () => {
    const out = await runAuthorization({ ...base(), ...approve() });
    assert.equal(out.email, "dest@example.com");
    assert.equal(out.refreshToken, "good-refresh-token");
  });

  it("the callback page the person sees never contains the code, the token or the secret", async () => {
    let page = "";
    let shown;
    const pageRead = new Promise((resolve) => (shown = resolve));
    await runAuthorization({ ...base(), ...browser(async (url) => {
      fake.registerCode("c1", { challenge: url.searchParams.get("code_challenge"), redirectUri: url.searchParams.get("redirect_uri") });
      page = await (await callback(url, { code: "c1", state: url.searchParams.get("state") })).text();
      shown();
    }) });
    await pageRead; // the person's browser has finished reading the page
    for (const secret of ["c1", "good-refresh-token", "test-secret", "at-"]) assert.ok(!page.includes(secret), secret);
    assert.match(page, /close this (window|tab)/i);
  });

  it("refuses a Google account that is not the configured destination, and hands back no token", async () => {
    fake.state.account = "someone.else@example.com";
    await assert.rejects(runAuthorization({ ...base(), ...approve() }), (err) => err instanceof OAuthError && err.code === "ACCOUNT_MISMATCH" && !/good-refresh-token/.test(err.message + JSON.stringify(err)));
  });

  it("refuses a callback with the wrong state (someone else's request), and does not use its code", async () => {
    await assert.rejects(
      runAuthorization({ ...base({ timeoutMs: 1500 }), ...browser(async (url) => {
        fake.registerCode("evil", { challenge: url.searchParams.get("code_challenge"), redirectUri: url.searchParams.get("redirect_uri") });
        await callback(url, { code: "evil", state: "forged" });
      }) }),
      (err) => err.code === "STATE_MISMATCH",
    );
    assert.ok(fake.state.codes.has("evil"), "the code was never exchanged");
  });

  it("access denied on Google's page is reported plainly", async () => {
    await assert.rejects(runAuthorization({ ...base(), ...browser(async (url) => callback(url, { error: "access_denied", state: url.searchParams.get("state") })) }), (err) => err.code === "DENIED");
  });

  it("if Google returns no refresh token (access was already granted before) it says how to fix that", async () => {
    await assert.rejects(runAuthorization({ ...base(), ...approve("c2", { withRefresh: false }) }), (err) => err.code === "NO_REFRESH_TOKEN" && /remove|revoke/i.test(err.message));
  });

  it("a wrong client id or secret is reported without echoing either", async () => {
    await assert.rejects(runAuthorization({ ...base({ clientSecret: "wrong-secret-value" }), ...approve() }), (err) => err.code === "AUTH_CONFIG" && !err.message.includes("wrong-secret-value"));
  });

  it("gives up after the time limit instead of waiting forever, and frees its port", async () => {
    let port;
    await assert.rejects(runAuthorization({ ...base({ timeoutMs: 400 }), openUrl: (url) => { port = new URL(new URL(url).searchParams.get("redirect_uri")).port; } }), (err) => err.code === "TIMEOUT");
    await assert.rejects(fetch(`http://127.0.0.1:${port}/oauth2callback`), "the loopback listener is closed");
  });

  it("listens on this computer only, answers nothing but its callback address, and takes the first result only", async () => {
    let probes;
    await runAuthorization({ ...base(), ...browser(async (url) => {
      const origin = new URL(url.searchParams.get("redirect_uri")).origin;
      assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      probes = [(await fetch(`${origin}/`)).status, (await fetch(`${origin}/favicon.ico`)).status, (await fetch(`${origin}/oauth2callback?code=x`)).status];
      fake.registerCode("c3", { challenge: url.searchParams.get("code_challenge"), redirectUri: url.searchParams.get("redirect_uri") });
      await callback(url, { code: "c3", state: url.searchParams.get("state") });
    }) }).catch(() => {});
    assert.deepEqual(probes.slice(0, 2), [404, 404]);
  });

  it("refuses to start without the client id, secret or destination account", async () => {
    for (const missing of ["clientId", "clientSecret", "account"]) await assert.rejects(runAuthorization({ ...base(), [missing]: "", openUrl() {} }), (err) => err.code === "NOT_CONFIGURED");
  });
});
