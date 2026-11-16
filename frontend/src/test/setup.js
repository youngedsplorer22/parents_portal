import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetSessionRenewal } from "../api/http.js";
import { resetLiveSharing } from "../liveLocation/liveSharing.js";
import { downloads } from "./downloads.js";

// jsdom has no object URLs and can't save files: during each test, record each download (blob + file name) instead,
// so tests can check exactly what a parent's browser would have saved. Ordinary links are untouched. Installed per
// test and restored after it (the global URL is Node's own, which the test runner itself relies on while loading).
const original = {};
beforeEach(() => {
  if (typeof window === "undefined") return; // node-environment tests
  const blobs = new Map();
  let made = 0;
  Object.assign(original, { create: URL.createObjectURL, revoke: URL.revokeObjectURL, click: HTMLAnchorElement.prototype.click });
  URL.createObjectURL = (blob) => {
    const url = `blob:test/${++made}`;
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url) => blobs.delete(url);
  HTMLAnchorElement.prototype.click = function () {
    if (this.href.startsWith("blob:test/")) downloads.push({ filename: this.download, blob: blobs.get(this.href) });
    else original.click.call(this);
  };
});

afterEach(() => {
  cleanup();
  downloads.length = 0;
  resetSessionRenewal(); // a refused renewal in one test must not carry into the next (a page reload clears it too)
  resetLiveSharing(); // likewise a team lead's sharing loop
  if (typeof window !== "undefined") {
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
    HTMLAnchorElement.prototype.click = original.click;
    // Tab-scoped state (e.g. the remembered school link) must not leak between tests. Neither may the address #section.
    window.sessionStorage.clear();
    window.history.replaceState(null, "", window.location.pathname);
  }
});
