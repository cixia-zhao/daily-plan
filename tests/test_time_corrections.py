"""时间修正的分类、偏移、回溯、幂等和快捷设置；仅使用临时数据库。"""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
import sqlite3

import pytest

from test_quick_corrections import setup_running


def correct(client, path, payload, **changes):
    body = {key: payload[key] for key in ('request_id', 'source_segment_id', 'minutes')}
    return client.post(path + '/time-corrections', json={**body, 'label_id': 'counted_game', **changes})


def test_middle_activity_preserves_later_learning_and_undo(tmp_path, monkeypatch):
    client, day, task, moment, payload, path = setup_running(tmp_path, monkeypatch)
    response = correct(client, path, payload, minutes=20, offset_minutes=10)
    assert response.status_code == 200, response.text
    data = response.json()
    estimated = next(s for s in data['segments'] if s['is_estimated'])
    assert (estimated['started_at'], estimated['ended_at']) == (f'{day}T09:30:00', f'{day}T09:50:00')
    assert data['active_segment']['started_at'] == f'{day}T09:50:00'
    assert data['active_segment']['label_id'] == 'effective_math_course'
    assert data['time_summary']['categories']['learning'] == 2400
    assert data['time_summary']['categories']['distraction'] == 1200
    assert sum(s['seconds'] for s in data['segments']) == 3600
    restored = client.delete(path + f"/segments/{estimated['id']}")
    assert restored.status_code == 200, restored.text
    assert restored.json()['time_summary']['categories']['learning'] == 3600


@pytest.mark.parametrize('label,category', [('interrupt_meal', 'life'), ('interrupt_pause', 'rest'), ('interrupt_incident', 'external')])
def test_real_activity_labels_and_categories(tmp_path, monkeypatch, label, category):
    client, day, task, moment, payload, path = setup_running(tmp_path, monkeypatch)
    response = correct(client, path, payload, label_id=label, minutes=30)
    assert response.status_code == 200, response.text
    data = response.json()
    estimate = next(s for s in data['segments'] if s['is_estimated'])
    assert estimate['label_id'] == label and estimate['time_category'] == category
    assert data['time_summary']['effective_ratio'] == 1


def setup_switch(tmp_path, monkeypatch):
    client, day, task, moment, payload, path = setup_running(tmp_path, monkeypatch)
    moment[0] = f'{day}T10:00:00'
    running = client.post(path + '/labels/start', json={'label_id': 'counted_game', 'task_id': task['id']}).json()['active_segment']
    moment[0] = f'{day}T10:30:00'
    payload.update(source_segment_id=running['id'], request_id=uuid4().hex)
    return client, day, task, moment, payload, path


def test_backdated_switch_restores_learning_and_can_undo(tmp_path, monkeypatch):
    client, day, task, moment, payload, path = setup_switch(tmp_path, monkeypatch)
    response = correct(client, path, payload, mode='switch', task_id=task['id'], minutes=10, label_id=None)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['time_summary']['categories']['learning'] == 4200
    assert data['time_summary']['categories']['distraction'] == 1200
    assert data['active_segment']['label_id'] == 'effective_math_course'
    estimate = data['correction_segment_id']
    restored = client.delete(path + f'/segments/{estimate}')
    assert restored.status_code == 200, restored.text
    assert restored.json()['active_segment']['label_id'] == 'counted_game'
    assert restored.json()['time_summary']['categories']['distraction'] == 1800


def test_switch_undo_after_stop_does_not_restart(tmp_path, monkeypatch):
    client, day, task, moment, payload, path = setup_switch(tmp_path, monkeypatch)
    data = correct(client, path, payload, mode='switch', minutes=10, label_id=None).json()
    client.post(path + '/stop')
    restored = client.delete(path + f"/segments/{data['correction_segment_id']}")
    assert restored.status_code == 200, restored.text
    assert restored.json()['active_segment'] is None


def test_retry_is_atomic_and_compares_every_parameter(tmp_path, monkeypatch):
    client, day, task, moment, payload, path = setup_running(tmp_path, monkeypatch)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: correct(client, path, payload, offset_minutes=10), range(2)))
    assert all(r.status_code == 200 for r in responses)
    assert len(client.get(path).json()['segments']) == 3
    assert correct(client, path, payload, offset_minutes=11).status_code == 409
    assert correct(client, path, payload, offset_minutes=10, label_id='interrupt_meal').status_code == 409


@pytest.mark.parametrize('changes', [{'minutes': 51, 'offset_minutes': 10}, {'minutes': 61}, {'mode': 'switch'}, {'label_id': 'missing'}])
def test_invalid_correction_preserves_original(tmp_path, monkeypatch, changes):
    client, day, task, moment, payload, path = setup_running(tmp_path, monkeypatch)
    before = client.get(path).json()['segments']
    assert correct(client, path, payload, **changes).status_code in (404, 409, 422)
    assert client.get(path).json()['segments'] == before


def test_shortcuts_persist_without_changing_main_settings_or_execution(tmp_path, monkeypatch):
    client, day, task, moment, payload, path = setup_running(tmp_path, monkeypatch)
    before = client.get(path).json()['segments']
    settings = client.get('/api/settings').json()
    item = {'label_id': 'counted_game', 'minutes': 20}
    first = client.post('/api/correction-shortcuts', json=item)
    assert first.status_code == 200, first.text
    assert client.post('/api/correction-shortcuts', json=item).json() == first.json()
    assert client.get('/api/settings').json() == settings
    assert client.get(path).json()['segments'] == before
    assert client.get(path).json()['correction_shortcuts'] == first.json()
    shortcut = next(s for s in first.json() if s['label_id'] == 'counted_game')
    removed = client.delete('/api/correction-shortcuts/' + shortcut['id'])
    assert all(s['id'] != shortcut['id'] for s in removed.json())


def test_switch_rejects_undo_after_related_edit(tmp_path, monkeypatch):
    client, day, task, moment, payload, path = setup_switch(tmp_path, monkeypatch)
    data = correct(client, path, payload, mode='switch', minutes=10, label_id=None).json()
    with sqlite3.connect(client.app.state.database_path) as db:
        db.execute("UPDATE task_execution_segments SET label_name='已改动' WHERE id=?", (data['active_segment']['id'],))
    assert client.delete(path + f"/segments/{data['correction_segment_id']}").status_code == 409


def test_middle_correction_keeps_auto_stop(tmp_path):
    from datetime import datetime, timedelta
    from test_auto_stop import setup, configure, future
    client, day, task, active = setup(tmp_path)
    with sqlite3.connect(client.app.state.database_path) as db:
        db.execute('UPDATE task_execution_segments SET started_at=? WHERE id=?', ((datetime.now()-timedelta(minutes=30)).isoformat(timespec='seconds'), active['id']))
    due = configure(client, day, active, future()).json()['active_segment']['auto_stop_at']
    response = client.post(f'/api/daily-execution/{day}/time-corrections', json={'request_id':uuid4().hex,'source_segment_id':active['id'],'minutes':5,'offset_minutes':10,'label_id':'interrupt_meal'})
    assert response.status_code == 200, response.text
    assert response.json()['active_segment']['auto_stop_at'] == due


def test_switch_can_choose_another_subject_and_undo(tmp_path, monkeypatch):
    client, day, task, moment, payload, path = setup_switch(tmp_path, monkeypatch)
    english = next(t for t in client.get(path).json()['tasks'] if t['category']=='english')
    data = correct(client, path, payload, mode='switch', minutes=10, task_id=english['id'], label_id=None).json()
    assert data['active_segment']['task_id'] == english['id']
    restored = client.delete(path + f"/segments/{data['correction_segment_id']}")
    assert restored.status_code == 200, restored.text
    assert restored.json()['active_segment']['task_id'] == task['id']


def test_reset_restore_switch_metadata_does_not_resume_timer(tmp_path, monkeypatch):
    client, day, task, moment, payload, path = setup_switch(tmp_path, monkeypatch)
    data = correct(client, path, payload, mode='switch', minutes=10, label_id=None).json()
    reset = client.delete(f'/api/daily-data/{day}').json()
    snapshot = reset['reset_snapshot']['id']
    assert client.post(f'/api/daily-data/{day}/reset-snapshots/{snapshot}/restore').status_code == 200
    restored = client.delete(path + f"/segments/{data['correction_segment_id']}")
    assert restored.status_code == 200, restored.text
    assert restored.json()['active_segment'] is None
