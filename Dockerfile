# syntax=docker/dockerfile:1

##########
# 1) deps: install all dependencies (incl. dev, needed to build)
##########
FROM node:24-alpine AS deps
WORKDIR /app

# libc compat for some native-ish deps under Alpine
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
RUN npm ci

##########
# 2) builder: compile the Next.js standalone bundle
##########
FROM node:24-alpine AS builder
WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Public (NEXT_PUBLIC_*) vars are baked into the client bundle at build time.
# The Clerk publishable key is public (it ships to every browser), so we bake a
# default here for platforms (e.g. EasyPanel) that don't forward env vars as
# build args. It can still be overridden with --build-arg. Server secrets are
# NOT needed here (SKIP_ENV_VALIDATION bypasses validation; read at runtime).
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ZmluZS1yYWNjb29uLTcuY2xlcmsuYWNjb3VudHMuZGV2JA
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_LOGGING_LEVEL=info

ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_LOGGING_LEVEL=${NEXT_PUBLIC_LOGGING_LEVEL} \
    NEXT_PUBLIC_SENTRY_DISABLED=true \
    SKIP_ENV_VALIDATION=true \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# Server Actions encryption key. When unset, Next.js regenerates a random key on
# every build, which rotates every Server Action ID per deploy and breaks any
# already-open browser tab ("Failed to find Server Action"). Pinning a stable key
# keeps action IDs consistent across deploys for unchanged actions; it must be a
# base64-encoded AES key (16/24/32 bytes) and is embedded into the build output.
#
# Passed as a BuildKit secret — never an ARG/ENV layer — so it doesn't trip
# Docker's SecretsUsedInArgOrEnv check. Falls back to a committed stable default
# for platforms (EasyPanel) that don't forward build secrets. Rotate in prod with:
#   docker build --secret id=sa_key,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY .
#
# Build the app only (migrations run at container startup, not at build time).
RUN --mount=type=secret,id=sa_key,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:-YhpHdhNUpnXwlS6N8zxuNLO2NDFCTczJNUHXypDTT2Q=}" \
    npm run build:next

##########
# 3) runner: minimal production image
##########
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Non-root user for safety
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone server + its trimmed node_modules (includes ./migrations via
# outputFileTracingIncludes in next.config.ts).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Turbopack bundles drizzle-orm into the server chunks, so it's absent from the
# standalone node_modules. The standalone tree DOES ship `pg`, so adding the
# zero-dependency drizzle-orm package is enough for the runtime migration runner.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/drizzle-orm ./node_modules/drizzle-orm

# Runtime migration runner + entrypoint (not traced into standalone).
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER nextjs

EXPOSE 3000

# Container-level healthcheck (EasyPanel also probes the HTTP port).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
