"""自由主项目只影响以后生成；验证稳定身份及旧日期不被修改。"""
from datetime import date,timedelta
import sqlite3
import pytest
from test_review_workspace import client_for,plan_for,record


def set_projects(client, categories, titles=None, minutes=None):
    settings=client.get('/api/settings').json()
    return client.put('/api/settings',json={**settings,'main_project_categories':categories,
        'task_titles':{**settings['task_titles'],**(titles or {})},
        'draft_main_minutes_by_category':{**settings['draft_main_minutes_by_category'],**(minutes or {})}})


def test_custom_project_full_lifecycle_order_and_history_unchanged(tmp_path):
    client=client_for(tmp_path);old_day=date.today()-timedelta(days=1)
    old_plan=plan_for(client,old_day);old_math=next(t for t in old_plan['tasks'] if t['category']=='math')
    record(client,old_day,old_math,'09:00:00','09:15:00')
    with sqlite3.connect(client.app.state.database_path) as db:
        before={name:db.execute(f'SELECT * FROM {name}').fetchall() for name in ['plans','tasks','task_execution_segments']}
    category='custom_guitar';r=set_projects(client,[category,'english','math','rehab'],{category:'吉他'},{category:45})
    assert r.status_code==200,r.text
    with sqlite3.connect(client.app.state.database_path) as db:
        for name,rows in before.items():assert db.execute(f'SELECT * FROM {name}').fetchall()==rows
    day=str(date.today());r=client.post('/api/daily-plans/draft',json={'date':day,'energy':'normal','day_type':'normal','target_minutes':{category:60}})
    assert r.status_code==201,r.text
    plan=r.json();main=[t for t in plan['tasks'] if not t['is_sub']]
    assert [t['category'] for t in main]==[category,'english','math','rehab']
    assert not any(t['category']=='computer' for t in plan['tasks'])
    guitar=main[0];assert guitar['title']=='吉他' and guitar['estimated_minutes']==60
    # 自定义清单可保存，不再强制塞入三门考试科目。
    editable=[{k:v for k,v in task.items() if k in {'id','title','category','estimated_minutes','priority','completion_criteria','reason','source','task_type','sub_category','is_sub'}} for task in plan['tasks']]
    saved=client.put(f'/api/daily-plans/{day}',json={'tasks':editable});assert saved.status_code==200,saved.text
    plan=client.get(f'/api/daily-plans/{day}').json();guitar=next(t for t in plan['tasks'] if t['category']==category)
    assert client.post(f'/api/daily-plans/{day}/approve').status_code==200
    label=client.post(f'/api/settings/effective-labels/{category}',json={'name':'练习曲'});assert label.status_code==201,label.text
    record(client,day,guitar,'10:00:00','10:20:00')
    record(client,day,guitar,'11:00:00','11:50:00','counted_label','counted_game')
    active=client.post(f'/api/daily-execution/{day}/tasks/start',json={'task_id':guitar['id']})
    assert active.status_code==200,active.text
    assert client.post(f'/api/daily-execution/{day}/stop').status_code==200
    review=client.get(f'/api/daily-review/{day}').json()
    assert any(t['category']==category and t['effective_minutes']>=20 for t in review['task_execution_board'])
    assert not next(t for t in client.get(f'/api/daily-plans/{day}').json()['tasks'] if t['category']==category)['completed']
    week=client.get(f'/api/weekly-review?anchor_date={day}').json()
    assert any(t['category']==category for t in week['task_distribution'])
    assert set_projects(client,['english','math']).status_code==200
    saved=client.get(f'/api/daily-plans/{day}').json();assert any(t['id']==guitar['id'] for t in saved['tasks'])
    assert client.get('/api/settings').json()['task_titles'][category]=='吉他'


def test_custom_defaults_suggestions_and_legacy_settings(tmp_path):
    client=client_for(tmp_path);category='custom_music'
    r=set_projects(client,[category],{category:'练琴'},{category:35});assert r.status_code==200,r.text
    day=date.today()-timedelta(days=1)
    draft=client.post('/api/daily-plans/draft',json={'date':str(day),'energy':'normal','day_type':'normal'}).json()
    assert draft['tasks'][0]['estimated_minutes']==35
    assert client.get(f'/api/target-suggestions?before_date={date.today()}').json()['categories']=={category:[35]}
    old=client.get('/api/settings').json();old.pop('main_project_categories')
    assert client.put('/api/settings',json=old).json()['main_project_categories']==[category]


@pytest.mark.parametrize('categories,titles',[
    ([],{}),(['math','math'],{}),(['unknown'],{}),(['custom_x'],{'custom_x':' '}),
    ([f'custom_{i}' for i in range(12)],{f'custom_{i}':str(i) for i in range(12)})])
def test_invalid_project_settings_leave_saved_settings(tmp_path,categories,titles):
    client=client_for(tmp_path);before=client.get('/api/settings').json()
    assert set_projects(client,categories,titles).status_code==422
    assert client.get('/api/settings').json()==before
