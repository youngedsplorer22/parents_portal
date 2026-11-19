import { ConfigError, resolveApiBase } from "../src/config";

describe("the API address", () => {
  it("accepts https origins (and trims a path to the origin)", () => {
    expect(resolveApiBase("https://parents.example.com", { allowLocalHttp: false })).toBe("https://parents.example.com");
    expect(resolveApiBase("https://parents.example.com/", { allowLocalHttp: false })).toBe("https://parents.example.com");
  });
  it("refuses plain http in a release build, even on the local network", () => {
    for (const raw of ["http://parents.example.com", "http://192.168.1.20:4000", "http://localhost:4000"]) {
      expect(() => resolveApiBase(raw, { allowLocalHttp: false })).toThrow(ConfigError);
    }
  });
  it("allows http only to a local development server when the build allows it", () => {
    expect(resolveApiBase("http://192.168.1.20:4000", { allowLocalHttp: true })).toBe("http://192.168.1.20:4000");
    expect(resolveApiBase("http://10.0.2.2:4000", { allowLocalHttp: true })).toBe("http://10.0.2.2:4000");
    expect(() => resolveApiBase("http://evil.example.com", { allowLocalHttp: true })).toThrow(ConfigError);
  });
  it("refuses missing, malformed, credential-bearing or query-bearing addresses", () => {
    for (const raw of [undefined, "", "not a url", "https://user:pass@parents.example.com", "https://parents.example.com?x=1", "ftp://parents.example.com"]) {
      expect(() => resolveApiBase(raw, { allowLocalHttp: true })).toThrow(ConfigError);
    }
  });
});
