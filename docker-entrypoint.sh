#!/bin/sh
set -e

# Apply pending database migrations before booting the server.
# Disable by setting RUN_MIGRATIONS=false (e.g. if you migrate out-of-band).
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] Running database migrations..."
  node scripts/db-migrate.mjs
else
  echo "[entrypoint] RUN_MIGRATIONS=false, skipping migrations."
fi

echo "[entrypoint] Starting Next.js server on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec node server.js
