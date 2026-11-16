import express from "express";
import { isIP } from "node:net";

const clientIp = (req) => (req.ip && isIP(req.ip) ? req.ip : null);

/**
 * Public. Mounted at /api/join. Nothing here identifies the caller: it only says whether a trip has a public
 * registration page, from the three address words /join/<school>/<branch>/<trip>. Rate limited per IP.
 */
export function createJoinRouter({ catalog }) {
  const router = express.Router();
  router.use((req, res, next) => {
    // Registration opens and closes, so never serve a stale answer.
    res.set({ "Cache-Control": "no-store" });
    next();
  });
  router.get("/:school/:branch/:trip", async (req, res) => {
    const { school, branch, trip } = req.params;
    res.json(await catalog.resolvePublicTrip({ school, branch, trip }, clientIp(req)));
  });
  return router;
}

/**
 * Public. Mounted at /api/school-logos. A school's logo by its address words: GET /:school/:branch. Served with the
 * type decided at upload from the image's own bytes, never sniffed by the browser, and unable to run anything.
 */
export function createLogoRouter({ catalog }) {
  const router = express.Router();
  router.get("/:school/:branch", async (req, res) => {
    const logo = await catalog.schoolLogo(req.params.school, req.params.branch);
    if (!logo) {
      res.set("Cache-Control", "no-store");
      return res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } });
    }
    res.set({
      "Content-Type": logo.contentType,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
      // the address carries ?v=<version>, which changes whenever the logo does
      "Cache-Control": "public, max-age=86400",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    res.send(logo.data);
  });
  return router;
}
