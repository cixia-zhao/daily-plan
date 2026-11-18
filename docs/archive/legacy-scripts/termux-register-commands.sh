#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

PROJECT_ROOT="$(pwd)"
PREFIX_BIN="${PREFIX:-/data/data/com.termux/files/usr}/bin"

mkdir -p "$PREFIX_BIN"

cat > "${PREFIX_BIN}/dp" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
cd "${PROJECT_ROOT}"
exec bash ./termux-start.sh "\$@"
EOF

cat > "${PREFIX_BIN}/spdp" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
cd "${PROJECT_ROOT}"
bash ./termux-update.sh
exec bash ./termux-start.sh "\$@"
EOF

chmod +x "${PREFIX_BIN}/dp" "${PREFIX_BIN}/spdp"

echo "[OK] 已注册快捷命令：dp / spdp"
echo "dp   -> 直接启动今日航线"
echo "spdp -> 先更新，再启动今日航线"
