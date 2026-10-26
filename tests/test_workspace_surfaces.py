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
