"""公共安装资源与认证、缓存边界；全部使用临时数据库。"""
import struct
from pathlib import Path
from fastapi.testclient import TestClient
from app.main import create_app
from app.auth import hash_password
from test_review_workspace import client_for


def test_public_install_resources_do_not_expose_private_pages(tmp_path):
    app=create_app(database_path=tmp_path/'pwa.db',disable_ai=True,runtime_mode='production',auth_password_hash=hash_password('temporary-password-for-pwa-test'),session_secret='temporary-pwa-test-session-secret')
    with TestClient(app,base_url='https://testserver') as client:
        manifest=client.get('/manifest.webmanifest')
        assert manifest.status_code==200
        assert manifest.headers['content-type'].startswith('application/manifest+json')
        data=manifest.json();assert data['name']==data['short_name']=='今日航线'
        assert data['display']=='standalone' and data['id']=='/' and data['scope']=='/'
        assert data['start_url'].startswith('/') and len(data['icons'])==3
        for item in data['icons']:
            icon=client.get(item['src']);assert icon.status_code==200 and icon.content.startswith(b'\x89PNG')
        assert client.get('/sw.js').status_code==200
        assert client.get('/offline').status_code==200
        assert client.get('/favicon.ico').status_code==200
        assert client.get('/api/settings').status_code==401
        assert client.get('/execute',follow_redirects=False).status_code==303
        login=client.get('/login');assert 'apple-touch-icon' in login.text and 'pwa-install' in login.text
        assert login.headers['cache-control']=='no-store'


def test_worker_headers_and_release_version(tmp_path):
    client=client_for(tmp_path)
    response=client.get('/sw.js')
    assert response.headers['content-type'].startswith('application/javascript')
    assert response.headers['service-worker-allowed']=='/'
    assert response.headers['cache-control']=='no-cache'
    assert '__PWA_VERSION__' not in response.text
    assert response.content==client.get('/sw.js').content


def test_pages_and_api_are_not_http_cached(tmp_path):
    client=client_for(tmp_path)
    for path in ['/','/execute','/review','/settings','/api/settings','/api/system/health','/missing-private-page']:
        response=client.get(path)
        assert response.headers['cache-control']=='no-store',path
    for path in ['/','/login','/execute','/review','/settings','/gpt-workbench']:
        response=client.get(path)
        assert 'viewport-fit=cover' in response.text and 'rel="manifest"' in response.text
        assert '/static/pwa.js?' in response.text


def test_icon_dimensions_and_maskable_asset(tmp_path):
    client=client_for(tmp_path)
    for filename,size in [('icon-192.png',192),('icon-512.png',512),('icon-maskable-512.png',512),('apple-touch-icon.png',180)]:
        content=client.get('/static/pwa/'+filename).content
        assert struct.unpack('>II',content[16:24])==(size,size)
    assert client.get('/favicon.ico').content[:4]==b'\x00\x00\x01\x00'


def test_offline_document_is_neutral_and_public(tmp_path):
    client=client_for(tmp_path);response=client.get('/offline')
    assert '暂时无法连接' in response.text
    assert '/static/pwa/offline.js' in response.text
    assert 'password' not in response.text and 'API_KEY' not in response.text
    assert '重新连接' in response.text
