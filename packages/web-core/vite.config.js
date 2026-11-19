
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
    ],
    server: {
        host: "0.0.0.0",
        // To open the dev server through a tunnel, list its hostname here for your own session only; never commit it.
        // allowedHosts: ["your-tunnel-hostname.example"],
        // Same-origin requests in development: no CORS needed.
        proxy: {
            // Preserve the existing Host header for staff API same-site checks.
            "/api": {
                target: "http://127.0.0.1:4000",
                changeOrigin: false,
            },
        },
    },
    test: {
        environment: "jsdom",
        setupFiles: ["./src/test/setup.js"],
        restoreMocks: true,
        testTimeout: 20000,
    },
});
