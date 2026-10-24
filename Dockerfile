# --- Build stage ---
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# --- Migration stage ---
# Migrations are a DISCRETE RELEASE COMMAND, never run at application boot.
# This stage exists so that command ships as an artifact instead of depending
# on someone having a checkout and the right CLI.
#
# It reuses `build` verbatim, which already carries devDependencies (the prisma
# CLI is one), prisma/schema.prisma and prisma/migrations. That reuse is the
# point: the migrator and the server come from ONE Dockerfile and ONE source
# commit, which removes the real hazard here — a migration applied from a
# DIFFERENT checkout than the running image, where the two drift and nothing
# detects it.
#
# It is deliberately NOT the last stage. `docker build` with no --target builds
# the last stage, so putting this after `runtime` would silently make a bare
# `docker build .` produce a migration container instead of the server. Keep
# `runtime` last, and pass --target explicitly anyway.
#
# Fat by design: it inherits the whole build stage. Acceptable for an image
# that never serves traffic and is never published.
FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

# --- Runtime stage ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Declared, not changed: alpine already defaults to UTC, so this does not move
# any schedule. It makes "03:00" in the runbook unambiguous and stops a future
# base image with a different default from silently moving the retention purge
# (MAINTENANCE_PURGE_CRON=0 0 3 * * *).
ENV TZ=UTC

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3000
# Container liveness, pointed at /health/live and NEVER at /health.
#
# /health queries the database and 503s when it is unreachable. Tying restarts
# to that turns a transient database blip into an UNBOOTABLE CRASH LOOP:
# PrismaService.onModuleInit() calls $connect(), whose failure exits the
# process, so the restart cannot succeed while the database is down — where the
# running container would have reconnected on its own.
#
# wget comes from busybox in this base image and nothing else here uses it, so
# its presence is verified explicitly inside the built image rather than
# assumed (control C-D11). A HEALTHCHECK whose command is MISSING reports
# `unhealthy` rather than erroring, so this would otherwise fail silently and
# look like an application fault.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health/live || exit 1
CMD ["node", "dist/main"]
