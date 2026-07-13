#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-/etc/daily-plan/daily-plan.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

cd "$ROOT_DIR"

exec "$ROOT_DIR/.venv/bin/python" -m uvicorn app.main:app \
  --host "${APP_HOST:-127.0.0.1}" \
  --port "${APP_PORT:-8000}"
