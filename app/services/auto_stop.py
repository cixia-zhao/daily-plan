"""持久化单次自动停止；服务端按截止时刻结算，不依赖网页存活。"""
from datetime import datetime, timedelta, timezone

from ..database import connect
from .reminders import cancel_reminders


def settle_due(connection, now=None):
    now = now or datetime.now(timezone.utc)
    closed = []
    rows = connection.execute('SELECT id,task_id,started_at,auto_stop_at FROM task_execution_segments WHERE ended_at IS NULL AND auto_stop_at IS NOT NULL').fetchall()
    for row in rows:
        due = datetime.fromisoformat(row['auto_stop_at'])
        if due.tzinfo is None:
            due = due.replace(tzinfo=timezone(timedelta(hours=8)))
        if due <= now:
            connection.execute('UPDATE task_execution_segments SET ended_at=auto_stop_at,stopped_automatically=1 WHERE id=? AND ended_at IS NULL', (row['id'],))
            cancel_reminders(connection, row['id'])
            closed.append(row['task_id'])
    if closed:
        # 统计仍使用现有统一口径；运行时导入避免应用初始化循环。
        from ..api import _sync_plan_actual_minutes_from_execution
        for task_id in set(closed):
            row = connection.execute('SELECT plan_id FROM tasks WHERE id=?', (task_id,)).fetchone()
            if row:
                _sync_plan_actual_minutes_from_execution(connection, row['plan_id'])
    return len(closed)


def dispatch_auto_stops(database_path, *, now=None):
    with connect(database_path) as connection:
        connection.execute('BEGIN IMMEDIATE')
        return settle_due(connection, now)
