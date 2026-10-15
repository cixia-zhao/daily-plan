"""有效细分管理只用临时数据库，历史快照与科目范围有独立保护。"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import sqlite3

from fastapi.testclient import TestClient
import pytest

from app.main import create_app


def setup(tmp_path):
    client = TestClient(create_app(database_path=tmp_path / 'labels.db', disable_ai=True))
    day = str(date.today() - timedelta(days=2))
    draft = client.post('/api/daily-plans/draft', json={'date':day, 'energy':'normal', 'day_type':'normal', 'target_minutes':{'math':60,'english':30,'computer':0,'rehab':0}}).json()
    assert client.post(f'/api/daily-plans/{day}/approve').status_code == 200
    return client, day, next(t for t in draft['tasks'] if t['category']=='math' and not t['is_sub'])


def test_category_labels_create_rename_delete_preserve_historical_segments(tmp_path):
    client, day, task = setup(tmp_path)
    before = client.get('/api/settings').json()
    created = client.post('/api/settings/effective-labels/math', json={'name':'  错题整理  '})
    assert created.status_code == 201
    label = next(t for t in created.json()['effective_labels_by_category']['math'] if t['name']=='错题整理')
    assert created.json()['effective_labels_by_category']['english'] == before['effective_labels_by_category']['english']
    payload = {'task_id':task['id'], 'segment_kind':'effective', 'label_id':label['id'], 'started_at':f'{day}T09:00:12', 'ended_at':f'{day}T09:05:23'}
    saved = client.post(f'/api/daily-execution/{day}/segments', json=payload)
    assert saved.status_code == 200
    old_segment = saved.json()['segments'][0]
    assert client.patch(f"/api/settings/effective-labels/math/{label['id']}", json={'name':'错题归纳'}).status_code == 200
    assert client.delete(f"/api/settings/effective-labels/math/{label['id']}").status_code == 200
    state = client.get(f'/api/daily-execution/{day}').json()
    assert state['segments'][0] == old_segment
    assert state['task_execution_board'][0]['effective_labels'][0]['label_name']=='错题整理'
    # 已删除标签仍可以原样编辑历史时段，不要求重新分类。
    assert client.put(f"/api/daily-execution/{day}/segments/{old_segment['id']}", json=payload).status_code==200
    assert client.get(f'/api/daily-execution/{day}').json()['segments'][0]['label_name']=='错题整理'
    assert client.post(f'/api/daily-execution/{day}/tasks/start', json={'task_id':task['id'],'label_id':label['id']}).status_code==404


def test_default_deletion_survives_reload_and_stale_settings_save(tmp_path):
    client, day, task = setup(tmp_path)
    stale = client.get('/api/settings').json()
    label_id='effective_math_course'
    assert client.post(f'/api/daily-execution/{day}/tasks/start', json={'task_id':task['id'],'label_id':label_id}).status_code==200
    old = client.get(f'/api/daily-execution/{day}').json()['active_segment']
    with ThreadPoolExecutor(max_workers=2) as pool:
        deleting=pool.submit(client.delete,f'/api/settings/effective-labels/math/{label_id}')
        stale_save=pool.submit(client.put,'/api/settings',json=stale)
        assert deleting.result().status_code==200
        assert stale_save.result().status_code==200
    result = client.put('/api/settings', json=stale)
    assert result.status_code==200
    assert not any(t['id']==label_id for t in result.json()['effective_labels_by_category']['math'])
    fresh = TestClient(create_app(database_path=client.app.state.database_path, disable_ai=True))
    assert not any(t['id']==label_id for t in fresh.get('/api/settings').json()['effective_labels_by_category']['math'])
    active = fresh.get(f'/api/daily-execution/{day}').json()['active_segment']
    assert active['id']==old['id'] and active['label_name']=='网课' and active['ended_at'] is None
    assert fresh.post(f'/api/daily-execution/{day}/stop').status_code==200
    independent=TestClient(create_app(database_path=tmp_path / 'independent.db', disable_ai=True))
    assert any(t['id']==label_id for t in independent.get('/api/settings').json()['effective_labels_by_category']['math'])


@pytest.mark.parametrize('name',['', '   ', '长'*51])
def test_invalid_names_do_not_modify_settings(tmp_path,name):
    client, _, _ = setup(tmp_path)
    before=client.get('/api/settings').json()
    assert client.post('/api/settings/effective-labels/math',json={'name':name}).status_code==422
    assert client.get('/api/settings').json()==before


def test_duplicate_wrong_category_and_missing_labels_rejected(tmp_path):
    client, _, _ = setup(tmp_path)
    assert client.post('/api/settings/effective-labels/math',json={'name':' 网课 '}).status_code==409
    assert client.patch('/api/settings/effective-labels/math/effective_math_course',json={'name':'刷题'}).status_code==409
    assert client.delete('/api/settings/effective-labels/english/effective_math_course').status_code==404
    assert client.delete('/api/settings/effective-labels/math/not_found').status_code==404
    assert client.post('/api/settings/effective-labels/not_a_category',json={'name':'新标签'}).status_code==422


def test_parallel_creates_do_not_drop_other_settings_or_labels(tmp_path):
    client, _, _ = setup(tmp_path)
    before=client.get('/api/settings').json()
    def add(i):
        return client.post('/api/settings/effective-labels/math',json={'name':f'科目细分{i}'})
    with ThreadPoolExecutor(max_workers=3) as pool:
        assert all(response.status_code==201 for response in pool.map(add,range(6)))
    after=client.get('/api/settings').json()
    assert len([t for t in after['effective_labels_by_category']['math'] if t['name'].startswith('科目细分')])==6
    assert {k:v for k,v in after.items() if k!='effective_labels_by_category'}=={k:v for k,v in before.items() if k!='effective_labels_by_category'}
    with sqlite3.connect(client.app.state.database_path) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
