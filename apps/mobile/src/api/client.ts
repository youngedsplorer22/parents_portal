import type { Tokens, TokenStore } from "../auth/tokenStore";

/**
 * The app's only way to talk to the portal (/api/mobile). It attaches the access token, renews it with the refresh
 * token when it is about to expire or a request is refused as expired, and retries that request once. Renewal is
 * single-flight (one at a time, shared by the screens and the background location task); when the server says another
 * renewal just won the race (409), the tokens that renewal stored are used. Nothing here logs a token or a position.
 */
export class ApiError extends Error {
  constructor(public code: string, public status = 0, public details: Record<string, unknown> = {}) {
    super(code);
    this.name = "ApiError";
  }
}

export type User = { email: string; firstName: string; lastName: string; role: string };
export type LiveState = "not_started" | "waiting" | "live" | "stale" | "stopped" | "ended";
export type TripView = {
  enrolmentId: string;
  trip: { title: string; destination: string | null; school: string; branch: string | null; status: string };
  state: LiveState;
  location: { latitude: number; longitude: number; accuracyM: number | null; capturedAt: string; receivedAt: string | null } | null;
  sharingSince: string | null;
  teamLead: { canShare: boolean; sharingHere: boolean } | null;
  policy: { updateIntervalSeconds: number; staleAfterSeconds: number };
};
export type Fix = { latitude: number; longitude: number; accuracy: number | null; capturedAt: string };

type TokenBody = { accessToken: string; accessExpiresIn: number; refreshToken: string; refreshExpiresIn: number; user: User };

const RENEW_BEFORE_MS = 30_000; // renew a little before the access token runs out
const TIMEOUT_MS = 20_000;

export function createApi({ baseUrl, store, fetchImpl = fetch, now = () => Date.now(), sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) }: {
  baseUrl: string;
  store: TokenStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}) {
  let renewing: Promise<Tokens> | null = null;

  async function raw(method: string, path: string, { body, token }: { body?: unknown; token?: string } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/api/mobile${path}`, {
        method,
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new ApiError("NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON (a proxy page): handled below */
    }
    if (!res.ok) {
      const e = (data as { error?: { code?: string } & Record<string, unknown> } | null)?.error;
      throw new ApiError(e?.code ?? (res.status >= 500 ? "SERVER_ERROR" : "REQUEST_FAILED"), res.status, e ?? {});
    }
    return data;
  }

  const toTokens = (b: TokenBody): Tokens => ({
    accessToken: b.accessToken,
    accessExpiresAt: now() + b.accessExpiresIn * 1000,
    refreshToken: b.refreshToken,
    refreshExpiresAt: now() + b.refreshExpiresIn * 1000,
  });

  /** Renews once for everyone waiting. 401 means the sign-in is over: the stored tokens are removed. */
  function renew(): Promise<Tokens> {
    renewing ??= (async () => {
      const current = await store.load();
      if (!current) throw new ApiError("UNAUTHENTICATED", 401);
      try {
        const body = (await raw("POST", "/auth/refresh", { body: { refreshToken: current.refreshToken } })) as TokenBody;
        const next = toTokens(body);
        await store.save(next);
        return next;
      } catch (err) {
        if (err instanceof ApiError && err.code === "REFRESH_RACE") {
          // another renewal (e.g. the background task) won a moment ago and is saving its tokens: use those
          await sleep(1500);
          const after = await store.load();
          if (after && after.refreshToken !== current.refreshToken) return after;
          throw new ApiError("NETWORK_ERROR"); // try again later; never sign out over a race
        }
        if (err instanceof ApiError && err.status === 401) await store.clear();
        throw err;
      }
    })().finally(() => {
      renewing = null;
    });
    return renewing;
  }

  /** A signed-in request: a fresh access token, and on "expired" one renewal and one retry (never a loop). */
  async function authed(method: string, path: string, body?: unknown) {
    let tokens = await store.load();
    if (!tokens) throw new ApiError("UNAUTHENTICATED", 401);
    if (tokens.accessExpiresAt - now() < RENEW_BEFORE_MS) tokens = await renew();
    try {
      return await raw(method, path, { body, token: tokens.accessToken });
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "UNAUTHENTICATED") throw err;
      tokens = await renew();
      return raw(method, path, { body, token: tokens.accessToken });
    }
  }

  return {
    async login(email: string, password: string): Promise<User> {
      const body = (await raw("POST", "/auth/login", { body: { email: email.trim().toLowerCase(), password } })) as TokenBody;
      await store.save(toTokens(body));
      return body.user;
    },
    /** Ends the sign-in on the server (best effort) and always forgets the tokens on this phone. */
    async logout(): Promise<void> {
      const tokens = await store.load();
      try {
        if (tokens) await raw("POST", "/auth/logout", { body: { refreshToken: tokens.refreshToken }, token: tokens.accessToken });
      } catch {
        /* offline: the server-side sign-in still ends at its own limits */
      } finally {
        await store.clear();
      }
    },
    hasSession: async () => (await store.load()) !== null,
    me: async () => ((await authed("GET", "/me")) as { user: User }).user,
    trips: async () => ((await authed("GET", "/trips")) as { trips: TripView[] }).trips,
    trip: async (enrolmentId: string) => ({ enrolmentId, ...((await authed("GET", `/trips/${encodeURIComponent(enrolmentId)}`)) as Omit<TripView, "enrolmentId">) }),
    start: async (enrolmentId: string) => authed("POST", `/trips/${encodeURIComponent(enrolmentId)}/start`, {}),
    stop: async (enrolmentId: string) => authed("POST", `/trips/${encodeURIComponent(enrolmentId)}/stop`, {}),
    sendLocation: async (enrolmentId: string, fix: Fix) => authed("POST", `/trips/${encodeURIComponent(enrolmentId)}/location`, fix),
  };
}

export type Api = ReturnType<typeof createApi>;
