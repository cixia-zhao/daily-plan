"""用真实接口验证目标与执行分离；数据库均在 pytest 临时目录。"""
import json
import shutil
import sqlite3
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.database import initialize
from app.main import create_app
from app.models import SCHEMA

DAY = '2026-10-11'


def client_for(tmp_path):
    return TestClient(create_app(database_path=tmp_path / 'flows.db', disable_ai=True))


def plan_for(client, day=DAY, targets=None):
    response = client.post('/api/daily-plans/draft', json={
        'date': day, 'energy': 'normal', 'day_type': 'normal',
        'target_minutes': targets or {},
    })
    assert response.status_code == 201, response.text
    assert client.post(f'/api/daily-plans/{day}/approve').status_code == 200
    return response.json()


def task(plan, category):
    return next(row for row in plan['tasks'] if row['category'] == category)


def span(client, task_id, start='09:00', end='09:30', label=None, choice=None):
    return client.post(f'/api/daily-execution/{DAY}/segments', json={
        'task_id': task_id, 'segment_kind': 'effective', 'label_id': label,
        'started_at': f'{DAY}T{start}:00', 'ended_at': f'{DAY}T{end}:00',
        'duplicate_choice': choice,
    })


def test_330_minute_goals_save_confirm_without_old_240_cap(tmp_path):
    client = client_for(tmp_path)
    response = client.post('/api/daily-plans/draft', json={
        'date': DAY, 'energy': 'minimum', 'available_minutes': 240, 'day_type': 'normal',
        'target_minutes': {'math': 240, 'english': 30, 'computer': 60},
    })
    assert response.status_code == 201
    plan = response.json()
    assert sum(row['estimated_minutes'] for row in plan['tasks']) == 330
    fields = {'id','title','category','estimated_minutes','priority','completion_criteria','reason','source','sub_category','is_sub','task_type'}
    rows = [{key: value for key, value in row.items() if key in fields} for row in plan['tasks']]
    assert client.put(f'/api/daily-plans/{DAY}', json={'tasks': rows}).status_code == 200
    confirmed = client.post(f'/api/daily-plans/{DAY}/approve').json()
    assert confirmed['available_minutes'] == 240
    assert task(confirmed, 'math')['estimated_minutes'] == 240


def test_zero_target_408_start_refresh_switch_stop_preserves_goal(tmp_path, monkeypatch):
    client = client_for(tmp_path)
    plan = plan_for(client)
    computer, math = task(plan, 'computer'), task(plan, 'math')
    now = [f'{DAY}T09:00:00']
    monkeypatch.setattr('app.api._now_iso', lambda: now[0])
    started = client.post(f'/api/daily-execution/{DAY}/tasks/start', json={'task_id': computer['id']})
    assert started.status_code == 200
    active_id = started.json()['active_segment']['id']
    refreshed = client.get(f'/api/daily-execution/{DAY}').json()
    assert refreshed['active_segment']['id'] == active_id
    now[0] = f'{DAY}T09:45:00'
    switched = client.post(f'/api/daily-execution/{DAY}/tasks/start', json={'task_id': math['id']}).json()
    assert len([row for row in switched['segments'] if row['ended_at'] is None]) == 1
    assert switched['segments'][0]['ended_at'] == now[0]
    now[0] = f'{DAY}T10:05:00'
    stopped = client.post(f'/api/daily-execution/{DAY}/stop').json()
    computer = task(stopped['plan'], 'computer')
    assert computer['estimated_minutes'] == 0
    assert computer['actual_minutes'] == 45
    assert computer['completed'] is False
    assert client.post(f'/api/daily-plans/{DAY}/submit').status_code == 200
    daily = client.get(f'/api/daily-review/{DAY}').json()
    weekly = client.get(f'/api/weekly-review?anchor_date={DAY}').json()
    assert daily['main_actual_minutes'] == weekly['actual_minutes'] == 65
    assert '计划 0 分｜实际 45 分' in daily['gpt_prompt_text']


def test_temporary_activity_keeps_segments_and_can_execute(tmp_path):
    client = client_for(tmp_path)
    plan = plan_for(client)
    old = span(client, task(plan,'math')['id']).json()['segments']
    added = client.post(f'/api/daily-execution/{DAY}/tasks', json={'title':'提交报名表','category':'writing','task_type':'todo'})
    assert added.status_code == 201
    assert added.json()['segments'] == old
    temporary = added.json()['tasks'][-1]
    assert temporary['estimated_minutes'] == 0
    assert client.post(f'/api/daily-execution/{DAY}/tasks/start', json={'task_id':temporary['id']}).status_code == 200
    assert client.get(f'/api/daily-execution/{DAY}').json()['active_segment']['task_id'] == temporary['id']


def test_over_goal_execution_and_habit_rest_never_destroy_duration(tmp_path):
    client = client_for(tmp_path)
    plan = plan_for(client, targets={'math':10, 'rehab':20})
    assert span(client, task(plan,'math')['id'], end='10:00').status_code == 200
    exercise = task(plan,'rehab')
    assert span(client, exercise['id'], '10:00','10:20').status_code == 200
    for status in ['rest','missed','done']:
        assert client.patch(f"/api/tasks/{exercise['id']}", json={'habit_status':status}).status_code == 200
        daily = client.get(f'/api/daily-review/{DAY}').json()
        board = next(row for row in daily['task_execution_board'] if row['category']=='rehab')
        assert board['habit_status'] == status
        assert board['effective_minutes'] == 20
        assert {'rest':'休息','missed':'没做','done':'做了'}[status] in daily['gpt_prompt_text']
    assert task(client.get(f'/api/daily-plans/{DAY}').json(), 'math')['actual_minutes'] == 60


def test_only_explicit_todos_generate_pool_even_zero_target_sub_route(tmp_path):
    client = client_for(tmp_path)
    plan = plan_for(client, targets={'math':240,'english':30,'rehab':20})
    concrete = task(plan,'writing')
    assert client.patch(f"/api/tasks/{concrete['id']}", json={'task_type':'todo'}).status_code == 200
    tomorrow = (date.fromisoformat(DAY)+timedelta(days=1)).isoformat()
    plan_for(client, tomorrow)
    pool = client.get('/api/carryovers').json()
    assert len(pool) == 1 and pool[0]['task_id'] == concrete['id']
    assert not any(row['source']=='carryover' for row in client.get(f'/api/daily-plans/{tomorrow}').json()['tasks'])
    assert client.post(f"/api/carryovers/{pool[0]['id']}/resolve", json={'action':'reschedule','target_date':'2026-10-13'}).status_code == 200
    future = plan_for(client, '2026-10-13')
    assert next(row for row in future['tasks'] if row['source']=='carryover')['task_type'] == 'todo'


def test_vocabulary_multiple_add_edit_delete_refresh_day_week_export(tmp_path):
    client = client_for(tmp_path)
    plan = plan_for(client)
    english = task(plan,'english')
    assert span(client, english['id'], label='effective_english_reading').status_code == 200
    first = client.post(f'/api/daily-execution/{DAY}/vocabulary', json={'minutes':15})
    assert first.status_code == 201 # 阅读计时不视为背单词重复
    record_id = first.json()['duration_records'][0]['id']
    assert client.post(f'/api/daily-execution/{DAY}/vocabulary', json={'minutes':10}).status_code == 201
    edited = client.put(f'/api/daily-execution/{DAY}/vocabulary/{record_id}', json={'minutes':20}).json()
    assert len(edited['duration_records']) == 2
    assert task(edited['plan'],'english')['actual_minutes'] == 60
    assert all('started_at' not in row and 'ended_at' not in row for row in edited['duration_records'])
    for _ in range(2):
        assert task(client.get(f'/api/daily-execution/{DAY}').json()['plan'],'english')['actual_minutes'] == 60
    assert client.delete(f'/api/daily-execution/{DAY}/vocabulary/{record_id}').status_code == 200
    assert client.post(f'/api/daily-plans/{DAY}/submit').status_code == 200
    daily = client.get(f'/api/daily-review/{DAY}').json()
    weekly = client.get(f'/api/weekly-review?anchor_date={DAY}').json()
    assert daily['english_minutes'] == weekly['english_minutes'] == 40
    assert daily['vocabulary_minutes'] == weekly['vocabulary_minutes'] == 10
    assert daily['main_actual_minutes'] == weekly['actual_minutes'] == 40
    assert '英语 40 分，其中背单词 10 分' in daily['gpt_prompt_text']
    assert '英语 40 分，其中背单词 10 分' in weekly['gpt_prompt_text']


@pytest.mark.parametrize('choice, expected', [('both',35), ('manual',15), ('timer',20)])
def test_vocabulary_user_selects_source_only_words_affected(tmp_path, choice, expected):
    client = client_for(tmp_path)
    plan = plan_for(client)
    english = task(plan,'english')
    assert span(client, english['id'], end='09:20', label='effective_english_words').status_code == 200
    assert span(client, english['id'], '10:00','10:30',label='effective_english_reading').status_code == 200
    assert client.post(f'/api/daily-execution/{DAY}/vocabulary',json={'minutes':15}).status_code == 409
    result = client.post(f'/api/daily-execution/{DAY}/vocabulary',json={'minutes':15,'duplicate_choice':choice}).json()
    assert len(result['segments']) == 2 and len(result['duration_records']) == 1
    assert task(result['plan'],'english')['actual_minutes'] == expected+30
    daily = client.get(f'/api/daily-review/{DAY}').json()
    assert daily['vocabulary_minutes'] == expected
    assert daily['english_minutes'] == expected+30


def test_vocabulary_record_first_then_timer_requires_choice(tmp_path, monkeypatch):
    client = client_for(tmp_path)
    plan = plan_for(client)
    english = task(plan,'english')
    client.post(f'/api/daily-execution/{DAY}/vocabulary',json={'minutes':15})
    payload={'task_id':english['id'],'label_id':'effective_english_words'}
    assert client.post(f'/api/daily-execution/{DAY}/tasks/start',json=payload).status_code == 409
    assert span(client,english['id'],label='effective_english_words').status_code == 409
    now=[f'{DAY}T11:00:00'];monkeypatch.setattr('app.api._now_iso',lambda:now[0])
    assert client.post(f'/api/daily-execution/{DAY}/tasks/start',json=payload|{'duplicate_choice':'manual'}).status_code == 200
    now[0]=f'{DAY}T11:30:00'
    result=client.post(f'/api/daily-execution/{DAY}/stop').json()
    assert task(result['plan'],'english')['actual_minutes']==15
    assert result['segments'][-1]['included'] is False


@pytest.mark.parametrize('minutes', [0,-1,1441])
def test_duration_input_validation_and_date_isolation(tmp_path, minutes):
    client=client_for(tmp_path);plan_for(client)
    assert client.post(f'/api/daily-execution/{DAY}/vocabulary',json={'minutes':minutes}).status_code==422
    assert client.post('/api/daily-execution/2026-10-12/vocabulary',json={'minutes':5}).status_code==404
    row=client.post(f'/api/daily-execution/{DAY}/vocabulary',json={'minutes':5}).json()['duration_records'][0]
    plan_for(client,'2026-10-12')
    assert client.put(f"/api/daily-execution/2026-10-12/vocabulary/{row['id']}",json={'minutes':10}).status_code==404
    assert client.delete(f"/api/daily-execution/2026-10-12/vocabulary/{row['id']}").status_code==404


def test_old_database_copy_migration_preserves_original_rows_and_is_idempotent(tmp_path):
    original=tmp_path/'original.db';copy=tmp_path/'copy.db'
    old=SCHEMA.replace('    task_type TEXT,\n','').replace('    habit_status TEXT,\n','').replace('    legacy_actual_minutes INTEGER,\n','').replace('    included INTEGER NOT NULL DEFAULT 1,\n','')
    start=old.index('CREATE TABLE IF NOT EXISTS task_duration_records');end=old.index('CREATE TABLE IF NOT EXISTS app_settings');old=old[:start]+old[end:]
    with sqlite3.connect(original) as db:
        db.executescript(old)
        db.execute("INSERT INTO plans(plan_date,energy,available_minutes,day_type,status) VALUES(?,'normal',240,'normal','submitted')",(DAY,))
        db.execute("INSERT INTO tasks(plan_id,title,category,estimated_minutes,actual_minutes,priority,completion_criteria,completed) VALUES(1,'旧运动','rehab',20,17,3,'安全运动',0)")
        db.execute("INSERT INTO tasks(plan_id,title,category,estimated_minutes,actual_minutes,priority,completion_criteria,completed) VALUES(1,'旧英语','english',0,12,2,'单词',0)")
        db.execute("INSERT INTO carryovers(task_id,title,category,estimated_minutes) VALUES(1,'旧待审运动','rehab',20)")
        db.execute("INSERT INTO reviews(review_date,effective_method,tomorrow_focus,reflection_text) VALUES(?,'旧方法','旧重点','旧复盘')",(DAY,))
        db.execute("INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,started_at,ended_at) VALUES(?,1,'effective',?,?)",(DAY,DAY+'T09:00:00',DAY+'T09:17:00'))
        db.execute("INSERT INTO weekly_reports(end_date,start_date,snapshot_json,final_report_text) VALUES(?,'2026-10-05','{}','旧周报')",(DAY,))
        db.execute("INSERT INTO app_settings(key,value_json) VALUES('main',?)",(json.dumps({'budget_normal':240}),))
        tables=['plans','tasks','carryovers','reviews','task_execution_segments','weekly_reports','app_settings']
        columns={table:[row[1] for row in db.execute(f'PRAGMA table_info({table})')] for table in tables}
        rows={table:db.execute(f'SELECT * FROM {table}').fetchall() for table in tables}
    shutil.copy2(original,copy)
    initialize(copy);initialize(copy)
    with sqlite3.connect(copy) as db:
        for table in tables:
            assert db.execute(f"SELECT {','.join(columns[table])} FROM {table}").fetchall()==rows[table]
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert db.execute('PRAGMA foreign_key_check').fetchall()==[]
        assert db.execute('SELECT task_type FROM tasks').fetchall()==[(None,),(None,)]
    client=TestClient(create_app(database_path=copy,disable_ai=True))
    daily=client.get(f'/api/daily-review/{DAY}').json()
    assert daily['main_actual_minutes']==29
    assert client.get('/api/carryovers').json()[0]['title']=='旧待审运动'
    assert daily['review']['reflection_text']=='旧复盘'
    # 旧版手填 12 分钟 + 新墨墨 5 分钟；刷新不能覆盖。
    added=client.post(f'/api/daily-execution/{DAY}/vocabulary',json={'minutes':5}).json()
    assert task(added['plan'],'english')['actual_minutes']==17
    assert task(client.get(f'/api/daily-execution/{DAY}').json()['plan'],'english')['actual_minutes']==17
    with sqlite3.connect(original) as db:
        for table in tables:
            assert db.execute(f'SELECT * FROM {table}').fetchall()==rows[table]


def test_concrete_todo_duration_is_not_completion_and_enters_pool(tmp_path):
    client=client_for(tmp_path)
    plan=plan_for(client, targets={'math':10})
    concrete=task(plan,'math')
    client.patch(f"/api/tasks/{concrete['id']}",json={'task_type':'todo'})
    assert span(client,concrete['id']).status_code==200
    assert task(client.get(f'/api/daily-plans/{DAY}').json(),'math')['completed'] is False
    plan_for(client,'2026-10-12')
    assert client.get('/api/carryovers').json()[0]['task_id']==concrete['id']


def test_habit_done_does_not_fabricate_minutes(tmp_path):
    client=client_for(tmp_path);plan=plan_for(client,targets={'rehab':20})
    exercise=task(plan,'rehab')
    changed=client.patch(f"/api/tasks/{exercise['id']}",json={'habit_status':'done'}).json()
    assert changed['completed'] is True
    assert changed['actual_minutes']==0
    board=next(row for row in client.get(f'/api/daily-review/{DAY}').json()['task_execution_board'] if row['category']=='rehab')
    assert board['habit_status']=='done' and board['effective_minutes']==0
