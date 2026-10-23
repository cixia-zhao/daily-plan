"""图表比较与运行段编辑：全部使用临时库和冻结时钟。"""
from datetime import date, timedelta
import sqlite3

import app.api as api_module
from test_review_workspace import client_for, plan_for, record
from test_weekly_comparison import set_today


def test_daily_comparison_has_seconds_project_identity_and_missing_days(tmp_path, monkeypatch):
    set_today(monkeypatch, '2026-10-22')
    client = client_for(tmp_path)
    for day, end in [('2026-10-20', '09:10:30'), ('2026-10-21', '09:20:45')]:
        task = plan_for(client, day)['tasks'][0]
        record(client, day, task, '09:00:00', end)
    result = client.get('/api/daily-review/2026-10-21').json()['comparison']
    assert result['previous_date'] == '2026-10-20'
    assert result['current_has_execution'] and result['previous_has_execution']
    assert result['effective_difference_seconds'] == 615
    assert next(p for p in result['projects'] if p['category'] == 'math')['previous_seconds'] == 630
    missing = client.get('/api/daily-review/2026-10-20').json()['comparison']
    assert not missing['previous_has_execution']
    assert missing['effective_difference_seconds'] is None
    assert not client.get('/api/daily-review/2026-10-23').json()['comparison']['available']


def test_weekly_chart_has_previous_days_and_same_period_projects(tmp_path, monkeypatch):
    set_today(monkeypatch, '2026-10-14')
    client = client_for(tmp_path)
    for day, end in [('2026-10-05','09:05:00'), ('2026-10-12','09:10:00'), ('2026-10-11','09:30:00')]:
        record(client, day, plan_for(client, day)['tasks'][0], '09:00:00', end)
    comparison = client.get('/api/weekly-review?anchor_date=2026-10-14').json()['comparison']
    assert len(comparison['previous_days']) == 7
    assert comparison['previous_days'][0]['effective_seconds'] == 300
    assert comparison['previous_days'][1]['effective_seconds'] is None
    assert comparison['previous_days'][6]['effective_seconds'] == 1800
    assert comparison['effective_difference_seconds'] == 300  # 周日不并入周三截止的同期。
    assert next(p for p in comparison['projects'] if p['category'] == 'math')['previous_seconds'] == 300


def live(client, monkeypatch, kind='effective', label=None):
    day = str(date.today())
    task = plan_for(client, day)['tasks'][0]
    monkeypatch.setattr(api_module, '_now_iso', lambda: f'{day}T10:00:00')
    path = f'/api/daily-execution/{day}'
    start = (client.post(path+'/tasks/start', json={'task_id':task['id']}) if kind == 'effective'
             else client.post(path+'/labels/start',json={'task_id':task['id'],'label_id':label})).json()
    monkeypatch.setattr(api_module, '_now_iso', lambda: f'{day}T10:20:00')
    segment = start['active_segment']
    payload = {key:segment[key] for key in ('task_id','segment_kind','label_id','time_category','started_at','ended_at')}
    payload['expected_state'] = dict(payload)
    return day, path, segment, payload


def test_edit_running_keeps_same_segment_and_does_not_stop(tmp_path, monkeypatch):
    client = client_for(tmp_path)
    day, path, segment, payload = live(client, monkeypatch)
    payload['started_at'] = f'{day}T09:50:00'
    result = client.put(f"{path}/segments/{segment['id']}",json=payload)
    assert result.status_code == 200, result.text
    assert result.json()['active_segment']['id'] == segment['id']
    assert result.json()['active_segment']['ended_at'] is None
    assert result.json()['active_segment']['seconds'] == 1800
    assert len(result.json()['segments']) == 1
    stale = client.put(f"{path}/segments/{segment['id']}",json=payload)
    assert stale.status_code == 409


def test_running_cannot_revive_stopped_segment_or_start_in_future(tmp_path, monkeypatch):
    client = client_for(tmp_path)
    day, path, segment, payload = live(client, monkeypatch)
    future = dict(payload, started_at=f'{day}T10:21:00')
    assert client.put(f"{path}/segments/{segment['id']}",json=future).status_code == 422
    assert client.post(path+'/stop').status_code == 200
    assert client.put(f"{path}/segments/{segment['id']}",json=payload).status_code == 409
    assert client.get(path).json()['active_segment'] is None


def test_running_edit_overlap_rolls_back(tmp_path, monkeypatch):
    client = client_for(tmp_path)
    day, path, segment, payload = live(client, monkeypatch)
    task = client.get(f'/api/daily-plans/{day}').json()['tasks'][1]
    record(client,day,task,'09:00:00','09:30:00')
    payload['started_at'] = f'{day}T09:15:00'
    assert client.put(f"{path}/segments/{segment['id']}",json=payload).status_code == 409
    assert client.get(path).json()['active_segment']['started_at'] == f'{day}T10:00:00'


def test_running_edit_changes_classification_without_inflating_effective_time(tmp_path, monkeypatch):
    client = client_for(tmp_path)
    day, path, segment, payload = live(client, monkeypatch)
    payload.update(segment_kind='counted_label',label_id='counted_game',time_category='distraction')
    response = client.put(f"{path}/segments/{segment['id']}",json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['active_segment']['ended_at'] is None
    assert result['time_summary']['categories']['learning'] == 0
    assert result['time_summary']['categories']['distraction'] == 1200


def test_comparison_uses_classified_seconds_and_percentage_points(tmp_path, monkeypatch):
    set_today(monkeypatch, '2026-10-22')
    client = client_for(tmp_path)
    for day, end in [('2026-10-20','10:20:00'),('2026-10-21','10:10:00')]:
        task=plan_for(client,day)['tasks'][0]
        record(client,day,task,'09:00:00','10:00:00')
        record(client,day,task,'10:00:00',end,'counted_label','counted_game')
        record(client,day,task,'10:20:00','10:50:00','interrupt_label','interrupt_meal')
    comparison=client.get('/api/daily-review/2026-10-21').json()['comparison']
    assert comparison['effective_difference_seconds']==0
    assert comparison['distraction_difference_seconds']==-600
    assert comparison['efficiency_difference_points']==10.71


def test_zero_learning_with_recorded_distraction_differs_from_missing_day(tmp_path, monkeypatch):
    set_today(monkeypatch, '2026-10-22')
    client=client_for(tmp_path)
    for day in ['2026-10-20','2026-10-21']:
        task=plan_for(client,day)['tasks'][0]
        record(client,day,task,'09:00:00','09:10:00','counted_label','counted_game')
    comparison=client.get('/api/daily-review/2026-10-21').json()['comparison']
    assert comparison['current_has_execution'] and comparison['previous_has_execution']
    assert comparison['effective_difference_seconds']==0
    assert comparison['efficiency_difference_points']==0


def test_running_edit_cancels_old_reminder_but_noop_keeps_it(tmp_path, monkeypatch):
    client=client_for(tmp_path);client.app.state.ui_preview=True
    day,path,segment,payload=live(client,monkeypatch,'interrupt_label','interrupt_meal')
    with sqlite3.connect(client.app.state.database_path) as db:
        db.execute("INSERT INTO execution_reminders(segment_id,due_at,status) VALUES(?,?,'pending')",
                   (segment['id'],day+'T12:00:00+08:00'))
    assert client.put(f"{path}/segments/{segment['id']}",json=payload).status_code==200
    with sqlite3.connect(client.app.state.database_path) as db:
        assert db.execute('SELECT status FROM execution_reminders').fetchone()[0]=='pending'
    payload.update(segment_kind='effective',label_id=None,time_category='learning')
    assert client.put(f"{path}/segments/{segment['id']}",json=payload).status_code==200
    with sqlite3.connect(client.app.state.database_path) as db:
        assert db.execute('SELECT status FROM execution_reminders').fetchone()[0]=='cancelled'


def test_running_edit_does_not_break_quick_correction_neighbors(tmp_path, monkeypatch):
    client=client_for(tmp_path)
    day,path,segment,payload=live(client,monkeypatch)
    corrected=client.post(path+'/quick-corrections',json={'source_segment_id':segment['id'],
        'request_id':'visual-live-correction-001','minutes':2,'time_category':'life'})
    assert corrected.status_code==200,corrected.text
    active=corrected.json()['active_segment']
    body={key:active[key] for key in ('task_id','segment_kind','label_id','time_category','started_at','ended_at')}
    body['started_at']=day+'T10:19:00'
    assert client.put(f"{path}/segments/{active['id']}",json=body).status_code==409
    # 原关联保持完整，仍可按原规则撤销补记。
    estimated=next(s for s in corrected.json()['segments'] if s['is_estimated'])
    assert client.delete(f"{path}/segments/{estimated['id']}").status_code==200
