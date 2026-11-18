"""每日计划、任务勾选、待审池与按日重置路由。"""
from __future__ import annotations

import json
from datetime import date

from fastapi import APIRouter, HTTPException, Request, status

from app.routers.deps import begin_immediate, db_session
from app.schemas import CarryoverResolution, DraftRequest, PlanUpdate, TaskDraft, TaskUpdate
from app.services.catalog import MAX_DAILY_TASKS, default_task_type_for
from app.services.clock import now_iso, today_iso
from app.services.daily_reset import restore_snapshot, save_reset_snapshot, snapshot_metadata
from app.services.execution_engine import (
    check_segment_overlap,
    get_active_execution_segment,
    get_plan_row,
    insert_tasks,
    plan_has_execution_segments,
    serialize_plan,
    serialize_task_row,
    sync_plan_tasks_to_db,
)
from app.services.settings_store import (
    apply_draft_main_minutes,
    configure_main_projects,
    get_settings,
    main_project_categories,
)
from app.services.task_rules import build_rule_plan, validate_ai_tasks

router = APIRouter()


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


def _validate_plan_tasks_for_update(tasks: list[TaskDraft], available_minutes: int) -> None:
    if not tasks or len(tasks) > MAX_DAILY_TASKS:
        raise HTTPException(422, "任务数量不合规")
    if not validate_ai_tasks(tasks, available_minutes, required_main_categories=set()):
        raise HTTPException(422, "任务数量、时长或类别不合规")


def _clear_daily_data(connection, plan_date: str) -> dict:
    deleted_review = connection.execute("DELETE FROM reviews WHERE review_date=?", (plan_date,)).rowcount > 0
    deleted_counts = (
        connection.execute("DELETE FROM vocabulary_daily_counts WHERE plan_date=?", (plan_date,)).rowcount > 0
    )
    plan = connection.execute("SELECT id FROM plans WHERE plan_date=?", (plan_date,)).fetchone()
    deleted_plan = False
    if plan:
        connection.execute("DELETE FROM plans WHERE id=?", (plan["id"],))
        deleted_plan = True
    return {
        "date": plan_date,
        "deleted_plan": deleted_plan,
        "deleted_review": deleted_review,
        "deleted_vocabulary_counts": deleted_counts,
        "message": (
            "当日数据已清空"
            if deleted_plan or deleted_review or deleted_counts
            else "当日原本没有可清空的数据"
        ),
    }


@router.get("/target-suggestions")
def get_target_suggestions(request: Request, before_date: date):
    with db_session(request) as connection:
        categories: dict[str, list[int]] = {
            key: [] for key in main_project_categories(get_settings(connection))
        }
        rows = connection.execute(
            """SELECT t.category,t.estimated_minutes FROM tasks t JOIN plans p ON p.id=t.plan_id
               WHERE p.plan_date<? AND p.plan_date<=? AND t.is_sub=0 AND t.source!='carryover'
               AND t.estimated_minutes BETWEEN 0 AND 720
               ORDER BY p.plan_date DESC,t.position,t.id""",
            (before_date.isoformat(), today_iso()),
        )
        for row in rows:
            values = categories.get(row["category"])
            if values is not None and len(values) < 4 and row["estimated_minutes"] not in values:
                values.append(row["estimated_minutes"])
    return {"date": before_date.isoformat(), "categories": categories}


@router.post("/daily-plans/draft", status_code=status.HTTP_201_CREATED)
def create_draft(payload: DraftRequest, request: Request):
    checkin = payload.model_copy(update={"plan_date": payload.date})
    rule_plan = build_rule_plan(checkin)
    day = payload.date.isoformat()
    degraded_reason = None

    with db_session(request) as connection:
        begin_immediate(connection)
        existing = connection.execute("SELECT id,status FROM plans WHERE plan_date=?", (day,)).fetchone()
        if existing and existing["status"] in ("approved", "submitted"):
            raise HTTPException(409, "当日计划已经确认或提交")
        _capture_unfinished(connection, day)
        settings = get_settings(connection)
        tasks = configure_main_projects(rule_plan.tasks, settings)
        tasks = [
            task.model_copy(update={"title": settings["task_titles"].get(task.category, task.title)})
            for task in tasks
        ]
        tasks = apply_draft_main_minutes(tasks, settings)
        tasks = [
            task.model_copy(update={"estimated_minutes": payload.target_minutes.get(task.category, task.estimated_minutes)})
            for task in tasks
        ]
        scheduled = [
            dict(row)
            for row in connection.execute(
                """SELECT * FROM carryovers WHERE status='resolved' AND
                   ((resolution='reschedule' AND target_date=?) OR
                    (resolution='split' AND (target_date=? OR target_date IS NULL)))""",
                (day, day),
            ).fetchall()
        ]
        for item in scheduled:
            tasks.append(
                TaskDraft(
                    title=item["split_title"] or item["title"],
                    category=item["category"],
                    estimated_minutes=item["estimated_minutes"],
                    priority=2,
                    completion_criteria="完成这项经过人工重排的任务",
                    reason="来自待审池的人工决定",
                    source="carryover",
                    task_type="todo",
                )
            )
        if len(tasks) > MAX_DAILY_TASKS:
            raise HTTPException(422, f"当天最多{MAX_DAILY_TASKS}项活动，请减少主项目或先处理待审项")

    # 外部 AI 调用放在数据库连接之外，防止长达数十秒的网络请求阻塞 SQLite 连接与并发操作
    planner = getattr(request.app.state, "ai_planner", None)
    if planner is not None:
        result = planner.generate(checkin, tasks)
        tasks = result.tasks
        degraded_reason = result.degraded_reason

    with db_session(request) as connection:
        begin_immediate(connection)
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
        insert_tasks(connection, int(cursor.lastrowid), tasks)
        if scheduled:
            connection.executemany(
                "UPDATE carryovers SET status='consumed' WHERE id=?",
                [(item["id"],) for item in scheduled],
            )
        return serialize_plan(connection, day)


@router.get("/daily-plans/{plan_date}")
def get_plan(plan_date: date, request: Request):
    with db_session(request) as connection:
        return serialize_plan(connection, plan_date.isoformat())


@router.put("/daily-plans/{plan_date}")
def update_plan(plan_date: date, payload: PlanUpdate, request: Request):
    tasks = [TaskDraft.model_validate(task.model_dump(exclude={"id"})) for task in payload.tasks]
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        plan = connection.execute("SELECT * FROM plans WHERE plan_date=?", (day,)).fetchone()
        if not plan:
            raise HTTPException(404, "计划不存在")
        if plan["status"] != "draft":
            raise HTTPException(409, "已确认计划不可编辑")
        _validate_plan_tasks_for_update(tasks, plan["available_minutes"])
        connection.execute("DELETE FROM tasks WHERE plan_id=?", (plan["id"],))
        insert_tasks(connection, plan["id"], tasks)
        return serialize_plan(connection, day)


@router.post("/daily-plans/{plan_date}/approve")
def approve_plan(plan_date: date, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        cursor = connection.execute(
            "UPDATE plans SET status='approved' WHERE plan_date=? AND status='draft'",
            (day,),
        )
        if cursor.rowcount == 0:
            raise HTTPException(409, "计划不存在或已经确认")
        return serialize_plan(connection, day)


@router.post("/daily-plans/{plan_date}/submit")
def submit_plan(plan_date: date, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        active = get_active_execution_segment(connection, day)
        if active:
            raise HTTPException(409, "还有正在计时的记录，请先停止当前执行")
        plan = get_plan_row(connection, day)
        if plan and plan_has_execution_segments(connection, day):
            sync_plan_tasks_to_db(connection, plan["id"])
        cursor = connection.execute(
            "UPDATE plans SET status='submitted' WHERE plan_date=? AND status='approved'",
            (day,),
        )
        if cursor.rowcount == 0:
            existing = connection.execute("SELECT status FROM plans WHERE plan_date=?", (day,)).fetchone()
            if not existing:
                raise HTTPException(404, "计划不存在")
            if existing["status"] == "draft":
                raise HTTPException(409, "草稿无法提交")
        return serialize_plan(connection, day)


@router.patch("/tasks/{task_id}")
def update_task(task_id: int, payload: TaskUpdate, request: Request):
    with db_session(request) as connection:
        begin_immediate(connection)
        row = connection.execute(
            "SELECT t.*, p.id AS plan_id, p.status AS plan_status FROM tasks t JOIN plans p ON p.id=t.plan_id WHERE t.id=?",
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

        task_type = payload.task_type or row["task_type"] or default_task_type_for(row["category"])
        habit_status = payload.habit_status if payload.habit_status is not None else row["habit_status"]
        if payload.habit_status is not None and task_type != "habit":
            raise HTTPException(422, "只有习惯可以记录做了、没做或休息")
        if payload.habit_status is not None:
            completed = int(habit_status == "done")
            completion_override = completed
        if payload.actual_minutes is not None:
            if connection.execute(
                "SELECT 1 FROM task_execution_segments WHERE task_id=? "
                "UNION ALL SELECT 1 FROM task_duration_records WHERE task_id=?",
                (task_id, task_id),
            ).fetchone():
                raise HTTPException(409, "已有执行明细，请编辑明细记录")
            connection.execute("UPDATE tasks SET legacy_actual_minutes=? WHERE id=?", (actual_minutes, task_id))
        connection.execute(
            "UPDATE tasks SET task_type=?, habit_status=?, completed=?, completion_override=?, actual_minutes=?, sub_category=? WHERE id=?",
            (
                task_type,
                habit_status if task_type == "habit" else None,
                completed,
                completion_override,
                actual_minutes,
                sub_category,
                task_id,
            ),
        )
        if row["plan_status"] == "submitted":
            connection.execute("UPDATE plans SET status='approved' WHERE id=?", (row["plan_id"],))
        updated = connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        return serialize_task_row(updated)


@router.get("/carryovers")
def list_carryovers(request: Request):
    with db_session(request) as connection:
        return [
            dict(row)
            for row in connection.execute(
                "SELECT * FROM carryovers WHERE status='pending' ORDER BY created_at,id"
            ).fetchall()
        ]


@router.post("/carryovers/{carryover_id}/resolve")
def resolve_carryover(carryover_id: int, payload: CarryoverResolution, request: Request):
    if payload.action == "reschedule" and payload.target_date is None:
        raise HTTPException(422, "重排必须选择日期")
    if payload.action == "split" and not payload.split_title:
        raise HTTPException(422, "拆分必须填写新任务名称")
    with db_session(request) as connection:
        begin_immediate(connection)
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


@router.delete("/daily-data/{plan_date}")
def clear_daily_data(plan_date: date, request: Request):
    day = str(plan_date)
    with db_session(request) as connection:
        begin_immediate(connection)
        snapshot = save_reset_snapshot(connection, day, now_iso())
        return _clear_daily_data(connection, day) | {"reset_snapshot": snapshot}


@router.get("/daily-data/{plan_date}/reset-snapshots")
def list_reset_snapshots(plan_date: date, request: Request):
    with db_session(request) as connection:
        return [
            snapshot_metadata(row)
            for row in connection.execute(
                "SELECT * FROM daily_reset_snapshots WHERE plan_date=? AND restored_at IS NULL ORDER BY id DESC",
                (str(plan_date),),
            )
        ]


@router.post("/daily-data/{plan_date}/reset-snapshots/{snapshot_id}/restore")
def restore_daily_data(plan_date: date, snapshot_id: int, request: Request):
    with db_session(request) as connection:
        begin_immediate(connection)
        return restore_snapshot(connection, str(plan_date), snapshot_id, now_iso(), check_segment_overlap)
