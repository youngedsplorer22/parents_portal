// TEST FIXTURE. This is the old admin HTTP router, kept ONLY so the test suite can set up schools, trips and live-location
// data over HTTP through the same validation and services as before. It is mounted by test/support/fixture-admin.js on a
// private test server. The product has no admin route: nothing under src/ imports this file.
import express from "express";
import { parseBody } from "../../src/modules/email-otp/validation.js";
import { staffActiveSchema, staffCreateSchema } from "../../src/modules/staff/management.js";

/** Mounted at /api/admin/staff, behind requireStaff AND requireRole("admin"). No public route exists. */
export function createStaffAdminRouter({ management }) {
  const router = express.Router();
  router.get("/", async (req, res) => res.json({ staff: await management.list() }));
  router.post("/", async (req, res) => {
    res.status(201).json({ staff: await management.createSales(req.staff, parseBody(staffCreateSchema, req.body)) });
  });
  router.patch("/:id", async (req, res) => {
    res.json({ staff: await management.setActive(req.staff, req.params.id, parseBody(staffActiveSchema, req.body).active) });
  });
  return router;
}
