import { vi } from "vitest";

export const TOKEN = "TOKEN-SENTINEL-must-never-leak-0123456789";
export const CHALLENGE = { expiresInSeconds: 300, resendAvailableInSeconds: 30, delivery: "smtp", alreadySent: false };
export const VERIFIED = { verified: true, verificationToken: TOKEN, verificationTokenExpiresInSeconds: 900 };

export const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
export const apiError = (status, code, details = {}) => reply(status, { error: { code, message: "server text", ...details } });

/**
 * Stubs global fetch. `routes` maps a URL to a queue of responses (or functions returning
 * one); each call takes the next entry. Unexpected URLs or empty queues throw, so a test
 * fails loudly if the UI makes a request it should not.
 */
export function mockApi(routes = {}) {
  const queues = Object.fromEntries(Object.entries(routes).map(([url, list]) => [url, [].concat(list)]));
  const calls = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, signal: init.signal, method: init.method });
    const next = queues[url]?.shift();
    if (next === undefined) throw new Error(`Unexpected fetch: ${url}`);
    return typeof next === "function" ? next(body) : next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, urls: () => calls.map((c) => c.url) };
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Spies on every console method; returns a function that reports whether `text` was ever logged. */
export function watchConsole() {
  const spies = ["log", "info", "warn", "error", "debug"].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  return (text) => spies.some((spy) => spy.mock.calls.some((args) => args.some((a) => String(a).includes(text))));
}

export const storageIsEmpty = () => window.localStorage.length === 0 && window.sessionStorage.length === 0;
