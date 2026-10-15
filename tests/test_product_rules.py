"""第二部分前三项产品规则；仅使用临时合成数据库。"""
import shutil
import sqlite3
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.database import initialize
from app.main import create_app
from test_review_workspace import client_for, plan_for
from test_data_integrity import add


def test_learning_daily_goal_uses_effective_not_counted_time(tmp_path):
    client=client_for(tmp_path)
    day=date.today()-timedelta(days=1)
    task=plan_for(client,day)['tasks'][0]
    assert add(client,day,task,f'{day}T09:00:00',f'{day}T09:10:00','counted_label','counted_game').status_code == 200
    state=client.get(f'/api/daily-execution/{day}').json()
    assert not next(t for t in state['tasks'] if t['id']==task['id'])['completed']
    assert state['task_execution_board'][0]['total_minutes'] == 10
    assert add(client,day,task,f'{day}T09:10:00',f'{day}T09:20:00').status_code == 200
    assert next(t for t in client.get(f'/api/daily-execution/{day}').json()['tasks'] if t['id']==task['id'])['completed']
    assert client.patch(f"/api/tasks/{task['id']}",json={'completed':False}).status_code == 200
    assert not client.get(f'/api/daily-execution/{day}').json()['tasks'][0]['completed']


def rows(db):
    return {name:db.execute(f'SELECT * FROM {name} ORDER BY 1').fetchall() for name in
            ['plans','tasks','reviews','carryovers','task_execution_segments','task_duration_records','gpt_collab_records','weekly_reports','app_settings']}


def test_reset_and_restore_day_exactly_preserves_other_days_and_history(tmp_path):
    client=client_for(tmp_path)
    day=date.today()-timedelta(days=2)
    task=plan_for(client,day)['tasks'][0]
    other=day+timedelta(days=1);plan_for(client,other)
    assert add(client,day,task,f'{day}T09:00:12',f'{day}T09:10:42').status_code==200
    assert client.post(f'/api/daily-execution/{day}/vocabulary',json={'minutes':4}).status_code==201
    assert client.post('/api/daily-reviews',json={'date':str(day),'effective_method':'原内容','tomorrow_focus':'保留'}).status_code==200
    assert client.put(f'/api/daily-review/{day}/gpt-record',json={'response_text':'GPT留档','adopted_text':'采用'}).status_code==200
    with sqlite3.connect(client.app.state.database_path) as db:
        db.execute("INSERT INTO carryovers(task_id,title,category,estimated_minutes) VALUES(?,?,?,?)",(task['id'],task['title'],task['category'],10))
        before=rows(db)
    result=client.delete(f'/api/daily-data/{day}').json()
    snapshot=result['reset_snapshot']
    assert snapshot['id']>0
    assert snapshot['counts']['segments']==1
    listing=client.get(f'/api/daily-data/{day}/reset-snapshots').json()
    assert listing[0]['id']==snapshot['id']
    assert 'snapshot_json' not in listing[0]
    restored=client.post(f"/api/daily-data/{day}/reset-snapshots/{snapshot['id']}/restore")
    assert restored.status_code==200,restored.text
    with sqlite3.connect(client.app.state.database_path) as db:
        assert rows(db)==before
        assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
    assert client.get(f'/api/daily-data/{day}/reset-snapshots').json()==[]
    assert client.post(f"/api/daily-data/{day}/reset-snapshots/{snapshot['id']}/restore").status_code==409


def test_restore_refuses_new_data_and_wrong_date_without_deleting_anything(tmp_path):
    client=client_for(tmp_path);day=date.today()-timedelta(days=2)
    plan_for(client,day)
    snapshot=client.delete(f'/api/daily-data/{day}').json()['reset_snapshot']
    endpoint=f"/api/daily-data/{day}/reset-snapshots/{snapshot['id']}/restore"
    assert client.post(endpoint.replace(str(day),str(day+timedelta(days=1)))).status_code==404
    plan_for(client,day)
    with sqlite3.connect(client.app.state.database_path) as db: before=rows(db)
    assert client.post(endpoint).status_code==409
    with sqlite3.connect(client.app.state.database_path) as db: assert rows(db)==before


def test_reset_failure_rolls_back_snapshot_and_original_data(tmp_path):
    client=client_for(tmp_path);day=date.today()-timedelta(days=2)
    plan_for(client,day)
    with sqlite3.connect(client.app.state.database_path) as db:
        before=rows(db)
        db.execute("CREATE TRIGGER reject_plan_delete BEFORE DELETE ON plans BEGIN SELECT RAISE(ABORT,'测试删除失败'); END")
    with TestClient(client.app,raise_server_exceptions=False) as safe_client:
        assert safe_client.delete(f'/api/daily-data/{day}').status_code==500
    with sqlite3.connect(client.app.state.database_path) as db: assert rows(db)==before
    assert client.get(f'/api/daily-data/{day}/reset-snapshots').json()==[]


def test_restore_closes_original_active_segment_at_reset_and_keeps_other_active(tmp_path):
    client=client_for(tmp_path);day=date.today()
    task=plan_for(client,day)['tasks'][0]
    assert client.post(f'/api/daily-execution/{day}/tasks/start',json={'task_id':task['id']}).status_code==200
    snapshot=client.delete(f'/api/daily-data/{day}').json()['reset_snapshot']
    result=client.post(f"/api/daily-data/{day}/reset-snapshots/{snapshot['id']}/restore")
    assert result.status_code==200,result.text
    state=client.get(f'/api/daily-execution/{day}').json()
    assert state['active_segment'] is None
    assert state['segments'][0]['ended_at']==snapshot['created_at']


def test_restore_refuses_cross_date_time_conflict(tmp_path):
    client=client_for(tmp_path);day=date.today()-timedelta(days=2);other=day+timedelta(days=1)
    task=plan_for(client,day)['tasks'][0]
    assert add(client,day,task,f'{day}T23:50:00',f'{other}T00:10:00').status_code==200
    snapshot=client.delete(f'/api/daily-data/{day}').json()['reset_snapshot']
    task2=plan_for(client,other)['tasks'][0]
    assert add(client,other,task2,f'{other}T00:00:00',f'{other}T00:20:00').status_code==200
    assert client.post(f"/api/daily-data/{day}/reset-snapshots/{snapshot['id']}/restore").status_code==409
    assert client.get(f'/api/daily-data/{day}/reset-snapshots').json()
    assert client.get(f'/api/daily-review/{day}').json()['status'] is None


def test_calendar_opens_existing_records_before_start_but_not_empty_or_future(tmp_path):
    client=client_for(tmp_path);start=date.today()
    settings=client.get('/api/settings').json();settings['project_start_date']=str(start)
    assert client.put('/api/settings',json=settings).status_code==200
    old=start-timedelta(days=2);plan_for(client,old)
    review_day=start-timedelta(days=1)
    client.post('/api/daily-reviews',json={'date':str(review_day),'effective_method':'','tomorrow_focus':''})
    def state(day):
        return next(d for d in client.get(f'/api/calendar-status?month={day:%Y-%m}').json()['days'] if d['date']==str(day))
    assert state(old)['visibility']=='in_range'
    client.delete(f'/api/daily-data/{old}')
    assert state(old)['visibility']=='in_range'  # 重置后仍可从日历回来恢复。
    assert state(review_day)['status']=='reviewed'
    assert state(old-timedelta(days=1))['visibility']=='out_of_range'
    future=start+timedelta(days=1);plan_for(client,future)
    assert state(future)['visibility']=='out_of_range'


def test_reset_snapshot_table_migration_only_adds_table_on_backup_copy(tmp_path):
    original=tmp_path/'old.db';initialize(original)
    with sqlite3.connect(original) as db:
        db.execute('DROP TABLE IF EXISTS daily_reset_snapshots')
        db.execute("INSERT INTO reviews(review_date,effective_method,tomorrow_focus) VALUES('2026-01-01','旧正文','保留')")
        before=rows(db)
        schema=db.execute("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").fetchall()
    copy=tmp_path/'copy.db';shutil.copy2(original,copy)
    initialize(copy);initialize(copy)
    with sqlite3.connect(copy) as db:
        assert rows(db)==before
        assert db.execute('PRAGMA integrity_check').fetchone()==('ok',)
        assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
        assert db.execute("SELECT name FROM sqlite_master WHERE name='daily_reset_snapshots'").fetchone()
        current=dict(db.execute("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name"))
        assert all(current[name]==sql for name,sql in schema)


def test_snapshot_save_failure_keeps_original_day(tmp_path):
    client=client_for(tmp_path);day=date.today()-timedelta(days=1)
    plan_for(client,day)
    with sqlite3.connect(client.app.state.database_path) as db:
        before=rows(db)
        db.execute("CREATE TRIGGER reject_snapshot BEFORE INSERT ON daily_reset_snapshots BEGIN SELECT RAISE(ABORT,'测试快照失败'); END")
    with TestClient(client.app,raise_server_exceptions=False) as safe:
        assert safe.delete(f'/api/daily-data/{day}').status_code==500
    with sqlite3.connect(client.app.state.database_path) as db: assert rows(db)==before


def test_reset_review_only_can_restore_without_a_plan(tmp_path):
    client=client_for(tmp_path);day=date.today()-timedelta(days=1)
    client.post('/api/daily-reviews',json={'date':str(day),'effective_method':'仅复盘','tomorrow_focus':''})
    snap=client.delete(f'/api/daily-data/{day}').json()['reset_snapshot']
    assert snap['counts']['tasks']==0
    assert client.post(f"/api/daily-data/{day}/reset-snapshots/{snap['id']}/restore").status_code==200
    assert client.get(f'/api/daily-review/{day}').json()['review']['effective_method']=='仅复盘'


@pytest.mark.parametrize('task_type,category', [('todo','math'),('habit','rehab')])
def test_counted_time_does_not_complete_todo_or_habit(tmp_path,task_type,category):
    client=client_for(tmp_path);day=date.today()-timedelta(days=1)
    plan_for(client,day)
    result=client.post(f'/api/daily-execution/{day}/tasks',json={'title':'保留原完成规则','category':category,'task_type':task_type})
    assert result.status_code==201,result.text
    task=result.json()['tasks'][-1]
    assert add(client,day,task,f'{day}T10:00:00',f'{day}T11:00:00','counted_label','counted_game').status_code==200
    assert not next(t for t in client.get(f'/api/daily-execution/{day}').json()['tasks'] if t['id']==task['id'])['completed']
