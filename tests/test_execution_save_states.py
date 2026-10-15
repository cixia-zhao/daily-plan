"""记录与复盘的保存状态独立于旧提交状态，测试只用临时数据库。"""
from datetime import date, timedelta

from fastapi.testclient import TestClient

from app.main import create_app


def test_saved_execution_and_review_are_independent(tmp_path):
    client = TestClient(create_app(database_path=tmp_path / 'states.db', disable_ai=True))
    day = str(date.today() - timedelta(days=1))
    state = lambda: client.get(f'/api/daily-execution/{day}').json()
    assert state()['has_execution'] is False
    assert state()['has_review'] is False
    draft = client.post('/api/daily-plans/draft', json={'date':day, 'energy':'normal', 'day_type':'normal'}).json()
    client.post(f'/api/daily-plans/{day}/approve')
    assert state()['has_execution'] is False  # 计划不等于执行记录。
    task = draft['tasks'][0]
    response = client.post(f'/api/daily-execution/{day}/segments', json={
        'task_id':task['id'], 'segment_kind':'effective',
        'started_at':f'{day}T09:00:00', 'ended_at':f'{day}T09:00:20',
    })
    assert response.status_code == 200
    assert state()['has_execution'] is True  # 小于一分钟也是真实记录。
    assert state()['plan']['status'] == 'approved'
    review = client.get(f'/api/daily-review/{day}').json()
    assert review['has_execution'] is True and review['has_review'] is False
    week = client.get(f'/api/weekly-review?anchor_date={day}').json()
    assert week['actual_seconds'] == 20  # 无须提交即可计入。
    client.post('/api/daily-reviews', json={'date':day, 'effective_method':'', 'mood':'平稳', 'tomorrow_focus':'继续学习'})
    assert state()['has_execution'] is True and state()['has_review'] is True
    segment = state()['segments'][0]
    client.delete(f"/api/daily-execution/{day}/segments/{segment['id']}")
    assert state()['has_execution'] is False and state()['has_review'] is True


def test_only_review_does_not_claim_learning_records_saved(tmp_path):
    client = TestClient(create_app(database_path=tmp_path / 'review.db', disable_ai=True))
    day = str(date.today())
    assert client.post('/api/daily-reviews', json={'date':day, 'effective_method':'', 'mood':'平稳', 'tomorrow_focus':'今天休息'}).status_code == 200
    for path in [f'/api/daily-execution/{day}', f'/api/daily-review/{day}']:
        result = client.get(path).json()
        assert result['has_review'] is True and result['has_execution'] is False
