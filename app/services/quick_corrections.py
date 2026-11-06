"""快捷补记的相邻边界保护；调用方持有写事务。"""
from datetime import datetime, timedelta, timezone
import json

from fastapi import HTTPException


def _time(value):
    parsed = datetime.fromisoformat(value)
    return parsed.replace(tzinfo=timezone(timedelta(hours=8))) if parsed.tzinfo is None else parsed


def correction_neighbors(connection, segment):
    group = connection.execute(
        'SELECT * FROM execution_quick_corrections WHERE correction_segment_id=?', (segment['id'],)
    ).fetchone()
    if not group:
        raise HTTPException(409, '补记的关联记录已变化，请核对时间轴，原记录保留')
    left = connection.execute('SELECT * FROM task_execution_segments WHERE id=?', (group['source_segment_id'],)).fetchone()
    right = connection.execute('SELECT * FROM task_execution_segments WHERE id=?', (group['continuation_segment_id'],)).fetchone()
    if not left or not right or any(row['segment_kind'] != 'effective' or row['task_id'] != segment['task_id'] or not row['included'] for row in (left, right)):
        raise HTTPException(409, '相邻学习记录已变化，请核对时间轴，未覆盖其他活动')
    if left['ended_at'] != segment['started_at'] or right['started_at'] != segment['ended_at']:
        raise HTTPException(409, '相邻记录边界已变化，请先核对时间轴')
    return group, left, right


def resize_correction(connection, segment, payload, started_at, ended_at, now):
    operation = connection.execute('SELECT original_state_json FROM execution_quick_corrections WHERE correction_segment_id=?', (segment['id'],)).fetchone()
    if operation and operation['original_state_json']:
        raise HTTPException(409, '这段是回溯切换记录，请撤销本次修正后重新填写')
    group, left, right = correction_neighbors(connection, segment)
    if payload.task_id != segment['task_id'] or payload.segment_kind != segment['segment_kind'] or payload.label_id != segment['label_id'] or payload.time_category not in (None, segment['time_category']):
        raise HTTPException(422, '补记记录可修改起止时间；如需改类型或任务，请先撤销补记')
    start, end = _time(started_at), _time(ended_at)
    if start < _time(left['started_at']) or end > _time(right['ended_at'] or now):
        raise HTTPException(409, '补记不能越过相邻学习段或延伸到未来，原记录保留')
    connection.execute('UPDATE task_execution_segments SET ended_at=? WHERE id=?', (started_at, left['id']))
    connection.execute('UPDATE task_execution_segments SET started_at=? WHERE id=?', (ended_at, right['id']))


def undo_correction(connection, segment, now=None):
    operation = connection.execute('SELECT * FROM execution_quick_corrections WHERE correction_segment_id=?', (segment['id'],)).fetchone()
    if operation and operation['original_state_json']:
        return _undo_switch(connection, operation, now)
    group, left, right = correction_neighbors(connection, segment)
    # 保留片段ID，避免影响后续补记对这个有效段的关联；还原的是分类与分钟。
    connection.execute(
        "UPDATE task_execution_segments SET segment_kind='effective',time_category=?,label_id=?,label_name=?,is_estimated=0 WHERE id=?",
        (left['time_category'], left['label_id'], left['label_name'], segment['id']),
    )
    connection.execute('DELETE FROM execution_quick_corrections WHERE id=?', (group['id'],))


def _undo_switch(connection, operation, now):
    saved = json.loads(operation['original_state_json'])
    rows = {}
    for identity, expected in saved['expected'].items():
        row = connection.execute('SELECT * FROM task_execution_segments WHERE id=?', (int(identity),)).fetchone()
        if not row:
            raise HTTPException(409, '关联记录已变化，未覆盖其他活动')
        current = dict(row)
        # 之后主动停止可以撤销，但不能重新启动已经停止的计时。
        allowed_end = int(identity) == operation['continuation_segment_id'] and expected['ended_at'] is None
        if any(current.get(key) != value for key, value in expected.items() if not (allowed_end and key == 'ended_at')):
            raise HTTPException(409, '关联记录已修改，请先核对时间轴；原记录保留')
        rows[int(identity)] = current
    identities = tuple(rows)
    linked = connection.execute(
        f'SELECT 1 FROM execution_quick_corrections WHERE id<>? AND (source_segment_id IN ({",".join("?" for _ in identities)}) OR correction_segment_id IN ({",".join("?" for _ in identities)}) OR continuation_segment_id IN ({",".join("?" for _ in identities)}))',
        (operation['id'], *identities, *identities, *identities),
    ).fetchone()
    if linked:
        raise HTTPException(409, '后面还有关联修正，请先撤销后一次修正')
    original = saved['original']
    original['ended_at'] = rows[operation['continuation_segment_id']]['ended_at']
    if original.get('auto_stop_at') and now and _time(original['auto_stop_at']) <= _time(now):
        original['ended_at'] = original['ended_at'] or original['auto_stop_at']
        original['stopped_automatically'] = 1
        original['auto_stop_at'] = None
    connection.execute('DELETE FROM execution_quick_corrections WHERE id=?', (operation['id'],))
    connection.execute('DELETE FROM task_execution_segments WHERE id IN (?,?)', (operation['correction_segment_id'], operation['continuation_segment_id']))
    columns = [row[1] for row in connection.execute('PRAGMA table_info(task_execution_segments)') if row[1] != 'id']
    connection.execute(f'UPDATE task_execution_segments SET {",".join(f"{key}=?" for key in columns)} WHERE id=?', (*[original[key] for key in columns], operation['source_segment_id']))
