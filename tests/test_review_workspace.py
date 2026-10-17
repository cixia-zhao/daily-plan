from datetime import date, timedelta

from fastapi.testclient import TestClient

from app.main import create_app


def client_for(tmp_path):
    return TestClient(create_app(database_path=tmp_path / 'review.db', disable_ai=True))


def plan_for(client, day):
    draft = client.post('/api/daily-plans/draft', json={
        'date': str(day), 'energy': 'normal', 'day_type': 'normal',
        'target_minutes': {'math': 10, 'english': 0, 'computer': 0, 'rehab': 0},
    }).json()
    assert client.post(f'/api/daily-plans/{day}/approve').status_code == 200
    return draft


def record(client, day, task, start, end, kind='effective', label=None):
    response = client.post(f'/api/daily-execution/{day}/segments', json={
        'task_id': task['id'], 'segment_kind': kind, 'label_id': label,
        'started_at': f'{day}T{start}', 'ended_at': f'{day}T{end}',
    })
    assert response.status_code == 200, response.text
    return response.json()['segments'][-1]


def test_saved_execution_counts_before_submit_and_after_edit(tmp_path):
    client = client_for(tmp_path)
    monday = date.today() - timedelta(days=date.today().weekday() + 7)
    for offset, minutes in [(0, 10), (1, 30)]:
        day = monday + timedelta(days=offset)
        draft = plan_for(client, day)
        math = next(t for t in draft['tasks'] if t['category'] == 'math')
        record(client, day, math, '09:00:00', f'09:{minutes:02}:00')
        if offset == 0:
            record(client, day, math, '09:10:00', '09:20:00', 'counted_label', 'counted_game')
            sub = next(t for t in draft['tasks'] if t['is_sub'])
            record(client, day, sub, '10:00:00', '10:30:00')
    client.post('/api/daily-reviews', json={'date': str(monday), 'effective_method': '先写目标', 'tomorrow_focus': ''})
    week = client.get(f'/api/weekly-review?anchor_date={monday}').json()
    assert week['actual_minutes'] == 40
    assert week['total_minutes'] == 50
    assert week['effective_ratio'] == 0.8
    assert week['total_sub_minutes'] == 30
    assert week['task_count'] == 2
    assert week['weekday_progress']['days'][1]['is_clickable']
    assert not week['weekday_progress']['days'][1]['has_review']
    assert week['weekday_progress']['days'][1]['has_execution']
    end = week['end_date']
    client.put(f'/api/weekly-reports/{end}', json={'final_report_text': '保留旧最终稿'})
    day = monday + timedelta(days=1)
    client.post(f'/api/daily-plans/{day}/submit')
    task = client.get(f'/api/daily-plans/{day}').json()['tasks'][0]
    client.patch(f"/api/tasks/{task['id']}", json={'completed': False})
    refreshed = client.get(f'/api/weekly-review?anchor_date={monday}').json()
    assert refreshed['actual_minutes'] == 40
    assert refreshed['final_report_text'] == '保留旧最终稿'
    assert '主航线总计投入：50 分' in refreshed['gpt_prompt_text']


def test_adjacent_seconds_and_real_overlap(tmp_path):
    client = client_for(tmp_path)
    day = date.today() - timedelta(days=1)
    task = plan_for(client, day)['tasks'][0]
    record(client, day, task, '10:30:12', '10:35:40')
    middle = record(client, day, task, '10:35:40', '10:45:22')
    record(client, day, task, '10:45:22', '10:50:10')
    data = {'task_id': task['id'], 'segment_kind': 'effective', 'label_id': 'effective_math_course',
            'started_at': middle['started_at'], 'ended_at': middle['ended_at']}
    response = client.put(f"/api/daily-execution/{day}/segments/{middle['id']}", json=data)
    assert response.status_code == 200
    saved = next(s for s in response.json()['segments'] if s['id'] == middle['id'])
    assert saved['started_at'].endswith('10:35:40')
    assert saved['ended_at'].endswith('10:45:22')
    data['started_at'] = f'{day}T10:35:00'
    assert client.put(f"/api/daily-execution/{day}/segments/{middle['id']}", json=data).status_code == 409


def test_future_and_draft_do_not_inflate_week_statistics(tmp_path):
    client = client_for(tmp_path)
    today = date.today()
    future = today + timedelta(days=1)
    task = plan_for(client, future)['tasks'][0]
    record(client, future, task, '09:00:00', '09:30:00')
    week = client.get(f'/api/weekly-review?anchor_date={future}').json()
    assert week['actual_minutes'] == 0
    assert week['task_count'] == 0


def test_replacement_day_setting_preserves_records_and_other_settings(tmp_path):
    client = client_for(tmp_path)
    day = date.today() - timedelta(days=1)
    task = plan_for(client, day)['tasks'][0]
    record(client, day, task, '09:00:00', '09:30:00')
    settings = client.get('/api/settings').json()
    settings.update(weekly_review_mode='replace_day', weekly_review_day=2)
    assert client.put('/api/settings', json=settings).status_code == 200
    assert client.get('/api/settings').json()['weekly_review_day'] == 2
    for key in ['weekly_review_mode', 'weekly_review_day']:
        settings.pop(key)
    saved = client.put('/api/settings', json=settings).json()
    assert saved['weekly_review_mode'] == 'replace_day'
    assert saved['weekly_review_day'] == 2
    assert client.get(f'/api/weekly-review?anchor_date={day}').json()['actual_minutes'] == 30
    settings['weekly_review_day'] = 7
    assert client.put('/api/settings', json=settings).status_code == 422


def test_edit_cannot_extend_into_an_active_segment(tmp_path):
    from datetime import datetime
    client = client_for(tmp_path)
    day = date.today()
    task = plan_for(client, day)['tasks'][0]
    started = client.post(f'/api/daily-execution/{day}/tasks/start', json={'task_id': task['id']}).json()['active_segment']['started_at']
    boundary = datetime.fromisoformat(started)
    segment = record(client, day, task, (boundary - timedelta(minutes=1)).time().isoformat(), boundary.time().isoformat())
    body = {'task_id': task['id'], 'segment_kind': 'effective',
            'started_at': segment['started_at'], 'ended_at': (boundary + timedelta(seconds=1)).isoformat()}
    assert client.put(f"/api/daily-execution/{day}/segments/{segment['id']}", json=body).status_code == 409


def test_saved_empty_review_has_same_completion_state_in_calendar_and_navigation(tmp_path):
    client = client_for(tmp_path)
    day = date.today()
    assert client.post('/api/daily-reviews', json={'date': str(day), 'effective_method': '', 'tomorrow_focus': ''}).status_code == 200
    progress = client.get(f'/api/weekly-review?anchor_date={day}').json()['weekday_progress']
    assert next(item for item in progress['days'] if item['date'] == str(day))['has_review']
    calendar = client.get(f'/api/calendar-status?month={day:%Y-%m}').json()
    assert next(item for item in calendar['days'] if item['date'] == str(day))['status'] == 'reviewed'


def test_week_boundaries_across_year_and_month_keep_both_ends(tmp_path):
    for anchor, start, end in [('2026-01-01', '2025-12-29', '2026-01-04'),
                               ('2026-09-30', '2026-09-28', '2026-10-04')]:
        client = client_for(tmp_path)
        for day in [start, end]:
            task = plan_for(client, day)['tasks'][0]
            record(client, day, task, '09:00:00', '09:10:00')
        week = client.get(f'/api/weekly-review?anchor_date={anchor}').json()
        assert (week['start_date'], week['end_date']) == (start, end)
        assert len(week['days']) == 7
        assert week['actual_minutes'] == week['total_minutes'] == 20
        assert week['task_count'] == 2
