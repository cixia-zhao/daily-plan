"""用户确认的有效率、分类快照和旧数据兼容，均使用临时库。"""
import sqlite3
from datetime import date, timedelta
from test_review_workspace import client_for, plan_for


def add(client, day, task, kind, label, start, end, category=None):
    body=dict(task_id=task['id'],segment_kind=kind,label_id=label,started_at=f'{day}T{start}',ended_at=f'{day}T{end}')
    if category: body['time_category']=category
    response=client.post(f'/api/daily-execution/{day}/segments',json=body)
    assert response.status_code==200,response.text
    return response.json()


def test_confirmed_learning_distraction_meal_example(tmp_path):
    client=client_for(tmp_path);day=str(date.today()-timedelta(days=1));task=plan_for(client,day)['tasks'][0]
    add(client,day,task,'effective',None,'09:00:00','10:00:00')
    add(client,day,task,'counted_label','counted_game','10:00:00','10:20:00','distraction')
    add(client,day,task,'interrupt_label','interrupt_meal','10:20:00','10:50:00','life')
    result=client.get(f'/api/daily-review/{day}').json();summary=result['time_summary']
    assert summary['categories']['learning']==3600
    assert summary['categories']['distraction']==1200
    assert summary['categories']['life']==1800
    assert summary['recorded_seconds']==6600
    assert summary['effective_ratio']==.75
    assert result['main_total_minutes']==80
    week=client.get(f'/api/weekly-review?anchor_date={day}').json()
    assert week['time_summary']==summary
    assert '生活活动' in result['gpt_prompt_text']


def test_rest_and_external_do_not_lower_efficiency_and_snapshot_survives_settings(tmp_path):
    client=client_for(tmp_path);day=str(date.today()-timedelta(days=1));task=plan_for(client,day)['tasks'][0]
    add(client,day,task,'effective',None,'09:00:00','10:00:00')
    add(client,day,task,'interrupt_label','interrupt_pause','10:00:00','10:10:00','rest')
    state=add(client,day,task,'interrupt_label','interrupt_incident','10:10:00','10:25:00','external')
    before=client.get(f'/api/daily-review/{day}').json()['time_summary']
    assert before['effective_ratio']==1 and before['categories']['rest']==600 and before['categories']['external']==900
    settings=client.get('/api/settings').json()
    for label in settings['execution_labels']:
        if label['id']=='interrupt_pause': label['time_category']='distraction'
    assert client.put('/api/settings',json=settings).status_code==200
    assert client.get(f'/api/daily-review/{day}').json()['time_summary']==before
    old=next(s for s in state['segments'] if s['label_id']=='interrupt_pause')
    response=client.put(f"/api/daily-execution/{day}/segments/{old['id']}",json=dict(task_id=task['id'],segment_kind=old['segment_kind'],label_id=old['label_id'],started_at=old['started_at'],ended_at=old['ended_at']))
    assert response.status_code==200,response.text
    assert next(s for s in response.json()['segments'] if s['id']==old['id'])['time_category']=='rest'


def test_legacy_records_keep_old_totals_and_unclassified_label(tmp_path):
    client=client_for(tmp_path);day=str(date.today()-timedelta(days=1));task=plan_for(client,day)['tasks'][0]
    with sqlite3.connect(client.app.state.database_path) as db:
        for kind,label,start,end in [('counted_label','counted_toilet','09:00:00','09:10:00'),('interrupt_label','interrupt_pause','09:10:00','09:20:00')]:
            db.execute('INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,label_id,label_name,started_at,ended_at) VALUES(?,?,?,?,?,?,?)',(day,task['id'],kind,label,'旧名称',f'{day}T{start}',f'{day}T{end}'))
    result=client.get(f'/api/daily-review/{day}').json()
    assert result['main_total_minutes']==10
    assert result['time_summary']['categories']['legacy_interrupt']==600
    assert result['time_summary']['recorded_seconds']==1200
    with sqlite3.connect(client.app.state.database_path) as db:
        assert db.execute('SELECT time_category FROM task_execution_segments').fetchall()==[(None,),(None,)]


def test_old_settings_client_cannot_erase_explicit_category(tmp_path):
    client=client_for(tmp_path);settings=client.get('/api/settings').json()
    next(label for label in settings['execution_labels'] if label['id']=='counted_game')['time_category']='rest'
    assert client.put('/api/settings',json=settings).status_code==200
    for label in settings['execution_labels']: label.pop('time_category',None)
    saved=client.put('/api/settings',json=settings).json()
    assert next(label for label in saved['execution_labels'] if label['id']=='counted_game')['time_category']=='rest'


def test_migration_runs_on_backup_copy_twice_without_changing_old_records(tmp_path):
    from app.database import initialize
    client=client_for(tmp_path);day=str(date.today()-timedelta(days=1));task=plan_for(client,day)['tasks'][0]
    add(client,day,task,'effective',None,'09:00:00','09:10:00')
    old=client.app.state.database_path
    with sqlite3.connect(old) as db:
        db.execute('DROP TABLE execution_reminders')
        db.execute('ALTER TABLE task_execution_segments DROP COLUMN time_category')
        names=[row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        original={table:([row[1] for row in db.execute(f'PRAGMA table_info({table})')],db.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall()) for table in names}
        with sqlite3.connect(tmp_path/'backup.db') as backup: db.backup(backup)
    copy=tmp_path/'backup.db'
    initialize(copy);initialize(copy)
    with sqlite3.connect(copy) as db:
        for table,(columns,rows) in original.items():
            assert db.execute(f'SELECT {",".join(columns)} FROM {table} ORDER BY rowid').fetchall()==rows
        assert db.execute('SELECT time_category FROM task_execution_segments').fetchall()==[(None,)]
        assert db.execute('SELECT count(*) FROM execution_reminders').fetchone()[0]==0
        assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not db.execute('PRAGMA foreign_key_check').fetchall()
    with sqlite3.connect(old) as db:
        assert 'time_category' not in [row[1] for row in db.execute('PRAGMA table_info(task_execution_segments)')]
