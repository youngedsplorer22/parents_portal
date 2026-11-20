// Shared Vite settings for every portal. Each app's vite.config.js calls createPortalConfig({ root, target, port }).
// Only PUBLIC values are ever baked into a build (VITE_*). Never put a password, token or secret in one.
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { portalConfigGuard } from "./deployment-guard.js";

const coreDir = path.dirname(fileURLToPath(import.meta.url));

export function createPortalConfig({ target, port = 5173, apiTarget = process.env.DEV_API_URL ?? "http://127.0.0.1:4000" }) {
  return defineConfig({
    plugins: [react(), tailwindcss(), portalConfigGuard({ target })],
    publicDir: path.join(coreDir, "public"),
    define: {
      __PORTAL_TARGET__: JSON.stringify(target),
      // Literal booleans so the bundler drops the other side's code (see AppRoutes.jsx).
      __HAS_STAFF__: String(target === "staff"),
      __HAS_PARENT__: String(target !== "staff"),
    },
    build: { sourcemap: false }, // no source maps in public output
    server: {
      host: "0.0.0.0",
      port,
      // Same-origin /api in development, with the browser's Host kept (the API compares it with Origin).
      proxy: { "/api": { target: apiTarget, changeOrigin: false } },
    },
  });
}
