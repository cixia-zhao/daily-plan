"""持久化单次自动停止；服务端按截止时刻结算，不依赖网页存活。"""
from __future__ import annotations

from datetime import datetime, timezone

from ..database import connect
from .clock import parse_iso_datetime
from .reminders import cancel_reminders


def _has_due_candidate(database_path, now: datetime) -> bool:
    with connect(database_path) as connection:
        rows = connection.execute(
            "SELECT auto_stop_at FROM task_execution_segments WHERE ended_at IS NULL AND auto_stop_at IS NOT NULL"
        ).fetchall()
    for row in rows:
        due = parse_iso_datetime(row["auto_stop_at"])
        if due is not None and due <= now:
            return True
    return False


def settle_due(connection, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    closed: list[int] = []
    rows = connection.execute(
        "SELECT id,task_id,started_at,auto_stop_at FROM task_execution_segments "
        "WHERE ended_at IS NULL AND auto_stop_at IS NOT NULL"
    ).fetchall()
    for row in rows:
        due = parse_iso_datetime(row["auto_stop_at"])
        if due is not None and due <= now:
            connection.execute(
                "UPDATE task_execution_segments SET ended_at=auto_stop_at,stopped_automatically=1 "
                "WHERE id=? AND ended_at IS NULL",
                (row["id"],),
            )
            cancel_reminders(connection, row["id"])
            closed.append(row["task_id"])
    if closed:
        from .execution_engine import sync_plan_tasks_to_db

        plan_ids = {
            plan_row["plan_id"]
            for task_id in set(closed)
            if (plan_row := connection.execute("SELECT plan_id FROM tasks WHERE id=?", (task_id,)).fetchone())
        }
        for plan_id in plan_ids:
            sync_plan_tasks_to_db(connection, plan_id)
    return len(closed)


def dispatch_auto_stops(database_path, *, now: datetime | None = None) -> int:
    effective_now = now or datetime.now(timezone.utc)
    # 空闲后台轮询与写请求先只读探测，无到期项时不获取写锁。
    if not _has_due_candidate(database_path, effective_now):
        return 0
    with connect(database_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        return settle_due(connection, effective_now)
