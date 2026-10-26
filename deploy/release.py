"""精确版本发布：沿用锁定依赖、先验备份副本、原子切换与只读验收。"""
import argparse
import base64
from datetime import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT=Path('/opt/daily-plan')
DB=Path('/var/lib/daily-plan/daily_plan.db')
BACKUPS=Path('/var/backups/daily-plan')
ENV=Path('/etc/daily-plan/daily-plan.env')


def run(args,**kwargs):
    return subprocess.run(args,check=True,text=True,**kwargs)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def backup(destination):
    with sqlite3.connect(f'file:{DB}?mode=ro',uri=True) as source,sqlite3.connect(destination) as target:
        source.backup(target)


def verify_http(release):
    import httpx
    from dotenv import dotenv_values
    from itsdangerous import TimestampSigner
    env=dotenv_values(ENV)
    secret=env.get('APP_SESSION_SECRET')
    assert secret,'缺少会话配置'
    session=TimestampSigner(secret).sign(base64.b64encode(json.dumps({'authenticated':True}).encode())).decode()
    with httpx.Client(base_url='http://127.0.0.1:8000',timeout=10,trust_env=False,headers={'Cookie':'daily_plan_session='+session}) as client:
        health=None
        for attempt in range(30):
            try:
                health=client.get('/api/system/health')
                if health.status_code==200:break
            except httpx.TransportError:pass
            time.sleep(.5)
        assert health is not None and health.status_code==200,'健康接口或会话验收失败'
        data=health.json()
        assert data['mode']=='production' and Path(data['database_path']).resolve()==DB
        for path in ['/','/execute','/review','/settings','/gpt-workbench']:
            response=client.get(path);assert response.status_code==200,path
            assert 'UI 预览' not in response.text
        static_files = sorted(path.relative_to(release/'app/static').as_posix() for path in (release/'app/static').rglob('*') if path.is_file() and path.suffix in ('.css','.js','.png','.svg','.ico','.html'))
        for filename in static_files:
            response=client.get('/static/'+filename)
            assert response.status_code==200
            assert hashlib.sha256(response.content).hexdigest()==sha(release/'app/static'/filename),filename
        response=client.get('/execute?date=2026-10-22')
        assert response.status_code==200 and 'data-page="execution-history"' in response.text
        today=client.get('/').text
        assert 'surfaces.css' in today
        assert 'plan-list-surface' in today and '修改目标时长' in today and 'cancel-target-edit' in today
        assert 'target-edit-error' in today
        assert 'id="plan-section" class="panel' not in today
        assert 'execution-controls' in client.get('/execute').text
        assert 'execution-controls' in client.get('/review').text
        assert 'execution-controls' not in client.get('/settings').text
        daily=client.get('/api/daily-review/2026-10-22')
        assert daily.status_code==200 and 'comparison' in daily.json()
        weekly=client.get('/api/weekly-review?anchor_date=2026-10-22')
        assert weekly.status_code==200 and 'previous_days' in weekly.json()['comparison']
        settings=client.get('/api/settings').json()
        assert isinstance(settings['main_project_categories'],list)
        assert 'show_energy_selector' in settings and 'show_day_type_selector' in settings
        notifications=client.get('/api/notifications/status').json()
        assert notifications['configured'] and not notifications['preview']
        paths=client.get('/openapi.json').json()['paths']
        assert '/api/daily-execution/{plan_date}/quick-corrections' in paths
        assert '/api/daily-execution/{plan_date}/auto-stop' in paths
        assert 'auto-stop-dialog' in client.get('/execute').text
        assert 'execution-records-page' in client.get('/execute').text
        assert 'rel="manifest"' in today and 'viewport-fit=cover' in today
    with httpx.Client(base_url='http://127.0.0.1:8000',timeout=10,trust_env=False) as client:
        private=client.get('/api/settings');assert private.status_code==401 and private.headers['cache-control']=='no-store'
        manifest=client.get('/manifest.webmanifest');assert manifest.status_code==200
        data=manifest.json();assert data['name']=='今日航线' and data['display']=='standalone'
        assert any(icon.get('purpose')=='maskable' for icon in data['icons'])
        for icon in data['icons']:assert client.get(icon['src']).status_code==200
        worker=client.get('/sw.js');assert worker.status_code==200 and '__PWA_VERSION__' not in worker.text
        assert worker.headers['cache-control']=='no-cache' and worker.headers['service-worker-allowed']=='/'
        assert client.get('/offline').status_code==200 and client.get('/favicon.ico').status_code==200
    for service in ['daily-plan.service','daily-plan-ntfy.service','nginx.service','daily-plan-backup.timer','daily-plan-cert-renew.timer']:
        run(['systemctl','is-active','--quiet',service])
    return {'protected_pages':5,'static_files_match':len(static_files),'production_database':True,'notification_configured':True,'unauthenticated_api':401,'services_active':True,'new_api_registered':True,'history_page':200,'pwa_public_resources':True,'pwa_standalone':True,'private_no_store':True,'auto_stop_api':True,'shared_execution_panel':True,'comparison_apis':2,'today_edit_controls':True,'today_content_surface':True}


def migration(release, source, target):
    result=run([str(release/'.venv/bin/python'),str(release/'deploy/verify-migration.py'),str(source),str(target)],capture_output=True)
    return json.loads(result.stdout)


def stage(args,release):
    assert not release.exists(),'目标版本目录已存在，请核对，不覆盖'
    assert sha(args.source_archive)==args.archive_sha,'源码归档校验失败'
    release.mkdir(parents=True)
    with tarfile.open(args.source_archive) as archive:archive.extractall(release,filter='data')
    wheel_dir=Path(tempfile.mkdtemp(prefix='daily-plan-release-wheels-'))
    assert sha(args.wheel_archive)==args.wheel_sha,'依赖归档校验失败'
    wheel_dir.mkdir(exist_ok=True)
    with tarfile.open(args.wheel_archive) as archive:archive.extractall(wheel_dir,filter='data')
    run(['/usr/bin/python3','-m','venv',str(release/'.venv')])
    run([str(release/'.venv/bin/python'),'-m','pip','install','--no-index','--find-links',str(wheel_dir/'daily-plan-release-wheels'),'-r',str(wheel_dir/'daily-plan-release-requirements.txt')],stdout=subprocess.DEVNULL)
    with tempfile.TemporaryDirectory(prefix='daily-plan-release-tests-') as temporary:
        test_env=dict(os.environ, APP_RUNTIME='development', DATABASE_PATH=str(Path(temporary)/'bootstrap.db'), DAILY_PLAN_BACKUP_DIR=str(Path(temporary)/'backups'))
        for key in ('DEEPSEEK_API_KEY','DAILY_PLAN_NTFY_URL','DAILY_PLAN_NTFY_TOPIC','DAILY_PLAN_NTFY_TOKEN'):
            test_env.pop(key,None)
        result=subprocess.run([str(release/'.venv/bin/python'),'-m','pytest','-o','addopts=','-q','--tb=short'],cwd=release,capture_output=True,text=True,env=test_env)
    print(result.stdout.strip(),flush=True)
    if result.returncode:
        print(result.stderr,flush=True)
    result.check_returncode()
    (release/'release-version.txt').write_text(args.commit+'\n')
    print(json.dumps({'staged':str(release),'commit':args.commit,'isolated_tests':True,'archive_sha256':args.archive_sha,'dependencies_sha256':args.wheel_sha}),flush=True)


def precheck(release):
    stamp=datetime.now().strftime('%Y%m%d-%H%M%S')
    destination=BACKUPS/f'precheck-pwa-{release.name[:7]}-{stamp}.db'
    backup(destination)
    result=migration(release,destination,BACKUPS/f'precheck-pwa-{release.name[:7]}-{stamp}-validated.db')
    print(json.dumps({'phase':'precheck','result':result},ensure_ascii=False),flush=True)


def switch(path):
    temporary=ROOT/'current.pwa-new'
    if temporary.is_symlink():temporary.unlink()
    assert not temporary.exists()
    temporary.symlink_to(path)
    temporary.replace(ROOT/'current')


def deploy(release):
    stamp=datetime.now().strftime('%Y%m%d-%H%M%S')
    previous=(ROOT/'current').resolve()
    assert previous!=release
    environment_sha=sha(ENV)
    record={'commit':release.name,'previous_release':str(previous),'release':str(release),'started_at':datetime.now().astimezone().isoformat()}
    record_path=BACKUPS/f'deployment-pwa-{release.name[:7]}-{stamp}.json'
    final_backup=BACKUPS/f'predeploy-pwa-{release.name[:7]}-{stamp}.db'
    run(['systemctl','stop','daily-plan.service'])
    try:
        backup(final_backup)
        record['final_backup']=str(final_backup)
        validated=BACKUPS/f'predeploy-pwa-{release.name[:7]}-{stamp}-validated.db'
        record['migration']=migration(release,final_backup,validated)
        code='from app.database import initialize;initialize('+repr(str(DB))+')'
        run([str(release/'.venv/bin/python'),'-c',code],cwd=release)
        # 初始化后、应用启动前，与已验证副本逐表逐行核对。
        spec=importlib.util.spec_from_file_location('migration_check',release/'deploy/verify-migration.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        assert module.snapshot(DB)==module.snapshot(validated),'生产迁移与验证副本不一致'
        record['exact_data_match_before_start']=True
        switch(release)
        run(['systemctl','start','daily-plan.service'])
        record['verification']=verify_http(release)
        assert sha(ENV)==environment_sha,'生产配置被改变'
        record['environment_unchanged']=True
        record['completed_at']=datetime.now().astimezone().isoformat()
        record['status']='deployed'
    except Exception as error:
        record['status']='rolled_back'
        record['error_type']=type(error).__name__
        run(['systemctl','stop','daily-plan.service'])
        switch(previous)
        run(['systemctl','start','daily-plan.service'])
        record_path.write_text(json.dumps(record,ensure_ascii=False,indent=2))
        raise
    record_path.write_text(json.dumps(record,ensure_ascii=False,indent=2))
    print(json.dumps({'status':record['status'],'commit':release.name,'record':str(record_path),'backup':str(final_backup),'previous_release':str(previous),'verification':record['verification']},ensure_ascii=False),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['stage','precheck','deploy','verify'])
    parser.add_argument('commit')
    parser.add_argument('--release-root',default=str(ROOT/'releases'),help='stage可在部署账户的独立目录预验证；正式发布仍使用默认目录')
    parser.add_argument('--source-archive',default='/tmp/daily-plan-release-source.tar')
    parser.add_argument('--archive-sha')
    parser.add_argument('--wheel-archive',default='/tmp/daily-plan-release-wheels.tar.gz')
    parser.add_argument('--wheel-sha')
    args=parser.parse_args()
    assert re.fullmatch('[a-f0-9]{40}',args.commit)
    release=Path(args.release_root)/args.commit
    if args.mode in ('precheck','deploy','verify'):assert release==ROOT/'releases'/args.commit,'正式操作必须使用固定发布目录'
    if args.mode=='stage':stage(args,release)
    elif args.mode=='precheck':precheck(release)
    elif args.mode=='deploy':deploy(release)
    else:print(json.dumps(verify_http(release)))
