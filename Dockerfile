# syntax=docker/dockerfile:1

# --- Stage 1: build (install all deps, bundle with esbuild) ---
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY drizzle ./drizzle
# Bundle the server to dist/server.js (esbuild, --packages=external keeps node_modules external).
RUN npm run build

# --- Stage 2: production deps only ---
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Production deps only; includes the argon2 native module compiled for this platform.
RUN npm ci --omit=dev

# --- Stage 3: runtime (non-root, minimal) ---
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Drop privileges (NFR1 / container hardening).
USER node
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/drizzle ./drizzle
COPY --chown=node:node package.json ./
EXPOSE 3000
# Simple healthcheck hitting /health (R15 / ALB parity).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
