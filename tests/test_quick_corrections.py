"""当前有效段的估计补记，全部使用临时库与冻结服务端时间。"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
import sqlite3
from uuid import uuid4

import pytest

from test_review_workspace import client_for, plan_for


def setup_running(tmp_path, monkeypatch):
    client = client_for(tmp_path)
    day = str(date.today())
    task = plan_for(client, day)['tasks'][0]
    moment = [f'{day}T09:00:00']
    monkeypatch.setattr('app.api._now_iso', lambda: moment[0])
    result = client.post(f'/api/daily-execution/{day}/tasks/start', json={'task_id':task['id'], 'label_id':'effective_math_course'}).json()
    moment[0] = f'{day}T10:00:00'
    payload = {'request_id':uuid4().hex, 'source_segment_id':result['active_segment']['id'], 'minutes':5, 'time_category':'distraction'}
    path = f'/api/daily-execution/{day}'
    return client, day, task, moment, payload, path


@pytest.mark.parametrize('category,ratio', [('distraction',55/60), ('life',1)])
def test_split_preserves_total_continuation_labels_and_daily_weekly(tmp_path,monkeypatch,category,ratio):
    client,day,task,moment,payload,path = setup_running(tmp_path,monkeypatch)
    payload['time_category'] = category
    response = client.post(path+'/quick-corrections',json=payload)
    assert response.status_code == 200,response.text
    data=response.json(); segments=data['segments']
    assert len(segments)==3 and sum(s['seconds'] for s in segments)==3600
    estimate=next(s for s in segments if s['is_estimated'])
    assert estimate['seconds']==300 and estimate['time_category']==category
    assert estimate['started_at']==f'{day}T09:55:00'
    assert data['active_segment']['task_id']==task['id']
    assert data['active_segment']['label_id']=='effective_math_course'
    assert not data['active_segment']['is_estimated']
    assert data['task_execution_board'][0]['effective_seconds']==3300
    assert data['time_summary']['effective_ratio']==pytest.approx(ratio,abs=.0001)
    assert client.get(path).json()['segments']==segments
    client.post(path+'/stop')
    review=client.get(f'/api/daily-review/{day}').json()
    week=client.get(f'/api/weekly-review?anchor_date={day}').json()
    assert review['main_actual_seconds']==3300
    assert week['actual_seconds']==3300
    labels=review['task_execution_board'][0]['counted_labels' if category=='distraction' else 'interrupt_labels']
    assert any('补记·估计' in label['label_name'] for label in labels)
    assert client.get('/api/notifications/status').json()['configured'] is False


def test_duplicate_and_competing_requests_never_deduct_twice(tmp_path,monkeypatch):
    client,day,task,moment,payload,path=setup_running(tmp_path,monkeypatch)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:client.post(path+'/quick-corrections',json=payload),range(2)))
    assert all(r.status_code==200 for r in results)
    assert len(client.get(path).json()['segments'])==3
    conflicting={**payload,'request_id':uuid4().hex}
    assert client.post(path+'/quick-corrections',json=conflicting).status_code==409
    assert client.post(path+'/quick-corrections',json={**payload,'minutes':2}).status_code==409


@pytest.mark.parametrize('value',[0,-1,1.5,'5',True,1441])
def test_invalid_and_insufficient_preserve_every_row(tmp_path,monkeypatch,value):
    client,day,task,moment,payload,path=setup_running(tmp_path,monkeypatch)
    before=client.get(path).json()['segments']
    assert client.post(path+'/quick-corrections',json={**payload,'minutes':value}).status_code==422
    assert client.post(path+'/quick-corrections',json={**payload,'minutes':61}).status_code==409
    assert client.get(path).json()['segments']==before


def test_stopped_switched_wrong_day_and_nonlearning_rejected(tmp_path,monkeypatch):
    client,day,task,moment,payload,path=setup_running(tmp_path,monkeypatch)
    assert client.post('/api/daily-execution/2020-01-01/quick-corrections',json=payload).status_code==409
    client.post(path+'/labels/start',json={'label_id':'counted_game','task_id':task['id']})
    active=client.get(path).json()['active_segment']
    assert client.post(path+'/quick-corrections',json=payload).status_code==409
    assert client.post(path+'/quick-corrections',json={**payload,'source_segment_id':active['id']}).status_code==409
    client.post(path+'/stop')
    assert client.post(path+'/quick-corrections',json=payload).status_code==409


def test_resize_and_undo_preserve_boundary_total_and_estimate_origin(tmp_path,monkeypatch):
    client,day,task,moment,payload,path=setup_running(tmp_path,monkeypatch)
    data=client.post(path+'/quick-corrections',json=payload).json()
    segment=next(s for s in data['segments'] if s['is_estimated'])
    moment[0]=f'{day}T10:02:00'
    edit={k:segment[k] for k in ['task_id','segment_kind','label_id','time_category','started_at','ended_at']}
    edit.update(started_at=f'{day}T09:54:00',ended_at=f'{day}T10:01:00')
    response=client.put(path+f"/segments/{segment['id']}",json=edit)
    assert response.status_code==200,response.text
    saved=response.json()
    assert sum(s['seconds'] for s in saved['segments'])==3720
    assert sum(s['seconds'] for s in saved['segments'] if s['is_estimated'])==420
    assert saved['active_segment']['started_at']==f'{day}T10:01:00'
    snapshot=client.get(path).json()['segments']
    assert client.put(path+f"/segments/{segment['id']}",json={**edit,'started_at':f'{day}T08:59:00'}).status_code==409
    assert client.get(path).json()['segments']==snapshot
    undone=client.delete(path+f"/segments/{segment['id']}")
    assert undone.status_code==200,undone.text
    assert all(s['segment_kind']=='effective' and not s['is_estimated'] for s in undone.json()['segments'])
    assert undone.json()['task_execution_board'][0]['effective_seconds']==3720


def test_changed_neighbors_do_not_get_overwritten_and_reset_restores_metadata(tmp_path,monkeypatch):
    client,day,task,moment,payload,path=setup_running(tmp_path,monkeypatch)
    data=client.post(path+'/quick-corrections',json=payload).json()
    estimate=next(s for s in data['segments'] if s['is_estimated'])
    client.post(path+'/stop')
    reset=client.delete(f'/api/daily-data/{day}').json()
    restored=client.post(f"/api/daily-data/{day}/reset-snapshots/{reset['reset_snapshot']['id']}/restore")
    assert restored.status_code==200,restored.text
    assert next(s for s in client.get(path).json()['segments'] if s['id']==estimate['id'])['is_estimated']
    with sqlite3.connect(client.app.state.database_path) as db:
        assert db.execute('SELECT COUNT(*) FROM execution_quick_corrections').fetchone()[0]==1
        db.execute("UPDATE task_execution_segments SET ended_at=? WHERE id=?",(f'{day}T09:54:00',payload['source_segment_id']))
    assert client.delete(path+f"/segments/{estimate['id']}").status_code==409


def test_whole_segment_can_be_corrected_and_failure_rolls_back(tmp_path,monkeypatch):
    from fastapi import HTTPException
    client,day,task,moment,payload,path=setup_running(tmp_path,monkeypatch)
    before=client.get(path).json()['segments']
    original=__import__('app.api',fromlist=['_assert_no_segment_overlap'])._assert_no_segment_overlap
    def fail(*args,**kwargs):raise HTTPException(409,'模拟其他记录冲突')
    monkeypatch.setattr('app.api._assert_no_segment_overlap',fail)
    assert client.post(path+'/quick-corrections',json=payload).status_code==409
    assert client.get(path).json()['segments']==before
    monkeypatch.setattr('app.api._assert_no_segment_overlap',original)
    response=client.post(path+'/quick-corrections',json={**payload,'minutes':60})
    assert response.status_code==200,response.text
    assert sum(s['seconds'] for s in response.json()['segments'])==3600
    assert response.json()['task_execution_board'][0]['effective_seconds']==0


def test_excluded_effective_segment_is_not_used(tmp_path,monkeypatch):
    client,day,task,moment,payload,path=setup_running(tmp_path,monkeypatch)
    with sqlite3.connect(client.app.state.database_path) as db:
        db.execute('UPDATE task_execution_segments SET included=0 WHERE id=?',(payload['source_segment_id'],))
    assert client.post(path+'/quick-corrections',json=payload).status_code==409


def test_migration_copy_preserves_old_records_and_source_schema(tmp_path,monkeypatch):
    import importlib.util
    from pathlib import Path
    client,day,task,moment,payload,path=setup_running(tmp_path,monkeypatch)
    source=client.app.state.database_path
    with sqlite3.connect(source) as db:
        db.execute('DROP TABLE execution_quick_corrections')
        db.execute('ALTER TABLE task_execution_segments DROP COLUMN is_estimated')
        original=db.execute('SELECT * FROM task_execution_segments').fetchall()
    spec=importlib.util.spec_from_file_location('migration_check',Path(__file__).parents[1]/'deploy/verify-migration.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    result=module.verify(source,tmp_path/'migrated.db')
    assert result['old_values_unchanged'] and result['migration_runs']==2
    with sqlite3.connect(source) as db:
        assert 'is_estimated' not in [r[1] for r in db.execute('PRAGMA table_info(task_execution_segments)')]
        assert db.execute('SELECT * FROM task_execution_segments').fetchall()==original
