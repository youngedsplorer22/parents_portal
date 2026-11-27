import { isIP } from "node:net";
import { parseBody } from "../email-otp/validation.js";
import { parentCookies } from "../auth/session-cookie.js";
import { registrationSchema } from "./validation.js";

const clientIp = (req) => (req.ip && isIP(req.ip) ? req.ip : null);

export function createRegistrationController({ service, cookie }) {
  return {
    async create(req, res) {
      const { verificationToken, publicTrip, ...fields } = parseBody(registrationSchema, req.body);
      // req.portal is set by the server from the portal's secret (middleware/portal-identity.js); the body can't claim a portal.
      const created = await service.register({ fields, verificationToken, publicTrip, ip: clientIp(req), portal: req.portal?.templateKey ?? null });
      // Sent only after COMMIT. The verification token is never echoed back; the
      // new session's token goes only into the HttpOnly cookie.
      res.set("Set-Cookie", parentCookies.issue(created.session, { secure: cookie.cookieSecure }));
      res.status(201).json({ registered: true, registrationId: created.id, email: created.email });
    },
  };
}
