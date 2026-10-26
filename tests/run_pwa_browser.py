"""只启动临时库与临时版本源，运行真实Service Worker生命周期专项。"""
from pathlib import Path
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

root=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='daily-plan-pwa-') as folder:
    temp=Path(folder)
    revision=temp/'worker-version.txt';revision.write_text('test-version-one')
    (temp/'pwa_test_boot.py').write_text('''from app.main import create_app
from fastapi.responses import Response
from pathlib import Path
import os
app=create_app(database_path=os.environ['DATABASE_PATH'],backup_dir=os.environ['DAILY_PLAN_BACKUP_DIR'],runtime_mode='development',disable_ai=True,disable_notifications=True)
@app.middleware('http')
async def test_worker_version(request,call_next):
    if request.url.path=='/sw.js':
        source=Path('app/static/pwa/sw.js').read_text().replace('__PWA_VERSION__',Path(os.environ['PWA_TEST_REVISION']).read_text())
        return Response(source,media_type='application/javascript',headers={'Cache-Control':'no-cache','Service-Worker-Allowed':'/'})
    return await call_next(request)
''')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    env=dict(os.environ,APP_RUNTIME='development',DATABASE_PATH=str(temp/'test.db'),DAILY_PLAN_BACKUP_DIR=str(temp/'backups'),DEEPSEEK_API_KEY='',DAILY_PLAN_NTFY_URL='',DAILY_PLAN_NTFY_TOPIC='',DAILY_PLAN_NTFY_TOKEN='',PYTHONPATH=str(root)+os.pathsep+folder,DAILY_PLAN_TEST_URL=f'http://127.0.0.1:{port}',PWA_TEST_REVISION=str(revision))
    with (temp/'server.log').open('w+') as log:
        server=subprocess.Popen([sys.executable,'-m','uvicorn','pwa_test_boot:app','--host','127.0.0.1','--port',str(port)],cwd=root,env=env,stdout=log,stderr=log)
        try:
            for _ in range(100):
                try:urllib.request.urlopen(env['DAILY_PLAN_TEST_URL']+'/api/system/health',timeout=.5);break
                except Exception:
                    if server.poll() is not None:raise RuntimeError('临时测试服务退出')
                    time.sleep(.1)
            else:raise RuntimeError('临时测试服务未就绪')
            subprocess.run([shutil.which('node'),str(root/'tests/pwa_flows.cjs')],cwd=root,env=env,check=True)
        except BaseException:
            log.flush();log.seek(0);print(log.read()[-3000:]);raise
        finally:
            server.terminate()
            try:server.wait(timeout=10)
            except subprocess.TimeoutExpired:server.kill();server.wait()
