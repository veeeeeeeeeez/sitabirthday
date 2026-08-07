#!/usr/bin/env bash
# Local dev server. Point Conductor's run script at this file, or run ./scripts/dev.sh
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"

if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install --silent
fi

if [ ! -f .env ]; then
  echo
  echo "  No .env file yet. Creating one from .env.example."
  echo "  Fill in R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, then run this again."
  echo
  cp .env.example .env
  exit 1
fi

# Free the port if a previous run is still holding it.
if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "Port $PORT is busy — stopping the old server."
  lsof -ti tcp:"$PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo
echo "  Upload page   http://localhost:$PORT"
echo "  The gallery   http://localhost:$PORT/wall/\$VIEW_KEY"
echo

exec node --env-file=.env server.js
