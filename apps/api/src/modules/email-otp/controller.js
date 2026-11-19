import { isIP } from "node:net";
import { parseBody, resendSchema, sendSchema, verifySchema } from "./validation.js";

const clientIp = (req) => (req.ip && isIP(req.ip) ? req.ip : null);

export function createOtpController({ service }) {
  return {
    async send(req, res) {
      const { email, purpose } = parseBody(sendSchema, req.body);
      res.json(await service.send({ email, purpose, ip: clientIp(req) }));
    },
    async resend(req, res) {
      const { email, purpose } = parseBody(resendSchema, req.body);
      res.json(await service.resend({ email, purpose, ip: clientIp(req) }));
    },
    async verify(req, res) {
      const { email, purpose, code } = parseBody(verifySchema, req.body);
      res.json(await service.verify({ email, purpose, code }));
    },
  };
}
