// DEVELOPMENT ONLY. No email is sent. The code is printed to the backend
// terminal so a developer can read it. It is never returned by the API, never
// stored in the database, and config.js refuses this sender outside
// NODE_ENV=development. This factory refuses production as a second guard.
//
// A real sender must implement the same shape:
//   { mode: string, send({ email, code, expiresInSeconds }): Promise<void> }
export function createDevConsoleSender({ log = console.log, env = process.env } = {}) {
  if (env.NODE_ENV === "production") {
    throw new Error("The dev-console sender prints OTPs and must never run in production.");
  }
  return {
    mode: "dev-console",
    async send({ email, code, expiresInSeconds, context }) {
      const what = context?.kind ? ` [staff ${context.kind}]` : "";
      log(`[DEV OTP]${what} ${email} -> ${code} (expires in ${expiresInSeconds}s). No email is sent.`);
    },
    async sendStaffPasswordChanged({ email, firstTime }) {
      log(`[DEV] staff password ${firstTime ? "set" : "changed"} for ${email}. No notification email is sent.`);
    },
    async sendPasswordChanged({ email }) {
      log(`[DEV] password changed for ${email}. No notification email is sent.`);
    },
  };
}
