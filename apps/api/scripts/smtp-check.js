// Non-destructive email diagnostic: `npm run mail:check`.
// Loads the SAME configuration the server uses, then (in smtp mode) connects to the mail server, negotiates TLS and
// logs in. It SENDS NOTHING. The output is the delivery mode, the server address and a plain verdict: never the
// username, password or any code.
import { ConfigError, loadConfig } from "../src/config.js";
import { createSender } from "../src/create-sender.js";

/** Removes anything secret from a provider's error text before it is shown. */
export function redact(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join("[hidden]");
  return out;
}

/** Resolves to an exit code: 0 verified, 1 the mail server refused or was unreachable, 2 bad configuration, 3 not in smtp mode. */
export async function run({ env = process.env, makeSender = createSender, log = console.log } = {}) {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    log(`Configuration problem:\n${err.message}`);
    return 2;
  }
  log(`Delivery mode: ${config.delivery} (environment: ${config.nodeEnv})`);
  if (config.delivery !== "smtp") {
    log("Nothing to check: in dev-console mode no email is sent and codes are printed in the backend terminal. Set OTP_DELIVERY=smtp to send real email.");
    return 3;
  }
  const { host, port, secure, user, from } = config.smtp;
  log(`Mail server: ${host}:${port} (${secure ? "implicit TLS" : "STARTTLS required, no plaintext fallback"})`);
  log(`Sender address domain: ${String(from).match(/@([^>\s]+)/)?.[1] ?? "unrecognised"}`);
  try {
    await makeSender(config, { logger: { error: () => {}, log: () => {} } }).verify();
  } catch (err) {
    log(`FAILED: ${redact(err?.message, [user, config.smtp.pass])}`);
    log("The server was reached or not as described above, but it did not accept the login. No email was sent. Check SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER and SMTP_PASSWORD (for Gmail this must be an app password, not the account password).");
    return 1;
  }
  log("OK: connected, TLS negotiated and the mail server accepted the login. No email was sent.");
  log("This proves the settings and credentials are accepted; it does not prove a message reaches any particular mailbox. Send one real code to an address you control to confirm delivery.");
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  run().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`Failed: ${err?.message ?? err}`);
      process.exit(1);
    },
  );
}
