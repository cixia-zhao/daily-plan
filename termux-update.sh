#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

DATABASE_PATH="${DATABASE_PATH:-data/daily_plan.db}"
BACKUP_DIR="${BACKUP_DIR:-backups}"

if ! command -v git >/dev/null 2>&1; then
  echo "[ERROR] 没找到 git。先运行：bash ./termux-install.sh"
  exit 1
fi

if ! command -v python >/dev/null 2>&1; then
  echo "[ERROR] 没找到 python。先运行：bash ./termux-install.sh"
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[ERROR] 当前目录不是 Git 工作区。"
  echo "请先按 docs/termux-git-update.md 完成一次性迁移，再使用这个脚本。"
  exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "[ERROR] 检测到本地代码有未提交修改，已停止自动更新。"
  echo "先执行：git status"
  exit 1
fi

if [ -f "$DATABASE_PATH" ]; then
  mkdir -p "$BACKUP_DIR"
  backup_path="${BACKUP_DIR}/daily_plan-$(date +%F-%H%M%S).db"
  cp "$DATABASE_PATH" "$backup_path"
  echo "[1/4] 已备份当前数据库到：$backup_path"
else
  echo "[1/4] 当前还没有数据库文件，跳过备份"
fi

echo "[2/4] 拉取 GitHub 最新代码"
git pull --ff-only

echo "[3/4] 同步 Python 依赖"
python -m pip install -e ".[dev]"

echo "[4/5] 刷新快捷命令"
bash ./termux-register-commands.sh

echo "[5/5] 保留本地数据目录，不做覆盖"
echo
echo "[OK] 更新完成。"
echo "下次启动继续运行：dp"
