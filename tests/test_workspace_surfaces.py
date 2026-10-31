"""当天执行与完整历史记录分开，历史读取不改变原记录。"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from test_review_workspace import client_for, plan_for, record


def test_history_execution_page_keeps_saved_records(tmp_path):
    client = client_for(tmp_path)
    day = datetime.now(ZoneInfo('Asia/Shanghai')).date() - timedelta(days=1)
    task = plan_for(client, day)['tasks'][0]
    record(client, day, task, '08:00:00', '08:20:00')
    before = client.get(f'/api/daily-execution/{day}').json()['segments']
    response = client.get(f'/execute?date={day}', follow_redirects=False)
    assert response.status_code == 200
    assert 'id="history-page-title"' in response.text
    assert 'id="history-task-list"' in response.text
    assert 'inline-records' in response.text
    assert client.get(f'/api/daily-execution/{day}').json()['segments'] == before


def test_current_execution_has_no_date_controls_and_shared_overlay(tmp_path):
    client = client_for(tmp_path)
    day = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    response = client.get(f'/execute?date={day}', follow_redirects=False)
    assert response.status_code == 200
    assert 'id="execute-date-button"' not in response.text
    assert 'id="execution-date-note"' not in response.text
    assert 'id="execution-mini-stop"' in response.text
    assert 'id="execution-complete-tab"' in response.text
    review = client.get(f'/review?date={day}')
    assert 'id="review-records-open"' in review.text
    assert 'id="segment-edit-dialog"' in review.text


def test_execution_rejects_invalid_calendar_date(tmp_path):
    client = client_for(tmp_path)
    for value in ('2026-99-99', '2026-02-30', '2026-1-1'):
        assert client.get('/execute?date='+value, follow_redirects=False).status_code == 422


def test_return_today_follows_current_day_progress_without_writes(tmp_path):
    import sqlite3
    from urllib.parse import parse_qs, urlsplit

    client = client_for(tmp_path)
    today = datetime.now(ZoneInfo('Asia/Shanghai')).date()

    def destination(path):
        with sqlite3.connect(tmp_path / 'review.db') as db:
            before = list(db.iterdump())
        result = client.get('/return-today', follow_redirects=False)
        assert result.status_code == 303
        assert result.headers['cache-control'] == 'no-store'
        url = urlsplit(result.headers['location'])
        assert url.path == path
        assert parse_qs(url.query)['date'] == [str(today)]
        if path == '/review':
            assert parse_qs(url.query)['scope'] == ['daily']
        with sqlite3.connect(tmp_path / 'review.db') as db:
            assert list(db.iterdump()) == before

    destination('/')
    past = today - timedelta(days=1)
    old = plan_for(client, past)
    record(client, past, old['tasks'][0], '08:00:00', '08:20:00')
    destination('/')
    draft = client.post('/api/daily-plans/draft', json={
        'date': str(today), 'energy': 'normal', 'day_type': 'normal',
        'target_minutes': {'math': 60, 'english': 30, 'computer': 0, 'rehab': 0},
    }).json()
    destination('/')
    assert client.post(f'/api/daily-plans/{today}/approve').status_code == 200
    destination('/execute')
    math = next(t for t in draft['tasks'] if t['category'] == 'math')
    assert client.post(f'/api/daily-execution/{today}/tasks/start', json={
        'task_id': math['id'], 'label_id': 'effective_math_course',
    }).status_code == 200
    destination('/execute')
    assert client.put(f'/api/vocabulary-counts/{today}', json={'new_words': 10, 'review_words': 20}).status_code == 200
    destination('/execute')
    assert client.post(f'/api/daily-execution/{today}/stop').status_code == 200
    destination('/review')
    assert client.post(f'/api/daily-execution/{today}/tasks/start', json={
        'task_id': math['id'], 'label_id': 'effective_math_course',
    }).status_code == 200
    destination('/execute')


def test_return_today_counts_words_even_without_a_plan(tmp_path):
    client = client_for(tmp_path)
    today = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    for counts in ({'new_words': 10, 'review_words': 20}, {'new_words': 0, 'review_words': 0}):
        assert client.put(f'/api/vocabulary-counts/{today}', json=counts).status_code == 200
        result = client.get('/return-today', follow_redirects=False)
        assert result.headers['location'] == f'/review?date={today}&scope=daily'
    assert client.delete(f'/api/vocabulary-counts/{today}').status_code == 200
    assert client.get('/return-today', follow_redirects=False).headers['location'] == f'/?date={today}'


def test_return_today_counts_manual_duration_and_legacy_progress(tmp_path):
    from app.database import connect

    client = client_for(tmp_path)
    today = datetime.now(ZoneInfo('Asia/Shanghai')).date()
    plan = plan_for(client, today)
    assert client.post(f'/api/daily-execution/{today}/vocabulary', json={'minutes': 15}).status_code == 201
    assert client.get('/return-today', follow_redirects=False).headers['location'].startswith('/review?')
    with connect(tmp_path / 'review.db') as db:
        db.execute('DELETE FROM task_duration_records')
        db.execute('UPDATE tasks SET actual_minutes=0, legacy_actual_minutes=NULL, completed=0, habit_status=NULL')
    assert client.get('/return-today', follow_redirects=False).headers['location'].startswith('/execute?')
    for column, value in [('actual_minutes', 3), ('legacy_actual_minutes', 3), ('completed', 1), ('habit_status', 'done')]:
        with connect(tmp_path / 'review.db') as db:
            db.execute(f'UPDATE tasks SET {column}=? WHERE id=?', (value, plan['tasks'][0]['id']))
        assert client.get('/return-today', follow_redirects=False).headers['location'].startswith('/review?')
        with connect(tmp_path / 'review.db') as db:
            db.execute('UPDATE tasks SET actual_minutes=0, legacy_actual_minutes=NULL, completed=0, habit_status=NULL')
