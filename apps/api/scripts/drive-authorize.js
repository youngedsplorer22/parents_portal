// One-time sign-in for the Google account that will keep the registration PDFs.
//
//   npm run drive:authorize
//
// Needs GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_DRIVE_ACCOUNT in backend/.env (see
// GOOGLE_DRIVE_SETUP.md at the project root). It opens Google's sign-in page; sign in as the DESTINATION account and
// choose Allow. The tool checks it really is that account, then prints one line to paste into backend/.env.
// It writes nothing to disk and never changes .env itself.
import { spawn } from "node:child_process";
import { OAuthError, runAuthorization } from "../src/modules/pdf-storage/oauth.js";

const { GOOGLE_OAUTH_CLIENT_ID: clientId, GOOGLE_OAUTH_CLIENT_SECRET: clientSecret, GOOGLE_DRIVE_ACCOUNT: account } = process.env;

try {
  const { refreshToken, email } = await runAuthorization({
    clientId,
    clientSecret,
    account,
    log: (line) => console.log(line),
    openUrl: (url) => {
      console.log(`\nOpen this address in your browser (it should open by itself), sign in as ${account}, and choose Allow:\n\n${url}\n`);
      if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    },
  });
  console.log(`\nAuthorised as ${email}. That is the destination account, so it is safe to continue.\n`);
  console.log("1. Open backend/.env in your editor and add this line (keep it secret; it must never be committed or shared):\n");
  console.log(`   GOOGLE_DRIVE_REFRESH_TOKEN=${refreshToken}\n`);
  console.log("2. Make sure backend/.env also has PDF_STORAGE=google-drive");
  console.log("3. Restart the backend, then run:  npm run drive:check\n");
} catch (err) {
  console.error(`\n${err instanceof OAuthError ? err.message : "The authorisation did not complete. Run the command again."}\n`);
  process.exit(1);
}
