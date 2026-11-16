import express from "express";

export function createOtpRouter({ controller }) {
  const router = express.Router();

  // Responses carry codes' outcomes and tokens: never cache them.
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(express.json({ limit: "2kb", inflate: false }));

  router.post("/send", controller.send);
  router.post("/resend", controller.resend);
  router.post("/verify", controller.verify);

  return router;
}
