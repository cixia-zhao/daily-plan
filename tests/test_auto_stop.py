"""单次自动停止的截止、竞态与既有记录兼容；全部使用临时数据库。"""
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import pytest
from app.database import initialize
from app.services.auto_stop import dispatch_auto_stops
from test_review_workspace import client_for, plan_for


def setup(tmp_path):
    client=client_for(tmp_path); day=str(date.today());task=plan_for(client,day)['tasks'][0]
    segment=client.post(f'/api/daily-execution/{day}/tasks/start',json={'task_id':task['id']}).json()['active_segment']
    return client,day,task,segment


def configure(client,day,segment,due):
    return client.put(f'/api/daily-execution/{day}/auto-stop',json={'segment_id':segment['id'],'due_at':due})


def future(minutes=25):
    return (datetime.now(timezone.utc)+timedelta(minutes=minutes)).replace(microsecond=0).isoformat()


def test_exact_stop_offline_recovery_and_concurrent_workers(tmp_path):
    c,day,task,s=setup(tmp_path);due=future();r=configure(c,day,s,due);assert r.status_code==200,r.text
    stored=r.json()['active_segment']['auto_stop_at'];instant=datetime.fromisoformat(due)+timedelta(days=2)
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sum(pool.map(lambda _:dispatch_auto_stops(c.app.state.database_path,now=instant),range(2)))==1
    state=c.get(f'/api/daily-execution/{day}').json();assert state['active_segment'] is None
    record=state['segments'][0];assert record['ended_at']==stored and record['stopped_automatically']
    assert 1499<=record['seconds']<=1500
    with sqlite3.connect(c.app.state.database_path) as db:
        assert db.execute('SELECT actual_minutes FROM tasks WHERE id=?',(task['id'],)).fetchone()[0]==record['minutes']
    assert dispatch_auto_stops(c.app.state.database_path,now=instant)==0


def test_modify_cancel_early_stop_and_switch(tmp_path):
    c,day,task,s=setup(tmp_path)
    assert configure(c,day,s,future()).status_code==200
    later=configure(c,day,s,future(45)).json()['active_segment']['auto_stop_at']
    assert later
    assert configure(c,day,s,None).json()['active_segment']['auto_stop_at'] is None
    assert configure(c,day,s,future()).status_code==200
    state=c.post(f'/api/daily-execution/{day}/stop').json();record=state['segments'][0]
    assert not record['stopped_automatically'] and record['auto_stop_at'] is None
    assert record['seconds']<10
    new=c.post(f'/api/daily-execution/{day}/tasks/start',json={'task_id':task['id']}).json()['active_segment']
    assert configure(c,day,s,future()).status_code==409
    assert configure(c,day,new,future()).status_code==200
    state=c.post(f'/api/daily-execution/{day}/labels/start',json={'task_id':task['id'],'label_id':'counted_game'}).json()
    assert state['active_segment']['auto_stop_at'] is None
    assert next(x for x in state['segments'] if x['id']==new['id'])['auto_stop_at'] is None
    dispatch_auto_stops(c.app.state.database_path,now=datetime.now(timezone.utc)+timedelta(days=1))
    assert c.get(f'/api/daily-execution/{day}').json()['active_segment']['id']==state['active_segment']['id']


@pytest.mark.parametrize('due',[ '2020-01-01T10:00:00+08:00','bad', '2099-01-01T10:00:00+08:00'])
def test_invalid_setting_preserves_previous(tmp_path,due):
    c,day,task,s=setup(tmp_path);saved=configure(c,day,s,future()).json()['active_segment']['auto_stop_at']
    assert configure(c,day,s,due).status_code==422
    assert c.get(f'/api/daily-execution/{day}').json()['active_segment']['auto_stop_at']==saved


def test_due_settles_even_if_request_then_conflicts(tmp_path):
    c,day,task,s=setup(tmp_path)
    with sqlite3.connect(c.app.state.database_path) as db:
        db.execute('UPDATE task_execution_segments SET started_at=?,auto_stop_at=? WHERE id=?',((datetime.now()-timedelta(minutes=12)).isoformat(),(datetime.now()-timedelta(minutes=2)).isoformat(),s['id']))
    assert configure(c,day,s,future()).status_code==409
    # 失败请求回滚不能撤销先前到期结算。
    with sqlite3.connect(c.app.state.database_path) as db:
        row=db.execute('SELECT ended_at,auto_stop_at,stopped_automatically FROM task_execution_segments WHERE id=?',(s['id'],)).fetchone()
        assert row[0]==row[1] and row[2]==1


def test_quick_correction_carries_original_deadline(tmp_path):
    c,day,task,s=setup(tmp_path)
    with sqlite3.connect(c.app.state.database_path) as db:
        db.execute('UPDATE task_execution_segments SET started_at=? WHERE id=?',((datetime.now()-timedelta(minutes=10)).isoformat(timespec='seconds'),s['id']))
    due=configure(c,day,s,future()).json()['active_segment']['auto_stop_at']
    r=c.post(f'/api/daily-execution/{day}/quick-corrections',json={'request_id':'autostop-correction-test','source_segment_id':s['id'],'minutes':2,'time_category':'life'})
    assert r.status_code==200,r.text
    state=r.json();assert state['active_segment']['auto_stop_at']==due
    assert next(x for x in state['segments'] if x['id']==s['id'])['auto_stop_at'] is None


def test_reset_restore_does_not_revive_scheduled_timer(tmp_path):
    c,day,task,s=setup(tmp_path);configure(c,day,s,future())
    snap=c.delete(f'/api/daily-data/{day}').json()['reset_snapshot']
    assert c.post(f"/api/daily-data/{day}/reset-snapshots/{snap['id']}/restore").status_code==200
    assert dispatch_auto_stops(c.app.state.database_path,now=datetime.now(timezone.utc)+timedelta(days=1))==0
    assert c.get(f'/api/daily-execution/{day}').json()['active_segment'] is None


def test_reminder_cancelled_only_when_automatic_stop_is_due(tmp_path):
    c,day,task,s=setup(tmp_path);c.app.state.ui_preview=True
    segment=c.post(f'/api/daily-execution/{day}/labels/start',json={'task_id':task['id'],'label_id':'interrupt_meal','reminder_minutes':15}).json()['active_segment']
    configure(c,day,segment,future(20))
    with sqlite3.connect(c.app.state.database_path) as db:assert db.execute('SELECT status FROM execution_reminders').fetchone()[0]=='pending'
    dispatch_auto_stops(c.app.state.database_path,now=datetime.now(timezone.utc)+timedelta(minutes=21))
    with sqlite3.connect(c.app.state.database_path) as db:assert db.execute('SELECT status FROM execution_reminders').fetchone()[0]=='cancelled'


def test_old_database_migration_is_idempotent(tmp_path):
    c,day,task,s=setup(tmp_path);path=c.app.state.database_path
    with sqlite3.connect(path) as db:
        db.execute('ALTER TABLE task_execution_segments DROP COLUMN auto_stop_at')
        db.execute('ALTER TABLE task_execution_segments DROP COLUMN stopped_automatically')
        before=db.execute('SELECT id,task_id,started_at,ended_at FROM task_execution_segments').fetchall()
    initialize(path);initialize(path)
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT id,task_id,started_at,ended_at FROM task_execution_segments').fetchall()==before
        assert db.execute('SELECT auto_stop_at,stopped_automatically FROM task_execution_segments').fetchall()==[(None,0)]


def test_next_day_deadline_and_offset_are_the_same_instant(tmp_path):
    c,day,task,s=setup(tmp_path)
    due=future(600)
    record=configure(c,day,s,due).json()['active_segment']
    saved=datetime.fromisoformat(record['auto_stop_at']).replace(tzinfo=timezone(timedelta(hours=8)))
    assert saved==datetime.fromisoformat(due)
    assert dispatch_auto_stops(c.app.state.database_path,now=saved-timedelta(seconds=1))==0
    assert dispatch_auto_stops(c.app.state.database_path,now=saved)==1
    with sqlite3.connect(c.app.state.database_path) as db:
        assert db.execute('SELECT ended_at FROM task_execution_segments WHERE id=?',(s['id'],)).fetchone()[0]==record['auto_stop_at']
