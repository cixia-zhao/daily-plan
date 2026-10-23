"""执行只处理今天，旧历史地址安全地进入复盘记录。"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from test_review_workspace import client_for, plan_for, record


def test_history_execution_redirect_keeps_saved_records(tmp_path):
    client = client_for(tmp_path)
    day = datetime.now(ZoneInfo('Asia/Shanghai')).date() - timedelta(days=1)
    task = plan_for(client, day)['tasks'][0]
    record(client, day, task, '08:00:00', '08:20:00')
    before = client.get(f'/api/daily-execution/{day}').json()['segments']
    response = client.get(f'/execute?date={day}', follow_redirects=False)
    assert response.status_code == 303
    assert response.headers['location'] == f'/review?date={day}&records=1'
    assert client.get(response.headers['location']).status_code == 200
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
