"""按日重置快照；调用方持有同一写事务，快照和清空共同提交。"""
from __future__ import annotations

import json

from fastapi import HTTPException


# 仅允许固定业务表，不能由请求指定表名或恢复整个数据库。
TABLE_ORDER = ('plans', 'tasks', 'task_execution_segments', 'execution_quick_corrections', 'task_duration_records', 'carryovers', 'reviews', 'vocabulary_daily_counts')


def capture_day(connection, plan_date: str) -> dict:
    def select(sql, params):
        return [dict(row) for row in connection.execute(sql, params)]
    data = {
        'plans': select('SELECT * FROM plans WHERE plan_date=?', (plan_date,)),
        'tasks': select('SELECT t.* FROM tasks t JOIN plans p ON p.id=t.plan_id WHERE p.plan_date=?', (plan_date,)),
        'reviews': select('SELECT * FROM reviews WHERE review_date=?', (plan_date,)),
        'vocabulary_daily_counts': select('SELECT * FROM vocabulary_daily_counts WHERE plan_date=?', (plan_date,)),
        'execution_quick_corrections': select('SELECT * FROM execution_quick_corrections WHERE plan_date=?', (plan_date,)),
    }
    for table in ('task_execution_segments', 'task_duration_records', 'carryovers'):
        data[table] = select(f'SELECT r.* FROM {table} r JOIN tasks t ON t.id=r.task_id JOIN plans p ON p.id=t.plan_id WHERE p.plan_date=?', (plan_date,))
    return data


def snapshot_metadata(row) -> dict:
    data = json.loads(row['snapshot_json'])
    return {
        'id': row['id'], 'date': row['plan_date'], 'created_at': row['created_at'],
        'counts': {name: len(data.get(table, [])) for name, table in (
            ('tasks','tasks'), ('segments','task_execution_segments'), ('durations','task_duration_records'),
            ('carryovers','carryovers'), ('reviews','reviews'), ('vocabulary_counts','vocabulary_daily_counts'))},
    }


def save_reset_snapshot(connection, plan_date: str, reset_at: str) -> dict | None:
    data = capture_day(connection, plan_date)
    if not any(data.values()):
        return None
    cursor = connection.execute(
        'INSERT INTO daily_reset_snapshots(plan_date,created_at,snapshot_json) VALUES(?,?,?)',
        (plan_date, reset_at, json.dumps(data,ensure_ascii=False)),
    )
    return snapshot_metadata(connection.execute('SELECT * FROM daily_reset_snapshots WHERE id=?', (cursor.lastrowid,)).fetchone())


def restore_snapshot(connection, plan_date: str, snapshot_id: int, restored_at: str, check_overlap) -> dict:
    row = connection.execute('SELECT * FROM daily_reset_snapshots WHERE id=? AND plan_date=?', (snapshot_id,plan_date)).fetchone()
    if not row:
        raise HTTPException(404, '重置快照不存在')
    if row['restored_at'] is not None:
        raise HTTPException(409, '这份快照已经恢复，请刷新页面')
    if any(capture_day(connection,plan_date).values()):
        raise HTTPException(409, '这一天已有新数据，已保留；请先处理新记录，恢复不会覆盖它们')
    data = json.loads(row['snapshot_json'])
    for segment in data['task_execution_segments']:
        # 原激活段只恢复到重置时刻，不能重新成为运行中的计时。
        segment['ended_at'] = segment['ended_at'] or row['created_at']
        check_overlap(connection,plan_date,segment['task_id'],segment['started_at'],segment['ended_at'])
    for table in TABLE_ORDER:
        for record in data.get(table, []):
            pk = 'review_date' if table == 'reviews' else 'plan_date' if table == 'vocabulary_daily_counts' else 'id'
            if connection.execute(f'SELECT 1 FROM {table} WHERE {pk}=?',(record[pk],)).fetchone():
                raise HTTPException(409, '恢复记录与现有记录冲突，未覆盖任何数据')
            columns = list(record)
            connection.execute(f'INSERT INTO {table} ({",".join(columns)}) VALUES({",".join("?" for _ in columns)})', tuple(record.values()))
    connection.execute('UPDATE daily_reset_snapshots SET restored_at=? WHERE id=?',(restored_at,snapshot_id))
    return {'date':plan_date,'restored':True,'message':'已恢复重置前的当日记录'}
