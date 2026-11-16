/**
 * Where the portal's API is. Set EXPO_PUBLIC_API_BASE_URL at build time (it is not a secret). Real use must be https;
 * plain http is accepted only for a development build talking to a computer on the local network or the Android
 * emulator's alias for the host (10.0.2.2), and only when the build allows it (ALLOW_LOCAL_HTTP=1, see app.config.ts).
 */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|10\.0\.2\.2|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

export class ConfigError extends Error {}

export function resolveApiBase(raw: string | undefined, { allowLocalHttp }: { allowLocalHttp: boolean }): string {
  if (!raw) throw new ConfigError("The app was built without an API address (EXPO_PUBLIC_API_BASE_URL).");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("The API address is not a valid URL.");
  }
  if (url.username || url.password || url.search || url.hash) throw new ConfigError("The API address must be an origin only.");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && allowLocalHttp && LOCAL_HOST.test(url.hostname)) return url.origin;
  throw new ConfigError("The API address must use https://.");
}
