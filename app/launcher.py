from __future__ import annotations

import sys
import time
import webbrowser
from urllib.request import urlopen


def wait_and_open(url: str, attempts: int = 60, delay: float = 1.0) -> bool:
    """等待本地服务就绪后打开浏览器。"""
    for _ in range(attempts):
        try:
            response = urlopen(url, timeout=1)
            close = getattr(response, "close", None)
            if close:
                close()
            webbrowser.open(url)
            return True
        except OSError:
            time.sleep(delay)
    print(f"服务启动等待超时，请稍后手动打开：{url}")
    return False


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
    raise SystemExit(0 if wait_and_open(target) else 1)
