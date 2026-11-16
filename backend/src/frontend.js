import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { notFoundHandler } from "./middleware/error-handler.js";

const ONE_YEAR = "public, max-age=31536000, immutable";

/**
 * Serves the built React app (frontend/dist). Rules, in order:
 *  1. /api/* that no API route answered is the API's JSON 404, never HTML (mounted FIRST, case-insensitively like the API).
 *  2. A real file is sent as that file. Vite names everything under /assets/ with a content hash, so those are immutable;
 *     index.html is never cached (a new deploy must be seen at once); other public files cache for an hour.
 *  3. GET/HEAD navigation (the browser asks for text/html) to anything else is index.html: that is how /admin/... and
 *     /join/<token> deep links reload. A missing file (script, image, source map) is a plain 404, never the shell.
 *  4. Everything else is the API's JSON 404.
 * Dotfiles are never served; the static handler refuses path traversal.
 */
export function createFrontend({ distDir }) {
  const dir = path.resolve(distDir);
  const indexFile = path.join(dir, "index.html");
  if (!existsSync(indexFile)) throw new Error("frontend build not found (index.html is missing): run `npm run build` first.");

  const router = express.Router();
  router.use("/api", notFoundHandler);
  router.use(express.static(dir, {
    index: false,
    dotfiles: "ignore",
    redirect: false,
    fallthrough: true,
    setHeaders(res, file) {
      const rel = path.relative(dir, file).split(path.sep);
      if (rel.length === 1 && rel[0] === "index.html") res.set("Cache-Control", "no-cache");
      else if (rel[0] === "assets") res.set("Cache-Control", ONE_YEAR);
      else res.set("Cache-Control", "public, max-age=3600");
    },
  }));
  router.use((req, res, next) => {
    const isRead = req.method === "GET" || req.method === "HEAD";
    const wantsHtml = /\btext\/html\b/.test(req.headers.accept ?? "");
    if (!isRead || !wantsHtml || /^\/assets(\/|$)/i.test(req.path)) return next();
    res.set("Cache-Control", "no-cache");
    res.sendFile(indexFile, { dotfiles: "deny" }, (err) => err && next(err));
  });
  return router;
}
