#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

echo "[1/4] 安装 Python 和 Git"
pkg update -y
pkg install -y python git

echo "[2/4] 升级 pip"
python -m pip install --upgrade pip

echo "[3/4] 安装项目依赖"
python -m pip install -e ".[dev]"

echo "[4/4] 初始化 .env"
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
fi

echo
echo "[OK] Termux 首次安装完成。"
echo "下次启动直接运行：bash ./termux-start.sh"
