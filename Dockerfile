# syntax=docker/dockerfile:1
#
# Meme Pals: one container that serves the PWA and runs the stateless relay.
# No volumes, no database, nothing written to disk at runtime.
#
#   docker build -t meme-pals .
#   docker run --rm -p 8787:8787 --read-only meme-pals
#
# Optional TURN: -e TURN_URLS=turn:turn.example.com:3478 -e TURN_USERNAME=... -e TURN_CREDENTIAL=...

ARG NODE_IMAGE=node:22-bookworm-slim

# ── base: Node + pnpm (version pinned by package.json "packageManager") ─────
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /app
# Workspace manifests only, so the install layer is cached until deps change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/relay/package.json apps/relay/
COPY apps/web/package.json apps/web/

# ── build: full install, then build the web app ─────────────────────────────
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @memes/web build

# ── relay-deps: production dependencies of the relay only (ws, tsx, shared) ─
FROM base AS relay-deps
RUN pnpm install --frozen-lockfile --prod --filter "@memes/relay..."

# ── runtime ─────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    STATIC_DIR=/app/apps/web/dist \
    TSX_DISABLE_CACHE=1
WORKDIR /app
COPY --from=relay-deps /app/package.json /app/tsconfig.base.json ./
COPY --from=relay-deps /app/node_modules ./node_modules
COPY --from=relay-deps /app/apps/relay/node_modules ./apps/relay/node_modules
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY apps/relay/package.json apps/relay/tsconfig.json apps/relay/
COPY apps/relay/src apps/relay/src
COPY --from=build /app/apps/web/dist apps/web/dist

# Everything is owned by root and read-only for the runtime user.
USER node
WORKDIR /app/apps/relay
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Same as `pnpm start` (tsx src/server.ts), but in a single process so
# SIGTERM reaches the relay directly and it can shut down gracefully.
CMD ["node", "--import", "tsx", "src/server.ts"]
