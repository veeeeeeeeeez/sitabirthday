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

# Read VIEW_KEY out of .env so the banner prints a link that actually works.
VIEW_KEY="$(grep -E '^VIEW_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"

echo
echo "  Upload page   http://localhost:$PORT"
if [ -n "$VIEW_KEY" ]; then
  echo "  The gallery   http://localhost:$PORT/wall/$VIEW_KEY"
else
  echo "  The gallery   http://localhost:$PORT/wall   (VIEW_KEY is unset)"
fi
echo

exec node --env-file=.env server.js
