"""为浏览器场景启动临时数据库，禁止连接预览库或正式库。"""
from pathlib import Path
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

root = Path(__file__).resolve().parents[1]
script = root / 'tests' / Path(sys.argv[1]).name
if script.suffix != '.cjs' or not script.is_file():
    raise SystemExit('请指定tests目录下的浏览器脚本')
with tempfile.TemporaryDirectory(prefix=f'daily-plan-ui-{script.stem}-') as folder:
    temp = Path(folder)
    (temp / 'browser_boot.py').write_text("""import os
from app.main import create_app
app=create_app(database_path=os.environ['DATABASE_PATH'],backup_dir=os.environ['DAILY_PLAN_BACKUP_DIR'],runtime_mode='development',disable_ai=True,disable_notifications=True)
""")
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = dict(os.environ, TZ='Asia/Shanghai', APP_RUNTIME='development', DATABASE_PATH=str(temp/'test.db'), DAILY_PLAN_BACKUP_DIR=str(temp/'backups'), PYTHONPATH=os.pathsep.join([str(root),folder,os.environ.get('PYTHONPATH','')]), DAILY_PLAN_TEST_URL=f'http://127.0.0.1:{port}')
    with (temp/'server.log').open('w+') as log:
        server = subprocess.Popen([sys.executable,'-m','uvicorn','browser_boot:app','--host','127.0.0.1','--port',str(port)],cwd=root,env=env,stdout=log,stderr=log)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(env['DAILY_PLAN_TEST_URL']+'/api/system/health',timeout=.5)
                    break
                except Exception:
                    if server.poll() is not None:
                        raise RuntimeError('临时测试服务退出')
                    time.sleep(.1)
            else:
                raise RuntimeError('临时测试服务未就绪')
            subprocess.run(['node',str(script)],cwd=root,env=env,check=True)
        except BaseException:
            log.flush();log.seek(0);print(log.read()[-4000:]);raise
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill();server.wait()
