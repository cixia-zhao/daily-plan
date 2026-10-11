"""独立 UI 预览入口，不读取日常数据库，不调用 AI。"""
from __future__ import annotations

import argparse
import socket
from pathlib import Path

import uvicorn

from .main import create_app

ROOT = Path(__file__).resolve().parent.parent


def create_preview_app():
    app = create_app(
        database_path=ROOT / "data" / "ui-preview.db",
        backup_dir=ROOT / "data" / "ui-preview-backups",
        runtime_mode="development",
        disable_ai=True,
    )
    app.state.ui_preview = True
    return app


def lan_address():
    # UDP connect 只查询本机路由，不发送数据；地址随热点/网络变化。
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect(("1.1.1.1", 80))
        return sock.getsockname()[0]


def main():
    parser = argparse.ArgumentParser(description="启动独立 UI 预览，Ctrl+C 停止")
    parser.add_argument("--lan", action="store_true", help="允许同一 Wi-Fi 或手机热点预览（仅测试数据）")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("端口须在 1024 到 65535 之间")
    host = lan_address() if args.lan else "127.0.0.1"
    print(f"预览地址：http://{host}:{args.port}/", flush=True)
    print("独立测试数据；修改后刷新页面查看。Ctrl+C 停止。", flush=True)
    uvicorn.run("app.preview:create_preview_app", factory=True, host=host, port=args.port,
                reload=True, reload_dirs=[str(ROOT / "app")])


if __name__ == "__main__":
    main()
