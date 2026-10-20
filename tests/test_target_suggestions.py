"""目标候选只读历史，自动化仅使用临时数据库。"""
from datetime import date,timedelta
import sqlite3

from test_review_workspace import client_for


def draft(client, day, math=0, english=0):
    r=client.post('/api/daily-plans/draft',json={'date':str(day),'energy':'normal','day_type':'normal','target_minutes':{'math':math,'english':english}})
    assert r.status_code==201,r.text
    return r.json()


def test_recent_targets_separate_categories_deduplicate_and_cap(tmp_path):
    client=client_for(tmp_path);today=date.today()
    for ago,minutes in [(1,135),(2,135),(3,240),(4,90),(5,180),(6,300)]:
        draft(client,today-timedelta(days=ago),minutes,20+ago)
    result=client.get(f'/api/target-suggestions?before_date={today}')
    assert result.status_code==200,result.text
    result=result.json()['categories']
    assert result['math']==[135,240,90,180]
    assert result['english']==[21,22,23,24]
    assert result['rehab']==[0]


def test_future_selected_and_subroute_not_used_and_read_does_not_write(tmp_path):
    client=client_for(tmp_path);today=date.today()
    draft(client,today-timedelta(days=1),135)
    draft(client,today,180)
    draft(client,today+timedelta(days=1),300)
    with sqlite3.connect(client.app.state.database_path) as db:
        db.execute("UPDATE tasks SET is_sub=1 WHERE category='math' AND estimated_minutes=135")
        before={name:db.execute(f'SELECT * FROM "{name}"').fetchall() for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    result=client.get(f'/api/target-suggestions?before_date={today+timedelta(days=2)}').json()['categories']
    assert result['math']==[180]
    assert client.get(f'/api/target-suggestions?before_date={today}').json()['categories']['math']==[]
    with sqlite3.connect(client.app.state.database_path) as db:
        for name,rows in before.items():assert db.execute(f'SELECT * FROM "{name}"').fetchall()==rows


def test_empty_and_invalid_date(tmp_path):
    client=client_for(tmp_path)
    assert all(not v for v in client.get(f'/api/target-suggestions?before_date={date.today()}').json()['categories'].values())
    assert client.get('/api/target-suggestions?before_date=not-a-date').status_code==422
