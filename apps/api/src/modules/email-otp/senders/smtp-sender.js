import nodemailer from "nodemailer";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function describeDuration(seconds) {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}

const STAFF_APP_NAME = "Young Edsplorer Admin Panel";

/**
 * Staff codes say plainly whether the person is SETTING a first password or RESETTING one, and
 * name the admin panel (not the parent portal). `context.kind` is "setup" or "reset".
 */
function buildStaffMessage({ from, to, code, expiresInSeconds, context }) {
  const lifetime = describeDuration(expiresInSeconds);
  const setup = context?.kind === "setup";
  const action = setup ? "set up your password" : "reset your password";
  const ignore = setup
    ? "If you did not expect this, you can ignore this email: nothing has been changed."
    : "If you did not ask to reset your password, you can ignore this email: your password has not been changed.";
  const text =
    `Your ${STAFF_APP_NAME} verification code is ${code}.\n\n` +
    `Use it to ${action}. It expires in ${lifetime}. ${ignore}\n`;
  const html =
    `<p>Your ${escapeHtml(STAFF_APP_NAME)} verification code is:</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${escapeHtml(code)}</p>` +
    `<p>Use it to ${action}. It expires in ${escapeHtml(lifetime)}. ${ignore}</p>`;
  return { from, to, subject: setup ? `Set up your ${STAFF_APP_NAME} password` : `Reset your ${STAFF_APP_NAME} password`, text, html };
}

export function buildStaffPasswordChangedMessage({ from, to, firstTime }) {
  const what = firstTime ? "was just set" : "was just changed";
  const text =
    `The password for your ${STAFF_APP_NAME} account ${what}.\n\n` +
    `If this was you, no action is needed. If it was not, ask an administrator to look into it right away.\n`;
  const html =
    `<p>The password for your ${escapeHtml(STAFF_APP_NAME)} account ${what}.</p>` +
    `<p>If this was you, no action is needed. If it was not, ask an administrator to look into it right away.</p>`;
  return { from, to, subject: firstTime ? `Your ${STAFF_APP_NAME} password was set` : `Your ${STAFF_APP_NAME} password was changed`, text, html };
}

export function buildMessage({ from, to, code, expiresInSeconds, appName, purpose = "registration", context }) {
  if (purpose === "staff_password") return buildStaffMessage({ from, to, code, expiresInSeconds, context });
  const lifetime = describeDuration(expiresInSeconds);
  const reset = purpose === "password_reset";
  const attempt = purpose === "login" ? "log in" : reset ? "reset your password" : "register";
  const ignore = reset
    ? `If you did not ask to reset your password, you can ignore this email: your password has not been changed.`
    : `If you did not try to ${attempt}, you can ignore this email.`;
  const text =
    `Your ${appName} verification code is ${code}.\n\n` +
    `It expires in ${lifetime}. ${ignore}\n`;
  const html =
    `<p>Your ${escapeHtml(appName)} verification code is:</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">${escapeHtml(code)}</p>` +
    `<p>It expires in ${escapeHtml(lifetime)}. ${ignore}</p>`;
  return { from, to, subject: `Your ${appName} verification code`, text, html };
}

export function buildPasswordChangedMessage({ from, to, appName }) {
  const text =
    `The password for your ${appName} account was just changed.\n\n` +
    `If this was you, no action is needed. If it was not, reset your password again right away and contact the school coordinator.\n`;
  const html =
    `<p>The password for your ${escapeHtml(appName)} account was just changed.</p>` +
    `<p>If this was you, no action is needed. If it was not, reset your password again right away and contact the school coordinator.</p>`;
  return { from, to, subject: `Your ${appName} password was changed`, text, html };
}

/** Error code only: SMTP error text can echo recipients, so it is not logged per delivery. */
const describeError = (err) => `${err?.code ?? "UNKNOWN"}${err?.responseCode ? ` ${err.responseCode}` : ""}`;

/**
 * Real email delivery through any SMTP server, via Nodemailer.
 *
 * - secure=true  -> implicit TLS (usually port 465).
 * - secure=false -> STARTTLS, and TLS is REQUIRED (no plaintext downgrade),
 *   except for a local test server on localhost.
 *
 * The OTP is only ever placed in the email. It is never logged here, and the
 * SMTP password is never logged or included in errors.
 */
export function createSmtpSender({
  smtp,
  appName = "Young Edsplorer Parent Portal",
  createTransport = nodemailer.createTransport,
  logger = console,
}) {
  const isLocal = LOCAL_HOSTS.has(smtp.host);
  const transporter = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure && !isLocal,
    auth: { user: smtp.user, pass: smtp.pass },
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  return {
    mode: "smtp",

    /** Security notice after a password reset. Contains no code, token or password. */
    async sendPasswordChanged({ email }) {
      try {
        await transporter.sendMail(buildPasswordChangedMessage({ from: smtp.from, to: email, appName }));
      } catch (err) {
        logger.error(`[smtp] delivery failed: ${describeError(err)}`);
        throw new Error("SMTP delivery failed");
      }
    },

    /** Security notice after a staff password was set or changed. Contains no code, token or password. */
    async sendStaffPasswordChanged({ email, firstTime = false }) {
      try {
        await transporter.sendMail(buildStaffPasswordChangedMessage({ from: smtp.from, to: email, firstTime }));
      } catch (err) {
        logger.error(`[smtp] delivery failed: ${describeError(err)}`);
        throw new Error("SMTP delivery failed");
      }
    },

    /** Startup check: connects and authenticates without sending anything. */
    async verify() {
      try {
        await transporter.verify();
      } catch (err) {
        const detail = String(err?.message ?? "").slice(0, 200);
        throw new Error(`SMTP check failed (${describeError(err)}): ${detail}`, { cause: err });
      }
    },

    async send({ email, code, expiresInSeconds, purpose, context }) {
      try {
        await transporter.sendMail(buildMessage({ from: smtp.from, to: email, code, expiresInSeconds, appName, purpose, context }));
      } catch (err) {
        logger.error(`[smtp] delivery failed: ${describeError(err)}`);
        throw new Error("SMTP delivery failed");
      }
    },
  };
}
