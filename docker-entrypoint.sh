#!/bin/sh
set -e

# Self-heal the uploads volume permissions, then drop privileges. The container
# starts as root so it can chown the mounted volume (EasyPanel mounts it
# root-owned); the app itself must NOT run as root. When started as root we fix
# ownership and re-exec this same script as `nextjs`, so migrations and the
# server below always run unprivileged.
UPLOAD_DIR="${UPLOAD_DIR:-/data/uploads}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$UPLOAD_DIR"
  chown -R nextjs:nodejs "$UPLOAD_DIR"
  exec su-exec nextjs:nodejs "$0" "$@"
fi

# Always apply pending database migrations on boot. The runner is idempotent
# (Drizzle records what it has applied), so re-running on every restart is a
# cheap no-op once the schema is in sync. We intentionally do NOT honor a
# RUN_MIGRATIONS=false switch any more: skipping migrations on deploy is exactly
# what left production a schema behind (the transfer->treasury column never
# landed). A migration failure must NOT crash-loop the container — the app
# tolerates a temporary schema gap (e.g. the bank-deposit bridge is best-effort)
# — so we log it and start the server anyway instead of taking the app down.
echo "[entrypoint] Running database migrations..."
if node scripts/db-migrate.mjs; then
  echo "[entrypoint] Migrations up to date."
else
  echo "[entrypoint] WARNING: migrations failed; starting the server anyway. See logs above."
fi

echo "[entrypoint] Starting Next.js server on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec node server.js
