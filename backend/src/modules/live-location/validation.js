import { z } from "zod";

const uuid = z.uuid();

/** Body of POST /api/live-location/location. Identity and trip come from the session and the enrolment, never from here. */
export const fixSchema = z.strictObject({
  enrolmentId: uuid,
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  // metres (the browser's 95% radius). Above 10 km the reading says nothing useful about where a group is.
  accuracy: z.number().finite().min(0).max(10000).nullable().optional(),
  // when the phone measured it, as an ISO 8601 date-time with a time zone
  capturedAt: z.iso.datetime({ offset: true }),
});

export const enrolmentBodySchema = z.strictObject({ enrolmentId: uuid });
export const enrolmentQuerySchema = z.strictObject({ enrolment: uuid });
export const assignSchema = z.strictObject({ enrolmentId: uuid.nullable() });
