"""执行时间段状态机、重叠窗口校验、纯内存统计投影与按需落库服务。"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta

from fastapi import HTTPException

from app.schemas import TaskDraft, TemporaryTaskInput
from app.services.catalog import (
    MAX_DAILY_TASKS,
    VOCABULARY_WORD_LABEL_ID,
    counts_as_study_goal,
    default_task_type_for,
    is_vocabulary_word_segment,
)
from app.services.clock import local_iso, now_iso, parse_iso_datetime, seconds_between
from app.services.reminders import cancel_reminders, reminders_for_segments
from app.services.settings_store import (
    build_effective_label_map,
    build_execution_label_map,
    correction_activities,
    correction_shortcuts,
    get_settings,
    serialize_execution_labels,
)
from app.services.time_accounting import combine_summaries, counts_in_learning_session, label_category, time_summary


def record_seconds(record: dict) -> int:
    return max(0, int(record.get("seconds", (record.get("minutes") or 0) * 60)))


def serialize_task_row(row) -> dict:
    task = dict(row)
    task["task_type"] = task.get("task_type") or default_task_type_for(task["category"])
    task["completed"] = bool(task["completed"])
    task["is_sub"] = bool(task["is_sub"])
    if task.get("completion_override") is not None:
        task["completion_override"] = bool(task["completion_override"])
    return task


def serialize_plan_from_rows(plan, task_rows: list[dict]) -> dict:
    return {
        "id": plan["id"],
        "date": plan["plan_date"],
        "energy": plan["energy"],
        "available_minutes": plan["available_minutes"],
        "day_type": plan["day_type"],
        "status": plan["status"],
        "methods": json.loads(plan["methods_json"]),
        "safety_notice": plan["safety_notice"],
        "degraded_reason": plan["degraded_reason"],
        "tasks": [serialize_task_row(row) for row in task_rows],
    }


def serialize_plan(connection, plan_date: str) -> dict:
    plan = connection.execute("SELECT * FROM plans WHERE plan_date=?", (plan_date,)).fetchone()
    if not plan:
        raise HTTPException(404, "计划不存在")
    tasks = connection.execute("SELECT * FROM tasks WHERE plan_id=? ORDER BY position,id", (plan["id"],)).fetchall()
    return serialize_plan_from_rows(plan, [dict(row) for row in tasks])


def get_plan_row(connection, plan_date: str):
    return connection.execute("SELECT * FROM plans WHERE plan_date=?", (plan_date,)).fetchone()


def insert_tasks(connection, plan_id: int, tasks: list[TaskDraft], start_position: int = 0) -> list[int]:
    inserted_ids: list[int] = []
    for offset, task in enumerate(tasks):
        cursor = connection.execute(
            """INSERT INTO tasks(plan_id,title,category,estimated_minutes,priority,
               completion_criteria,reason,source,position,sub_category,is_sub,task_type)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                plan_id,
                task.title,
                task.category,
                task.estimated_minutes,
                task.priority,
                task.completion_criteria,
                task.reason,
                task.source,
                start_position + offset,
                task.sub_category,
                task.is_sub,
                task.task_type or default_task_type_for(task.category),
            ),
        )
        inserted_ids.append(int(cursor.lastrowid))
    return inserted_ids


def get_task_row_for_execution(connection, plan_date: str, task_id: int):
    row = connection.execute(
        """SELECT t.*, p.plan_date, p.status AS plan_status
           FROM tasks t JOIN plans p ON p.id=t.plan_id
           WHERE t.id=? AND p.plan_date=?""",
        (task_id, plan_date),
    ).fetchone()
    if not row:
        raise HTTPException(404, "任务不存在")
    if row["plan_status"] not in ("approved", "submitted"):
        raise HTTPException(409, "计划确认后才能开始执行记录")
    return row


def get_active_execution_segment(connection, plan_date: str | None = None):
    if plan_date:
        return connection.execute(
            """SELECT s.*, t.title AS task_title
               FROM task_execution_segments s
               JOIN tasks t ON t.id=s.task_id
               WHERE s.plan_date=? AND s.ended_at IS NULL
               ORDER BY s.started_at DESC, s.id DESC
               LIMIT 1""",
            (plan_date,),
        ).fetchone()
    return connection.execute(
        """SELECT s.*, t.title AS task_title
           FROM task_execution_segments s
           JOIN tasks t ON t.id=s.task_id
           WHERE s.ended_at IS NULL
           ORDER BY s.started_at DESC, s.id DESC
           LIMIT 1"""
    ).fetchone()


def serialize_execution_segment_row(row, *, reference_now: str | None = None) -> dict:
    ended_at = row["ended_at"]
    stopped_automatically = bool(row["stopped_automatically"])
    # 后台调度尚未落库时，读请求也必须按截止时刻显示停止状态，且不写数据库。
    if ended_at is None and row["auto_stop_at"]:
        due = parse_iso_datetime(row["auto_stop_at"])
        current = parse_iso_datetime(reference_now or now_iso())
        if due is not None and current is not None and due <= current:
            ended_at = row["auto_stop_at"]
            stopped_automatically = True
    seconds = seconds_between(row["started_at"], ended_at, reference_now=reference_now)
    return {
        "id": row["id"],
        "plan_date": row["plan_date"],
        "task_id": row["task_id"],
        "task_title": row["task_title"],
        "segment_kind": row["segment_kind"],
        "time_category": row["time_category"],
        "label_id": row["label_id"],
        "label_name": row["label_name"],
        "started_at": row["started_at"],
        "ended_at": ended_at,
        "minutes": seconds // 60,
        "seconds": seconds,
        "included": bool(row["included"]),
        "is_estimated": bool(row["is_estimated"]),
        "auto_stop_at": row["auto_stop_at"],
        "stopped_automatically": stopped_automatically,
    }


def list_execution_segments(connection, plan_date: str) -> list[dict]:
    rows = connection.execute(
        """SELECT s.*, t.title AS task_title
           FROM task_execution_segments s
           JOIN tasks t ON t.id=s.task_id
           WHERE s.plan_date=?
           ORDER BY s.started_at, s.id""",
        (plan_date,),
    ).fetchall()
    if not rows:
        return []
    ref_now = now_iso()
    reminder_map = reminders_for_segments(connection, [row["id"] for row in rows])
    return [
        serialize_execution_segment_row(row, reference_now=ref_now) | {"reminder": reminder_map.get(row["id"])}
        for row in rows
    ]


def list_duration_records(connection, plan_date: str) -> list[dict]:
    return [
        dict(row)
        for row in connection.execute(
            """SELECT r.*, t.title AS task_title FROM task_duration_records r
               JOIN tasks t ON t.id=r.task_id JOIN plans p ON p.id=t.plan_id
               WHERE p.plan_date=? ORDER BY r.id""",
            (plan_date,),
        ).fetchall()
    ]


def execution_records(connection, plan_date: str) -> list[dict]:
    records = list_execution_segments(connection, plan_date)
    records += [dict(row, segment_kind="effective") for row in list_duration_records(connection, plan_date)]
    return records


def prepare_execution_task(connection, task) -> None:
    if task["legacy_actual_minutes"] is None and not connection.execute(
        "SELECT 1 FROM task_execution_segments WHERE task_id=? UNION ALL SELECT 1 FROM task_duration_records WHERE task_id=?",
        (task["id"], task["id"]),
    ).fetchone():
        connection.execute(
            "UPDATE tasks SET legacy_actual_minutes=? WHERE id=?",
            (task["actual_minutes"] or 0, task["id"]),
        )


def effective_minutes_by_task(segments: list[dict]) -> dict[int, int]:
    totals: dict[int, int] = {}
    for segment in segments:
        if not segment.get("included", True) or segment["segment_kind"] != "effective":
            continue
        task_id = segment["task_id"]
        totals[task_id] = totals.get(task_id, 0) + record_seconds(segment)
    return {task: seconds // 60 for task, seconds in totals.items()}


def total_minutes_by_task(segments: list[dict]) -> dict[int, int]:
    totals: dict[int, int] = {}
    for segment in segments:
        if not segment.get("included", True) or not counts_in_learning_session(segment):
            continue
        task_id = segment["task_id"]
        totals[task_id] = totals.get(task_id, 0) + record_seconds(segment)
    return {task: seconds // 60 for task, seconds in totals.items()}


def compute_task_progress(task_rows: list, segments: list[dict]) -> list[dict]:
    """纯内存计算各任务的当前有效分钟与完成状态，供只读 GET 接口使用而不产生数据库写操作。"""
    eff_by_task = effective_minutes_by_task(segments)
    tot_by_task = total_minutes_by_task(segments)
    tasks_with_records = {record["task_id"] for record in segments}
    projected: list[dict] = []
    for raw in task_rows:
        task = dict(raw)
        task_id = task["id"]
        if task_id in tasks_with_records or task.get("legacy_actual_minutes") is not None:
            legacy = task.get("legacy_actual_minutes") or 0
            effective_minutes = legacy + eff_by_task.get(task_id, 0)
            total_minutes = legacy + tot_by_task.get(task_id, 0)
            if task.get("completion_override") is not None:
                completed = int(bool(task["completion_override"]))
            else:
                learning = counts_as_study_goal(task["category"])
                completion_minutes = effective_minutes if learning else total_minutes
                reaches_planned = task["estimated_minutes"] > 0 and completion_minutes >= task["estimated_minutes"]
                if task.get("task_type") is None or task.get("task_type") == "todo":
                    completed = int(bool(task["completed"]))
                elif task.get("task_type") == "habit":
                    completed = int(task.get("habit_status") == "done")
                else:
                    completed = int(reaches_planned)
            if task.get("habit_status") is not None:
                completed = int(task.get("habit_status") == "done")
            task["actual_minutes"] = effective_minutes
            task["completed"] = completed
        projected.append(task)
    return projected


def sync_plan_tasks_to_db(connection, plan_id: int, segments: list[dict] | None = None) -> None:
    """仅在写操作路径调用：将计算后的分钟与完成状态按需写回 tasks 表。"""
    if segments is None:
        plan_date_row = connection.execute("SELECT plan_date FROM plans WHERE id=?", (plan_id,)).fetchone()
        if not plan_date_row:
            return
        segments = execution_records(connection, plan_date_row["plan_date"])
    rows = connection.execute("SELECT * FROM tasks WHERE plan_id=? ORDER BY position,id", (plan_id,)).fetchall()
    projected = compute_task_progress(rows, segments)
    for original, updated in zip(rows, projected):
        if original["actual_minutes"] != updated["actual_minutes"] or int(bool(original["completed"])) != int(bool(updated["completed"])):
            connection.execute(
                "UPDATE tasks SET actual_minutes=?, completed=? WHERE id=?",
                (updated["actual_minutes"], int(bool(updated["completed"])), updated["id"]),
            )


def aggregate_execution_board(tasks: list[dict], segments: list[dict]) -> list[dict]:
    board_map: dict[int, dict] = {}
    records_by_task: dict[int, list[dict]] = {}
    for segment in segments:
        records_by_task.setdefault(segment["task_id"], []).append(segment)

    for task in tasks:
        board_map[task["id"]] = {
            "task_id": task["id"],
            "task_title": task["title"],
            "category": task["category"],
            "is_sub": bool(task["is_sub"]),
            "estimated_minutes": task["estimated_minutes"],
            "task_type": task.get("task_type") or default_task_type_for(task["category"]),
            "habit_status": task.get("habit_status"),
            "total_seconds": 0,
            "effective_seconds": 0,
            "counted_label_seconds": 0,
            "interrupt_seconds": 0,
            "effective_labels": [],
            "counted_labels": [],
            "interrupt_labels": [],
            "_effective": {},
            "_counted": {},
            "_interrupt": {},
        }

    for segment in segments:
        if not segment.get("included", True):
            continue
        board = board_map.get(segment["task_id"])
        if not board:
            continue
        seconds = record_seconds(segment)
        if segment["segment_kind"] == "effective":
            board["effective_seconds"] += seconds
            board["total_seconds"] += seconds
            key = segment["label_id"] or "__unlabeled_effective__"
            label_bucket = board["_effective"]
            if key not in label_bucket:
                label_bucket[key] = {
                    "label_id": segment["label_id"],
                    "label_name": segment["label_name"] or "未细分",
                    "seconds": 0,
                    "count": 0,
                }
                board["effective_labels"].append(label_bucket[key])
            label_bucket[key]["seconds"] += seconds
            label_bucket[key]["count"] += 1
            continue
        counted = counts_in_learning_session(segment)
        bucket_name = "_counted" if counted else "_interrupt"
        public_name = "counted_labels" if counted else "interrupt_labels"
        if counted:
            board["counted_label_seconds"] += seconds
            board["total_seconds"] += seconds
        else:
            board["interrupt_seconds"] += seconds
        key = segment["label_id"] or segment["label_name"] or "unknown"
        label_bucket = board[bucket_name]
        if key not in label_bucket:
            name = segment["label_name"] or "未命名标签"
            if segment.get("is_estimated"):
                name += "（补记·估计）"
            label_bucket[key] = {"label_id": segment["label_id"], "label_name": name, "seconds": 0, "count": 0}
            board[public_name].append(label_bucket[key])
        label_bucket[key]["seconds"] += seconds
        label_bucket[key]["count"] += 1

    board_items = []
    for task in tasks:
        task_id = task["id"]
        board = board_map[task_id]
        board.pop("_effective")
        board.pop("_counted")
        board.pop("_interrupt")
        task_segments = records_by_task.get(task_id, [])
        legacy = task.get("legacy_actual_minutes")
        if legacy is None and not task_segments:
            legacy = task.get("actual_minutes") or 0
        if legacy:
            board["effective_seconds"] += legacy * 60
            board["total_seconds"] += legacy * 60
            board["effective_labels"].append(
                {"label_id": None, "label_name": "旧版时长记录", "seconds": legacy * 60, "count": 1}
            )
        effective_seconds = max(0, int(board["effective_seconds"] or 0))
        board["time_summary"] = time_summary(task_segments, (legacy or 0) * 60)
        board["effective_ratio"] = board["time_summary"]["effective_ratio"] or 0
        for label in board["effective_labels"]:
            label_seconds = max(0, int(label["seconds"] or 0))
            label["effective_share"] = round(label_seconds / effective_seconds, 4) if effective_seconds else 0
        board["has_segments"] = bool(
            board["habit_status"]
            or board["effective_seconds"]
            or board["counted_label_seconds"]
            or board["interrupt_seconds"]
        )
        board["bar_total_seconds"] = max(
            board["total_seconds"],
            board["interrupt_seconds"],
            board["effective_seconds"] + board["counted_label_seconds"] + board["interrupt_seconds"],
        )
        for labels in (board["effective_labels"], board["counted_labels"], board["interrupt_labels"]):
            for label in labels:
                label["minutes"] = label["seconds"] // 60
        for name in ("total", "effective", "counted_label", "interrupt", "bar_total"):
            board[f"{name}_minutes"] = board[f"{name}_seconds"] // 60
        board_items.append(board)
    return [item for item in board_items if item["has_segments"]]


def has_saved_execution(tasks: list, records: list) -> bool:
    return bool(records) or any(
        (task.get("actual_minutes") or 0) > 0
        or (task.get("legacy_actual_minutes") or 0) > 0
        or task.get("habit_status") is not None
        or bool(task.get("completed"))
        for task in tasks
    )


def vocabulary_counts(connection, plan_date: str) -> dict | None:
    row = connection.execute("SELECT * FROM vocabulary_daily_counts WHERE plan_date=?", (plan_date,)).fetchone()
    return dict(row) if row else None


def build_execution_payload(connection, plan_date: str) -> dict:
    settings = get_settings(connection)
    plan = get_plan_row(connection, plan_date)
    segments = list_execution_segments(connection, plan_date)
    duration_records = list_duration_records(connection, plan_date)
    records = segments + [dict(row, segment_kind="effective") for row in duration_records]
    active = next((segment for segment in reversed(segments) if segment["ended_at"] is None), None)
    plan_payload = None
    tasks: list[dict] = []
    if plan:
        raw_tasks = connection.execute(
            "SELECT * FROM tasks WHERE plan_id=? ORDER BY position,id",
            (plan["id"],),
        ).fetchall()
        projected_rows = compute_task_progress(raw_tasks, records)
        tasks = [serialize_task_row(row) for row in projected_rows]
        plan_payload = serialize_plan_from_rows(plan, projected_rows)
    boards = aggregate_execution_board(tasks, records)
    return {
        "date": plan_date,
        "plan": plan_payload,
        "tasks": tasks,
        "labels": serialize_execution_labels(settings),
        "correction_activities": list(correction_activities(settings).values()),
        "correction_shortcuts": correction_shortcuts(connection),
        "active_segment": active,
        "segments": segments,
        "duration_records": duration_records,
        "vocabulary_counts": vocabulary_counts(connection, plan_date),
        "task_execution_board": boards,
        "time_summary": combine_summaries([board["time_summary"] for board in boards]),
        "has_execution": has_saved_execution(tasks, records),
        "has_review": connection.execute("SELECT 1 FROM reviews WHERE review_date=?", (plan_date,)).fetchone() is not None,
    }


def assert_segment_time_window(started_at: datetime, ended_at: datetime) -> None:
    end_parsed = parse_iso_datetime(ended_at.replace(microsecond=0).isoformat())
    start_parsed = parse_iso_datetime(started_at.replace(microsecond=0).isoformat())
    if end_parsed is None or start_parsed is None or end_parsed <= start_parsed:
        raise HTTPException(422, "结束时间必须晚于开始时间")


def assert_no_segment_overlap(
    connection,
    plan_date: str,
    task_id: int,
    started_at: str,
    ended_at: str | None,
    skip_segment_id: int | None = None,
) -> None:
    del plan_date, task_id  # 保持调用签名兼容，实际按全局物理时间轴检查重叠
    start = parse_iso_datetime(started_at)
    end = parse_iso_datetime(ended_at) if ended_at else None
    assert start is not None
    # 利用 ISO 日期前 10 位 ±2 天安全窗口预筛（兼容任意时区偏移与跨午夜记录）+ 全部未结束激活段，告别全表扫描
    min_end_prefix = (start.date() - timedelta(days=2)).isoformat()
    if end is not None:
        max_start_prefix = (end.date() + timedelta(days=2)).isoformat()
        rows = connection.execute(
            """SELECT id,started_at,ended_at FROM task_execution_segments
               WHERE ended_at IS NULL
                  OR (substr(started_at,1,10) <= ? AND substr(ended_at,1,10) >= ?)""",
            (max_start_prefix, min_end_prefix),
        ).fetchall()
    else:
        rows = connection.execute(
            """SELECT id,started_at,ended_at FROM task_execution_segments
               WHERE ended_at IS NULL OR substr(ended_at,1,10) >= ?""",
            (min_end_prefix,),
        ).fetchall()

    for row in rows:
        if row["id"] == skip_segment_id:
            continue
        other_start = parse_iso_datetime(row["started_at"])
        other_end = parse_iso_datetime(row["ended_at"])
        if other_start is None:
            continue
        if other_end is not None and other_end <= other_start:
            continue
        if (end is None or other_start < end) and (other_end is None or other_end > start):
            raise HTTPException(409, "时间段发生重叠，请先调整现有记录（含其他日期）")


def check_segment_overlap(
    connection,
    plan_date: str,
    task_id: int,
    started_at: str,
    ended_at: str | None,
    skip_segment_id: int | None = None,
) -> None:
    api_mod = sys.modules.get("app.api")
    if api_mod is not None:
        hook = getattr(api_mod, "_assert_no_segment_overlap", None)
        if callable(hook) and hook is not assert_no_segment_overlap:
            hook(connection, plan_date, task_id, started_at, ended_at, skip_segment_id=skip_segment_id)
            return
    assert_no_segment_overlap(connection, plan_date, task_id, started_at, ended_at, skip_segment_id=skip_segment_id)


def close_active_execution_segment(connection, plan_date: str | None = None, ended_at: str | None = None) -> int | None:
    active = get_active_execution_segment(connection, plan_date)
    if not active:
        return None
    cancel_reminders(connection, active["id"])
    effective_end = ended_at or now_iso()
    auto_stop = parse_iso_datetime(active["auto_stop_at"]) if active["auto_stop_at"] else None
    end_dt = parse_iso_datetime(effective_end)
    start_dt = parse_iso_datetime(active["started_at"])
    automatic = bool(auto_stop and end_dt and auto_stop <= end_dt)
    if automatic:
        effective_end = active["auto_stop_at"]
        end_dt = auto_stop
    if end_dt and start_dt and end_dt <= start_dt:
        effective_end = active["started_at"]
    connection.execute(
        "UPDATE task_execution_segments SET ended_at=?,auto_stop_at=?,stopped_automatically=? WHERE id=?",
        (effective_end, active["auto_stop_at"] if automatic else None, int(automatic), active["id"]),
    )
    return active["task_id"]


def resolve_segment_label(
    settings: dict,
    task_category: str,
    label_id: str | None,
    segment_kind: str,
) -> tuple[str | None, str | None]:
    if segment_kind == "effective":
        if not label_id:
            return None, None
        label = build_effective_label_map(settings, task_category).get(label_id)
        if not label:
            raise HTTPException(404, "有效细分标签不存在")
        return label["id"], label["name"]
    if not label_id:
        raise HTTPException(422, "标签不能为空")
    label_map = build_execution_label_map(settings)
    label = label_map.get(label_id)
    if not label:
        raise HTTPException(404, "标签不存在")
    expected_kind = "counted_label" if label["bucket"] == "counted" else "interrupt_label"
    if segment_kind != expected_kind:
        raise HTTPException(422, "标签类型与时间段类型不匹配")
    return label["id"], label["name"]


def resolve_segment_category(settings: dict, kind: str, label_id: str | None, explicit: str | None = None) -> str:
    if kind == "effective":
        if explicit not in (None, "learning"):
            raise HTTPException(422, "有效学习时间不能归入非学习活动")
        return "learning"
    if explicit == "learning":
        raise HTTPException(422, "非学习标签不能归为有效学习")
    assert label_id is not None
    return explicit or label_category(build_execution_label_map(settings)[label_id])


def ensure_recordable_plan(connection, plan_date: str):
    plan = get_plan_row(connection, plan_date)
    if not plan:
        raise HTTPException(404, "计划不存在")
    if plan["status"] not in ("approved", "submitted"):
        raise HTTPException(409, "请先确认当天清单")
    return plan


def append_temporary_task(connection, plan, payload: TemporaryTaskInput):
    title = payload.title.strip()
    if not title:
        raise HTTPException(422, "请填写活动名称")
    count_row = connection.execute("SELECT COUNT(*), COALESCE(MAX(position), -1) FROM tasks WHERE plan_id=?", (plan["id"],)).fetchone()
    if count_row[0] >= MAX_DAILY_TASKS:
        raise HTTPException(422, f"当天最多 {MAX_DAILY_TASKS} 项活动")
    next_position = int(count_row[1]) + 1
    inserted_ids = insert_tasks(
        connection,
        plan["id"],
        [
            TaskDraft(
                title=title,
                category=payload.category,
                estimated_minutes=0,
                priority=4,
                reason="用户临时添加",
                task_type=payload.task_type,
            )
        ],
        start_position=next_position,
    )
    return connection.execute("SELECT * FROM tasks WHERE id=?", (inserted_ids[0],)).fetchone()


def apply_vocabulary_choice(connection, plan_date: str, choice: str | None) -> None:
    word_segments = connection.execute(
        """SELECT s.id,s.ended_at FROM task_execution_segments s JOIN tasks t ON t.id=s.task_id
           WHERE s.plan_date=? AND t.category='english' AND s.segment_kind='effective'
           AND s.label_id=?""",
        (plan_date, VOCABULARY_WORD_LABEL_ID),
    ).fetchall()
    if word_segments and choice is None:
        raise HTTPException(409, "当天已有背单词计时，请选择：分别学习保留两份、只保留墨墨或只保留计时")
    if not choice:
        return
    if choice == "manual" and any(row["ended_at"] is None for row in word_segments):
        raise HTTPException(409, "请先停止正在进行的背单词计时，再选择只保留墨墨")
    connection.execute(
        """UPDATE task_execution_segments SET included=? WHERE id IN (
           SELECT s.id FROM task_execution_segments s JOIN tasks t ON t.id=s.task_id
           WHERE s.plan_date=? AND t.category='english' AND s.segment_kind='effective'
           AND s.label_id=?)""",
        (int(choice != "manual"), plan_date, VOCABULARY_WORD_LABEL_ID),
    )
    connection.execute(
        """UPDATE task_duration_records SET included=? WHERE task_id IN (
           SELECT t.id FROM tasks t JOIN plans p ON p.id=t.plan_id WHERE p.plan_date=?)""",
        (int(choice != "timer"), plan_date),
    )


def handle_word_segment_conflict(
    connection,
    plan_date: str,
    category: str,
    label_id: str | None,
    segment_kind: str,
    duplicate_choice: str | None,
) -> bool:
    """统一处理背单词有效计时与手动时长录入的冲突选择；返回新片段是否应排除（included=0）。"""
    if not is_vocabulary_word_segment(category, label_id, segment_kind):
        return False
    if list_duration_records(connection, plan_date):
        if duplicate_choice is None:
            raise HTTPException(409, "当天已有墨墨录入，请明确选择保留哪份背单词记录")
        apply_vocabulary_choice(connection, plan_date, duplicate_choice)
    return duplicate_choice == "manual"


def plan_has_execution_segments(connection, plan_date: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM task_execution_segments WHERE plan_date=? "
        "UNION ALL SELECT 1 FROM task_duration_records r JOIN tasks t ON t.id=r.task_id "
        "JOIN plans p ON p.id=t.plan_id WHERE p.plan_date=? LIMIT 1",
        (plan_date, plan_date),
    ).fetchone()
    return bool(row)
