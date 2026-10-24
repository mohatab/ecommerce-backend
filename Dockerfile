# --- Build stage ---
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

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
CMD ["node", "dist/main"]
