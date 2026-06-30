from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, status

from .database import connect
from .schemas import (
    CarryoverResolution,
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

DEFAULT_SETTINGS = {
    "current_stage": "恢复秩序期",
    "ai_project_weekly_frequency": 3,
    "rehab_enabled": True,
    "project_start_date": date.today().isoformat(),
    "task_titles": {
        "math": "数学", "english": "英语", "computer": "408",
        "vibe_coding": "vibe coding", "algorithm": "算法",
        "reading": "阅读", "writing": "练字", "rehab": "运动",
    },
    "budget_minimum": 90,
    "budget_normal": 150,
    "budget_ample": 210,
    "execution_labels": DEFAULT_EXECUTION_LABELS,
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


def _is_planned_main_task(row) -> bool:
    return not row["is_sub"] and row["estimated_minutes"] > 0


def _capture_unfinished(connection, before_date: str) -> None:
    rows = connection.execute(
        """SELECT t.id, t.title, t.category, t.estimated_minutes
           FROM tasks t JOIN plans p ON p.id=t.plan_id
           WHERE p.status IN ('approved', 'submitted') AND p.plan_date < ? AND t.completed=0 AND t.is_sub=0""",
        (before_date,),
    ).fetchall()
    rows = [row for row in rows if row["estimated_minutes"] > 0]
    for row in rows:
        connection.execute(
            """INSERT OR IGNORE INTO carryovers(task_id,title,category,estimated_minutes)
               VALUES(?,?,?,?)""",
            (row["id"], row["title"], row["category"], row["estimated_minutes"]),
        )


def _get_settings(connection) -> dict:
    row = connection.execute("SELECT value_json FROM app_settings WHERE key='main'").fetchone()
    settings = json.loads(row["value_json"]) if row else dict(DEFAULT_SETTINGS)
    settings.setdefault("project_start_date", DEFAULT_SETTINGS["project_start_date"])
    settings.setdefault("execution_labels", DEFAULT_SETTINGS["execution_labels"])
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
    return datetime.fromisoformat(value)


def _minutes_between(started_at: str, ended_at: str | None) -> int:
    start = _parse_iso_datetime(started_at)
    end = _parse_iso_datetime(ended_at) or datetime.now().replace(microsecond=0)
    return max(0, int((end - start).total_seconds() // 60))


def _build_execution_label_map(settings: dict) -> dict[str, dict]:
    labels = settings.get("execution_labels") or DEFAULT_EXECUTION_LABELS
    return {item["id"]: item for item in labels}


def _serialize_execution_labels(settings: dict) -> list[dict]:
    labels = settings.get("execution_labels") or DEFAULT_EXECUTION_LABELS
    return [ExecutionLabelItem(**item).model_dump(mode="json") for item in labels]


def _resolve_execution_label(settings: dict, label_id: str | None, segment_kind: str) -> tuple[str | None, str | None]:
    if segment_kind == "effective":
        return None, None
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
    raw = settings.get("project_start_date") or DEFAULT_SETTINGS["project_start_date"]
    if isinstance(raw, date):
        return raw
    return date.fromisoformat(str(raw))


def _week_bounds(anchor: date) -> tuple[date, date]:
    start = anchor - timedelta(days=anchor.weekday())
    end = start + timedelta(days=6)
    return start, end


def _parse_month_start(month: str) -> date:
    return datetime.strptime(f"{month}-01", "%Y-%m-%d").date()


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
        "tasks": [dict(row) | {"completed": bool(row["completed"]), "is_sub": bool(row["is_sub"])} for row in tasks],
    }


def _get_plan_row(connection, plan_date: str):
    return connection.execute("SELECT * FROM plans WHERE plan_date=?", (plan_date,)).fetchone()


def _get_plan_task_rows(connection, plan_id: int):
    rows = connection.execute("SELECT * FROM tasks WHERE plan_id=? ORDER BY position,id", (plan_id,)).fetchall()
    return [dict(row) | {"completed": bool(row["completed"]), "is_sub": bool(row["is_sub"])} for row in rows]


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
        "minutes": _minutes_between(row["started_at"], row["ended_at"]),
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


def _effective_minutes_by_task(segments: list[dict]) -> dict[int, int]:
    totals: dict[int, int] = {}
    for segment in segments:
        if segment["segment_kind"] != "effective":
            continue
        task_id = segment["task_id"]
        totals[task_id] = totals.get(task_id, 0) + max(0, int(segment["minutes"] or 0))
    return totals


def _aggregate_execution_board(tasks: list[dict], segments: list[dict]) -> list[dict]:
    tasks_by_id = {task["id"]: task for task in tasks}
    board_map: dict[int, dict] = {}
    for task in tasks:
        board_map[task["id"]] = {
            "task_id": task["id"],
            "task_title": task["title"],
            "category": task["category"],
            "is_sub": bool(task["is_sub"]),
            "total_minutes": 0,
            "effective_minutes": 0,
            "counted_label_minutes": 0,
            "interrupt_minutes": 0,
            "counted_labels": [],
            "interrupt_labels": [],
            "_counted": {},
            "_interrupt": {},
        }

    for segment in segments:
        board = board_map.get(segment["task_id"])
        if not board:
            continue
        minutes = segment["minutes"]
        if segment["segment_kind"] == "effective":
            board["effective_minutes"] += minutes
            board["total_minutes"] += minutes
            continue
        bucket_name = "_counted" if segment["segment_kind"] == "counted_label" else "_interrupt"
        public_name = "counted_labels" if segment["segment_kind"] == "counted_label" else "interrupt_labels"
        if segment["segment_kind"] == "counted_label":
            board["counted_label_minutes"] += minutes
            board["total_minutes"] += minutes
        else:
            board["interrupt_minutes"] += minutes
        key = segment["label_id"] or segment["label_name"] or "unknown"
        label_bucket = board[bucket_name]
        if key not in label_bucket:
            label_bucket[key] = {"label_id": segment["label_id"], "label_name": segment["label_name"] or "未命名标签", "minutes": 0, "count": 0}
            board[public_name].append(label_bucket[key])
        label_bucket[key]["minutes"] += minutes
        label_bucket[key]["count"] += 1

    board_items = []
    for task in tasks:
        board = board_map[task["id"]]
        board.pop("_counted")
        board.pop("_interrupt")
        board["has_segments"] = bool(
            board["effective_minutes"]
            or board["counted_label_minutes"]
            or board["interrupt_minutes"]
        )
        board["bar_total_minutes"] = max(
            board["total_minutes"],
            board["interrupt_minutes"],
            board["effective_minutes"] + board["counted_label_minutes"] + board["interrupt_minutes"],
        )
        board_items.append(board)
    return [item for item in board_items if item["has_segments"]]


def _plan_has_execution_segments(connection, plan_date: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM task_execution_segments WHERE plan_date=? LIMIT 1",
        (plan_date,),
    ).fetchone()
    return bool(row)


def _sync_plan_actual_minutes_from_execution(connection, plan_id: int, segments: list[dict] | None = None) -> None:
    if segments is None:
        plan_date_row = connection.execute("SELECT plan_date FROM plans WHERE id=?", (plan_id,)).fetchone()
        if not plan_date_row:
            return
        segments = _list_execution_segments(connection, plan_date_row["plan_date"])
    effective_minutes_by_task = _effective_minutes_by_task(segments)
    tasks = connection.execute("SELECT id,is_sub FROM tasks WHERE plan_id=?", (plan_id,)).fetchall()
    for task in tasks:
        effective_minutes = effective_minutes_by_task.get(task["id"], 0)
        completed = 1 if task["is_sub"] and effective_minutes >= 30 else None
        if completed is None:
            connection.execute(
                "UPDATE tasks SET actual_minutes=? WHERE id=?",
                (effective_minutes, task["id"]),
            )
        else:
            connection.execute(
                "UPDATE tasks SET actual_minutes=?, completed=? WHERE id=?",
                (effective_minutes, completed, task["id"]),
            )


def _build_execution_payload(connection, plan_date: str) -> dict:
    settings = _get_settings(connection)
    plan = _get_plan_row(connection, plan_date)
    segments = _list_execution_segments(connection, plan_date)
    active = _get_active_execution_segment(connection, plan_date)
    plan_payload = None
    tasks = []
    if plan:
        _sync_plan_actual_minutes_from_execution(connection, plan["id"], segments)
        tasks = _get_plan_task_rows(connection, plan["id"])
        plan_payload = _serialize_plan(connection, plan_date)
    return {
        "date": plan_date,
        "plan": plan_payload,
        "tasks": tasks,
        "labels": _serialize_execution_labels(settings),
        "active_segment": _serialize_execution_segment_row(active) if active else None,
        "segments": segments,
        "task_execution_board": _aggregate_execution_board(tasks, segments),
    }


def _assert_segment_time_window(started_at: datetime, ended_at: datetime) -> None:
    if ended_at <= started_at:
        raise HTTPException(422, "结束时间必须晚于开始时间")


def _assert_no_segment_overlap(connection, plan_date: str, task_id: int, started_at: str, ended_at: str | None, skip_segment_id: int | None = None) -> None:
    query = (
        """SELECT id FROM task_execution_segments
           WHERE plan_date=? AND ended_at IS NOT NULL
             AND NOT (ended_at<=? OR started_at>=?)"""
    )
    params: list = [plan_date, started_at, ended_at or _now_iso()]
    if skip_segment_id is not None:
        query += " AND id<>?"
        params.append(skip_segment_id)
    rows = connection.execute(query, tuple(params)).fetchall()
    if rows:
        raise HTTPException(409, "时间段发生重叠，请先调整现有记录")


def _close_active_execution_segment(connection, plan_date: str | None = None, ended_at: str | None = None):
    active = _get_active_execution_segment(connection, plan_date)
    if not active:
        return None
    effective_end = ended_at or _now_iso()
    if effective_end <= active["started_at"]:
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
    if plan:
        if _plan_has_execution_segments(connection, plan_date):
            _sync_plan_actual_minutes_from_execution(connection, plan["id"])
        task_rows = connection.execute(
            "SELECT id,title,category,is_sub,completed,estimated_minutes,actual_minutes FROM tasks WHERE plan_id=?",
            (plan["id"],),
        ).fetchall()
        task_board = _aggregate_execution_board(
            [dict(row) | {"completed": bool(row["completed"]), "is_sub": bool(row["is_sub"])} for row in task_rows],
            _list_execution_segments(connection, plan_date),
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

    return {
        "date": plan_date,
        "status": status,
        "status_label": status_label,
        "main_task_count": len(main_tasks),
        "main_completed_count": sum(row["completed"] for row in main_tasks),
        "main_planned_minutes": sum(row["estimated_minutes"] for row in main_tasks),
        "main_actual_minutes": sum(row["actual_minutes"] or 0 for row in main_tasks),
        "sub_actual_minutes": sum(row["actual_minutes"] or 0 for row in sub_tasks),
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
               completion_criteria,reason,source,position,sub_category,is_sub) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
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
            ),
        )


def _fit_with_carryovers(tasks: list[TaskDraft], available_minutes: int) -> list[TaskDraft]:
    fitted = list(tasks)
    if sum(task.estimated_minutes for task in fitted if not task.is_sub) <= available_minutes:
        return fitted
    if any(task.category == "rehab" and task.source != "carryover" for task in fitted):
        fitted = [task for task in fitted if task.source == "carryover" or task.category != "rehab"]
    while sum(task.estimated_minutes for task in fitted if not task.is_sub) > available_minutes:
        candidates = [task for task in fitted if task.source != "carryover" and not task.is_sub and task.estimated_minutes > 10]
        if not candidates:
            break
        largest = max(candidates, key=lambda task: task.estimated_minutes)
        index = fitted.index(largest)
        fitted[index] = largest.model_copy(update={"estimated_minutes": largest.estimated_minutes - 5})
    return fitted


def _validate_plan_tasks_for_update(tasks: list[TaskDraft], available_minutes: int) -> None:
    if not tasks or len(tasks) > 15:
        raise HTTPException(422, "任务数量不合规")
    main_tasks = [task for task in tasks if not task.is_sub]
    if any(task.estimated_minutes > available_minutes for task in main_tasks):
        raise HTTPException(422, "单个主航线任务不能超过当天可用时间")
    if sum(task.estimated_minutes for task in main_tasks) > available_minutes:
        raise HTTPException(422, "主航线总分钟数不能超过当天可用时间")
    if not validate_ai_tasks(tasks, available_minutes):
        raise HTTPException(422, "任务数量、时长或安全规则不合规")


def _compute_weekly_metrics(connection, start: date, end: date) -> dict:
    review_days = connection.execute(
        "SELECT COUNT(*) FROM reviews WHERE review_date BETWEEN ? AND ?",
        (start.isoformat(), end.isoformat()),
    ).fetchone()[0]
    task_rows = connection.execute(
        """SELECT t.is_sub,t.completed,t.estimated_minutes,t.actual_minutes
           FROM tasks t JOIN plans p ON p.id=t.plan_id
           WHERE p.status='submitted' AND p.plan_date BETWEEN ? AND ?""",
        (start.isoformat(), end.isoformat()),
    ).fetchall()

    main_tasks = [t for t in task_rows if _is_planned_main_task(t)]
    sub_tasks = [t for t in task_rows if t["is_sub"]]
    total_main = len(main_tasks)
    completed_main = sum(row["completed"] for row in main_tasks)

    return {
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "review_days": review_days,
        "task_count": total_main,
        "completed_count": completed_main,
        "completed_sub_count": sum(row["completed"] for row in sub_tasks),
        "completion_rate": round(completed_main / total_main, 3) if total_main else 0,
        "planned_minutes": sum(row["estimated_minutes"] for row in main_tasks),
        "actual_minutes": sum(row["actual_minutes"] or 0 for row in main_tasks),
        "actual_sub_minutes": sum(row["actual_minutes"] or 0 for row in sub_tasks),
    }


def _build_weekly_snapshot(connection, start: date, end: date) -> dict:
    metrics = _compute_weekly_metrics(connection, start, end)
    days = []
    cursor = start
    while cursor <= end:
        days.append(_serialize_daily_review(connection, cursor.isoformat()))
        cursor += timedelta(days=1)
    return metrics | {"days": days}


def _calendar_day_state(day: date, project_start: date, today: date, plan_status: str | None, has_review: bool) -> dict:
    if day < project_start or day > today:
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

    days = []
    cursor = month_start
    while cursor <= month_end:
        state = _calendar_day_state(
            cursor,
            project_start,
            today,
            plan_statuses.get(cursor.isoformat()),
            cursor.isoformat() in review_dates,
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
        f"副航线实际分钟：{snapshot['actual_sub_minutes']} 分",
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
            """SELECT title,category,estimated_minutes,actual_minutes,completed,is_sub,sub_category
               FROM tasks WHERE plan_id=? ORDER BY position,id""",
            (plan["id"],),
        ).fetchall()
        tasks = [
            {
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
        f"副航线实际：{daily['sub_actual_minutes']} 分",
        "",
        "今天的任务明细：",
    ]
    if tasks:
        for task in tasks:
            route_label = "副航线" if task["is_sub"] else "主航线"
            lines.append(
                f"- {route_label}｜{task['title']}｜计划 {task['estimated_minutes']} 分｜实际 {task['actual_minutes']} 分｜"
                f"{'已完成' if task['completed'] else '未完成'}"
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
        has_content = any((review[key] or "").strip() for key in review)
        if has_content:
            saved_count += 1
        days.append({
            "date": day["date"],
            "label": labels[index],
            "has_review": has_content,
            "is_future": day["date"] > today,
            "is_clickable": has_content and day["date"] <= today,
        })
    return {
        "saved_count": saved_count,
        "total": 7,
        "progress_ratio": round(saved_count / 7, 3),
        "days": days,
    }


def _refresh_weekly_report(connection, analyzer, snapshot: dict, settings: dict, force: bool = False) -> dict:
    snapshot_json, digest = _snapshot_hash(snapshot)
    existing = _get_weekly_report(connection, snapshot["end_date"])
    existing_final = existing["final_report_text"] if existing else ""
    weekly_prompt = _resolve_prompt_content(
        settings,
        "weekly_analysis_prompts",
        "weekly_analysis_active_prompt_id",
        "weekly_analysis_system_default",
        WEEKLY_ANALYSIS_SYSTEM_PROMPT,
    )
    export_prompt = _resolve_prompt_content(
        settings,
        "chatgpt_export_prompts",
        "chatgpt_export_active_prompt_id",
        "chatgpt_export_system_default",
        CHATGPT_EXPORT_SYSTEM_PROMPT,
    )

    if not analyzer:
        chatgpt_prompt = _build_chatgpt_prompt(snapshot, existing["deepseek_analysis"] if existing else None, export_prompt)
        _save_weekly_report(
            connection,
            snapshot,
            snapshot_json,
            digest,
            existing["deepseek_analysis"] if existing else None,
            chatgpt_prompt,
            existing["ai_status"] if existing and existing["has_ai_draft"] else "unavailable",
            existing["ai_error"] if existing else None,
            existing_final,
        )
        return _get_weekly_report(connection, snapshot["end_date"])

    if existing and not force and existing["snapshot"].get("end_date") == snapshot["end_date"]:
        existing_digest = hashlib.sha256(json.dumps(existing["snapshot"], ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        if existing_digest == digest and existing["has_ai_draft"]:
            return existing

    analysis_model, error = analyzer.analyze(snapshot, weekly_prompt)
    analysis = analysis_model.model_dump() if analysis_model else None
    chatgpt_prompt = _build_chatgpt_prompt(snapshot, analysis, export_prompt)
    _save_weekly_report(
        connection,
        snapshot,
        snapshot_json,
        digest,
        analysis,
        chatgpt_prompt,
        "ready" if analysis else "error",
        error,
        existing_final,
    )
    return _get_weekly_report(connection, snapshot["end_date"])


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
            ))
        tasks = _fit_with_carryovers(tasks, payload.available_minutes)
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

        if payload.completed is not None:
            completed = int(payload.completed)
            if not row["is_sub"]:
                if completed and actual_minutes == 0:
                    actual_minutes = row["estimated_minutes"]
                elif not completed:
                    actual_minutes = 0
        if payload.actual_minutes is not None:
            actual_minutes = payload.actual_minutes
            if row["is_sub"]:
                completed = 1 if actual_minutes >= 30 else 0
        if payload.sub_category is not None:
            sub_category = payload.sub_category

        connection.execute(
            "UPDATE tasks SET completed=?, actual_minutes=?, sub_category=? WHERE id=?",
            (completed, actual_minutes, sub_category, task_id),
        )

        if row["plan_status"] == "submitted":
            connection.execute("UPDATE plans SET status='approved' WHERE id=?", (row["plan_id"],))

        updated = connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return dict(updated) | {"completed": bool(updated["completed"])}


@router.get("/daily-execution/{plan_date}")
def daily_execution(plan_date: date, request: Request):
    with _db(request) as connection:
        return _build_execution_payload(connection, plan_date.isoformat())


@router.post("/daily-execution/{plan_date}/tasks/start")
def start_execution_task(plan_date: date, payload: ExecutionTaskStartInput, request: Request):
    with _db(request) as connection:
        task = _get_task_row_for_execution(connection, plan_date.isoformat(), payload.task_id)
        _close_active_execution_segment(connection)
        started_at = _now_iso()
        connection.execute(
            """INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,started_at)
               VALUES(?,?,?,?)""",
            (plan_date.isoformat(), task["id"], "effective", started_at),
        )
        _sync_plan_actual_minutes_from_execution(connection, task["plan_id"])
        return _build_execution_payload(connection, plan_date.isoformat())


@router.post("/daily-execution/{plan_date}/labels/start")
def start_execution_label(plan_date: date, payload: ExecutionLabelStartInput, request: Request):
    with _db(request) as connection:
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
        _close_active_execution_segment(connection)
        segment_kind = "counted_label" if label["bucket"] == "counted" else "interrupt_label"
        connection.execute(
            """INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,label_id,label_name,started_at)
               VALUES(?,?,?,?,?,?)""",
            (plan_date.isoformat(), task["id"], segment_kind, label["id"], label["name"], _now_iso()),
        )
        _sync_plan_actual_minutes_from_execution(connection, task["plan_id"])
        return _build_execution_payload(connection, plan_date.isoformat())


@router.post("/daily-execution/{plan_date}/stop")
def stop_execution(plan_date: date, request: Request):
    with _db(request) as connection:
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
        task = _get_task_row_for_execution(connection, plan_date.isoformat(), payload.task_id)
        settings = _get_settings(connection)
        label_id, label_name = _resolve_execution_label(settings, payload.label_id, payload.segment_kind)
        _assert_no_segment_overlap(
            connection,
            plan_date.isoformat(),
            task["id"],
            payload.started_at.replace(microsecond=0).isoformat(),
            payload.ended_at.replace(microsecond=0).isoformat(),
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
                payload.started_at.replace(microsecond=0).isoformat(),
                payload.ended_at.replace(microsecond=0).isoformat(),
            ),
        )
        _sync_plan_actual_minutes_from_execution(connection, task["plan_id"])
        return _build_execution_payload(connection, plan_date.isoformat())


@router.put("/daily-execution/{plan_date}/segments/{segment_id}")
def update_execution_segment(plan_date: date, segment_id: int, payload: ExecutionSegmentUpdateInput, request: Request):
    _assert_segment_time_window(payload.started_at, payload.ended_at)
    with _db(request) as connection:
        existing = connection.execute(
            """SELECT s.*, t.plan_id
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
        settings = _get_settings(connection)
        label_id, label_name = _resolve_execution_label(settings, payload.label_id, payload.segment_kind)
        _assert_no_segment_overlap(
            connection,
            plan_date.isoformat(),
            task["id"],
            payload.started_at.replace(microsecond=0).isoformat(),
            payload.ended_at.replace(microsecond=0).isoformat(),
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
                payload.started_at.replace(microsecond=0).isoformat(),
                payload.ended_at.replace(microsecond=0).isoformat(),
                segment_id,
            ),
        )
        _sync_plan_actual_minutes_from_execution(connection, existing["plan_id"])
        if existing["plan_id"] != task["plan_id"]:
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
        _sync_plan_actual_minutes_from_execution(connection, existing["plan_id"])
        return _build_execution_payload(connection, plan_date.isoformat())


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
        return _clear_daily_data(connection, plan_date.isoformat())


@router.get("/weekly-review")
def weekly_review(request: Request, end_date: date | None = None, anchor_date: date | None = None):
    anchor = anchor_date or end_date or date.today()
    start, end = _week_bounds(anchor)
    with _db(request) as connection:
        settings = _get_settings(connection)
        snapshot = _build_weekly_snapshot(connection, start, end)
        report = _refresh_weekly_report(connection, getattr(request.app.state, "weekly_review_analyzer", None), snapshot, settings)
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
        report = _refresh_weekly_report(connection, getattr(request.app.state, "weekly_review_analyzer", None), snapshot, settings)
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
        report = _refresh_weekly_report(connection, getattr(request.app.state, "weekly_review_analyzer", None), snapshot, settings, force=True)
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


@router.put("/weekly-reports/{end_date}")
def save_weekly_report(end_date: date, payload: WeeklyReportSaveInput, request: Request):
    with _db(request) as connection:
        report = _get_weekly_report(connection, end_date.isoformat())
        if not report:
            start = end_date - timedelta(days=6)
            snapshot = _build_weekly_snapshot(connection, start, end_date)
            settings = _get_settings(connection)
            report = _refresh_weekly_report(connection, getattr(request.app.state, "weekly_review_analyzer", None), snapshot, settings)
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
        report = _refresh_weekly_report(connection, getattr(request.app.state, "weekly_review_analyzer", None), snapshot, settings)
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
        existing = _get_settings(connection)
        data = payload.model_dump(mode="json")
        for key in [
            "execution_labels",
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
        connection.execute(
            """INSERT INTO app_settings(key,value_json) VALUES('main',?)
               ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP""",
            (json.dumps(data, ensure_ascii=False),),
        )
        return _get_settings(connection)
