import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";

/**
 * One-time sign-in for the destination Google account (used by `npm run drive:authorize`; the running portal never
 * does this). It is the standard "installed app" OAuth flow with a loopback address, PKCE and a state value:
 *
 *   1. a one-time address on accounts.google.com is shown (and opened); the person signs in as the destination account
 *      and allows "See, edit, create and delete only the specific Google Drive files you use with this app";
 *   2. Google sends their browser back to http://127.0.0.1:<port>/oauth2callback on THIS computer, where a short-lived
 *      listener catches the one-time code (and nothing else: any other address gets a 404);
 *   3. the code is exchanged for a refresh token, and the account it belongs to is checked against the configured
 *      destination. Only then is the token handed back, to be pasted into the git-ignored backend/.env by the owner.
 *
 * The refresh token and the client secret are never written to a file, logged, or shown on the page the browser gets.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ABOUT_URL = "https://www.googleapis.com/drive/v3/about";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const MESSAGES = {
  NOT_CONFIGURED: "Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_DRIVE_ACCOUNT in backend/.env first (see GOOGLE_DRIVE_SETUP.md).",
  DENIED: "Access was not granted on Google's page, so nothing was authorised. Run the command again and choose Allow.",
  STATE_MISMATCH: "The sign-in answer did not match this request, so it was ignored. Run the command again.",
  NO_REFRESH_TOKEN: "Google did not return a refresh token (access was probably granted to this app before). In the destination account go to https://myaccount.google.com/permissions, remove this app, then run the command again.",
  AUTH_CONFIG: "Google did not accept the client id or secret, or the one-time code. Check the OAuth client in Google Cloud Console and run the command again.",
  ACCOUNT_MISMATCH: "You signed in as a different Google account than the configured destination (GOOGLE_DRIVE_ACCOUNT). Nothing was saved. Run the command again and choose the destination account.",
  TIMEOUT: "No sign-in was completed within the time limit.",
  FAILED: "Google's reply could not be used. Run the command again.",
};
export class OAuthError extends Error {
  constructor(code) {
    super(MESSAGES[code] ?? MESSAGES.FAILED);
    this.name = "OAuthError";
    this.code = code;
  }
}

export function createPkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function buildAuthUrl({ clientId, redirectUri, state, challenge, account, authUrl = AUTH_URL }) {
  const url = new URL(authUrl);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline", // so a refresh token is returned
    prompt: "consent", // and returned again even if this app was allowed before
    login_hint: account,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const page = (title, line) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.3rem">${title}</h1><p>${line}</p>`;

/** -> { refreshToken, email }. `openUrl(url)` shows or opens the sign-in address. Throws OAuthError. */
export async function runAuthorization({ clientId, clientSecret, account, openUrl, timeoutMs = 5 * 60_000, authUrl = AUTH_URL, tokenUrl = TOKEN_URL, apiBase, log = () => {} }) {
  for (const v of [clientId, clientSecret, account]) if (typeof v !== "string" || v.trim() === "") throw new OAuthError("NOT_CONFIGURED");
  const aboutUrl = apiBase ? `${apiBase}/about` : ABOUT_URL;
  const destination = account.trim().toLowerCase();
  const { verifier, challenge } = createPkce();
  const state = randomBytes(24).toString("base64url");

  let finish;
  const outcome = new Promise((resolve, reject) => (finish = { resolve, reject }));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/oauth2callback" || !url.searchParams.has("state")) {
      res.writeHead(404).end(); // favicon, probes, anything else
      return;
    }
    // The page is fully sent before the outcome is reported (which closes this listener).
    const say = (status, title, line) =>
      new Promise((resolve) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(title, line), resolve));
    if (!sameText(url.searchParams.get("state"), state)) {
      await say(400, "Not accepted", "This answer did not belong to the sign-in that was started. You can close this window.");
      return finish.reject(new OAuthError("STATE_MISMATCH"));
    }
    if (url.searchParams.get("error")) {
      await say(200, "Not authorised", "Access was not granted. You can close this window and run the command again.");
      return finish.reject(new OAuthError("DENIED"));
    }
    try {
      const result = await exchange(url.searchParams.get("code"));
      await say(200, "Authorised", "Return to the terminal to finish. You can close this window.");
      finish.resolve(result);
    } catch (err) {
      await say(200, "Not completed", "Return to the terminal to see what to do. You can close this window.");
      finish.reject(err);
    }
  });

  let redirectUri;
  async function exchange(code) {
    if (!code) throw new OAuthError("FAILED");
    let res;
    try {
      res = await fetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new OAuthError("FAILED");
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.access_token) throw new OAuthError(res.status === 400 || res.status === 401 ? "AUTH_CONFIG" : "FAILED");
    if (!body.refresh_token) throw new OAuthError("NO_REFRESH_TOKEN");
    let about;
    try {
      about = await (await fetch(`${aboutUrl}?fields=${encodeURIComponent("user(emailAddress)")}`, { headers: { authorization: `Bearer ${body.access_token}` }, signal: AbortSignal.timeout(15_000) })).json();
    } catch {
      throw new OAuthError("FAILED");
    }
    const email = String(about?.user?.emailAddress ?? "").trim().toLowerCase();
    if (email !== destination) throw new OAuthError("ACCOUNT_MISMATCH");
    return { refreshToken: body.refresh_token, email };
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); // this computer only
  redirectUri = `http://127.0.0.1:${server.address().port}/oauth2callback`;
  const timer = setTimeout(() => finish.reject(new OAuthError("TIMEOUT")), timeoutMs);
  try {
    const url = buildAuthUrl({ clientId, redirectUri, state, challenge, account: destination, authUrl });
    log("Waiting for you to sign in as the destination account in your browser...");
    openUrl(url);
    return await outcome;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
}
