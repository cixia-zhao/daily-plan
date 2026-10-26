"""公共PWA元信息及按内容变化的服务工作线程版本。"""
import hashlib
from pathlib import Path


def asset_version(static_dir: Path):
    digest=hashlib.sha256()
    for path in sorted(static_dir.rglob('*')):
        if path.is_file():
            digest.update(path.relative_to(static_dir).as_posix().encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


def manifest():
    return {
        'id':'/', 'name':'今日航线', 'short_name':'今日航线', 'lang':'zh-CN',
        'description':'安排今天，记录投入，回顾自己的学习航线。',
        'start_url':'/?source=pwa', 'scope':'/', 'display':'standalone',
        'background_color':'#f4f1e9', 'theme_color':'#f4f1e9',
        'icons':[
            {'src':'/static/pwa/icon-192.png','sizes':'192x192','type':'image/png','purpose':'any'},
            {'src':'/static/pwa/icon-512.png','sizes':'512x512','type':'image/png','purpose':'any'},
            {'src':'/static/pwa/icon-maskable-512.png','sizes':'512x512','type':'image/png','purpose':'maskable'},
        ],
        'shortcuts':[
            {'name':'计划','url':'/','icons':[{'src':'/static/pwa/icon-192.png','sizes':'192x192'}]},
            {'name':'执行','url':'/execute','icons':[{'src':'/static/pwa/icon-192.png','sizes':'192x192'}]},
            {'name':'复盘','url':'/review','icons':[{'src':'/static/pwa/icon-192.png','sizes':'192x192'}]},
        ],
    }
