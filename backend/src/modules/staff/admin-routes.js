import express from "express";
import { parseBody } from "../email-otp/validation.js";
import { staffActiveSchema, staffCreateSchema } from "./management.js";

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
