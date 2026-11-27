import { ApiError, createApi } from "../src/api/client";
import type { Tokens, TokenStore } from "../src/auth/tokenStore";

const T = (c: string) => c.repeat(43);
function memoryStore(initial: Tokens | null = null): TokenStore & { value: Tokens | null } {
  const s = { value: initial, load: async () => s.value, save: async (t: Tokens) => void (s.value = t), clear: async () => void (s.value = null) };
  return s;
}
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const tokenBody = (a: string, r: string) => ({ tokenType: "Bearer", accessToken: T(a), accessExpiresIn: 900, refreshToken: T(r), refreshExpiresIn: 259200, user: { email: "lead@example.com", firstName: "Tara", lastName: "Lead", role: "Team Leader" } });

describe("signing in", () => {
  it("stores the tokens (secure store) and sends the normalised email; nothing is put in a URL", async () => {
    const store = memoryStore();
    const fetchImpl = jest.fn(async () => json(200, tokenBody("a", "r")));
    const api = createApi({ baseUrl: "https://p.example.com", store, fetchImpl, now: () => 1000 });
    const user = await api.login("  Lead@Example.com ", "secret-pass");
    expect(user.firstName).toBe("Tara");
    expect(store.value).toEqual({ accessToken: T("a"), accessExpiresAt: 1000 + 900_000, refreshToken: T("r"), refreshExpiresAt: 1000 + 259_200_000 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://p.example.com/api/mobile/auth/login");
    expect(JSON.parse(init.body as string)).toEqual({ email: "lead@example.com", password: "secret-pass" });
  });
  it("a refused sign-in keeps nothing", async () => {
    const store = memoryStore();
    const api = createApi({ baseUrl: "https://p.example.com", store, fetchImpl: jest.fn(async () => json(401, { error: { code: "INVALID_CREDENTIALS" } })) });
    await expect(api.login("a@b.co", "x")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(store.value).toBeNull();
  });
});

describe("renewing the access token", () => {
  it("sends the bearer token; an expired one is renewed ONCE and the request repeated ONCE", async () => {
    const store = memoryStore({ accessToken: T("a"), accessExpiresAt: 10_000_000, refreshToken: T("r"), refreshExpiresAt: 99_000_000 });
    const calls: string[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url.replace("https://p.example.com/api/mobile", "")} ${(init?.headers as Record<string, string>).Authorization ?? ""}`);
      if (url.endsWith("/auth/refresh")) return json(200, tokenBody("b", "s"));
      return (init?.headers as Record<string, string>).Authorization === `Bearer ${T("a")}` ? json(401, { error: { code: "UNAUTHENTICATED" } }) : json(200, { trips: [] });
    });
    const api = createApi({ baseUrl: "https://p.example.com", store, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    expect(await api.trips()).toEqual([]);
    expect(calls).toEqual([`GET /trips Bearer ${T("a")}`, "POST /auth/refresh ", `GET /trips Bearer ${T("b")}`]);
    expect(store.value?.refreshToken).toBe(T("s"));
  });

  it("renews before the token expires, and several requests share one renewal", async () => {
    const store = memoryStore({ accessToken: T("a"), accessExpiresAt: 10_000, refreshToken: T("r"), refreshExpiresAt: 99_000_000 });
    let refreshes = 0;
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) {
        refreshes++;
        return json(200, tokenBody("b", "s"));
      }
      return json(200, { user: {}, trips: [] });
    });
    const api = createApi({ baseUrl: "https://p.example.com", store, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0 });
    await Promise.all([api.trips(), api.me(), api.trips()]);
    expect(refreshes).toBe(1);
  });

  it("a renewal refused with 401 forgets the tokens (signed out) and reports UNAUTHENTICATED; no loop", async () => {
    const store = memoryStore({ accessToken: T("a"), accessExpiresAt: 0, refreshToken: T("r"), refreshExpiresAt: 1 });
    const fetchImpl = jest.fn(async () => json(401, { error: { code: "UNAUTHENTICATED" } }));
    const api = createApi({ baseUrl: "https://p.example.com", store, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 5 });
    await expect(api.trips()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(store.value).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a 409 race (the background task renewed first) uses the tokens that renewal stored; it never signs out", async () => {
    const store = memoryStore({ accessToken: T("a"), accessExpiresAt: 0, refreshToken: T("r"), refreshExpiresAt: 99 });
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/refresh")) {
        store.value = { accessToken: T("b"), accessExpiresAt: 99_000_000, refreshToken: T("s"), refreshExpiresAt: 99_000_000 }; // the other renewal's result
        return json(409, { error: { code: "REFRESH_RACE" } });
      }
      return (init?.headers as Record<string, string>).Authorization === `Bearer ${T("b")}` ? json(200, { trips: ["ok"] }) : json(401, { error: { code: "UNAUTHENTICATED" } });
    });
    const api = createApi({ baseUrl: "https://p.example.com", store, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 0, sleep: async () => {} });
    expect(await api.trips()).toEqual(["ok"]);
    expect(store.value?.accessToken).toBe(T("b"));
  });

  it("offline is reported as NETWORK_ERROR and keeps the sign-in", async () => {
    const store = memoryStore({ accessToken: T("a"), accessExpiresAt: 99_000_000, refreshToken: T("r"), refreshExpiresAt: 99_000_000 });
    const api = createApi({ baseUrl: "https://p.example.com", store, fetchImpl: jest.fn(async () => { throw new TypeError("Network request failed"); }) as unknown as typeof fetch, now: () => 0 });
    await expect(api.trips()).rejects.toBeInstanceOf(ApiError);
    await expect(api.trips()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(store.value).not.toBeNull();
  });

  it("logout tells the server (with the refresh token) and always forgets the tokens, even offline", async () => {
    const store = memoryStore({ accessToken: T("a"), accessExpiresAt: 99, refreshToken: T("r"), refreshExpiresAt: 99 });
    const fetchImpl = jest.fn(async () => { throw new TypeError("offline"); });
    await createApi({ baseUrl: "https://p.example.com", store, fetchImpl: fetchImpl as unknown as typeof fetch }).logout();
    expect(store.value).toBeNull();
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ refreshToken: T("r") });
  });
});
