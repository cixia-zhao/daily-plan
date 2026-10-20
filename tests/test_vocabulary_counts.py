"""词数是每日累计记录，不折算时长；仅使用临时库。"""
import json
import sqlite3
from datetime import date, timedelta

import pytest
from test_review_workspace import client_for, plan_for


def test_counts_without_plan_overwrite_dates_and_remove(tmp_path):
    client=client_for(tmp_path); day=str(date.today()); other=str(date.today()-timedelta(days=1))
    path=f'/api/vocabulary-counts/{day}'
    assert client.get(path).json()['vocabulary_counts'] is None
    for new, review in [(20,100),(30,150),(0,0)]:
        result=client.put(path,json={'new_words':new,'review_words':review})
        assert result.status_code==200, result.text
        counts=result.json()['vocabulary_counts']
        assert counts['new_words']==new and counts['review_words']==review and counts['updated_at']
        state=client.get(f'/api/daily-execution/{day}').json()
        assert state['plan'] is None and not state['segments']
    client.put(f'/api/vocabulary-counts/{other}',json={'new_words':7,'review_words':8})
    assert client.get(f'/api/vocabulary-counts/{other}').json()['vocabulary_counts']['new_words']==7
    assert client.delete(path).status_code==200
    assert client.get(path).json()['vocabulary_counts'] is None
    with sqlite3.connect(client.app.state.database_path) as db:
        assert db.execute('SELECT COUNT(*) FROM vocabulary_daily_counts').fetchone()==(1,)
        assert db.execute('SELECT COUNT(*) FROM tasks').fetchone()==(0,)
        assert db.execute('SELECT COUNT(*) FROM task_duration_records').fetchone()==(0,)


@pytest.mark.parametrize('value',[-1,1.5,True,'20',10001,None])
def test_count_validation_preserves_saved_values(tmp_path,value):
    client=client_for(tmp_path); path=f'/api/vocabulary-counts/{date.today()}'
    client.put(path,json={'new_words':20,'review_words':100})
    for field in ['new_words','review_words']:
        body={'new_words':30,'review_words':150,field:value}
        assert client.put(path,json=body).status_code==422
    assert client.get(path).json()['vocabulary_counts']['new_words']==20


def test_counts_do_not_modify_timer_minutes_or_vocabulary_sources(tmp_path):
    client=client_for(tmp_path); day=str(date.today()); task=plan_for(client,day)['tasks'][0]
    manual=client.post(f'/api/daily-execution/{day}/vocabulary',json={'minutes':10}).json()
    active=client.post(f'/api/daily-execution/{day}/tasks/start',json={'task_id':task['id']}).json()['active_segment']
    assert client.put(f'/api/vocabulary-counts/{day}',json={'new_words':20,'review_words':100}).status_code==200
    result=client.get(f'/api/daily-execution/{day}').json()
    assert result['active_segment']['id']==active['id']
    assert result['duration_records']==manual['duration_records']
    assert len(result['segments'])==1
    day_result=client.get(f'/api/daily-review/{day}')
    assert day_result.status_code==200, day_result.text
    payload=day_result.json()
    assert payload['vocabulary_counts']['new_words']==20
    assert payload['vocabulary_minutes']==payload['english_minutes']==10


def test_count_only_reset_restore_and_old_snapshot(tmp_path):
    client=client_for(tmp_path); day=str(date.today()); path=f'/api/vocabulary-counts/{day}'
    client.put(path,json={'new_words':20,'review_words':100})
    reset=client.delete(f'/api/daily-data/{day}').json()['reset_snapshot']
    assert reset['counts']['vocabulary_counts']==1
    assert client.get(path).json()['vocabulary_counts'] is None
    assert client.post(f"/api/daily-data/{day}/reset-snapshots/{reset['id']}/restore").status_code==200
    assert client.get(path).json()['vocabulary_counts']['review_words']==100
    reset=client.delete(f'/api/daily-data/{day}').json()['reset_snapshot']
    with sqlite3.connect(client.app.state.database_path) as db:
        raw=json.loads(db.execute('SELECT snapshot_json FROM daily_reset_snapshots WHERE id=?',(reset['id'],)).fetchone()[0])
        raw.pop('vocabulary_daily_counts')
        db.execute('UPDATE daily_reset_snapshots SET snapshot_json=? WHERE id=?',(json.dumps(raw),reset['id']))
    assert client.post(f"/api/daily-data/{day}/reset-snapshots/{reset['id']}/restore").status_code==200
    assert client.get(path).json()['vocabulary_counts'] is None


def test_counts_migrate_backup_without_changing_old_tables(tmp_path):
    from app.database import initialize
    source=tmp_path/'old.db';target=tmp_path/'copy.db'
    initialize(source)
    with sqlite3.connect(source) as db:
        db.execute('DROP TABLE vocabulary_daily_counts')
        db.execute("INSERT INTO reviews(review_date,effective_method,tomorrow_focus) VALUES('2026-10-01','原方法','原计划')")
        db.commit()
        old={name:(db.execute(f'PRAGMA table_info("{name}")').fetchall(),db.execute(f'SELECT * FROM "{name}"').fetchall()) for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        with sqlite3.connect(target) as copy:db.backup(copy)
    initialize(target);initialize(target)
    with sqlite3.connect(target) as db:
        for name,(columns,rows) in old.items():
            assert db.execute(f'PRAGMA table_info("{name}")').fetchall()==columns
            assert db.execute(f'SELECT * FROM "{name}"').fetchall()==rows
        assert db.execute('SELECT COUNT(*) FROM vocabulary_daily_counts').fetchone()==(0,)
        assert db.execute('PRAGMA integrity_check').fetchone()==('ok',)
        assert db.execute('PRAGMA foreign_key_check').fetchall()==[]


def test_count_only_history_before_project_start_remains_accessible(tmp_path):
    client=client_for(tmp_path)
    settings=client.get('/api/settings').json()
    assert client.put('/api/settings',json={**settings,'project_start_date':'2026-10-10'}).status_code==200
    assert client.put('/api/vocabulary-counts/2026-10-01',json={'new_words':20,'review_words':100}).status_code==200
    days=client.get('/api/calendar-status?month=2026-10').json()['days']
    assert next(d for d in days if d['date']=='2026-10-01')['visibility']=='in_range'
