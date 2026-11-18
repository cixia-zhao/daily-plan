#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

echo "[1/4] 安装 Python 和 Git"
pkg update -y
pkg install -y python git

echo "[2/4] 检查 pip"
python -m pip --version >/dev/null

echo "[3/4] 安装项目依赖"
python -m pip install -e ".[dev]"

echo "[4/5] 初始化 .env"
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
fi

echo "[5/5] 注册快捷命令"
bash ./termux-register-commands.sh

echo
echo "[OK] Termux 首次安装完成。"
echo "下次启动直接运行：dp"
