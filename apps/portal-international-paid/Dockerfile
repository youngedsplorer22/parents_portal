# Build stage: full monorepo with devDependencies so Vite can resolve all workspace packages.
# Uses npm install rather than npm ci to avoid an EBUSY error seen with Railpack's file-locking
# behaviour on Railway (commit 1e3880e). Docker builds are unaffected by that issue, but keeping
# the same command avoids a hidden behavioural difference between local and CI builds.
FROM node:24-alpine AS build
WORKDIR /app
COPY . .
RUN npm install --include=dev && npm run build -w @pp/portal-international-paid

# Runtime stage: only the zero-dependency web-server and the built portal assets.
# web-server imports nothing outside node: built-ins, so no node_modules are needed here.
# The start command and all required env vars (PORTAL_ROLE, STATIC_DIR, PORT, API_URL,
# PORTAL_PROXY_SECRET, CLIENT_IP_SOURCE) are supplied by Railway via deploy.startCommand
# and the service's environment variables; this CMD is a local-run fallback only.
FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/apps/web-server ./apps/web-server
COPY --from=build /app/apps/portal-international-paid/dist ./apps/portal-international-paid/dist
CMD ["node", "apps/web-server/src/server.js"]
