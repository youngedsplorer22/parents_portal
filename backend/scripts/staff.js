// Local provisioning for staff accounts of the internal admin panel.
// There is deliberately NO HTTP endpoint for this. Run it on the machine that can reach the database:
//
//   npm run staff -- create admin         first account (must be an admin; asks for email, name, password)
//   npm run staff -- create sales         a sales account
//   npm run staff -- create admin --additional-admin   another admin (asks you to type a confirmation)
//   npm run staff -- create admin --pending [--additional-admin]   an admin with NO password: the person sets
//                                         their own at /admin/login ("First time or forgot your password?")
//   npm run staff -- create sales --pending
//   npm run staff -- disable <email>      disable an account and end its sessions
//   npm run staff -- enable <email>
//   npm run staff -- set-password <email> set a new password and end its sessions
//
// The password is typed at a hidden prompt (or piped in on stdin), twice. It is never accepted as a
// command-line argument or an environment variable, so it can't end up in shell history or `ps`.
// Uses DATABASE_URL from backend/.env (loaded by `npm run staff`); refuses non-local databases.
import { createInterface } from "node:readline";
import pg from "pg";
import { assertLocalDatabaseUrl } from "../src/config.js";
import { createPasswordHasher } from "../src/modules/auth/password.js";
import { ProvisionError, ROLES, createStaff, setStaffDisabled, setStaffPassword } from "../src/modules/staff/provision.js";

/** Prompts: hidden input on a terminal; otherwise one line per prompt from stdin (for piping). */
function createPrompter(input = process.stdin, output = process.stdout) {
  const tty = Boolean(input.isTTY);
  let lines = null;
  const nextLine = async () => {
    lines ??= createInterface({ input })[Symbol.asyncIterator]();
    const { value, done } = await lines.next();
    if (done) throw new ProvisionError("Input ended before all answers were given.");
    return value;
  };

  const ask = async (label) => {
    output.write(label);
    if (tty) {
      const rl = createInterface({ input, output, terminal: false });
      return new Promise((resolve) => rl.once("line", (l) => { rl.close(); resolve(l); }));
    }
    return nextLine();
  };

  const askHidden = async (label) => {
    if (!tty) return ask(label);
    output.write(label);
    return new Promise((resolve, reject) => {
      let buffer = "";
      input.setRawMode(true);
      input.resume();
      const onData = (chunk) => {
        for (const ch of chunk.toString("utf8")) {
          if (ch === "\u0003") { cleanup(); reject(new ProvisionError("Cancelled.")); return; }
          if (ch === "\r" || ch === "\n") { cleanup(); output.write("\n"); resolve(buffer); return; }
          if (ch === "\u007f" || ch === "\b") buffer = buffer.slice(0, -1);
          else buffer += ch; // never echoed
        }
      };
      const cleanup = () => { input.setRawMode(false); input.pause(); input.off("data", onData); };
      input.on("data", onData);
    });
  };
  return { ask, askHidden };
}

async function askNewPassword(prompt) {
  const first = await prompt.askHidden("Password: ");
  const second = await prompt.askHidden("Confirm password: ");
  if (first !== second) throw new ProvisionError("The two passwords do not match.");
  return first;
}

export async function run(argv, { db, prompt = createPrompter(), passwords = createPasswordHasher(), log = console.log } = {}) {
  const [command, arg, ...rest] = argv;
  switch (command) {
    case "create": {
      const role = arg;
      if (!ROLES.includes(role)) throw new ProvisionError(`Usage: create <${ROLES.join("|")}> [--additional-admin]`);
      const email = (await prompt.ask("Email: ")).trim();
      const name = await prompt.ask("Name: ");
      const additional = rest.includes("--additional-admin");
      if (role === "admin" && additional) {
        const typed = await prompt.ask(`Another admin was requested. Type "CREATE ADMIN ${email.toLowerCase()}" to confirm: `);
        if (typed.trim() !== `CREATE ADMIN ${email.toLowerCase()}`) throw new ProvisionError("Confirmation did not match. Nothing was created.");
      }
      const pending = rest.includes("--pending");
      const password = pending ? undefined : await askNewPassword(prompt);
      const made = await createStaff(db, passwords, { email, name, role, password, allowAdditionalAdmin: additional, pending });
      log(
        made.pending
          ? `Created ${made.role} account for ${made.email} with no password yet. They set it at /admin/login ("First time or forgot your password?") with a code sent to that email.`
          : `Created ${made.role} account for ${made.email}.`,
      );
      return;
    }
    case "disable":
    case "enable": {
      if (!arg) throw new ProvisionError(`Usage: ${command} <email>`);
      const done = await setStaffDisabled(db, { email: arg, disabled: command === "disable" });
      log(`${done.disabled ? "Disabled" : "Enabled"} ${done.email}.`);
      return;
    }
    case "set-password": {
      if (!arg) throw new ProvisionError("Usage: set-password <email>");
      const password = await askNewPassword(prompt);
      const done = await setStaffPassword(db, passwords, { email: arg, password });
      log(`Password changed for ${done.email}; its sessions were ended.`);
      return;
    }
    default:
      throw new ProvisionError("Commands: create <admin|sales>, disable <email>, enable <email>, set-password <email>");
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new ProvisionError("DATABASE_URL is not set (run through `npm run staff`).");
  assertLocalDatabaseUrl(url);
  const db = new pg.Pool({ connectionString: url, max: 2 });
  try {
    await run(process.argv.slice(2), { db });
  } finally {
    await db.end();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    // Provisioning errors are safe to show. Anything else: the message only (no stack, no values).
    console.error(err instanceof ProvisionError ? err.message : `Failed: ${err?.message ?? err}`);
    process.exit(1);
  });
}
