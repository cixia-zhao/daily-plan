"""调研第一部分回归；所有数据库均为临时合成数据。"""
import os
import sqlite3
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from test_review_workspace import client_for, plan_for


def add(client, day, task, start, end, kind='effective', label=None):
    return client.post(f'/api/daily-execution/{day}/segments', json={
        'task_id': task['id'], 'segment_kind': kind, 'label_id': label,
        'started_at': start, 'ended_at': end,
    })


def test_short_segments_aggregate_before_rounding_and_keep_originals(tmp_path):
    client = client_for(tmp_path)
    day = date.today() - timedelta(days=7)
    task = plan_for(client, day)['tasks'][0]
    start = datetime.combine(day, datetime.min.time()) + timedelta(hours=9)
    for i in range(10):
        response = add(client, day, task, (start + timedelta(seconds=i*50)).isoformat(),
                       (start + timedelta(seconds=(i+1)*50)).isoformat(), label='effective_math_course')
        assert response.status_code == 200, response.text
    daily = client.get(f'/api/daily-review/{day}').json()
    board = daily['task_execution_board'][0]
    assert daily['main_actual_minutes'] == daily['main_total_minutes'] == 8
    assert daily['main_actual_seconds'] == board['effective_seconds'] == 500
    assert board['effective_labels'][0]['minutes'] == 8
    assert board['effective_labels'][0]['seconds'] == 500
    assert '实际 8' in daily['gpt_prompt_text']
    week = client.get(f'/api/weekly-review?anchor_date={day}').json()
    assert week['actual_minutes'] == week['total_minutes'] == 8
    assert week['actual_seconds'] == 500
    assert '实际分钟：8 分' in week['gpt_prompt_text']
    assert len(response.json()['segments']) == 10
    assert response.json()['segments'][0]['seconds'] == 50


def test_seconds_survive_across_tasks_days_labels_and_excluded_records(tmp_path):
    client = client_for(tmp_path)
    monday = date.today() - timedelta(days=date.today().weekday()+7)
    for offset in [0, 1]:
        day = monday + timedelta(days=offset)
        tasks = plan_for(client, day)['tasks']
        math = tasks[0]
        english = next(t for t in tasks if t['category'] == 'english')
        for task, start, end in [(math,'09:00:00','09:00:40'),(english,'09:01:00','09:01:40')]:
            assert add(client, day, task, f'{day}T{start}',f'{day}T{end}').status_code == 200
        daily = client.get(f'/api/daily-review/{day}').json()
        assert daily['main_actual_minutes'] == 1
        assert len(daily['task_execution_board']) == 2
    week = client.get(f'/api/weekly-review?anchor_date={monday}').json()
    assert week['actual_minutes'] == 2
    assert week['actual_seconds'] == 160
    assert all(item['effective_minutes'] == 1 for item in week['task_distribution'])

    day = monday + timedelta(days=2)
    tasks = plan_for(client, day)['tasks']
    english = next(t for t in tasks if t['category'] == 'english')
    for i in range(2):
        response = add(client, day, english, f'{day}T09:0{i}:00', f'{day}T09:0{i}:50',label='effective_english_words')
        assert response.status_code == 200
    assert client.post(f'/api/daily-execution/{day}/vocabulary',json={'minutes':3,'duplicate_choice':'both'}).status_code == 201
    daily = client.get(f'/api/daily-review/{day}').json()
    assert daily['english_minutes'] == daily['vocabulary_minutes'] == 4
    records = response.json()['segments']
    with sqlite3.connect(client.app.state.database_path) as db:
        db.execute('UPDATE task_execution_segments SET included=0 WHERE id=?',(records[0]['id'],))
    daily = client.get(f'/api/daily-review/{day}').json()
    assert daily['vocabulary_seconds'] == 230
    assert daily['vocabulary_minutes'] == 3


@pytest.mark.parametrize('first_day,second_day', [('2026-10-11','2026-10-12'),('2026-09-30','2026-10-01'),('2025-12-31','2026-01-01')])
def test_cross_date_overlap_and_exact_boundary(tmp_path, first_day, second_day):
    client = client_for(tmp_path)
    first = plan_for(client, first_day)['tasks'][0]
    second = plan_for(client, second_day)['tasks'][0]
    assert add(client, first_day, first, f'{first_day}T23:50:00',f'{second_day}T00:10:00').status_code == 200
    assert add(client, second_day, second, f'{second_day}T00:00:00',f'{second_day}T00:20:00').status_code == 409
    response = add(client, second_day, second, f'{second_day}T00:10:00',f'{second_day}T00:20:00')
    assert response.status_code == 200
    segment = response.json()['segments'][0]
    assert client.put(f"/api/daily-execution/{second_day}/segments/{segment['id']}",json={
        'task_id':second['id'],'segment_kind':'effective','started_at':f'{second_day}T00:09:59','ended_at':f'{second_day}T00:20:00',
    }).status_code == 409


def test_timezone_inputs_compare_real_instants(tmp_path):
    client = client_for(tmp_path)
    day = date.today() - timedelta(days=1)
    task = plan_for(client, day)['tasks'][0]
    assert add(client, day, task, f'{day}T09:00:00',f'{day}T09:10:00').status_code == 200
    assert add(client, day, task, f'{day}T01:05:00Z',f'{day}T01:15:00+00:00').status_code == 409
    assert add(client, day, task, f'{day}T01:10:00Z',f'{day}T09:20:00+08:00').status_code == 200
    assert client.get(f'/api/daily-review/{day}').json()['main_actual_minutes'] == 20


def test_start_rejects_future_booked_segment_and_rolls_back(tmp_path):
    client = client_for(tmp_path)
    day = date.today()
    task = plan_for(client, day)['tasks'][0]
    future = datetime.now().replace(microsecond=0) + timedelta(hours=1)
    assert add(client, day, task, future.isoformat(),(future+timedelta(minutes=5)).isoformat()).status_code == 200
    assert client.post(f'/api/daily-execution/{day}/tasks/start',json={'task_id':task['id']}).status_code == 409
    assert client.get(f'/api/daily-execution/{day}').json()['active_segment'] is None


def test_imports_do_not_initialize_default_database_and_legacy_entry_works(tmp_path):
    db = tmp_path / 'sentinel.db'
    with sqlite3.connect(db) as connection:
        connection.execute('CREATE TABLE sentinel(value TEXT)')
    env = os.environ | {'DATABASE_PATH':str(db),'PYTHON_DOTENV_DISABLED':'1','DEEPSEEK_API_KEY':'','APP_RUNTIME':'development'}
    subprocess.run([sys.executable,'-c','import app.main; import app.preview'],env=env,check=True)
    with sqlite3.connect(db) as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [('sentinel',)]
    subprocess.run([sys.executable,'-c','from app.main import app; assert app.state.database_path.exists()'],env=env,check=True)
    with sqlite3.connect(db) as connection:
        assert connection.execute("SELECT name FROM sqlite_master WHERE name='plans'").fetchone()


def test_reads_and_saves_never_analyze_and_explicit_analysis_releases_write_lock(tmp_path):
    client = client_for(tmp_path)
    day = date.today() - timedelta(days=7)
    task = plan_for(client, day)['tasks'][0]
    assert add(client,day,task,f'{day}T09:00:00',f'{day}T09:10:00').status_code == 200
    end = day + timedelta(days=6-day.weekday())
    class Model:
        def model_dump(self): return {'summary_title':'替身分析'}
    class Analyzer:
        calls = 0
        def analyze(self,snapshot,prompt):
            self.calls += 1
            with sqlite3.connect(client.app.state.database_path,timeout=0.2) as db:
                db.execute("INSERT INTO reviews(review_date,tomorrow_focus,effective_method) VALUES(?,?,'') ON CONFLICT(review_date) DO UPDATE SET tomorrow_focus=excluded.tomorrow_focus",(str(day),'分析中仍能保存'))
            # 分析期间并发保存最终稿，分析落库不可覆盖它。
            assert client.put(f'/api/weekly-reports/{end}',json={'final_report_text':'并发最终稿'}).status_code == 200
            return Model(),None
    analyzer=Analyzer();client.app.state.weekly_review_analyzer=analyzer
    for path in [f'/api/review-navigation?anchor_date={day}',f'/api/weekly-review?anchor_date={day}',f'/api/weekly-reports/{end}']:
        assert client.get(path).status_code == 200
    assert client.get('/api/weekly-reports').json() == []
    assert client.put(f'/api/weekly-reports/{end}',json={'final_report_text':'最终稿'}).status_code == 200
    assert client.put(f'/api/weekly-review/{end}/gpt-record',json={'response_text':'回复','adopted_text':''}).status_code == 200
    assert analyzer.calls == 0
    assert client.post(f'/api/weekly-reports/{end}/refresh').status_code == 200
    assert analyzer.calls == 1
    result=client.get(f'/api/weekly-review?anchor_date={day}').json()
    assert analyzer.calls == 1
    assert result['final_report_text'] == '并发最终稿'
    assert result['analysis']['summary_title'] == '替身分析'
    assert result['analysis_stale']


def test_ai_failure_preserves_analysis_basis_and_final_report(tmp_path):
    client = client_for(tmp_path)
    day = date.today() - timedelta(days=7)
    end = day + timedelta(days=6-day.weekday())
    class Model:
        def model_dump(self): return {'summary_title':'原来的分析'}
    class Analyzer:
        fail = False
        def analyze(self,snapshot,prompt):
            return (None,'测试失败') if self.fail else (Model(),None)
    analyzer=Analyzer();client.app.state.weekly_review_analyzer=analyzer
    assert client.post(f'/api/weekly-reports/{end}/refresh').status_code == 200
    assert client.put(f'/api/weekly-reports/{end}',json={'final_report_text':'已确认的最终稿'}).status_code == 200
    assert client.post('/api/daily-reviews',json={'date':str(day),'effective_method':'新的正文','tomorrow_focus':''}).status_code == 200
    analyzer.fail=True
    assert client.post(f'/api/weekly-reports/{end}/refresh').status_code == 502
    result=client.get(f'/api/weekly-review?anchor_date={day}').json()
    assert result['analysis']['summary_title'] == '原来的分析'
    assert result['final_report_text'] == '已确认的最终稿'
    assert result['analysis_stale']
    assert result['ai_status'] == 'error'


def test_preview_factory_and_reimport_only_touch_preview_paths(tmp_path):
    sentinel = tmp_path/'non-preview.db'
    with sqlite3.connect(sentinel) as db:
        db.execute('CREATE TABLE sentinel(value TEXT)')
    env=os.environ|{'DATABASE_PATH':str(sentinel),'PYTHON_DOTENV_DISABLED':'1','DEEPSEEK_API_KEY':'','APP_RUNTIME':'development'}
    code='''import importlib
from pathlib import Path
import app.preview as preview
preview.ROOT=Path(%r)
for _ in range(2):
    app=preview.create_preview_app()
    assert app.state.database_path == preview.ROOT/'data/ui-preview.db'
    assert app.state.ai_planner is None
    assert app.state.ui_preview
importlib.reload(preview)
''' % str(tmp_path)
    subprocess.run([sys.executable,'-c',code],env=env,check=True)
    with sqlite3.connect(sentinel) as db:
        assert db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [('sentinel',)]
