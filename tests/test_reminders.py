"""提醒只使用临时库和本地替身；不得外发真实通知。"""
import sqlite3
from datetime import date,timedelta
from concurrent.futures import ThreadPoolExecutor
import httpx
import pytest
from app.services.reminders import dispatch_due,utc_now,iso,NtfySender
from test_review_workspace import client_for,plan_for


def setup(tmp_path):
    client=client_for(tmp_path);client.app.state.ui_preview=True
    day=str(date.today());task=plan_for(client,day)['tasks'][0]
    return client,day,task


def start(client,day,task,label='interrupt_meal',minutes=15):
    r=client.post(f'/api/daily-execution/{day}/labels/start',json={'task_id':task['id'],'label_id':label,'reminder_minutes':minutes})
    assert r.status_code==200,r.text
    return r.json()['active_segment']


def due(client):
    with sqlite3.connect(client.app.state.database_path) as db:
        db.execute('UPDATE execution_reminders SET due_at=?',(iso(utc_now()-timedelta(seconds=1)),))


def state(client):
    with sqlite3.connect(client.app.state.database_path) as db:
        return db.execute('SELECT status FROM execution_reminders ORDER BY id').fetchall()


def test_reminder_fires_once_and_never_stops_segment(tmp_path):
    client,day,task=setup(tmp_path);segment=start(client,day,task);assert segment['reminder']['status']=='pending'
    due(client);calls=[]
    dispatch_due(client.app.state.database_path,calls.append)
    dispatch_due(client.app.state.database_path,calls.append)
    assert len(calls)==1 and state(client)==[('sent',)]
    assert client.get(f'/api/daily-execution/{day}').json()['active_segment']['id']==segment['id']
    # 相同标签重复请求不能重启计时或安排第二条提醒。
    assert start(client,day,task)['id']==segment['id']
    assert state(client)==[('sent',)]


@pytest.mark.parametrize('action',['stop','switch','reset','reset_restore'])
def test_stop_switch_reset_cancel_old_notification(tmp_path,action):
    client,day,task=setup(tmp_path);start(client,day,task)
    if action=='stop': assert client.post(f'/api/daily-execution/{day}/stop').status_code==200
    elif action=='switch': assert client.post(f'/api/daily-execution/{day}/tasks/start',json={'task_id':task['id']}).status_code==200
    else:
        reset=client.delete(f'/api/daily-data/{day}').json()
        if action=='reset_restore': assert client.post(f"/api/daily-data/{day}/reset-snapshots/{reset['reset_snapshot']['id']}/restore").status_code==200
    due(client);calls=[];dispatch_due(client.app.state.database_path,calls.append)
    assert not calls
    assert not any(value[0]=='pending' for value in state(client))


def test_transport_failure_expiry_missing_config_and_preview(tmp_path):
    client,day,task=setup(tmp_path);start(client,day,task);due(client)
    calls=[];dispatch_due(client.app.state.database_path,calls.append,preview=True)
    assert not calls and state(client)==[('simulated',)]
    client.post(f'/api/daily-execution/{day}/stop')
    start(client,day,task);due(client)
    def fail(row): raise RuntimeError('secret-token')
    dispatch_due(client.app.state.database_path,fail)
    assert state(client)[-1]==('failed',)
    payload=client.get(f'/api/daily-execution/{day}').text
    assert 'secret-token' not in payload
    client.post(f'/api/daily-execution/{day}/stop')
    start(client,day,task);due(client)
    dispatch_due(client.app.state.database_path,calls.append,now=utc_now()+timedelta(minutes=11))
    assert state(client)[-1]==('expired',) and not calls
    client.post(f'/api/daily-execution/{day}/stop');client.app.state.ui_preview=False
    response=client.post(f'/api/daily-execution/{day}/labels/start',json={'task_id':task['id'],'label_id':'interrupt_meal','reminder_minutes':15})
    assert response.status_code==409
    assert client.get(f'/api/daily-execution/{day}').json()['active_segment'] is None
    assert client.post(f'/api/daily-execution/{day}/labels/start',json={'task_id':task['id'],'label_id':'interrupt_meal'}).status_code==200


def test_competing_workers_do_not_send_duplicates(tmp_path):
    client,day,task=setup(tmp_path);start(client,day,task);due(client);calls=[]
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: dispatch_due(client.app.state.database_path,calls.append),range(2)))
    assert len(calls)==1


def test_ntfy_body_auth_and_acceptance(monkeypatch):
    sent=[]
    def handle(request):
        import json
        sent.append((json.loads(request.content),request.headers['authorization']))
        return httpx.Response(200,json={'id':'test-only'})
    original=httpx.Client
    monkeypatch.setattr(httpx,'Client',lambda **kwargs:original(transport=httpx.MockTransport(handle),**kwargs))
    sender=NtfySender('https://example.test','private-test','fake-token','https://app.example.test')
    sender({'label_name':'吃饭','plan_date':'2026-10-17'})
    assert sent[0][0]['topic']=='private-test' and '计时仍在继续' in sent[0][0]['message']
    assert sent[0][0]['click']=='https://app.example.test/execute?date=2026-10-17'
    assert sent[0][1]=='Bearer fake-token'


def test_preview_ignores_external_configuration(tmp_path,monkeypatch):
    from app import preview
    monkeypatch.setattr(preview,'ROOT',tmp_path)
    for key,value in [('URL','https://example.test'),('TOPIC','private-test'),('TOKEN','fake-token')]:
        monkeypatch.setenv('DAILY_PLAN_NTFY_'+key,value)
    app=preview.create_preview_app()
    assert app.state.reminder_sender is None


def test_invalid_minutes_and_failed_start_preserve_running_learning(tmp_path):
    client,day,task=setup(tmp_path)
    original=client.post(f'/api/daily-execution/{day}/tasks/start',json={'task_id':task['id']}).json()['active_segment']
    for minutes in [0,1,14,1441,-5,1.5,True,"15"]:
        assert client.post(f'/api/daily-execution/{day}/labels/start',json={'task_id':task['id'],'label_id':'interrupt_meal','reminder_minutes':minutes}).status_code==422
    client.app.state.ui_preview=False
    assert client.post(f'/api/daily-execution/{day}/labels/start',json={'task_id':task['id'],'label_id':'interrupt_meal','reminder_minutes':15}).status_code==409
    assert client.get(f'/api/daily-execution/{day}').json()['active_segment']['id']==original['id']


def test_restart_handles_unconfirmed_send_without_repeating(tmp_path):
    client,day,task=setup(tmp_path);start(client,day,task);due(client)
    with sqlite3.connect(client.app.state.database_path) as db:
        db.execute("UPDATE execution_reminders SET status='sending',claimed_at=?",(iso(utc_now()-timedelta(minutes=3)),))
    calls=[];dispatch_due(client.app.state.database_path,calls.append)
    assert not calls and state(client)==[('failed',)]


def test_cancel_after_claim_before_transport(tmp_path,monkeypatch):
    """领取与网络发送之间若用户停止，应在发送前的二次检查拦住。"""
    from contextlib import contextmanager
    from app.services import reminders
    client,day,task=setup(tmp_path);start(client,day,task);due(client)
    original=reminders.connect; rounds=0
    @contextmanager
    def stop_before_send(path):
        nonlocal rounds
        rounds+=1
        if rounds==2:
            assert client.post(f'/api/daily-execution/{day}/stop').status_code==200
        with original(path) as db: yield db
    monkeypatch.setattr(reminders,'connect',stop_before_send)
    calls=[];dispatch_due(client.app.state.database_path,calls.append)
    assert calls==[] and state(client)==[('cancelled',)]
