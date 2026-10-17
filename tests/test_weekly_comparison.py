"""同期比较只读取临时数据，覆盖半周、整周、边界与零基数。"""
from datetime import date, timedelta
import sqlite3

import pytest
import app.api as api_module
from test_review_workspace import client_for, plan_for, record


def set_today(monkeypatch, value):
    class FixedDate(date):
        @classmethod
        def __get_pydantic_core_schema__(cls, source, handler):
            return handler(date)

        @classmethod
        def today(cls):
            return date.fromisoformat(value)
    monkeypatch.setattr(api_module, 'date', FixedDate)


@pytest.mark.parametrize('today', ['2026-10-14', '2026-01-01', '2026-10-12', '2026-10-18'])
def test_current_week_compares_only_same_weekdays(tmp_path, monkeypatch, today):
    set_today(monkeypatch, today)
    current = date.fromisoformat(today)
    monday = current - timedelta(days=current.weekday())
    client = client_for(tmp_path)
    for day, minutes in [(monday, 20), (monday-timedelta(days=7), 10)]:
        tasks = plan_for(client, day)['tasks']
        record(client, day, tasks[0], '09:00:00', f'09:{minutes:02}:00')
        record(client, day, tasks[0], '10:00:00', '10:05:00', 'counted_label', 'counted_game')
        record(client, day, next(t for t in tasks if t['is_sub']), '11:00:00', '11:40:00')
    if current.weekday() < 6:
        # 上周后半周和本周未来记录均不能混入同期比较。
        for day in [current + timedelta(days=1), current - timedelta(days=6)]:
            task = plan_for(client, day)['tasks'][0]
            record(client, day, task, '09:00:00', '10:00:00')
    response = client.get(f'/api/weekly-review?anchor_date={monday+timedelta(days=6)}')
    assert response.status_code == 200, response.text
    comparison = response.json()['comparison']
    assert comparison['in_progress']
    assert comparison['through_date'] == today
    assert comparison['previous_end_date'] == str(current-timedelta(days=7))
    assert comparison['current_seconds'] == 25*60
    assert comparison['previous_seconds'] == 15*60
    assert comparison['difference_seconds'] == 600
    assert comparison['change_ratio'] == 0.6667
    # 普通读取既不生成报告也不请求 AI。
    with sqlite3.connect(client.app.state.database_path) as connection:
        assert connection.execute('SELECT count(*) FROM weekly_reports').fetchone()[0] == 0


def test_historical_week_uses_complete_previous_week_and_no_zero_division(tmp_path, monkeypatch):
    set_today(monkeypatch, '2026-10-14')
    client = client_for(tmp_path)
    for day, minutes in [('2026-10-04',10),('2026-10-11',20)]:
        record(client, day, plan_for(client, day)['tasks'][0], '09:00:00', f'09:{minutes:02}:00')
    result = client.get('/api/weekly-review?anchor_date=2026-10-07').json()['comparison']
    assert not result['in_progress']
    assert (result['start_date'], result['through_date']) == ('2026-10-05','2026-10-11')
    assert (result['previous_start_date'], result['previous_end_date']) == ('2026-09-28','2026-10-04')
    assert result['change_ratio'] == 1
    empty = client.get('/api/weekly-review?anchor_date=2026-09-21').json()['comparison']
    assert empty['previous_seconds'] == 0 and empty['change_ratio'] is None
    future = client.get('/api/weekly-review?anchor_date=2026-10-26').json()['comparison']
    assert not future['available']


def test_comparison_preserves_seconds_and_excludes_drafts(tmp_path, monkeypatch):
    set_today(monkeypatch, '2026-10-14')
    client = client_for(tmp_path)
    for day in ['2026-10-05','2026-10-12']:
        record(client, day, plan_for(client, day)['tasks'][0], '09:00:00', '09:00:50')
    with sqlite3.connect(client.app.state.database_path) as db:
        db.execute("UPDATE plans SET status='draft' WHERE plan_date='2026-10-12'")
    result=client.get('/api/weekly-review?anchor_date=2026-10-14').json()['comparison']
    assert result['current_seconds'] == 0
    assert result['previous_seconds'] == 50
    assert result['difference_seconds'] == -50 and result['change_ratio'] == -1
