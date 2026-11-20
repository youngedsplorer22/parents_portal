// TEST FIXTURE. Assignments and portal bindings are developer commands in the product (src/cli/ops.js); these two small routes
// let the tests drive the same operations over HTTP, from the private test server in fixture-admin.js.
import express from "express";
import { parseBody } from "../../src/modules/email-otp/validation.js";
import { TEMPLATE_KEYS } from "../../src/modules/itinerary/validation.js";
import { z } from "zod";

const bindSchema = z.strictObject({ tripId: z.string().regex(/^[0-9a-f-]{36}$/i) });

export function createFixtureOperationsRouter({ operations, actor }) {
  const router = express.Router();
  router.get("/trips/:tripId/assignments", async (req, res) => res.json({ assignments: await operations.listAssignments(actor, req.params.tripId) }));
  router.put("/trips/:tripId/assignments/:staffId", async (req, res) => res.json({ assignment: await operations.assign(actor, req.params.tripId, req.params.staffId) }));
  router.delete("/trips/:tripId/assignments/:staffId", async (req, res) => res.json(await operations.revoke(actor, req.params.tripId, req.params.staffId)));
  router.get("/portal-deployments", async (req, res) => res.json({ deployments: await operations.listDeployments(actor) }));
  router.put("/portal-deployments/:templateKey", async (req, res) => {
    const { tripId } = parseBody(bindSchema, req.body);
    res.json({ deployment: await operations.bindDeployment(actor, req.params.templateKey, tripId) });
  });
  void TEMPLATE_KEYS;
  return router;
}
