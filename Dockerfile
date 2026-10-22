# siiswell, self-hosted: Bun server + SQLite (see docs/deploy.md "Deploy with Docker").
# Base image pinned to an exact release (>= 2 weeks old); bump deliberately, together with @types/bun in package.json.
FROM oven/bun:1.3.6-slim

WORKDIR /app
# No runtime dependencies: the server uses only Bun built-ins (bun:sqlite, Bun.serve, Bun.password, WebCrypto).
COPY package.json tsconfig.json ./
COPY src ./src
COPY cli/build.ts cli/package.json ./cli/
COPY cli/src ./cli/src
COPY public ./public
COPY migrations ./migrations
COPY scripts/embed-client.ts ./scripts/
COPY scripts/hash-password.ts scripts/recovery-token.ts scripts/vapid.ts scripts/new-token.ts scripts/purge-source.ts scripts/db-exec.ts ./scripts/

# the build stamp shown in the footer and /api/health: docker build --build-arg SIISWELL_BUILD_SHA=$(git rev-parse --short=7 HEAD) --build-arg SIISWELL_BUILD_DATE=$(date -u +%F)
ARG SIISWELL_BUILD_SHA=""
ARG SIISWELL_BUILD_DATE=""
ENV SIISWELL_BUILD_SHA=$SIISWELL_BUILD_SHA \
    SIISWELL_BUILD_DATE=$SIISWELL_BUILD_DATE

# the CLI bundle `siiswell update` downloads (same sha stamp as the server)
RUN bun scripts/embed-client.ts

RUN mkdir -p /data && chown bun:bun /data
USER bun

ENV NODE_ENV=production \
    BIND=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# exec form: bun is PID 1 and receives SIGTERM directly (graceful shutdown in src/server/bun.ts).
CMD ["bun", "src/server/bun.ts"]
