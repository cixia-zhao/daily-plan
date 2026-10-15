from __future__ import annotations

import hashlib
import json
from uuid import uuid4
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import FileResponse

from .backup_utils import create_sqlite_backup, prune_old_backups
from .database import connect
from .services.daily_reset import restore_snapshot, save_reset_snapshot, snapshot_metadata
from .schemas import (
    CarryoverResolution,
    Category,
    EffectiveLabelNameInput,
    DurationRecordInput,
    TemporaryTaskInput,
    EffectiveLabelItem,
    DraftRequest,
    ExecutionLabelItem,
    ExecutionLabelStartInput,
    ExecutionSegmentCreateInput,
    ExecutionSegmentUpdateInput,
    ExecutionTaskStartInput,
    GPTRecordSaveInput,
    PlanUpdate,
    PromptConfigItem,
    ReviewInput,
    SettingsInput,
    TaskDraft,
    TaskUpdate,
    WeeklyReportSaveInput,
)
from .services.task_rules import build_rule_plan, validate_ai_tasks


router = APIRouter(prefix="/api")

WEEKLY_ANALYSIS_SYSTEM_PROMPT = """你是一个帮助用户做周复盘的分析助手。
你会收到最近 7 天的执行数据和每日复盘内容。
只输出 JSON，格式必须是：
{
  "summary_title": "...",
  "load_advice": "...",
  "drag_factors": "...",
  "effective_patterns": "...",
  "real_progress_assessment": "...",
  "next_week_focus": "..."
}
要求：
1. 基于事实，不夸张，不说空话。
2. 不要替用户自动决定，只给审阅参考。
3. 优先回答：要不要调量、为什么没完成、什么方法有效、这周是否真实推进、下周该抓什么。
4. 不要输出 Markdown，不要输出额外解释。
"""

CHATGPT_EXPORT_SYSTEM_PROMPT = """请你作为我的周复盘教练，基于下面这 7 天的数据帮我做深入周复盘。
请重点回答：
1. 我下周该减量、持平还是加量，为什么？
2. 这周最主要的拖累因素是什么？
3. 哪些方法或条件对我最有效？
4. 我这周是否有真实推进，而不是表面完成？
5. 下周最该抓住的 3 个重点是什么？
请给我一份清晰、诚实、可执行的周复盘。
"""

DAILY_GPT_SYSTEM_PROMPT = """你现在是我的单日复盘搭子，不要急着给大道理。
我会把某一天的计划完成情况、实际投入和复盘内容发给你。
请按下面顺序和我协作：
1. 先用 2-4 句话复述你看到的真实情况，不要夸张。
2. 明确指出今天最值得追问的 1-2 个问题。
3. 给我一个很小的明天调整建议，必须具体到动作。
4. 如果信息还不够，继续追问我，而不是假装已经看清。
回答要自然、诚实、可执行，不要空泛鼓励。
"""

WEEKLY_GPT_SYSTEM_PROMPT = """你现在是我的周整理搭子，不要直接替我下结论。
我会把这一周的完成情况、每日复盘和当前草稿发给你。
请按下面顺序和我协作：
1. 先概括这一周真实发生了什么，别用漂亮空话。
2. 指出最值得深聊的 2-3 个模式或问题。
3. 给出下周执行层面的优先级建议，但不要替我拍板。
4. 如果判断依据不足，请继续追问我需要补充的事实。
回答要像一起整理，而不是像上对下打分。
"""

DEFAULT_EXECUTION_LABELS = [
    {"id": "counted_toilet", "name": "上厕所", "bucket": "counted", "is_system": True},
    {"id": "counted_walk", "name": "走动", "bucket": "counted", "is_system": True},
    {"id": "counted_game", "name": "打游戏", "bucket": "counted", "is_system": True},
    {"id": "interrupt_meal", "name": "吃饭", "bucket": "interrupt", "is_system": True},
    {"id": "interrupt_incident", "name": "突发", "bucket": "interrupt", "is_system": True},
    {"id": "interrupt_pause", "name": "手动暂停", "bucket": "interrupt", "is_system": True},
]

DEFAULT_EFFECTIVE_LABELS_BY_CATEGORY = {
    "math": [
        {"id": "effective_math_course", "name": "网课", "is_system": True},
        {"id": "effective_math_practice", "name": "刷题", "is_system": True},
    ],
    "english": [
        {"id": "effective_english_reading", "name": "阅读", "is_system": True},
        {"id": "effective_english_words", "name": "单词", "is_system": True},
    ],
}

DEFAULT_DRAFT_MAIN_MINUTES_BY_CATEGORY = {
    "math": 0,
    "english": 0,
    "computer": 0,
    "rehab": 0,
}

DEFAULT_SETTINGS = {
    "current_stage": "恢复秩序期",
    "ai_project_weekly_frequency": 3,
    "rehab_enabled": True,
    "weekly_review_mode": "separate",
    "weekly_review_day": 6,
    "project_start_date": date.today().isoformat(),
    "task_titles": {
        "math": "数学", "english": "英语", "computer": "408",
        "vibe_coding": "vibe coding", "algorithm": "算法",
        "reading": "阅读", "writing": "练字", "rehab": "运动",
    },
    "draft_main_minutes_by_category": DEFAULT_DRAFT_MAIN_MINUTES_BY_CATEGORY,
    "budget_minimum": 90,
    "budget_normal": 150,
    "budget_ample": 210,
    "execution_labels": DEFAULT_EXECUTION_LABELS,
    "effective_labels_by_category": DEFAULT_EFFECTIVE_LABELS_BY_CATEGORY,
    "deleted_effective_label_ids": {},
    "weekly_analysis_prompts": [
        {
            "id": "weekly_analysis_system_default",
            "name": "系统默认",
            "content": WEEKLY_ANALYSIS_SYSTEM_PROMPT,
            "is_system": True,
        }
    ],
    "weekly_analysis_active_prompt_id": "weekly_analysis_system_default",
    "chatgpt_export_prompts": [
        {
            "id": "chatgpt_export_system_default",
            "name": "系统默认",
            "content": CHATGPT_EXPORT_SYSTEM_PROMPT,
            "is_system": True,
        }
    ],
    "chatgpt_export_active_prompt_id": "chatgpt_export_system_default",
    "daily_gpt_prompts": [
        {
            "id": "daily_gpt_system_default",
            "name": "系统默认",
            "content": DAILY_GPT_SYSTEM_PROMPT,
            "is_system": True,
        }
    ],
    "daily_gpt_active_prompt_id": "daily_gpt_system_default",
    "weekly_gpt_prompts": [
        {
            "id": "weekly_gpt_system_default",
            "name": "系统默认",
            "content": WEEKLY_GPT_SYSTEM_PROMPT,
            "is_system": True,
        }
    ],
    "weekly_gpt_active_prompt_id": "weekly_gpt_system_default",
}

EMPTY_REVIEW = {
    "mood": "",
    "hardest_point": "",
    "effective_method": "",
    "optimization_note": "",
    "real_progress": "",
    "tomorrow_focus": "",
    "reflection_text": "",
}


def _db(request: Request):
    return connect(request.app.state.database_path)


def _backup_dir(request: Request):
    return request.app.state.backup_dir


def _is_planned_main_task(row) -> bool:
    return not row["is_sub"] and row["estimated_minutes"] > 0


def _capture_unfinished(connection, before_date: str) -> None:
    rows = connection.execute(
        """SELECT t.id, t.title, t.category, t.estimated_minutes
           FROM tasks t JOIN plans p ON p.id=t.plan_id
           WHERE p.status IN ('approved', 'submitted') AND p.plan_date < ? AND t.completed=0 AND t.task_type='todo'""",
        (before_date,),
    ).fetchall()
    for row in rows:
        connection.execute(
            """INSERT OR IGNORE INTO carryovers(task_id,title,category,estimated_minutes)
               VALUES(?,?,?,?)""",
            (row["id"], row["title"], row["category"], row["estimated_minutes"]),
        )


def _earliest_business_date(connection) -> str | None:
    row = connection.execute(
        """SELECT MIN(record_date) AS record_date FROM (
               SELECT plan_date AS record_date FROM plans
               UNION ALL SELECT review_date AS record_date FROM reviews
               UNION ALL SELECT plan_date AS record_date FROM task_execution_segments
           )"""
    ).fetchone()
    return row["record_date"] if row and row["record_date"] else None


def _get_settings(connection) -> dict:
    row = connection.execute("SELECT value_json FROM app_settings WHERE key='main'").fetchone()
    stored_settings = json.loads(row["value_json"]) if row else {}
    settings = dict(DEFAULT_SETTINGS) | stored_settings
    settings["deleted_effective_label_ids"] = {
        category: list(ids) for category, ids in settings.get("deleted_effective_label_ids", {}).items()
    }
    settings["project_start_date"] = (
        stored_settings.get("project_start_date")
        or _earliest_business_date(connection)
        or date.today().isoformat()
    )
    settings.setdefault("execution_labels", DEFAULT_SETTINGS["execution_labels"])
    settings.setdefault("effective_labels_by_category", DEFAULT_SETTINGS["effective_labels_by_category"])
    settings.setdefault("draft_main_minutes_by_category", DEFAULT_SETTINGS["draft_main_minutes_by_category"])
    settings["effective_labels_by_category"] = _effective_labels_by_category(settings)
    settings["draft_main_minutes_by_category"] = _draft_main_minutes_by_category(settings)
    settings.setdefault("weekly_analysis_prompts", DEFAULT_SETTINGS["weekly_analysis_prompts"])
    settings.setdefault("weekly_analysis_active_prompt_id", "weekly_analysis_system_default")
    settings.setdefault("chatgpt_export_prompts", DEFAULT_SETTINGS["chatgpt_export_prompts"])
    settings.setdefault("chatgpt_export_active_prompt_id", "chatgpt_export_system_default")
    settings.setdefault("daily_gpt_prompts", DEFAULT_SETTINGS["daily_gpt_prompts"])
    settings.setdefault("daily_gpt_active_prompt_id", "daily_gpt_system_default")
    settings.setdefault("weekly_gpt_prompts", DEFAULT_SETTINGS["weekly_gpt_prompts"])
    settings.setdefault("weekly_gpt_active_prompt_id", "weekly_gpt_system_default")
    return settings


def _now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value)
    # 无时区旧记录按本项目中国时间解释，带时区输入先统一为同一时间轴。
    return parsed.replace(tzinfo=timezone(timedelta(hours=8))) if parsed.tzinfo is None else parsed


def _seconds_between(started_at: str, ended_at: str | None) -> int:
    start = _parse_iso_datetime(started_at)
    end = _parse_iso_datetime(ended_at or _now_iso())
    return max(0, int((end - start).total_seconds()))


def _local_iso(value: datetime) -> str:
    parsed = _parse_iso_datetime(value.replace(microsecond=0).isoformat())
    return parsed.astimezone(timezone(timedelta(hours=8))).replace(tzinfo=None).isoformat()


def _minutes_between(started_at: str, ended_at: str | None) -> int:
    return _seconds_between(started_at, ended_at) // 60


def _record_seconds(record: dict) -> int:
    return max(0, int(record.get("seconds", (record.get("minutes") or 0) * 60)))


def _build_execution_label_map(settings: dict) -> dict[str, dict]:
    labels = settings.get("execution_labels") or DEFAULT_EXECUTION_LABELS
    return {item["id"]: item for item in labels}


def _effective_labels_by_category(settings: dict) -> dict[str, list[dict]]:
    raw = settings.get("effective_labels_by_category") or DEFAULT_EFFECTIVE_LABELS_BY_CATEGORY
    merged: dict[str, list[dict]] = {}
    category_keys = {*(DEFAULT_EFFECTIVE_LABELS_BY_CATEGORY.keys()), *(str(key) for key in raw.keys())}
    for category in category_keys:
        default_items = [dict(item) for item in DEFAULT_EFFECTIVE_LABELS_BY_CATEGORY.get(category, [])]
        raw_items = [dict(item) for item in (raw.get(category) or raw.get(str(category)) or [])]
        raw_by_id = {item["id"]: item for item in raw_items}
        combined = [raw_by_id.pop(item["id"], item) for item in default_items]
        combined.extend(raw_by_id.values())
        deleted = set(settings.get("deleted_effective_label_ids", {}).get(category, []))
        merged[category] = [item for item in combined if item["id"] not in deleted]
    return merged


def _draft_main_minutes_by_category(settings: dict) -> dict[str, int]:
    raw = settings.get("draft_main_minutes_by_category") or DEFAULT_DRAFT_MAIN_MINUTES_BY_CATEGORY
    merged = dict(DEFAULT_DRAFT_MAIN_MINUTES_BY_CATEGORY)
    for category, value in raw.items():
        if category not in merged:
            continue
        try:
            merged[category] = max(0, min(720, int(value)))
        except (TypeError, ValueError):
            continue
    return merged


def _build_effective_label_map(settings: dict, category: str) -> dict[str, dict]:
    labels = _effective_labels_by_category(settings).get(category) or []
    return {item["id"]: item for item in labels}


def _serialize_execution_labels(settings: dict) -> list[dict]:
    labels = settings.get("execution_labels") or DEFAULT_EXECUTION_LABELS
    return [ExecutionLabelItem(**item).model_dump(mode="json") for item in labels]


def _serialize_effective_labels_by_category(settings: dict) -> dict[str, list[dict]]:
    return {
        category: [EffectiveLabelItem(**item).model_dump(mode="json") for item in labels]
        for category, labels in _effective_labels_by_category(settings).items()
    }


def _apply_draft_main_minutes(tasks: list[TaskDraft], settings: dict) -> list[TaskDraft]:
    defaults = _draft_main_minutes_by_category(settings)
    output: list[TaskDraft] = []
    for task in tasks:
        if task.is_sub or task.source == "carryover":
            output.append(task)
            continue
        if task.category not in defaults:
            output.append(task)
            continue
        output.append(task.model_copy(update={"estimated_minutes": defaults[task.category]}))
    return output


def _resolve_segment_label(settings: dict, task_category: str, label_id: str | None, segment_kind: str) -> tuple[str | None, str | None]:
    if segment_kind == "effective":
        if not label_id:
            return None, None
        label = _build_effective_label_map(settings, task_category).get(label_id)
        if not label:
            raise HTTPException(404, "有效细分标签不存在")
        return label["id"], label["name"]
    if not label_id:
        raise HTTPException(422, "标签不能为空")
    label_map = _build_execution_label_map(settings)
    label = label_map.get(label_id)
    if not label:
        raise HTTPException(404, "标签不存在")
    expected_kind = "counted_label" if label["bucket"] == "counted" else "interrupt_label"
    if segment_kind != expected_kind:
        raise HTTPException(422, "标签类型与时间段类型不匹配")
    return label["id"], label["name"]


def _resolve_prompt_content(settings: dict, prompt_key: str, active_key: str, default_id: str, default_content: str) -> str:
    prompts = settings.get(prompt_key) or []
    active_id = settings.get(active_key) or default_id
    for prompt in prompts:
        if prompt.get("id") == active_id and (prompt.get("content") or "").strip():
            return prompt["content"]
    return default_content


def _project_start_date(settings: dict) -> date:
    raw = settings.get("project_start_date") or date.today().isoformat()
    if isinstance(raw, date):
        return raw
    return date.fromisoformat(str(raw))


def _week_bounds(anchor: date) -> tuple[date, date]:
    start = anchor - timedelta(days=anchor.weekday())
    end = start + timedelta(days=6)
    return start, end


def _parse_month_start(month: str) -> date:
    return datetime.strptime(f"{month}-01", "%Y-%m-%d").date()


def _serialize_task_row(row) -> dict:
    task = dict(row)
    task["task_type"] = task.get("task_type") or ("habit" if task["category"] == "rehab" else "daily_goal")
    task["completed"] = bool(task["completed"])
    task["is_sub"] = bool(task["is_sub"])
    if task.get("completion_override") is not None:
        task["completion_override"] = bool(task["completion_override"])
    return task


def _serialize_plan(connection, plan_date: str) -> dict:
    plan = connection.execute("SELECT * FROM plans WHERE plan_date=?", (plan_date,)).fetchone()
    if not plan:
        raise HTTPException(404, "计划不存在")
    tasks = connection.execute("SELECT * FROM tasks WHERE plan_id=? ORDER BY position,id", (plan["id"],)).fetchall()
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
        "tasks": [_serialize_task_row(row) for row in tasks],
    }


def _get_plan_row(connection, plan_date: str):
    return connection.execute("SELECT * FROM plans WHERE plan_date=?", (plan_date,)).fetchone()


def _get_plan_task_rows(connection, plan_id: int):
    rows = connection.execute("SELECT * FROM tasks WHERE plan_id=? ORDER BY position,id", (plan_id,)).fetchall()
    return [_serialize_task_row(row) for row in rows]


def _get_task_row_for_execution(connection, plan_date: str, task_id: int):
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


def _get_active_execution_segment(connection, plan_date: str | None = None):
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


def _serialize_execution_segment_row(row) -> dict:
    seconds = _seconds_between(row["started_at"], row["ended_at"])
    return {
        "id": row["id"],
        "plan_date": row["plan_date"],
        "task_id": row["task_id"],
        "task_title": row["task_title"],
        "segment_kind": row["segment_kind"],
        "label_id": row["label_id"],
        "label_name": row["label_name"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "minutes": seconds // 60,
        "seconds": seconds,
        "included": bool(row["included"]),
    }


def _list_execution_segments(connection, plan_date: str) -> list[dict]:
    rows = connection.execute(
        """SELECT s.*, t.title AS task_title
           FROM task_execution_segments s
           JOIN tasks t ON t.id=s.task_id
           WHERE s.plan_date=?
           ORDER BY s.started_at, s.id""",
        (plan_date,),
    ).fetchall()
    return [_serialize_execution_segment_row(row) for row in rows]


def _list_duration_records(connection, plan_date: str) -> list[dict]:
    return [dict(row) for row in connection.execute(
        """SELECT r.*, t.title AS task_title FROM task_duration_records r
           JOIN tasks t ON t.id=r.task_id JOIN plans p ON p.id=t.plan_id
           WHERE p.plan_date=? ORDER BY r.id""", (plan_date,)
    ).fetchall()]


def _execution_records(connection, plan_date: str) -> list[dict]:
    records = _list_execution_segments(connection, plan_date)
    records += [dict(row, segment_kind="effective") for row in _list_duration_records(connection, plan_date)]
    return records


def _prepare_execution_task(connection, task) -> None:
    # 保留旧版只有实际分钟、没有明细的记录，新增计时不能将它覆盖。
    if task["legacy_actual_minutes"] is None and not connection.execute(
        "SELECT 1 FROM task_execution_segments WHERE task_id=? UNION ALL SELECT 1 FROM task_duration_records WHERE task_id=?",
        (task["id"], task["id"]),
    ).fetchone():
        connection.execute("UPDATE tasks SET legacy_actual_minutes=? WHERE id=?", (task["actual_minutes"] or 0, task["id"]))


def _effective_minutes_by_task(segments: list[dict]) -> dict[int, int]:
    totals: dict[int, int] = {}
    for segment in segments:
        if not segment.get("included", True):
            continue
        if segment["segment_kind"] != "effective":
            continue
        task_id = segment["task_id"]
        totals[task_id] = totals.get(task_id, 0) + _record_seconds(segment)
    return {task: seconds // 60 for task, seconds in totals.items()}


def _total_minutes_by_task(segments: list[dict]) -> dict[int, int]:
    totals: dict[int, int] = {}
    for segment in segments:
        if not segment.get("included", True):
            continue
        if segment["segment_kind"] not in ("effective", "counted_label"):
            continue
        task_id = segment["task_id"]
        totals[task_id] = totals.get(task_id, 0) + _record_seconds(segment)
    return {task: seconds // 60 for task, seconds in totals.items()}


def _aggregate_execution_board(tasks: list[dict], segments: list[dict]) -> list[dict]:
    board_map: dict[int, dict] = {}
    for task in tasks:
        board_map[task["id"]] = {
            "task_id": task["id"],
            "task_title": task["title"],
            "category": task["category"],
            "is_sub": bool(task["is_sub"]),
            "estimated_minutes": task["estimated_minutes"],
            "task_type": task.get("task_type") or ("habit" if task["category"] == "rehab" else "daily_goal"),
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
        seconds = _record_seconds(segment)
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
        bucket_name = "_counted" if segment["segment_kind"] == "counted_label" else "_interrupt"
        public_name = "counted_labels" if segment["segment_kind"] == "counted_label" else "interrupt_labels"
        if segment["segment_kind"] == "counted_label":
            board["counted_label_seconds"] += seconds
            board["total_seconds"] += seconds
        else:
            board["interrupt_seconds"] += seconds
        key = segment["label_id"] or segment["label_name"] or "unknown"
        label_bucket = board[bucket_name]
        if key not in label_bucket:
            label_bucket[key] = {"label_id": segment["label_id"], "label_name": segment["label_name"] or "未命名标签", "seconds": 0, "count": 0}
            board[public_name].append(label_bucket[key])
        label_bucket[key]["seconds"] += seconds
        label_bucket[key]["count"] += 1

    board_items = []
    for task in tasks:
        board = board_map[task["id"]]
        board.pop("_effective")
        board.pop("_counted")
        board.pop("_interrupt")
        legacy = task.get("legacy_actual_minutes")
        if legacy is None and not any(record["task_id"] == task["id"] for record in segments):
            legacy = task.get("actual_minutes") or 0
        if legacy:
            board["effective_seconds"] += legacy * 60
            board["total_seconds"] += legacy * 60
            board["effective_labels"].append({"label_id": None, "label_name": "旧版时长记录", "seconds": legacy * 60, "count": 1})
        effective_seconds = max(0, int(board["effective_seconds"] or 0))
        total_seconds = max(0, int(board["total_seconds"] or 0))
        board["effective_ratio"] = round(effective_seconds / total_seconds, 4) if total_seconds else 0
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


def _plan_has_execution_segments(connection, plan_date: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM task_execution_segments WHERE plan_date=? UNION ALL SELECT 1 FROM task_duration_records r JOIN tasks t ON t.id=r.task_id JOIN plans p ON p.id=t.plan_id WHERE p.plan_date=? LIMIT 1",
        (plan_date, plan_date),
    ).fetchone()
    return bool(row)


def _sync_plan_actual_minutes_from_execution(connection, plan_id: int, segments: list[dict] | None = None) -> None:
    if segments is None:
        plan_date_row = connection.execute("SELECT plan_date FROM plans WHERE id=?", (plan_id,)).fetchone()
        if not plan_date_row:
            return
        segments = _execution_records(connection, plan_date_row["plan_date"])
    effective_minutes_by_task = _effective_minutes_by_task(segments)
    total_minutes_by_task = _total_minutes_by_task(segments)
    tasks = connection.execute(
        "SELECT * FROM tasks WHERE plan_id=?",
        (plan_id,),
    ).fetchall()
    for task in tasks:
        has_records = any(record["task_id"] == task["id"] for record in segments)
        if not has_records and task["legacy_actual_minutes"] is None:
            continue
        effective_minutes = (task["legacy_actual_minutes"] or 0) + effective_minutes_by_task.get(task["id"], 0)
        total_minutes = (task["legacy_actual_minutes"] or 0) + total_minutes_by_task.get(task["id"], 0)
        if task["completion_override"] is not None:
            completed = int(bool(task["completion_override"]))
        else:
            # 学习目标以有效投入达标；计总标签继续保留在投入统计中。
            learning = task["category"] in {"math", "english", "computer", "ai_project", "vibe_coding", "algorithm", "reading", "writing"}
            completion_minutes = effective_minutes if learning else total_minutes
            reaches_planned_total = task["estimated_minutes"] > 0 and completion_minutes >= task["estimated_minutes"]
            if task["task_type"] is None:
                # 旧记录维持旧完成含义，迁移不重新解释历史结果。
                completed = task["completed"]
            elif task["task_type"] == "todo":
                completed = task["completed"]
            elif task["task_type"] == "habit":
                completed = int(task["habit_status"] == "done")
            else:
                completed = int(reaches_planned_total)
        if task["habit_status"] is not None:
            completed = int(task["habit_status"] == "done")
        connection.execute(
            "UPDATE tasks SET actual_minutes=?, completed=? WHERE id=?",
            (effective_minutes, completed, task["id"]),
        )


def _has_saved_execution(tasks, records) -> bool:
    return bool(records) or any((task["actual_minutes"] or 0) > 0 or task["habit_status"] is not None or task["completed"] for task in tasks)


def _build_execution_payload(connection, plan_date: str) -> dict:
    settings = _get_settings(connection)
    plan = _get_plan_row(connection, plan_date)
    segments = _list_execution_segments(connection, plan_date)
    duration_records = _list_duration_records(connection, plan_date)
    records = segments + [dict(row, segment_kind="effective") for row in duration_records]
    active = _get_active_execution_segment(connection, plan_date)
    plan_payload = None
    tasks = []
    if plan:
        _sync_plan_actual_minutes_from_execution(connection, plan["id"], records)
        tasks = _get_plan_task_rows(connection, plan["id"])
        plan_payload = _serialize_plan(connection, plan_date)
    return {
        "date": plan_date,
        "plan": plan_payload,
        "tasks": tasks,
        "labels": _serialize_execution_labels(settings),
        "active_segment": _serialize_execution_segment_row(active) if active else None,
        "segments": segments,
        "duration_records": duration_records,
        "task_execution_board": _aggregate_execution_board(tasks, records),
        "has_execution": _has_saved_execution(tasks, records),
        "has_review": connection.execute("SELECT 1 FROM reviews WHERE review_date=?", (plan_date,)).fetchone() is not None,
    }


def _assert_segment_time_window(started_at: datetime, ended_at: datetime) -> None:
    if _parse_iso_datetime(ended_at.replace(microsecond=0).isoformat()) <= _parse_iso_datetime(started_at.replace(microsecond=0).isoformat()):
        raise HTTPException(422, "结束时间必须晚于开始时间")


def _assert_no_segment_overlap(connection, plan_date: str, task_id: int, started_at: str, ended_at: str | None, skip_segment_id: int | None = None) -> None:
    start = _parse_iso_datetime(started_at)
    end = _parse_iso_datetime(ended_at) if ended_at else None
    # 不按计划日期过滤，也不依赖 ISO 字符串的字典序；激活段延伸至未来。
    rows = connection.execute("SELECT id,started_at,ended_at FROM task_execution_segments").fetchall()
    for row in rows:
        if row["id"] == skip_segment_id:
            continue
        other_start = _parse_iso_datetime(row["started_at"])
        other_end = _parse_iso_datetime(row["ended_at"])
        if other_end is not None and other_end <= other_start:
            continue
        if (end is None or other_start < end) and (other_end is None or other_end > start):
            raise HTTPException(409, "时间段发生重叠，请先调整现有记录（含其他日期）")


def _close_active_execution_segment(connection, plan_date: str | None = None, ended_at: str | None = None):
    active = _get_active_execution_segment(connection, plan_date)
    if not active:
        return None
    effective_end = ended_at or _now_iso()
    if _parse_iso_datetime(effective_end) <= _parse_iso_datetime(active["started_at"]):
        effective_end = active["started_at"]
    connection.execute("UPDATE task_execution_segments SET ended_at=? WHERE id=?", (effective_end, active["id"]))
    return active["task_id"]


def _serialize_review_row(review) -> dict:
    if not review:
        return dict(EMPTY_REVIEW)
    return {
        "mood": review["mood"] or "",
        "hardest_point": review["hardest_point"] or review["distraction"] or "",
        "effective_method": review["effective_method"] or "",
        "optimization_note": review["optimization_note"] or "",
        "real_progress": review["real_progress"] or "",
        "tomorrow_focus": review["tomorrow_focus"] or "",
        "reflection_text": review["reflection_text"] or "",
    }


def _serialize_daily_review(connection, plan_date: str) -> dict:
    plan = connection.execute("SELECT * FROM plans WHERE plan_date=?", (plan_date,)).fetchone()
    review = connection.execute(
        """SELECT distraction,mood,hardest_point,effective_method,optimization_note,
                  real_progress,tomorrow_focus,reflection_text
           FROM reviews WHERE review_date=?""",
        (plan_date,),
    ).fetchone()
    task_rows = []
    task_board = []
    records = []
    if plan:
        records = _execution_records(connection, plan_date)
        if records:
            _sync_plan_actual_minutes_from_execution(connection, plan["id"], records)
        task_rows = connection.execute(
            "SELECT * FROM tasks WHERE plan_id=?",
            (plan["id"],),
        ).fetchall()
        task_board = _aggregate_execution_board(
            [dict(row) | {"completed": bool(row["completed"]), "is_sub": bool(row["is_sub"])} for row in task_rows],
            records,
        )

    main_tasks = [row for row in task_rows if _is_planned_main_task(row)]
    sub_tasks = [row for row in task_rows if row["is_sub"]]
    status = plan["status"] if plan else None
    status_label = {
        None: "未生成",
        "draft": "草稿",
        "approved": "已确认",
        "submitted": "已提交",
    }[status]

    seconds = {
        "main_actual": sum(t["effective_seconds"] for t in task_board if not t["is_sub"]),
        "sub_actual": sum(t["effective_seconds"] for t in task_board if t["is_sub"]),
        "main_total": sum(t["total_seconds"] for t in task_board if not t["is_sub"]),
        "sub_total": sum(t["total_seconds"] for t in task_board if t["is_sub"]),
        "english": sum(t["effective_seconds"] for t in task_board if t["category"] == "english"),
        "vocabulary": sum(label["seconds"] for t in task_board for label in t["effective_labels"] if label["label_id"] == "effective_english_words"),
    }
    return {
        **{f"{key}_seconds": value for key, value in seconds.items()},
        "date": plan_date,
        "status": status,
        "status_label": status_label,
        "main_task_count": len(main_tasks),
        "main_completed_count": sum(row["completed"] for row in main_tasks),
        "main_planned_minutes": sum(row["estimated_minutes"] for row in main_tasks),
        "english_minutes": seconds["english"] // 60,
        "vocabulary_minutes": seconds["vocabulary"] // 60,
        "main_actual_minutes": seconds["main_actual"] // 60,
        "sub_actual_minutes": seconds["sub_actual"] // 60,
        "main_total_minutes": seconds["main_total"] // 60,
        "sub_total_minutes": seconds["sub_total"] // 60,
        "sub_completed_count": sum(row["completed"] for row in sub_tasks),
        "has_review": bool(review),
        "has_execution": _has_saved_execution(task_rows, records),
        "task_execution_board": task_board,
        "review": _serialize_review_row(review),
    }

def _daily_prompt_settings(settings: dict) -> dict:
    return {
        "daily_gpt_prompts": settings["daily_gpt_prompts"],
        "daily_gpt_active_prompt_id": settings["daily_gpt_active_prompt_id"],
    }


def _weekly_prompt_settings(settings: dict) -> dict:
    return {
        "project_start_date": settings["project_start_date"],
        "weekly_analysis_prompts": settings["weekly_analysis_prompts"],
        "weekly_analysis_active_prompt_id": settings["weekly_analysis_active_prompt_id"],
        "chatgpt_export_prompts": settings["chatgpt_export_prompts"],
        "chatgpt_export_active_prompt_id": settings["chatgpt_export_active_prompt_id"],
        "weekly_gpt_prompts": settings["weekly_gpt_prompts"],
        "weekly_gpt_active_prompt_id": settings["weekly_gpt_active_prompt_id"],
    }


def _serialize_gpt_record_row(row, record_type: str, anchor_key: str, date_label: str, prompt_text: str) -> dict:
    if not row:
        return {
            "record_type": record_type,
            "anchor_key": anchor_key,
            "date_label": date_label,
            "prompt_text": prompt_text,
            "response_text": "",
            "adopted_text": "",
            "created_at": None,
            "updated_at": None,
        }
    return {
        "record_type": row["record_type"],
        "anchor_key": row["anchor_key"],
        "date_label": row["date_label"] or date_label,
        "prompt_text": row["prompt_text"] or prompt_text,
        "response_text": row["response_text"] or "",
        "adopted_text": row["adopted_text"] or "",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _get_gpt_record(connection, record_type: str, anchor_key: str, date_label: str, prompt_text: str) -> dict:
    row = connection.execute(
        """SELECT record_type,anchor_key,date_label,prompt_text,response_text,adopted_text,created_at,updated_at
           FROM gpt_collab_records WHERE record_type=? AND anchor_key=?""",
        (record_type, anchor_key),
    ).fetchone()
    return _serialize_gpt_record_row(row, record_type, anchor_key, date_label, prompt_text)


def _save_gpt_record(
    connection,
    record_type: str,
    anchor_key: str,
    date_label: str,
    prompt_text: str,
    response_text: str,
    adopted_text: str,
) -> dict:
    connection.execute(
        """INSERT INTO gpt_collab_records(
               record_type,anchor_key,date_label,prompt_text,response_text,adopted_text
           ) VALUES(?,?,?,?,?,?)
           ON CONFLICT(record_type,anchor_key) DO UPDATE SET
               date_label=excluded.date_label,
               prompt_text=excluded.prompt_text,
               response_text=excluded.response_text,
               adopted_text=excluded.adopted_text,
               updated_at=CURRENT_TIMESTAMP""",
        (record_type, anchor_key, date_label, prompt_text, response_text, adopted_text),
    )
    return _get_gpt_record(connection, record_type, anchor_key, date_label, prompt_text)


def _list_gpt_records(connection, record_type: str) -> list[dict]:
    rows = connection.execute(
        """SELECT record_type,anchor_key,date_label,prompt_text,response_text,adopted_text,created_at,updated_at
           FROM gpt_collab_records
           WHERE record_type=? AND (response_text <> '' OR adopted_text <> '')
           ORDER BY updated_at DESC, id DESC LIMIT 24""",
        (record_type,),
    ).fetchall()
    return [
        {
            "record_type": row["record_type"],
            "anchor_key": row["anchor_key"],
            "date_label": row["date_label"],
            "prompt_text": row["prompt_text"],
            "response_text": row["response_text"],
            "adopted_text": row["adopted_text"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


def _clear_daily_data(connection, plan_date: str) -> dict:
    deleted_review = connection.execute("DELETE FROM reviews WHERE review_date=?", (plan_date,)).rowcount > 0
    plan = connection.execute("SELECT id FROM plans WHERE plan_date=?", (plan_date,)).fetchone()
    deleted_plan = False
    if plan:
        connection.execute("DELETE FROM plans WHERE id=?", (plan["id"],))
        deleted_plan = True
    return {
        "date": plan_date,
        "deleted_plan": deleted_plan,
        "deleted_review": deleted_review,
        "message": "当日数据已清空" if deleted_plan or deleted_review else "当日原本没有可清空的数据",
    }


def _insert_tasks(connection, plan_id: int, tasks: list[TaskDraft]) -> None:
    for position, task in enumerate(tasks):
        connection.execute(
            """INSERT INTO tasks(plan_id,title,category,estimated_minutes,priority,
               completion_criteria,reason,source,position,sub_category,is_sub,task_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                plan_id,
                task.title,
                task.category,
                task.estimated_minutes,
                task.priority,
                task.completion_criteria,
                task.reason,
                task.source,
                position,
                task.sub_category,
                task.is_sub,
                task.task_type or ("habit" if task.category == "rehab" else "daily_goal"),
            ),
        )


def _validate_plan_tasks_for_update(tasks: list[TaskDraft], available_minutes: int) -> None:
    if not tasks or len(tasks) > 15:
        raise HTTPException(422, "任务数量不合规")
    if not validate_ai_tasks(tasks, available_minutes):
        raise HTTPException(422, "任务数量、时长或类别不合规")


def _compute_weekly_metrics(connection, start: date, end: date, days: list[dict] | None = None) -> dict:
    days = days if days is not None else [
        _serialize_daily_review(connection, (start + timedelta(days=offset)).isoformat())
        for offset in range((end - start).days + 1)
    ]
    eligible = [day for day in days if day["date"] <= date.today().isoformat()
                and day["status"] in ("approved", "submitted")]
    task_count = sum(day["main_task_count"] for day in eligible)
    completed = sum(day["main_completed_count"] for day in eligible)
    effective = sum(day["main_actual_seconds"] for day in eligible)
    total = sum(day["main_total_seconds"] for day in eligible)
    distribution: dict[str, dict] = {}
    for day in eligible:
        for task in day["task_execution_board"]:
            if task["is_sub"]:
                continue
            item = distribution.setdefault(task["category"], {
                "category": task["category"], "title": task["task_title"],
                "total_seconds": 0, "effective_seconds": 0,
            })
            item["total_seconds"] += task["total_seconds"]
            item["effective_seconds"] += task["effective_seconds"]
    for item in distribution.values():
        item["total_minutes"] = item["total_seconds"] // 60
        item["effective_minutes"] = item["effective_seconds"] // 60
    return {
        "start_date": start.isoformat(), "end_date": end.isoformat(),
        "review_days": sum(day["has_review"] for day in days if day["date"] <= date.today().isoformat()),
        "task_count": task_count, "completed_count": completed,
        "completed_sub_count": sum(day["sub_completed_count"] for day in eligible),
        "completion_rate": round(completed / task_count, 3) if task_count else 0,
        "planned_minutes": sum(day["main_planned_minutes"] for day in eligible),
        "actual_minutes": effective // 60, "total_minutes": total // 60,
        "actual_seconds": effective, "total_seconds": total,
        "effective_ratio": round(effective / total, 4) if total else 0,
        "actual_sub_minutes": sum(day["sub_actual_seconds"] for day in eligible) // 60,
        "total_sub_minutes": sum(day["sub_total_seconds"] for day in eligible) // 60,
        "total_sub_seconds": sum(day["sub_total_seconds"] for day in eligible),
        "english_minutes": sum(day["english_seconds"] for day in eligible) // 60,
        "vocabulary_minutes": sum(day["vocabulary_seconds"] for day in eligible) // 60,
        "task_distribution": sorted(distribution.values(), key=lambda item: item["total_minutes"], reverse=True),
    }


def _build_weekly_snapshot(connection, start: date, end: date) -> dict:
    days = [_serialize_daily_review(connection, (start + timedelta(days=offset)).isoformat())
            for offset in range((end - start).days + 1)]
    return _compute_weekly_metrics(connection, start, end, days) | {"days": days}


def _calendar_day_state(day: date, project_start: date, today: date, plan_status: str | None, has_review: bool, has_history: bool = False) -> dict:
    if day > today or (day < project_start and not has_history):
        return {
            "visibility": "out_of_range",
            "status": None,
            "is_today": day == today,
            "is_future": day > today,
        }
    if has_review:
        status_value = "reviewed"
    elif plan_status == "submitted":
        status_value = "submitted"
    elif plan_status == "approved":
        status_value = "planned"
    else:
        status_value = "empty"
    return {
        "visibility": "in_range",
        "status": status_value,
        "is_today": day == today,
        "is_future": False,
    }


def _build_calendar_status(connection, month_start: date, project_start: date) -> dict:
    if month_start.month == 12:
        next_month = date(month_start.year + 1, 1, 1)
    else:
        next_month = date(month_start.year, month_start.month + 1, 1)
    month_end = next_month - timedelta(days=1)
    today = date.today()

    plan_rows = connection.execute(
        "SELECT plan_date,status FROM plans WHERE plan_date BETWEEN ? AND ?",
        (month_start.isoformat(), month_end.isoformat()),
    ).fetchall()
    review_rows = connection.execute(
        "SELECT review_date FROM reviews WHERE review_date BETWEEN ? AND ?",
        (month_start.isoformat(), month_end.isoformat()),
    ).fetchall()

    plan_statuses = {row["plan_date"]: row["status"] for row in plan_rows}
    review_dates = {row["review_date"] for row in review_rows}
    execution_dates = {row[0] for row in connection.execute(
        "SELECT DISTINCT plan_date FROM task_execution_segments WHERE plan_date BETWEEN ? AND ?",
        (month_start.isoformat(), month_end.isoformat()))}
    reset_dates = {row[0] for row in connection.execute(
        "SELECT DISTINCT plan_date FROM daily_reset_snapshots WHERE restored_at IS NULL AND plan_date BETWEEN ? AND ?",
        (month_start.isoformat(), month_end.isoformat()))}
    history_dates = set(plan_statuses) | review_dates | execution_dates | reset_dates

    days = []
    cursor = month_start
    while cursor <= month_end:
        state = _calendar_day_state(
            cursor,
            project_start,
            today,
            plan_statuses.get(cursor.isoformat()),
            cursor.isoformat() in review_dates,
            cursor.isoformat() in history_dates,
        )
        days.append({
            "date": cursor.isoformat(),
            "day": cursor.day,
            **state,
        })
        cursor += timedelta(days=1)

    return {
        "month": month_start.strftime("%Y-%m"),
        "month_start": month_start.isoformat(),
        "month_end": month_end.isoformat(),
        "project_start_date": project_start.isoformat(),
        "days": days,
    }


def _build_chatgpt_prompt(snapshot: dict, deepseek_analysis: dict | None, export_template: str) -> str:
    lines = [
        export_template,
        "",
        f"周范围：{snapshot['start_date']} 到 {snapshot['end_date']}",
        f"主任务完成率：{round(snapshot['completion_rate'] * 100)}%",
        f"主任务完成数：{snapshot['completed_count']} / {snapshot['task_count']}",
        f"主任务计划分钟：{snapshot['planned_minutes']} 分",
        f"主任务实际分钟：{snapshot['actual_minutes']} 分",
        f"主航线总计投入：{snapshot['total_minutes']} 分",
        f"秒级合计：主航线有效 {snapshot['actual_seconds']} 秒，总计 {snapshot['total_seconds']} 秒（分钟显示向下取整，零头未丢失）",
        f"主航线有效率：{round(snapshot['effective_ratio'] * 100)}%（有效时间总和 / 总计时间总和）",
        "统计包含已保存执行记录，提交仅表示收尾完成。",
        f"副航线实际分钟：{snapshot['actual_sub_minutes']} 分",
        f"英语 {snapshot['english_minutes']} 分，其中背单词 {snapshot['vocabulary_minutes']} 分（已包含在实际分钟中）",
        f"本周写复盘的天数：{snapshot['review_days']} 天",
        "",
    ]
    if deepseek_analysis:
        lines.extend([
            "这是系统自动生成的一版周分析草稿，你可以参考也可以推翻：",
            json.dumps(deepseek_analysis, ensure_ascii=False, indent=2),
            "",
        ])
    lines.append("下面是逐日记录：")
    for day in snapshot["days"]:
        review = day["review"]
        lines.extend([
            f"- 日期：{day['date']}",
            f"  计划状态：{day['status_label']}",
            f"  主任务完成：{day['main_completed_count']} / {day['main_task_count']}",
            f"  主任务分钟：计划 {day['main_planned_minutes']} / 实际 {day['main_actual_minutes']}",
            f"  副航线实际：{day['sub_actual_minutes']} 分",
            f"  英语 {day['english_minutes']} 分，其中背单词 {day['vocabulary_minutes']} 分",
            f"  情绪：{review['mood'] or '未写'}",
            f"  最卡点：{review['hardest_point'] or '未写'}",
            f"  有效方法：{review['effective_method'] or '未写'}",
            f"  小优化：{review['optimization_note'] or '未写'}",
            f"  推进感：{review['real_progress'] or '未写'}",
            f"  明天保持：{review['tomorrow_focus'] or '未写'}",
            f"  补充复盘：{review['reflection_text'] or '未写'}",
            "",
        ])
    return "\n".join(lines)


def _build_daily_gpt_prompt(connection, plan_date: str, export_template: str) -> str:
    daily = _serialize_daily_review(connection, plan_date)
    plan = connection.execute("SELECT id FROM plans WHERE plan_date=?", (plan_date,)).fetchone()
    tasks = []
    if plan:
        task_rows = connection.execute(
            """SELECT title,category,estimated_minutes,actual_minutes,completed,is_sub,sub_category,task_type,habit_status
               FROM tasks WHERE plan_id=? ORDER BY position,id""",
            (plan["id"],),
        ).fetchall()
        tasks = [
            {
                "task_type": row["task_type"] or ("habit" if row["category"] == "rehab" else "daily_goal"),
                "habit_status": row["habit_status"],
                "title": row["title"],
                "category": row["category"],
                "estimated_minutes": row["estimated_minutes"],
                "actual_minutes": row["actual_minutes"] or 0,
                "completed": bool(row["completed"]),
                "is_sub": bool(row["is_sub"]),
                "sub_category": row["sub_category"] or "",
            }
            for row in task_rows
        ]

    lines = [
        export_template,
        "",
        f"日期：{plan_date}",
        f"计划状态：{daily['status_label']}",
        f"主任务完成：{daily['main_completed_count']} / {daily['main_task_count']}",
        f"主任务分钟：计划 {daily['main_planned_minutes']} / 实际 {daily['main_actual_minutes']}",
        f"秒级合计：主航线有效 {daily['main_actual_seconds']} 秒，总计 {daily['main_total_seconds']} 秒（分钟显示向下取整，零头未丢失）",
        f"副航线实际：{daily['sub_actual_minutes']} 分",
        f"英语 {daily['english_minutes']} 分，其中背单词 {daily['vocabulary_minutes']} 分（已包含在实际分钟中）",
        "",
        "今天的任务明细：",
    ]
    if tasks:
        for task in tasks:
            route_label = "副航线" if task["is_sub"] else "主航线"
            lines.append(
                f"- {route_label}｜{task['title']}｜计划 {task['estimated_minutes']} 分｜实际 {task['actual_minutes']} 分｜"
                f"{dict(habit='习惯', daily_goal='每日目标', todo='具体待办')[task['task_type']]}｜"
                f"{dict(done='做了', missed='没做', rest='休息').get(task['habit_status'], '已完成' if task['completed'] else '未完成')}"
            )
    else:
        lines.append("- 今天还没有保存任务计划。")

    review = daily["review"]
    lines.extend([
        "",
        "今天的结构化复盘：",
        f"- 情绪：{review['mood'] or '未写'}",
        f"- 最卡点：{review['hardest_point'] or '未写'}",
        f"- 有效方法：{review['effective_method'] or '未写'}",
        f"- 小优化：{review['optimization_note'] or '未写'}",
        f"- 推进感：{review['real_progress'] or '未写'}",
        f"- 明天保持：{review['tomorrow_focus'] or '未写'}",
        f"- 补充复盘：{review['reflection_text'] or '未写'}",
    ])
    return "\n".join(lines)


def _snapshot_hash(snapshot: dict) -> tuple[str, str]:
    snapshot_json = json.dumps(snapshot, ensure_ascii=False, sort_keys=True)
    digest = hashlib.sha256(snapshot_json.encode("utf-8")).hexdigest()
    return snapshot_json, digest


def _serialize_weekly_report_row(row) -> dict | None:
    if not row:
        return None
    analysis = json.loads(row["deepseek_analysis_json"]) if row["deepseek_analysis_json"] else None
    snapshot = json.loads(row["snapshot_json"]) if row["snapshot_json"] else {}
    return {
        "start_date": row["start_date"],
        "end_date": row["end_date"],
        "snapshot": snapshot,
        "deepseek_analysis": analysis,
        "chatgpt_prompt_text": row["chatgpt_prompt_text"],
        "final_report_text": row["final_report_text"],
        "ai_status": row["ai_status"],
        "ai_error": row["ai_error"],
        "updated_at": row["updated_at"],
        "has_final_report": bool((row["final_report_text"] or "").strip()),
        "has_ai_draft": analysis is not None,
    }


def _get_weekly_report(connection, end_date: str):
    row = connection.execute("SELECT * FROM weekly_reports WHERE end_date=?", (end_date,)).fetchone()
    return _serialize_weekly_report_row(row)


def _save_weekly_report(
    connection,
    snapshot: dict,
    snapshot_json: str,
    snapshot_hash: str,
    deepseek_analysis: dict | None,
    chatgpt_prompt_text: str,
    ai_status: str,
    ai_error: str | None,
    final_report_text: str = "",
) -> None:
    connection.execute(
        """INSERT INTO weekly_reports(
               end_date,start_date,snapshot_json,snapshot_hash,deepseek_analysis_json,
               chatgpt_prompt_text,final_report_text,ai_status,ai_error
           ) VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(end_date) DO UPDATE SET
               start_date=excluded.start_date,
               snapshot_json=excluded.snapshot_json,
               snapshot_hash=excluded.snapshot_hash,
               deepseek_analysis_json=excluded.deepseek_analysis_json,
               chatgpt_prompt_text=excluded.chatgpt_prompt_text,
               final_report_text=CASE
                   WHEN excluded.final_report_text = '' THEN weekly_reports.final_report_text
                   ELSE excluded.final_report_text
               END,
               ai_status=excluded.ai_status,
               ai_error=excluded.ai_error,
               updated_at=CURRENT_TIMESTAMP""",
        (
            snapshot["end_date"],
            snapshot["start_date"],
            snapshot_json,
            snapshot_hash,
            json.dumps(deepseek_analysis, ensure_ascii=False) if deepseek_analysis else None,
            chatgpt_prompt_text,
            final_report_text,
            ai_status,
            ai_error,
        ),
    )


def _build_weekday_progress(snapshot: dict) -> dict:
    labels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    today = date.today().isoformat()
    days = []
    saved_count = 0
    for index, day in enumerate(snapshot["days"]):
        review = day["review"]
        has_content = bool(day["has_review"]) and day["date"] <= today
        if has_content:
            saved_count += 1
        days.append({
            "date": day["date"],
            "label": labels[index],
            "has_review": has_content,
            "is_future": day["date"] > today,
            "is_clickable": day["date"] <= today,
            "has_execution": bool(day["task_execution_board"]),
        })
    return {
        "saved_count": saved_count,
        "total": 7,
        "progress_ratio": round(saved_count / 7, 3),
        "days": days,
    }


def _read_weekly_report(connection, snapshot: dict, settings: dict) -> dict:
    """读取当前事实及已有分析；导航不保存快照、不发起分析。"""
    existing = _get_weekly_report(connection, snapshot["end_date"])
    analysis = existing["deepseek_analysis"] if existing else None
    prompt = _resolve_prompt_content(settings, "chatgpt_export_prompts", "chatgpt_export_active_prompt_id",
                                     "chatgpt_export_system_default", CHATGPT_EXPORT_SYSTEM_PROMPT)
    return {
        "start_date": snapshot["start_date"], "end_date": snapshot["end_date"],
        "snapshot": snapshot, "deepseek_analysis": analysis,
        "chatgpt_prompt_text": _build_chatgpt_prompt(snapshot, analysis, prompt),
        "final_report_text": existing["final_report_text"] if existing else "",
        "ai_status": existing["ai_status"] if existing else "unavailable",
        "ai_error": existing["ai_error"] if existing else None,
        "updated_at": existing["updated_at"] if existing else None,
        "has_final_report": bool(existing and existing["has_final_report"]),
        "has_ai_draft": analysis is not None,
        "analysis_stale": bool(analysis and _snapshot_hash(existing["snapshot"])[1] != _snapshot_hash(snapshot)[1]),
    }


def _list_weekly_reports(connection) -> list[dict]:
    rows = connection.execute(
        """SELECT end_date,start_date,deepseek_analysis_json,final_report_text,ai_status,updated_at
           FROM weekly_reports ORDER BY end_date DESC LIMIT 12"""
    ).fetchall()
    return [
        {
            "start_date": row["start_date"],
            "end_date": row["end_date"],
            "ai_status": row["ai_status"],
            "updated_at": row["updated_at"],
            "has_ai_draft": bool(row["deepseek_analysis_json"]),
            "has_final_report": bool((row["final_report_text"] or "").strip()),
        }
        for row in rows
    ]


@router.post("/daily-plans/draft", status_code=status.HTTP_201_CREATED)
def create_draft(payload: DraftRequest, request: Request):
    checkin = payload.model_copy(update={"plan_date": payload.date})
    rule_plan = build_rule_plan(checkin)
    tasks = rule_plan.tasks
    degraded_reason = None

    with _db(request) as connection:
        day = payload.date.isoformat()
        _capture_unfinished(connection, day)
        settings = _get_settings(connection)
        if not settings["rehab_enabled"]:
            tasks = [task for task in tasks if task.category != "rehab"]

        tasks = [task.model_copy(update={"title": settings["task_titles"].get(task.category, task.title)}) for task in tasks]
        tasks = _apply_draft_main_minutes(tasks, settings)
        tasks = [task.model_copy(update={"estimated_minutes": payload.target_minutes.get(task.category, task.estimated_minutes)}) for task in tasks]
        scheduled = connection.execute(
            """SELECT * FROM carryovers WHERE status='resolved' AND
               ((resolution='reschedule' AND target_date=?) OR
                (resolution='split' AND (target_date=? OR target_date IS NULL)))""",
            (day, day),
        ).fetchall()
        for item in scheduled:
            tasks.append(TaskDraft(
                title=item["split_title"] or item["title"],
                category=item["category"],
                estimated_minutes=item["estimated_minutes"],
                priority=2,
                completion_criteria="完成这项经过人工重排的任务",
                reason="来自待审池的人工决定",
                source="carryover",
                task_type="todo",
            ))
        planner = getattr(request.app.state, "ai_planner", None)
        if planner is not None:
            result = planner.generate(checkin, tasks)
            tasks = result.tasks
            degraded_reason = result.degraded_reason
        existing = connection.execute("SELECT id,status FROM plans WHERE plan_date=?", (day,)).fetchone()
        if existing and existing["status"] in ("approved", "submitted"):
            raise HTTPException(409, "当日计划已经确认或提交")
        if existing:
            connection.execute("DELETE FROM plans WHERE id=?", (existing["id"],))
        cursor = connection.execute(
            """INSERT INTO plans(plan_date,energy,available_minutes,day_type,methods_json,
               safety_notice,degraded_reason) VALUES(?,?,?,?,?,?,?)""",
            (
                day,
                payload.energy,
                payload.available_minutes,
                payload.day_type,
                json.dumps(rule_plan.methods, ensure_ascii=False),
                rule_plan.safety_notice,
                degraded_reason,
            ),
        )
        _insert_tasks(connection, cursor.lastrowid, tasks)
        if scheduled:
            connection.executemany("UPDATE carryovers SET status='consumed' WHERE id=?", [(item["id"],) for item in scheduled])
        return _serialize_plan(connection, day)


@router.get("/daily-plans/{plan_date}")
def get_plan(plan_date: date, request: Request):
    with _db(request) as connection:
        return _serialize_plan(connection, plan_date.isoformat())


@router.put("/daily-plans/{plan_date}")
def update_plan(plan_date: date, payload: PlanUpdate, request: Request):
    tasks = [TaskDraft.model_validate(task.model_dump(exclude={"id"})) for task in payload.tasks]
    with _db(request) as connection:
        plan = connection.execute("SELECT * FROM plans WHERE plan_date=?", (plan_date.isoformat(),)).fetchone()
        if not plan:
            raise HTTPException(404, "计划不存在")
        if plan["status"] != "draft":
            raise HTTPException(409, "已确认计划不可编辑")
        _validate_plan_tasks_for_update(tasks, plan["available_minutes"])
        connection.execute("DELETE FROM tasks WHERE plan_id=?", (plan["id"],))
        _insert_tasks(connection, plan["id"], tasks)
        return _serialize_plan(connection, plan_date.isoformat())


@router.post("/daily-plans/{plan_date}/approve")
def approve_plan(plan_date: date, request: Request):
    with _db(request) as connection:
        cursor = connection.execute(
            "UPDATE plans SET status='approved' WHERE plan_date=? AND status='draft'",
            (plan_date.isoformat(),),
        )
        if cursor.rowcount == 0:
            raise HTTPException(409, "计划不存在或已经确认")
        return _serialize_plan(connection, plan_date.isoformat())


@router.post("/daily-plans/{plan_date}/submit")
def submit_plan(plan_date: date, request: Request):
    with _db(request) as connection:
        active = _get_active_execution_segment(connection, plan_date.isoformat())
        if active:
            raise HTTPException(409, "还有正在计时的记录，请先停止当前执行")
        plan = _get_plan_row(connection, plan_date.isoformat())
        if plan and _plan_has_execution_segments(connection, plan_date.isoformat()):
            _sync_plan_actual_minutes_from_execution(connection, plan["id"])
        cursor = connection.execute(
            "UPDATE plans SET status='submitted' WHERE plan_date=? AND status='approved'",
            (plan_date.isoformat(),),
        )
        if cursor.rowcount == 0:
            existing = connection.execute("SELECT status FROM plans WHERE plan_date=?", (plan_date.isoformat(),)).fetchone()
            if not existing:
                raise HTTPException(404, "计划不存在")
            if existing["status"] == "draft":
                raise HTTPException(409, "草稿无法提交")
        return _serialize_plan(connection, plan_date.isoformat())


@router.patch("/tasks/{task_id}")
def update_task(task_id: int, payload: TaskUpdate, request: Request):
    with _db(request) as connection:
        row = connection.execute(
            "SELECT t.*, p.id as plan_id, p.status as plan_status FROM tasks t JOIN plans p ON p.id=t.plan_id WHERE t.id=?",
            (task_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "任务不存在")
        if row["plan_status"] not in ("approved", "submitted"):
            raise HTTPException(409, "计划确认后才能勾选或修改任务")

        completed = row["completed"]
        actual_minutes = row["actual_minutes"] or 0
        sub_category = row["sub_category"]
        completion_override = row["completion_override"]

        if payload.completed is not None:
            completed = int(payload.completed)
            completion_override = completed
        if payload.actual_minutes is not None:
            actual_minutes = payload.actual_minutes
            if row["is_sub"] and (row["task_type"] or "daily_goal") == "daily_goal":
                completed = int(row["estimated_minutes"] > 0 and actual_minutes >= row["estimated_minutes"])
        if payload.sub_category is not None:
            sub_category = payload.sub_category

        task_type = payload.task_type or row["task_type"] or ("habit" if row["category"] == "rehab" else "daily_goal")
        habit_status = payload.habit_status if payload.habit_status is not None else row["habit_status"]
        if payload.habit_status is not None and task_type != "habit":
            raise HTTPException(422, "只有习惯可以记录做了、没做或休息")
        if payload.habit_status is not None:
            completed = int(habit_status == "done")
            completion_override = completed
        if payload.actual_minutes is not None:
            if connection.execute("SELECT 1 FROM task_execution_segments WHERE task_id=? UNION ALL SELECT 1 FROM task_duration_records WHERE task_id=?", (task_id, task_id)).fetchone():
                raise HTTPException(409, "已有执行明细，请编辑明细记录")
            connection.execute("UPDATE tasks SET legacy_actual_minutes=? WHERE id=?", (actual_minutes, task_id))
        connection.execute("UPDATE tasks SET task_type=?, habit_status=? WHERE id=?", (task_type, habit_status if task_type == "habit" else None, task_id))
        connection.execute(
            "UPDATE tasks SET completed=?, completion_override=?, actual_minutes=?, sub_category=? WHERE id=?",
            (completed, completion_override, actual_minutes, sub_category, task_id),
        )

        if row["plan_status"] == "submitted":
            connection.execute("UPDATE plans SET status='approved' WHERE id=?", (row["plan_id"],))

        updated = connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return _serialize_task_row(updated)


@router.get("/daily-execution/{plan_date}")
def daily_execution(plan_date: date, request: Request):
    with _db(request) as connection:
        return _build_execution_payload(connection, plan_date.isoformat())


@router.post("/daily-execution/{plan_date}/tasks/start")
def start_execution_task(plan_date: date, payload: ExecutionTaskStartInput, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        task = _get_task_row_for_execution(connection, plan_date.isoformat(), payload.task_id)
        _prepare_execution_task(connection, task)
        settings = _get_settings(connection)
        label_id, label_name = _resolve_segment_label(settings, task["category"], payload.label_id, "effective")
        if task["category"] == "english" and label_id == "effective_english_words" and _list_duration_records(connection, plan_date.isoformat()):
            if payload.duplicate_choice is None:
                raise HTTPException(409, "当天已有墨墨录入，请明确选择保留哪份背单词记录")
            _apply_vocabulary_choice(connection, plan_date.isoformat(), payload.duplicate_choice)
        _close_active_execution_segment(connection)
        started_at = _now_iso()
        _assert_no_segment_overlap(connection, plan_date.isoformat(), task["id"], started_at, None)
        connection.execute(
            """INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,label_id,label_name,started_at)
               VALUES(?,?,?,?,?,?)""",
            (plan_date.isoformat(), task["id"], "effective", label_id, label_name, started_at),
        )
        if payload.duplicate_choice == "manual" and label_id == "effective_english_words" and task["category"] == "english":
            connection.execute("UPDATE task_execution_segments SET included=0 WHERE id=last_insert_rowid()"
        )
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (task["plan_id"],))
        _sync_plan_actual_minutes_from_execution(connection, task["plan_id"])
        return _build_execution_payload(connection, plan_date.isoformat())


@router.post("/daily-execution/{plan_date}/labels/start")
def start_execution_label(plan_date: date, payload: ExecutionLabelStartInput, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        settings = _get_settings(connection)
        label_map = _build_execution_label_map(settings)
        label = label_map.get(payload.label_id)
        if not label:
            raise HTTPException(404, "标签不存在")
        active = _get_active_execution_segment(connection, plan_date.isoformat())
        task_id = payload.task_id or (active["task_id"] if active else None)
        if task_id is None:
            raise HTTPException(409, "请先开始一个任务，再切换到标签")
        task = _get_task_row_for_execution(connection, plan_date.isoformat(), task_id)
        _prepare_execution_task(connection, task)
        _close_active_execution_segment(connection)
        started_at = _now_iso()
        _assert_no_segment_overlap(connection, plan_date.isoformat(), task["id"], started_at, None)
        segment_kind = "counted_label" if label["bucket"] == "counted" else "interrupt_label"
        connection.execute(
            """INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,label_id,label_name,started_at)
               VALUES(?,?,?,?,?,?)""",
            (plan_date.isoformat(), task["id"], segment_kind, label["id"], label["name"], started_at),
        )
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (task["plan_id"],))
        _sync_plan_actual_minutes_from_execution(connection, task["plan_id"])
        return _build_execution_payload(connection, plan_date.isoformat())


@router.post("/daily-execution/{plan_date}/stop")
def stop_execution(plan_date: date, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        plan = _get_plan_row(connection, plan_date.isoformat())
        closed_task_id = _close_active_execution_segment(connection, plan_date.isoformat())
        if closed_task_id is None:
            raise HTTPException(409, "当前没有正在计时的记录")
        if plan:
            _sync_plan_actual_minutes_from_execution(connection, plan["id"])
        return _build_execution_payload(connection, plan_date.isoformat())


@router.post("/daily-execution/{plan_date}/segments")
def create_execution_segment(plan_date: date, payload: ExecutionSegmentCreateInput, request: Request):
    _assert_segment_time_window(payload.started_at, payload.ended_at)
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        task = _get_task_row_for_execution(connection, plan_date.isoformat(), payload.task_id)
        _prepare_execution_task(connection, task)
        settings = _get_settings(connection)
        label_id, label_name = _resolve_segment_label(settings, task["category"], payload.label_id, payload.segment_kind)
        if task["category"] == "english" and payload.segment_kind == "effective" and label_id == "effective_english_words" and _list_duration_records(connection, plan_date.isoformat()):
            if payload.duplicate_choice is None:
                raise HTTPException(409, "当天已有墨墨录入，请明确选择保留哪份背单词记录")
            _apply_vocabulary_choice(connection, plan_date.isoformat(), payload.duplicate_choice)
        _assert_no_segment_overlap(
            connection,
            plan_date.isoformat(),
            task["id"],
            _local_iso(payload.started_at),
            _local_iso(payload.ended_at),
        )
        connection.execute(
            """INSERT INTO task_execution_segments(
                   plan_date,task_id,segment_kind,label_id,label_name,started_at,ended_at
               ) VALUES(?,?,?,?,?,?,?)""",
            (
                plan_date.isoformat(),
                task["id"],
                payload.segment_kind,
                label_id,
                label_name,
                _local_iso(payload.started_at),
                _local_iso(payload.ended_at),
            ),
        )
        if payload.duplicate_choice == "manual" and label_id == "effective_english_words" and task["category"] == "english":
            connection.execute("UPDATE task_execution_segments SET included=0 WHERE id=last_insert_rowid()")
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (task["plan_id"],))
        _sync_plan_actual_minutes_from_execution(connection, task["plan_id"])
        return _build_execution_payload(connection, plan_date.isoformat())


@router.put("/daily-execution/{plan_date}/segments/{segment_id}")
def update_execution_segment(plan_date: date, segment_id: int, payload: ExecutionSegmentUpdateInput, request: Request):
    _assert_segment_time_window(payload.started_at, payload.ended_at)
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            """SELECT s.*, t.plan_id, t.category AS task_category
               FROM task_execution_segments s
               JOIN tasks t ON t.id=s.task_id
               WHERE s.id=? AND s.plan_date=?""",
            (segment_id, plan_date.isoformat()),
        ).fetchone()
        if not existing:
            raise HTTPException(404, "时间段不存在")
        if existing["ended_at"] is None:
            raise HTTPException(409, "请先停止当前正在计时的记录，再编辑它")
        task = _get_task_row_for_execution(connection, plan_date.isoformat(), payload.task_id)
        _prepare_execution_task(connection, task)
        settings = _get_settings(connection)
        # 只改时间或任务时保留原标签快照；设置中的改名/归类仅影响新记录。
        keep_label_snapshot = (
            payload.label_id == existing["label_id"]
            and payload.segment_kind == existing["segment_kind"]
            and (payload.segment_kind != "effective" or task["category"] == existing["task_category"])
        )
        if keep_label_snapshot:
            label_id, label_name = existing["label_id"], existing["label_name"]
        else:
            label_id, label_name = _resolve_segment_label(settings, task["category"], payload.label_id, payload.segment_kind)
        if task["category"] == "english" and payload.segment_kind == "effective" and label_id == "effective_english_words" and _list_duration_records(connection, plan_date.isoformat()):
            if payload.duplicate_choice is None:
                raise HTTPException(409, "当天已有墨墨录入，请明确选择保留哪份背单词记录")
            _apply_vocabulary_choice(connection, plan_date.isoformat(), payload.duplicate_choice)
        _assert_no_segment_overlap(
            connection,
            plan_date.isoformat(),
            task["id"],
            _local_iso(payload.started_at),
            _local_iso(payload.ended_at),
            skip_segment_id=segment_id,
        )
        connection.execute(
            """UPDATE task_execution_segments
               SET task_id=?, segment_kind=?, label_id=?, label_name=?, started_at=?, ended_at=?
               WHERE id=?""",
            (
                task["id"],
                payload.segment_kind,
                label_id,
                label_name,
                _local_iso(payload.started_at),
                _local_iso(payload.ended_at),
                segment_id,
            ),
        )
        included = existing["included"] if label_id == existing["label_id"] and payload.duplicate_choice is None else 1
        if payload.duplicate_choice == "manual" and label_id == "effective_english_words" and task["category"] == "english":
            included = 0
        connection.execute("UPDATE task_execution_segments SET included=? WHERE id=?", (included, segment_id))
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (existing["plan_id"],))
        _sync_plan_actual_minutes_from_execution(connection, existing["plan_id"])
        if existing["plan_id"] != task["plan_id"]:
            connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (task["plan_id"],))
            _sync_plan_actual_minutes_from_execution(connection, task["plan_id"])
        return _build_execution_payload(connection, plan_date.isoformat())


@router.delete("/daily-execution/{plan_date}/segments/{segment_id}")
def delete_execution_segment(plan_date: date, segment_id: int, request: Request):
    with _db(request) as connection:
        existing = connection.execute(
            """SELECT s.id, s.ended_at, t.plan_id
               FROM task_execution_segments s
               JOIN tasks t ON t.id=s.task_id
               WHERE s.id=? AND s.plan_date=?""",
            (segment_id, plan_date.isoformat()),
        ).fetchone()
        if not existing:
            raise HTTPException(404, "时间段不存在")
        if existing["ended_at"] is None:
            raise HTTPException(409, "请先停止当前正在计时的记录，再删除它")
        connection.execute("DELETE FROM task_execution_segments WHERE id=?", (segment_id,))
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (existing["plan_id"],))
        _sync_plan_actual_minutes_from_execution(connection, existing["plan_id"])
        return _build_execution_payload(connection, plan_date.isoformat())


def _ensure_recordable_plan(connection, plan_date: str):
    plan = _get_plan_row(connection, plan_date)
    if not plan:
        raise HTTPException(404, "计划不存在")
    if plan["status"] not in ("approved", "submitted"):
        raise HTTPException(409, "请先确认当天清单")
    return plan


def _append_temporary_task(connection, plan, payload: TemporaryTaskInput):
    title = payload.title.strip()
    if not title:
        raise HTTPException(422, "请填写活动名称")
    if connection.execute("SELECT COUNT(*) FROM tasks WHERE plan_id=?", (plan["id"],)).fetchone()[0] >= 15:
        raise HTTPException(422, "当天最多 15 项活动")
    _insert_tasks(connection, plan["id"], [TaskDraft(title=title, category=payload.category,
        estimated_minutes=0, priority=4, reason="用户临时添加", task_type=payload.task_type)])
    task_id = connection.execute("SELECT MAX(id) FROM tasks WHERE plan_id=?", (plan["id"],)).fetchone()[0]
    connection.execute("UPDATE tasks SET position=(SELECT MAX(position)+1 FROM tasks WHERE plan_id=?) WHERE id=?", (plan["id"], task_id))
    return connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()


@router.post("/daily-execution/{plan_date}/tasks", status_code=201)
def add_temporary_task(plan_date: date, payload: TemporaryTaskInput, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        plan = _ensure_recordable_plan(connection, plan_date.isoformat())
        _append_temporary_task(connection, plan, payload)
        connection.execute("UPDATE plans SET status='approved' WHERE id=?", (plan["id"],))
        return _build_execution_payload(connection, plan_date.isoformat())


def _apply_vocabulary_choice(connection, plan_date: str, choice: str | None):
    word_segments = connection.execute(
        """SELECT s.id,s.ended_at FROM task_execution_segments s JOIN tasks t ON t.id=s.task_id
           WHERE s.plan_date=? AND t.category='english' AND s.segment_kind='effective'
           AND s.label_id='effective_english_words'""", (plan_date,)
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
           AND s.label_id='effective_english_words')""", (int(choice != "manual"), plan_date)
    )
    connection.execute(
        """UPDATE task_duration_records SET included=? WHERE task_id IN (
           SELECT t.id FROM tasks t JOIN plans p ON p.id=t.plan_id WHERE p.plan_date=?)""",
        (int(choice != "timer"), plan_date)
    )


@router.post("/daily-execution/{plan_date}/vocabulary", status_code=201)
def create_vocabulary_record(plan_date: date, payload: DurationRecordInput, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        day = plan_date.isoformat()
        plan = _ensure_recordable_plan(connection, day)
        _apply_vocabulary_choice(connection, day, payload.duplicate_choice)
        task = connection.execute("SELECT * FROM tasks WHERE plan_id=? AND category='english' ORDER BY is_sub,position,id LIMIT 1", (plan["id"],)).fetchone()
        if not task:
            task = _append_temporary_task(connection, plan, TemporaryTaskInput(title="英语", category="english"))
        _prepare_execution_task(connection, task)
        connection.execute("INSERT INTO task_duration_records(task_id,minutes,included) VALUES(?,?,?)",
            (task["id"], payload.minutes, int(payload.duplicate_choice != "timer")))
        connection.execute("UPDATE plans SET status='approved' WHERE id=?", (plan["id"],))
        return _build_execution_payload(connection, day)


@router.put("/daily-execution/{plan_date}/vocabulary/{record_id}")
def update_vocabulary_record(plan_date: date, record_id: int, payload: DurationRecordInput, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        day = plan_date.isoformat()
        plan = _ensure_recordable_plan(connection, day)
        if not any(row["id"] == record_id for row in _list_duration_records(connection, day)):
            raise HTTPException(404, "时长记录不存在")
        _apply_vocabulary_choice(connection, day, payload.duplicate_choice)
        connection.execute("UPDATE task_duration_records SET minutes=? WHERE id=?", (payload.minutes, record_id))
        connection.execute("UPDATE plans SET status='approved' WHERE id=?", (plan["id"],))
        return _build_execution_payload(connection, day)


@router.delete("/daily-execution/{plan_date}/vocabulary/{record_id}")
def delete_vocabulary_record(plan_date: date, record_id: int, request: Request):
    with _db(request) as connection:
        day = plan_date.isoformat()
        plan = _ensure_recordable_plan(connection, day)
        if not any(row["id"] == record_id for row in _list_duration_records(connection, day)):
            raise HTTPException(404, "时长记录不存在")
        connection.execute("DELETE FROM task_duration_records WHERE id=?", (record_id,))
        connection.execute("UPDATE plans SET status='approved' WHERE id=?", (plan["id"],))
        return _build_execution_payload(connection, day)


@router.get("/carryovers")
def list_carryovers(request: Request):
    with _db(request) as connection:
        return [dict(row) for row in connection.execute(
            "SELECT * FROM carryovers WHERE status='pending' ORDER BY created_at,id"
        ).fetchall()]


@router.post("/carryovers/{carryover_id}/resolve")
def resolve_carryover(carryover_id: int, payload: CarryoverResolution, request: Request):
    if payload.action == "reschedule" and payload.target_date is None:
        raise HTTPException(422, "重排必须选择日期")
    if payload.action == "split" and not payload.split_title:
        raise HTTPException(422, "拆分必须填写新任务名称")
    with _db(request) as connection:
        cursor = connection.execute(
            """UPDATE carryovers SET status='resolved',resolution=?,target_date=?,split_title=?
               WHERE id=? AND status='pending'""",
            (
                payload.action,
                payload.target_date.isoformat() if payload.target_date else None,
                payload.split_title,
                carryover_id,
            ),
        )
        if cursor.rowcount == 0:
            raise HTTPException(404, "待审项不存在")
        return dict(connection.execute("SELECT * FROM carryovers WHERE id=?", (carryover_id,)).fetchone())


@router.post("/daily-reviews")
def save_review(payload: ReviewInput, request: Request):
    with _db(request) as connection:
        connection.execute(
            """INSERT INTO reviews(
                   review_date,distraction,mood,hardest_point,effective_method,
                   optimization_note,real_progress,tomorrow_focus,reflection_text
               ) VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(review_date) DO UPDATE SET
                   distraction=excluded.distraction,
                   mood=excluded.mood,
                   hardest_point=excluded.hardest_point,
                   effective_method=excluded.effective_method,
                   optimization_note=excluded.optimization_note,
                   real_progress=excluded.real_progress,
                   tomorrow_focus=excluded.tomorrow_focus,
                   reflection_text=excluded.reflection_text""",
            (
                payload.date.isoformat(),
                payload.hardest_point,
                payload.mood,
                payload.hardest_point,
                payload.effective_method,
                payload.optimization_note,
                payload.real_progress,
                payload.tomorrow_focus,
                payload.reflection_text,
            ),
        )
        return {"saved": True}


@router.get("/daily-review/{plan_date}")
def daily_review(plan_date: date, request: Request):
    with _db(request) as connection:
        settings = _get_settings(connection)
        prompt_text = _build_daily_gpt_prompt(
            connection,
            plan_date.isoformat(),
            _resolve_prompt_content(
                settings,
                "daily_gpt_prompts",
                "daily_gpt_active_prompt_id",
                "daily_gpt_system_default",
                DAILY_GPT_SYSTEM_PROMPT,
            ),
        )
        daily = _serialize_daily_review(connection, plan_date.isoformat())
        return daily | {
            "gpt_prompt_text": prompt_text,
            "gpt_record": _get_gpt_record(connection, "daily", plan_date.isoformat(), plan_date.isoformat(), prompt_text),
            "prompt_settings": _daily_prompt_settings(settings),
        }


@router.put("/daily-review/{plan_date}/gpt-record")
def save_daily_gpt_record(plan_date: date, payload: GPTRecordSaveInput, request: Request):
    with _db(request) as connection:
        settings = _get_settings(connection)
        prompt_text = _build_daily_gpt_prompt(
            connection,
            plan_date.isoformat(),
            _resolve_prompt_content(
                settings,
                "daily_gpt_prompts",
                "daily_gpt_active_prompt_id",
                "daily_gpt_system_default",
                DAILY_GPT_SYSTEM_PROMPT,
            ),
        )
        return _save_gpt_record(
            connection,
            "daily",
            plan_date.isoformat(),
            plan_date.isoformat(),
            prompt_text,
            payload.response_text,
            payload.adopted_text,
        )


@router.delete("/daily-data/{plan_date}")
def clear_daily_data(plan_date: date, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        snapshot = save_reset_snapshot(connection, str(plan_date), _now_iso())
        return _clear_daily_data(connection, str(plan_date)) | {"reset_snapshot": snapshot}


@router.get("/daily-data/{plan_date}/reset-snapshots")
def list_reset_snapshots(plan_date: date, request: Request):
    with _db(request) as connection:
        return [snapshot_metadata(row) for row in connection.execute(
            "SELECT * FROM daily_reset_snapshots WHERE plan_date=? AND restored_at IS NULL ORDER BY id DESC",
            (str(plan_date),))]


@router.post("/daily-data/{plan_date}/reset-snapshots/{snapshot_id}/restore")
def restore_daily_data(plan_date: date, snapshot_id: int, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        return restore_snapshot(connection, str(plan_date), snapshot_id, _now_iso(), _assert_no_segment_overlap)


@router.get("/review-navigation")
def review_navigation(request: Request, anchor_date: date):
    start, end = _week_bounds(anchor_date)
    with _db(request) as connection:
        plans = {row["plan_date"]: row["status"] for row in connection.execute(
            "SELECT plan_date,status FROM plans WHERE plan_date BETWEEN ? AND ?", (str(start), str(end)))}
        reviews = {row[0] for row in connection.execute(
            "SELECT review_date FROM reviews WHERE review_date BETWEEN ? AND ?", (str(start), str(end)))}
        recorded = {row[0] for row in connection.execute(
            """SELECT plan_date FROM task_execution_segments WHERE plan_date BETWEEN ? AND ?
               UNION SELECT p.plan_date FROM task_duration_records r JOIN tasks t ON t.id=r.task_id
               JOIN plans p ON p.id=t.plan_id WHERE p.plan_date BETWEEN ? AND ?
               UNION SELECT p.plan_date FROM tasks t JOIN plans p ON p.id=t.plan_id
               WHERE p.plan_date BETWEEN ? AND ? AND (t.actual_minutes>0 OR t.habit_status IS NOT NULL)""",
            (str(start), str(end), str(start), str(end), str(start), str(end)))}
        days = [{"date": str(start + timedelta(days=i)), "label": label,
                 "has_review": str(start + timedelta(days=i)) in reviews,
                 "has_execution": str(start + timedelta(days=i)) in recorded,
                 "status": plans.get(str(start + timedelta(days=i)))}
                for i, label in enumerate(["周一", "周二", "周三", "周四", "周五", "周六", "周日"])]
        return {"start_date": str(start), "end_date": str(end), "days": days,
                "weekday_progress": {"days": days}}


@router.get("/weekly-review")
def weekly_review(request: Request, end_date: date | None = None, anchor_date: date | None = None):
    anchor = anchor_date or end_date or date.today()
    start, end = _week_bounds(anchor)
    with _db(request) as connection:
        settings = _get_settings(connection)
        snapshot = _build_weekly_snapshot(connection, start, end)
        report = _read_weekly_report(connection, snapshot, settings)
        progress = _build_weekday_progress(snapshot)
        gpt_prompt_text = _build_chatgpt_prompt(
            snapshot,
            report["deepseek_analysis"],
            _resolve_prompt_content(
                settings,
                "weekly_gpt_prompts",
                "weekly_gpt_active_prompt_id",
                "weekly_gpt_system_default",
                WEEKLY_GPT_SYSTEM_PROMPT,
            ),
        )
        week_key = end.isoformat()
        week_label = f"{start.isoformat()} → {end.isoformat()}"
        return snapshot | {
            "analysis": report["deepseek_analysis"],
            "analysis_stale": report["analysis_stale"],
            "ai_status": report["ai_status"],
            "ai_error": report["ai_error"],
            "chatgpt_prompt_text": report["chatgpt_prompt_text"],
            "gpt_prompt_text": gpt_prompt_text,
            "gpt_record": _get_gpt_record(connection, "weekly", week_key, week_label, gpt_prompt_text),
            "final_report_text": report["final_report_text"],
            "history": _list_weekly_reports(connection),
            "weekday_progress": progress,
            "anchor_date": anchor.isoformat(),
            "prompt_settings": _weekly_prompt_settings(settings),
        }


@router.get("/calendar-status")
def calendar_status(month: str, request: Request):
    month_start = _parse_month_start(month)
    with _db(request) as connection:
        settings = _get_settings(connection)
        return _build_calendar_status(connection, month_start, _project_start_date(settings))


@router.get("/weekly-reports")
def list_weekly_reports(request: Request):
    with _db(request) as connection:
        return _list_weekly_reports(connection)


@router.get("/weekly-reports/{end_date}")
def get_weekly_report(end_date: date, request: Request):
    start = end_date - timedelta(days=6)
    with _db(request) as connection:
        settings = _get_settings(connection)
        snapshot = _build_weekly_snapshot(connection, start, end_date)
        report = _read_weekly_report(connection, snapshot, settings)
        gpt_prompt_text = _build_chatgpt_prompt(
            snapshot,
            report["deepseek_analysis"],
            _resolve_prompt_content(
                settings,
                "weekly_gpt_prompts",
                "weekly_gpt_active_prompt_id",
                "weekly_gpt_system_default",
                WEEKLY_GPT_SYSTEM_PROMPT,
            ),
        )
        week_label = f"{start.isoformat()} → {end_date.isoformat()}"
        return report | {
            "gpt_prompt_text": gpt_prompt_text,
            "gpt_record": _get_gpt_record(connection, "weekly", end_date.isoformat(), week_label, gpt_prompt_text),
            "weekday_progress": _build_weekday_progress(snapshot),
        }


@router.post("/weekly-reports/{end_date}/refresh")
def refresh_weekly_report(end_date: date, request: Request):
    start = end_date - timedelta(days=6)
    with _db(request) as connection:
        settings = _get_settings(connection)
        snapshot = _build_weekly_snapshot(connection, start, end_date)
    analyzer = getattr(request.app.state, "weekly_review_analyzer", None)
    if not analyzer:
        raise HTTPException(409, "AI 分析未启用；可复制本周事实给 ChatGPT 整理")
    prompt = _resolve_prompt_content(settings, "weekly_analysis_prompts", "weekly_analysis_active_prompt_id",
                                     "weekly_analysis_system_default", WEEKLY_ANALYSIS_SYSTEM_PROMPT)
    # 外部调用在数据库连接与写事务之外，分析期间允许正常记录和保存。
    model, error = analyzer.analyze(snapshot, prompt)
    analysis = model.model_dump() if model else None
    export_prompt = _resolve_prompt_content(settings, "chatgpt_export_prompts", "chatgpt_export_active_prompt_id",
                                            "chatgpt_export_system_default", CHATGPT_EXPORT_SYSTEM_PROMPT)
    snapshot_json, digest = _snapshot_hash(snapshot)
    with _db(request) as connection:
        if not analysis:
            # 失败不把旧分析的依据替换成新快照，也不覆盖用户正在保存的最终稿。
            connection.execute("UPDATE weekly_reports SET ai_status='error', ai_error=? WHERE end_date=?",
                               (error or "AI 分析失败", str(end_date)))
        else:
            _save_weekly_report(connection, snapshot, snapshot_json, digest, analysis,
                                _build_chatgpt_prompt(snapshot, analysis, export_prompt), "ready", None)
    if not analysis:
        raise HTTPException(502, error or "AI 分析失败，已保留原来的内容")
    return {"saved": True}


@router.put("/weekly-reports/{end_date}")
def save_weekly_report(end_date: date, payload: WeeklyReportSaveInput, request: Request):
    with _db(request) as connection:
        report = _get_weekly_report(connection, end_date.isoformat())
        if not report:
            start = end_date - timedelta(days=6)
            snapshot = _build_weekly_snapshot(connection, start, end_date)
            settings = _get_settings(connection)
            report = _read_weekly_report(connection, snapshot, settings)
            snapshot_json, digest = _snapshot_hash(snapshot)
            _save_weekly_report(connection, snapshot, snapshot_json, digest, None,
                                report["chatgpt_prompt_text"], "unavailable", None)
        connection.execute(
            "UPDATE weekly_reports SET final_report_text=?, updated_at=CURRENT_TIMESTAMP WHERE end_date=?",
            (payload.final_report_text, end_date.isoformat()),
        )
        return _get_weekly_report(connection, end_date.isoformat())


@router.put("/weekly-review/{end_date}/gpt-record")
def save_weekly_gpt_record(end_date: date, payload: GPTRecordSaveInput, request: Request):
    start = end_date - timedelta(days=6)
    with _db(request) as connection:
        settings = _get_settings(connection)
        snapshot = _build_weekly_snapshot(connection, start, end_date)
        report = _read_weekly_report(connection, snapshot, settings)
        prompt_text = _build_chatgpt_prompt(
            snapshot,
            report["deepseek_analysis"],
            _resolve_prompt_content(
                settings,
                "weekly_gpt_prompts",
                "weekly_gpt_active_prompt_id",
                "weekly_gpt_system_default",
                WEEKLY_GPT_SYSTEM_PROMPT,
            ),
        )
        return _save_gpt_record(
            connection,
            "weekly",
            end_date.isoformat(),
            f"{start.isoformat()} → {end_date.isoformat()}",
            prompt_text,
            payload.response_text,
            payload.adopted_text,
        )


@router.get("/gpt-workbench")
def get_gpt_workbench(request: Request):
    with _db(request) as connection:
        settings = _get_settings(connection)
        return {
            "prompt_settings": {
                **_daily_prompt_settings(settings),
                "weekly_gpt_prompts": settings["weekly_gpt_prompts"],
                "weekly_gpt_active_prompt_id": settings["weekly_gpt_active_prompt_id"],
            },
            "daily_records": _list_gpt_records(connection, "daily"),
            "weekly_records": _list_gpt_records(connection, "weekly"),
        }


@router.get("/settings")
def get_settings(request: Request):
    with _db(request) as connection:
        return _get_settings(connection)


@router.put("/settings")
def save_settings(payload: SettingsInput, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = _get_settings(connection)
        data = payload.model_dump(mode="json")
        for key in [
            "weekly_review_mode",
            "weekly_review_day",
            "execution_labels",
            "effective_labels_by_category",
            "deleted_effective_label_ids",
            "draft_main_minutes_by_category",
            "weekly_analysis_prompts",
            "weekly_analysis_active_prompt_id",
            "chatgpt_export_prompts",
            "chatgpt_export_active_prompt_id",
            "daily_gpt_prompts",
            "daily_gpt_active_prompt_id",
            "weekly_gpt_prompts",
            "weekly_gpt_active_prompt_id",
        ]:
            if key not in payload.model_fields_set:
                data[key] = existing.get(key, DEFAULT_SETTINGS[key])
        old_deleted = existing.get("deleted_effective_label_ids", {})
        new_deleted = data.get("deleted_effective_label_ids", {})
        data["deleted_effective_label_ids"] = {
            category: sorted(set(old_deleted.get(category, [])) | set(new_deleted.get(category, [])))
            for category in old_deleted.keys() | new_deleted.keys()
        }
        connection.execute(
            """INSERT INTO app_settings(key,value_json) VALUES('main',?)
               ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP""",
            (json.dumps(data, ensure_ascii=False),),
        )
        return _get_settings(connection)


def _store_effective_label_settings(connection, settings: dict) -> dict:
    connection.execute(
        """INSERT INTO app_settings(key,value_json) VALUES('main',?)
           ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP""",
        (json.dumps(settings, ensure_ascii=False),),
    )
    return _get_settings(connection)


def _assert_unique_effective_name(labels: list[dict], name: str, skip_id: str | None = None) -> None:
    if any(item["id"] != skip_id and item["name"].strip().casefold() == name.casefold() for item in labels):
        raise HTTPException(409, "这个科目已有同名细分，请换一个名称")


@router.post("/settings/effective-labels/{category}", status_code=201)
def create_effective_label(category: Category, payload: EffectiveLabelNameInput, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        settings = _get_settings(connection)
        labels = settings["effective_labels_by_category"].setdefault(category, [])
        _assert_unique_effective_name(labels, payload.name)
        labels.append({"id": f"effective_{category}_{uuid4().hex}", "name": payload.name, "is_system": False})
        return _store_effective_label_settings(connection, settings)


@router.patch("/settings/effective-labels/{category}/{label_id}")
def rename_effective_label(category: Category, label_id: str, payload: EffectiveLabelNameInput, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        settings = _get_settings(connection)
        labels = settings["effective_labels_by_category"].get(category, [])
        label = next((item for item in labels if item["id"] == label_id), None)
        if label is None:
            raise HTTPException(404, "有效细分标签不存在，请刷新后重试")
        _assert_unique_effective_name(labels, payload.name, label_id)
        label["name"] = payload.name
        return _store_effective_label_settings(connection, settings)


@router.delete("/settings/effective-labels/{category}/{label_id}")
def delete_effective_label(category: Category, label_id: str, request: Request):
    with _db(request) as connection:
        connection.execute("BEGIN IMMEDIATE")
        settings = _get_settings(connection)
        labels = settings["effective_labels_by_category"].get(category, [])
        if not any(item["id"] == label_id for item in labels):
            raise HTTPException(404, "有效细分标签不存在，请刷新后重试")
        settings["effective_labels_by_category"][category] = [item for item in labels if item["id"] != label_id]
        # 记住显式删除，防止默认标签合并或旧设置页保存时让它重新出现。
        deleted = settings.setdefault("deleted_effective_label_ids", {}).setdefault(category, [])
        if label_id not in deleted:
            deleted.append(label_id)
        return _store_effective_label_settings(connection, settings)


@router.get("/system/health")
def system_health(request: Request):
    with _db(request) as connection:
        connection.execute("SELECT 1").fetchone()
    return {
        "status": "ok",
        "mode": getattr(request.app.state, "runtime_mode", "development"),
        "database_path": str(request.app.state.database_path),
        "backup_dir": str(_backup_dir(request)),
        "backup_retention_days": int(getattr(request.app.state, "backup_retention_days", 14)),
        "ai_enabled": bool(getattr(request.app.state, "ai_planner", None)),
    }


@router.get("/system/backup-export")
def export_backup(request: Request):
    backup_path = create_sqlite_backup(request.app.state.database_path, _backup_dir(request))
    prune_old_backups(_backup_dir(request), int(getattr(request.app.state, "backup_retention_days", 14)))
    return FileResponse(
        path=backup_path,
        media_type="application/octet-stream",
        filename=backup_path.name,
    )
