from __future__ import annotations

import json
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Request, status

from .database import connect
from .schemas import CarryoverResolution, DraftRequest, PlanUpdate, ReviewInput, SettingsInput, TaskDraft, TaskUpdate
from .services.task_rules import build_rule_plan, validate_ai_tasks


router = APIRouter(prefix="/api")

DEFAULT_SETTINGS = {
    "current_stage": "恢复秩序期",
    "ai_project_weekly_frequency": 3,
    "rehab_enabled": True,
    "task_titles": {
        "math": "数学任务", "english": "英语任务", "computer": "C语言 / 数据结构",
        "ai_project": "AI 小工具", "rehab": "身体重建", "sleep": "夜间收尾",
    },
}


def _db(request: Request):
    return connect(request.app.state.database_path)


def _capture_unfinished(connection, before_date: str) -> None:
    rows = connection.execute(
        """SELECT t.id, t.title, t.category, t.estimated_minutes
           FROM tasks t JOIN plans p ON p.id=t.plan_id
           WHERE p.status='approved' AND p.plan_date < ? AND t.completed=0""",
        (before_date,),
    ).fetchall()
    for row in rows:
        connection.execute(
            """INSERT OR IGNORE INTO carryovers(task_id,title,category,estimated_minutes)
               VALUES(?,?,?,?)""",
            (row["id"], row["title"], row["category"], row["estimated_minutes"]),
        )


def _get_settings(connection) -> dict:
    row = connection.execute("SELECT value_json FROM app_settings WHERE key='main'").fetchone()
    return json.loads(row["value_json"]) if row else DEFAULT_SETTINGS


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
        "tasks": [dict(row) | {"completed": bool(row["completed"])} for row in tasks],
    }


def _insert_tasks(connection, plan_id: int, tasks: list[TaskDraft]) -> None:
    for position, task in enumerate(tasks):
        connection.execute(
            """INSERT INTO tasks(plan_id,title,category,estimated_minutes,priority,
               completion_criteria,reason,source,position) VALUES(?,?,?,?,?,?,?,?,?)""",
            (plan_id, task.title, task.category, task.estimated_minutes, task.priority,
             task.completion_criteria, task.reason, task.source, position),
        )


def _fit_with_carryovers(tasks: list[TaskDraft], available_minutes: int) -> list[TaskDraft]:
    fitted = list(tasks)
    for category in ("ai_project", "rehab"):
        if sum(task.estimated_minutes for task in fitted) <= available_minutes:
            return fitted
        fitted = [task for task in fitted if task.source == "carryover" or task.category != category]
    while sum(task.estimated_minutes for task in fitted) > available_minutes:
        candidates = [task for task in fitted if task.source != "carryover" and task.estimated_minutes > 10]
        if not candidates:
            break
        largest = max(candidates, key=lambda task: task.estimated_minutes)
        index = fitted.index(largest)
        fitted[index] = largest.model_copy(update={"estimated_minutes": largest.estimated_minutes - 5})
    return fitted


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
        week_start = (payload.date - timedelta(days=6)).isoformat()
        ai_count = connection.execute(
            """SELECT COUNT(*) FROM tasks t JOIN plans p ON p.id=t.plan_id
               WHERE t.category='ai_project' AND p.status='approved' AND p.plan_date BETWEEN ? AND ?""",
            (week_start, day),
        ).fetchone()[0]
        if ai_count >= settings["ai_project_weekly_frequency"]:
            tasks = [task for task in tasks if task.category != "ai_project"]
        tasks = [task.model_copy(update={"title": settings["task_titles"].get(task.category, task.title)}) for task in tasks]
        scheduled = connection.execute(
            """SELECT * FROM carryovers WHERE status='resolved' AND
               ((resolution='reschedule' AND target_date=?) OR
                (resolution='split' AND (target_date=? OR target_date IS NULL)))""",
            (day, day),
        ).fetchall()
        for item in scheduled:
            tasks.append(TaskDraft(
                title=item["split_title"] or item["title"], category=item["category"],
                estimated_minutes=item["estimated_minutes"], priority=2,
                completion_criteria="完成这项经过人工重排的任务", reason="来自待审池的人工决定",
                source="carryover",
            ))
        tasks = _fit_with_carryovers(tasks, payload.available_minutes)
        planner = getattr(request.app.state, "ai_planner", None)
        if planner is not None:
            result = planner.generate(checkin, tasks)
            tasks = result.tasks
            degraded_reason = result.degraded_reason
        existing = connection.execute("SELECT id,status FROM plans WHERE plan_date=?", (day,)).fetchone()
        if existing and existing["status"] == "approved":
            raise HTTPException(409, "当日计划已经确认")
        if existing:
            connection.execute("DELETE FROM plans WHERE id=?", (existing["id"],))
        cursor = connection.execute(
            """INSERT INTO plans(plan_date,energy,available_minutes,day_type,methods_json,
               safety_notice,degraded_reason) VALUES(?,?,?,?,?,?,?)""",
            (day, payload.energy, payload.available_minutes, payload.day_type,
             json.dumps(rule_plan.methods, ensure_ascii=False), rule_plan.safety_notice, degraded_reason),
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
        if not validate_ai_tasks(tasks, plan["available_minutes"]):
            raise HTTPException(422, "任务数量、时长或安全规则不合规")
        connection.execute("DELETE FROM tasks WHERE plan_id=?", (plan["id"],))
        _insert_tasks(connection, plan["id"], tasks)
        return _serialize_plan(connection, plan_date.isoformat())


@router.post("/daily-plans/{plan_date}/approve")
def approve_plan(plan_date: date, request: Request):
    with _db(request) as connection:
        cursor = connection.execute(
            "UPDATE plans SET status='approved' WHERE plan_date=? AND status='draft'", (plan_date.isoformat(),)
        )
        if cursor.rowcount == 0:
            raise HTTPException(409, "计划不存在或已经确认")
        return _serialize_plan(connection, plan_date.isoformat())


@router.patch("/tasks/{task_id}")
def update_task(task_id: int, payload: TaskUpdate, request: Request):
    with _db(request) as connection:
        row = connection.execute(
            "SELECT t.*,p.status FROM tasks t JOIN plans p ON p.id=t.plan_id WHERE t.id=?", (task_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "任务不存在")
        if row["status"] != "approved":
            raise HTTPException(409, "计划确认后才能勾选任务")
        connection.execute(
            "UPDATE tasks SET completed=?,actual_minutes=? WHERE id=?",
            (int(payload.completed), payload.actual_minutes, task_id),
        )
        updated = connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return dict(updated) | {"completed": bool(updated["completed"])}


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
            (payload.action, payload.target_date.isoformat() if payload.target_date else None,
             payload.split_title, carryover_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(404, "待审项不存在")
        return dict(connection.execute("SELECT * FROM carryovers WHERE id=?", (carryover_id,)).fetchone())


@router.post("/daily-reviews")
def save_review(payload: ReviewInput, request: Request):
    with _db(request) as connection:
        connection.execute(
            """INSERT INTO reviews(review_date,distraction,effective_method,tomorrow_focus)
               VALUES(?,?,?,?) ON CONFLICT(review_date) DO UPDATE SET
               distraction=excluded.distraction,effective_method=excluded.effective_method,
               tomorrow_focus=excluded.tomorrow_focus""",
            (payload.date.isoformat(), payload.distraction, payload.effective_method, payload.tomorrow_focus),
        )
        return {"saved": True}


@router.get("/weekly-review")
def weekly_review(request: Request, end_date: date | None = None):
    end = end_date or date.today()
    start = end - timedelta(days=6)
    with _db(request) as connection:
        review_days = connection.execute(
            "SELECT COUNT(*) FROM reviews WHERE review_date BETWEEN ? AND ?",
            (start.isoformat(), end.isoformat()),
        ).fetchone()[0]
        task_rows = connection.execute(
            """SELECT t.category,t.completed,t.estimated_minutes,t.actual_minutes
               FROM tasks t JOIN plans p ON p.id=t.plan_id
               WHERE p.status='approved' AND p.plan_date BETWEEN ? AND ?""",
            (start.isoformat(), end.isoformat()),
        ).fetchall()
        total = len(task_rows)
        completed = sum(row["completed"] for row in task_rows)
        return {
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "review_days": review_days,
            "task_count": total,
            "completed_count": completed,
            "completion_rate": round(completed / total, 3) if total else 0,
            "planned_minutes": sum(row["estimated_minutes"] for row in task_rows),
            "actual_minutes": sum(row["actual_minutes"] or 0 for row in task_rows),
        }


@router.get("/settings")
def get_settings(request: Request):
    with _db(request) as connection:
        return _get_settings(connection)


@router.put("/settings")
def save_settings(payload: SettingsInput, request: Request):
    with _db(request) as connection:
        connection.execute(
            """INSERT INTO app_settings(key,value_json) VALUES('main',?)
               ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP""",
            (json.dumps(payload.model_dump(), ensure_ascii=False),),
        )
        return _get_settings(connection)
