import { secureTokenStore } from "../auth/tokenStore";
import { resolveApiBase } from "../config";
import { createApi, type Api } from "./client";

/** One API client for the whole app (screens and background task share its single-flight token renewal). */
let api: Api | null = null;
export function getApi(): Api {
  api ??= createApi({
    baseUrl: resolveApiBase(process.env.EXPO_PUBLIC_API_BASE_URL, { allowLocalHttp: __DEV__ }),
    store: secureTokenStore,
  });
  return api;
}
