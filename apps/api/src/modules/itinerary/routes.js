import express from "express";
import { parseBody } from "../email-otp/validation.js";
import { requireRole } from "../staff/middleware.js";
import { itemCreateSchema, itemUpdateSchema } from "./validation.js";

/**
 * The Sales itinerary API. Mounted under /api/admin AFTER requireStaff. Only a Sales account gets in at all; the service then
 * lets it touch only the trips a developer assigned to it. Nothing else exists under /api/admin: no school, trip, staff,
 * assignment, binding or live-location route.
 *
 *   GET   /itinerary/trips                         the trips assigned to the caller
 *   GET   /trips/:tripId/itinerary                 their items
 *   POST  /trips/:tripId/itinerary                 add an item
 *   PATCH /trips/:tripId/itinerary/:itemId         edit an item
 * Items cannot be deleted through the API.
 */
export function createItineraryRouter({ service }) {
  const router = express.Router();
  const sales = requireRole("sales");

  router.get("/itinerary/trips", sales, async (req, res) => res.json({ trips: await service.listTrips(req.staff) }));
  router.get("/trips/:tripId/itinerary", sales, async (req, res) => res.json({ items: await service.listItems(req.staff, req.params.tripId) }));
  router.post("/trips/:tripId/itinerary", sales, async (req, res) => {
    const input = parseBody(itemCreateSchema, req.body);
    res.status(201).json({ item: await service.addItem(req.staff, req.params.tripId, input) });
  });
  router.patch("/trips/:tripId/itinerary/:itemId", sales, async (req, res) => {
    const patch = parseBody(itemUpdateSchema, req.body);
    res.json({ item: await service.updateItem(req.staff, req.params.tripId, req.params.itemId, patch) });
  });
  return router;
}
