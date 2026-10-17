"""一句成果只使用临时库；旧正文和旧客户端不得丢失成果。"""
from datetime import date
import json
import sqlite3

from app.database import initialize
from test_review_workspace import client_for


def test_outcome_optional_daily_weekly_and_legacy_save(tmp_path):
    client = client_for(tmp_path)
    day = str(date.today())
    payload = {'date': day, 'effective_method': '先列目标', 'tomorrow_focus': '',
               'reflection_text': '原复盘正文', 'learning_outcome': '线代第二讲完成，错题归纳3条'}
    assert client.post('/api/daily-reviews', json=payload).status_code == 200
    daily = client.get(f'/api/daily-review/{day}').json()
    assert daily['review']['learning_outcome'] == payload['learning_outcome']
    assert daily['review']['reflection_text'] == '原复盘正文'
    assert payload['learning_outcome'] in daily['gpt_prompt_text']
    weekly = client.get(f'/api/weekly-review?anchor_date={day}').json()
    assert payload['learning_outcome'] in weekly['gpt_prompt_text']
    assert next(item for item in weekly['days'] if item['date'] == day)['review']['learning_outcome'] == payload['learning_outcome']
    del payload['learning_outcome']
    payload['reflection_text'] = '旧客户端修改正文'
    assert client.post('/api/daily-reviews', json=payload).status_code == 200
    assert client.get(f'/api/daily-review/{day}').json()['review']['learning_outcome'] == '线代第二讲完成，错题归纳3条'
    payload['learning_outcome'] = ''
    assert client.post('/api/daily-reviews', json=payload).status_code == 200
    assert client.get(f'/api/daily-review/{day}').json()['review']['learning_outcome'] == ''
    payload['learning_outcome'] = '学' * 301
    assert client.post('/api/daily-reviews', json=payload).status_code == 422


def test_outcome_reset_restore_and_old_snapshot(tmp_path):
    client = client_for(tmp_path)
    day = str(date.today())
    assert client.post('/api/daily-reviews', json={
        'date': day, 'effective_method': '', 'tomorrow_focus': '', 'learning_outcome': '读完第4章',
    }).status_code == 200
    reset = client.delete(f'/api/daily-data/{day}').json()['reset_snapshot']
    assert client.post(f"/api/daily-data/{day}/reset-snapshots/{reset['id']}/restore").status_code == 200
    assert client.get(f'/api/daily-review/{day}').json()['review']['learning_outcome'] == '读完第4章'
    reset = client.delete(f'/api/daily-data/{day}').json()['reset_snapshot']
    with sqlite3.connect(client.app.state.database_path) as db:
        raw = db.execute('SELECT snapshot_json FROM daily_reset_snapshots WHERE id=?', (reset['id'],)).fetchone()[0]
        snapshot = json.loads(raw)
        del snapshot['reviews'][0]['learning_outcome']
        db.execute('UPDATE daily_reset_snapshots SET snapshot_json=? WHERE id=?', (json.dumps(snapshot), reset['id']))
    assert client.post(f"/api/daily-data/{day}/reset-snapshots/{reset['id']}/restore").status_code == 200
    assert client.get(f'/api/daily-review/{day}').json()['review']['learning_outcome'] == ''


def test_outcome_migrates_backup_twice_without_changing_old_values(tmp_path):
    source = tmp_path / 'old.db'
    with sqlite3.connect(source) as db:
        db.execute("CREATE TABLE reviews(review_date TEXT PRIMARY KEY,distraction TEXT NOT NULL DEFAULT '',effective_method TEXT NOT NULL,tomorrow_focus TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
        db.execute("INSERT INTO reviews(review_date,distraction,effective_method,tomorrow_focus) VALUES('2026-10-10','旧分心','旧方法','旧计划')")
        columns = [r[1] for r in db.execute('PRAGMA table_info(reviews)')]
        values = db.execute('SELECT * FROM reviews').fetchall()
        with sqlite3.connect(tmp_path / 'backup.db') as backup:
            db.commit()
            db.backup(backup)
    initialize(tmp_path / 'backup.db')
    initialize(tmp_path / 'backup.db')
    with sqlite3.connect(tmp_path / 'backup.db') as db:
        assert db.execute(f'SELECT {",".join(columns)} FROM reviews').fetchall() == values
        assert db.execute('SELECT learning_outcome FROM reviews').fetchone() == ('',)
        assert db.execute('PRAGMA integrity_check').fetchone() == ('ok',)
        assert db.execute('PRAGMA foreign_key_check').fetchall() == []
    with sqlite3.connect(source) as db:
        assert [r[1] for r in db.execute('PRAGMA table_info(reviews)')] == columns
