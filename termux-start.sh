#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"
DATABASE_PATH="${DATABASE_PATH:-data/daily_plan.db}"
APP_URL="http://${HOST}:${PORT}"

if ! command -v python >/dev/null 2>&1; then
  echo "[ERROR] 没找到 python。先在 Termux 里运行：pkg install python"
  exit 1
fi

if ! python -c "import app.main, uvicorn" >/dev/null 2>&1; then
  echo "[ERROR] 依赖还没装好。先运行：bash ./termux-install.sh"
  exit 1
fi

export DATABASE_PATH

echo "========================================"
echo "         DAILY PLAN TERMUX SERVER"
echo "========================================"
echo "Project: $(pwd)"
echo "DB:      ${DATABASE_PATH}"
echo "URL:     ${APP_URL}"
echo
echo "[START] 服务启动后可在手机浏览器打开上面这个地址。"
echo "[STOP]  在当前 Termux 窗口按 Ctrl+C 停止。"
echo

if command -v termux-open-url >/dev/null 2>&1; then
  (
    sleep 2
    termux-open-url "${APP_URL}" >/dev/null 2>&1 || true
  ) &
fi

python -m uvicorn app.main:app --host "${HOST}" --port "${PORT}"
