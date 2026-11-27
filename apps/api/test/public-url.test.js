import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { missingLinkHosts, publicUrlFor } from "../src/modules/catalog/public-url.js";
import { createCatalogService } from "../src/modules/catalog/service.js";

const PATH = "/join/greenfield-public-school/main/winter-trip";
const hosts = {
  domestic_payment: "https://domestic-paid.example.test",
  domestic_none: "https://domestic-free.example.test",
  international_payment: "https://international-paid.example.test",
  international_none: "https://international-free.example.test",
};

describe("publicUrlFor: the registration link's host follows the trip's template key", () => {
  it("uses each variant's own host and keeps the path unchanged", () => {
    for (const [key, host] of Object.entries(hosts)) {
      assert.equal(publicUrlFor({ publicBaseUrls: hosts, publicBaseUrl: "https://fallback.example.test" }, key, PATH), `${host}${PATH}`, key);
    }
  });

  it("falls back to PUBLIC_BASE_URL for a variant with no host of its own", () => {
    const cfg = { publicBaseUrls: { domestic_none: hosts.domestic_none, domestic_payment: null }, publicBaseUrl: "https://fallback.example.test" };
    assert.equal(publicUrlFor(cfg, "domestic_payment", PATH), `https://fallback.example.test${PATH}`);
    assert.equal(publicUrlFor(cfg, "international_none", PATH), `https://fallback.example.test${PATH}`);
    assert.equal(publicUrlFor(cfg, "domestic_none", PATH), `${hosts.domestic_none}${PATH}`);
  });

  it("behaves exactly as before when no per-variant host is configured (or the map is absent)", () => {
    assert.equal(publicUrlFor({ publicBaseUrl: "https://fallback.example.test" }, "domestic_none", PATH), `https://fallback.example.test${PATH}`);
    assert.equal(publicUrlFor({ publicBaseUrls: {}, publicBaseUrl: "https://fallback.example.test" }, "domestic_none", PATH), `https://fallback.example.test${PATH}`);
    assert.equal(publicUrlFor({ publicBaseUrl: null }, "domestic_none", PATH), null, "no host at all: the panel adds its own origin");
    assert.equal(publicUrlFor({ publicBaseUrls: {}, publicBaseUrl: null }, "domestic_none", PATH), null);
  });

  it("never doubles a slash, whatever the configured host ends with", () => {
    for (const host of ["https://x.example.test", "https://x.example.test/", "https://x.example.test//"]) {
      const url = publicUrlFor({ publicBaseUrls: { domestic_none: host } }, "domestic_none", PATH);
      assert.equal(url, `https://x.example.test${PATH}`);
      assert.ok(!url.slice("https://".length).includes("//"), url);
    }
  });

  it("an unknown or hostile template key uses the fallback and never reads inherited object properties", () => {
    const cfg = { publicBaseUrls: hosts, publicBaseUrl: "https://fallback.example.test" };
    for (const key of ["", "unknown", "constructor", "__proto__", "toString", undefined, null]) {
      assert.equal(publicUrlFor(cfg, key, PATH), `https://fallback.example.test${PATH}`, String(key));
    }
  });
});

describe("missingLinkHosts: which template keys would get no usable host", () => {
  const KEYS = Object.keys(hosts);
  it("none when all four have their own host (with or without a fallback)", () => {
    assert.deepEqual(missingLinkHosts({ publicBaseUrls: hosts, publicBaseUrl: null }), []);
    assert.deepEqual(missingLinkHosts({ publicBaseUrls: hosts, publicBaseUrl: "https://fallback.example.test" }), []);
  });
  it("none for the legacy setups: only PUBLIC_BASE_URL, or nothing at all (the panel then uses its own address, as before)", () => {
    assert.deepEqual(missingLinkHosts({ publicBaseUrl: "https://legacy.example.test" }), []);
    assert.deepEqual(missingLinkHosts({ publicBaseUrls: {}, publicBaseUrl: null }), []);
    assert.deepEqual(missingLinkHosts({ publicBaseUrls: { domestic_none: null, domestic_payment: null }, publicBaseUrl: null }), []);
    assert.deepEqual(missingLinkHosts(), []);
  });
  it("none when some variants are set and PUBLIC_BASE_URL covers the rest", () => {
    assert.deepEqual(missingLinkHosts({ publicBaseUrls: { domestic_none: hosts.domestic_none }, publicBaseUrl: "https://fallback.example.test" }), []);
  });
  it("lists exactly the keys left without a host when some are set and there is no fallback", () => {
    assert.deepEqual(missingLinkHosts({ publicBaseUrls: { domestic_none: hosts.domestic_none, international_none: hosts.international_none }, publicBaseUrl: null }).sort(), ["domestic_payment", "international_payment"]);
    assert.deepEqual(missingLinkHosts({ publicBaseUrls: { international_payment: hosts.international_payment }, publicBaseUrl: null }).sort(), ["domestic_none", "domestic_payment", "international_none"]);
  });
  it("ignores keys that are not template keys, and never reports one", () => {
    const missing = missingLinkHosts({ publicBaseUrls: { domestic_none: hosts.domestic_none, bogus_key: "https://x.example.test" }, publicBaseUrl: null });
    for (const k of missing) assert.ok(KEYS.includes(k), k);
    assert.ok(!missing.includes("bogus_key"));
  });
});

describe("the catalog service refuses an incomplete link configuration instead of producing misleading links", () => {
  const make = (config) => () => createCatalogService({ db: {}, config });
  it("throws at construction for partial variant hosts without a fallback, naming the template keys but no URL", () => {
    assert.throws(make({ publicBaseUrls: { domestic_none: hosts.domestic_none }, publicBaseUrl: null }), (e) => /domestic_payment/.test(e.message) && !/example\.test/.test(e.message));
  });
  it("does not throw for all four, for a fallback, for the legacy fallback alone, or for no hosts at all", () => {
    for (const config of [
      { publicBaseUrls: hosts, publicBaseUrl: null },
      { publicBaseUrls: { domestic_none: hosts.domestic_none }, publicBaseUrl: "https://fallback.example.test" },
      { publicBaseUrl: "https://legacy.example.test" },
      { publicBaseUrls: {}, publicBaseUrl: null },
      {},
    ]) assert.doesNotThrow(make(config), JSON.stringify(config));
  });
});
