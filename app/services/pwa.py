"""公共 PWA 元信息及带文件状态热缓存的静态资源版本计算。"""
from __future__ import annotations

import hashlib
from pathlib import Path

_VERSION_CACHE: dict[Path, tuple[tuple[tuple[str, int, int], ...], str]] = {}


def asset_version(static_dir: Path) -> str:
    resolved = static_dir.resolve()
    files = sorted(path for path in resolved.rglob("*") if path.is_file())
    signature = tuple(
        (path.relative_to(resolved).as_posix(), (stat := path.stat()).st_mtime_ns, stat.st_size)
        for path in files
    )
    cached = _VERSION_CACHE.get(resolved)
    if cached is not None and cached[0] == signature:
        return cached[1]
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(resolved).as_posix().encode())
        digest.update(path.read_bytes())
    version = digest.hexdigest()[:16]
    _VERSION_CACHE[resolved] = (signature, version)
    return version


def manifest() -> dict:
    return {
        "id": "/",
        "name": "今日航线",
        "short_name": "今日航线",
        "lang": "zh-CN",
        "description": "安排今天，记录投入，回顾自己的学习航线。",
        "start_url": "/?source=pwa",
        "scope": "/",
        "display": "standalone",
        "background_color": "#f4f1e9",
        "theme_color": "#f4f1e9",
        "icons": [
            {"src": "/static/pwa/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/static/pwa/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/static/pwa/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
        "shortcuts": [
            {"name": "计划", "url": "/", "icons": [{"src": "/static/pwa/icon-192.png", "sizes": "192x192"}]},
            {"name": "执行", "url": "/execute", "icons": [{"src": "/static/pwa/icon-192.png", "sizes": "192x192"}]},
            {"name": "复盘", "url": "/review", "icons": [{"src": "/static/pwa/icon-192.png", "sizes": "192x192"}]},
        ],
    }
