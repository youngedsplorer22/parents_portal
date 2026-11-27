import express from "express";

export function createRegistrationRouter({ controller }) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(express.json({ limit: "4kb", inflate: false }));

  router.post("/", controller.create);

  return router;
}
