"""执行计时、时间修正、自动停止、片段编辑与词汇记录路由。"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request

from app.routers.deps import begin_immediate, db_session
from app.schemas import (
    CorrectionShortcutInput,
    DurationRecordInput,
    ExecutionAutoStopInput,
    ExecutionLabelStartInput,
    ExecutionSegmentCreateInput,
    ExecutionSegmentUpdateInput,
    ExecutionTaskStartInput,
    QuickCorrectionInput,
    TemporaryTaskInput,
    TimeCorrectionInput,
    VocabularyCountsInput,
)
from app.services.catalog import QUICK_CORRECTION_BUILTINS, is_vocabulary_word_segment
from app.services.clock import local_iso, now_iso, parse_iso_datetime
from app.services.execution_engine import (
    append_temporary_task,
    apply_vocabulary_choice,
    assert_segment_time_window,
    build_execution_payload,
    check_segment_overlap,
    close_active_execution_segment,
    ensure_recordable_plan,
    get_active_execution_segment,
    get_plan_row,
    get_task_row_for_execution,
    handle_word_segment_conflict,
    list_duration_records,
    prepare_execution_task,
    resolve_segment_category,
    resolve_segment_label,
    sync_plan_tasks_to_db,
    vocabulary_counts,
)
from app.services.quick_corrections import resize_correction, undo_correction
from app.services.reminders import cancel_reminders, schedule_reminder
from app.services.settings_store import (
    add_shortcut_item,
    build_execution_label_map,
    correction_activities,
    correction_shortcuts,
    get_settings,
    save_correction_shortcuts,
)
from app.services.time_accounting import label_category

router = APIRouter()


@router.get("/daily-execution/{plan_date}")
def daily_execution(plan_date: date, request: Request):
    with db_session(request) as connection:
        return build_execution_payload(connection, plan_date.isoformat())


@router.post("/daily-execution/{plan_date}/tasks/start")
def start_execution_task(plan_date: date, payload: ExecutionTaskStartInput, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        task = get_task_row_for_execution(connection, day, payload.task_id)
        prepare_execution_task(connection, task)
        settings = get_settings(connection)
        label_id, label_name = resolve_segment_label(settings, task["category"], payload.label_id, "effective")
        exclude_new = handle_word_segment_conflict(
            connection, day, task["category"], label_id, "effective", payload.duplicate_choice
        )
        close_active_execution_segment(connection)
        started_at = now_iso()
        check_segment_overlap(connection, day, task["id"], started_at, None)
        cursor = connection.execute(
            """INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,label_id,label_name,started_at,time_category,included)
               VALUES(?,?,?,?,?,?,?,?)""",
            (day, task["id"], "effective", label_id, label_name, started_at, "learning", 0 if exclude_new else 1),
        )
        del cursor
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (task["plan_id"],))
        sync_plan_tasks_to_db(connection, task["plan_id"])
        return build_execution_payload(connection, day)


@router.post("/daily-execution/{plan_date}/labels/start")
def start_execution_label(plan_date: date, payload: ExecutionLabelStartInput, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        settings = get_settings(connection)
        label = build_execution_label_map(settings).get(payload.label_id)
        if not label:
            raise HTTPException(404, "标签不存在")
        active = get_active_execution_segment(connection, day)
        if active and active["label_id"] == label["id"] and (payload.task_id is None or payload.task_id == active["task_id"]):
            return build_execution_payload(connection, day)
        task_id = payload.task_id or (active["task_id"] if active else None)
        if task_id is None:
            raise HTTPException(409, "请先开始一个任务，再切换到标签")
        task = get_task_row_for_execution(connection, day, task_id)
        prepare_execution_task(connection, task)
        close_active_execution_segment(connection)
        started_at = now_iso()
        check_segment_overlap(connection, day, task["id"], started_at, None)
        segment_kind = "counted_label" if label["bucket"] == "counted" else "interrupt_label"
        cursor = connection.execute(
            """INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,label_id,label_name,started_at,time_category)
               VALUES(?,?,?,?,?,?,?)""",
            (day, task["id"], segment_kind, label["id"], label["name"], started_at, label_category(label)),
        )
        schedule_reminder(connection, int(cursor.lastrowid), payload.reminder_minutes, request.app)
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (task["plan_id"],))
        sync_plan_tasks_to_db(connection, task["plan_id"])
        return build_execution_payload(connection, day)


@router.post("/daily-execution/{plan_date}/quick-corrections")
def quick_correct_execution(plan_date: date, payload: QuickCorrectionInput, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        previous = connection.execute(
            "SELECT * FROM execution_quick_corrections WHERE request_id=?",
            (payload.request_id,),
        ).fetchone()
        if previous:
            if (
                previous["plan_date"],
                previous["source_segment_id"],
                previous["minutes"],
                previous["time_category"],
            ) != (day, payload.source_segment_id, payload.minutes, payload.time_category):
                raise HTTPException(409, "这次补记请求已使用，请核对记录后重新打开补记")
            return build_execution_payload(connection, day)
        active = get_active_execution_segment(connection)
        if not active or active["id"] != payload.source_segment_id or active["plan_date"] != day:
            raise HTTPException(409, "当前计时已停止或切换，请核对记录后重新打开补记")
        if active["segment_kind"] != "effective" or not active["included"]:
            raise HTTPException(409, "请在正在记录的有效学习段补记，其他活动保持原样")
        task = get_task_row_for_execution(connection, day, active["task_id"])
        now = now_iso()
        end = parse_iso_datetime(now)
        assert end is not None
        auto_stop = parse_iso_datetime(active["auto_stop_at"]) if active["auto_stop_at"] else None
        if auto_stop and auto_stop <= end:
            raise HTTPException(409, "本次计时已到自动停止时刻，请核对记录后再补录")
        start = end - timedelta(minutes=payload.minutes)
        active_start = parse_iso_datetime(active["started_at"])
        if active_start and start < active_start:
            raise HTTPException(409, "补记时长超过当前有效学习段，请选择更短的时长；原记录保留")
        start_text = local_iso(start)
        cancel_reminders(connection, active["id"])
        connection.execute("UPDATE task_execution_segments SET ended_at=? WHERE id=?", (start_text, active["id"]))
        check_segment_overlap(connection, day, task["id"], start_text, now)
        category = payload.time_category
        builtin_key = "quick_distraction" if category == "distraction" else "quick_life"
        builtin = QUICK_CORRECTION_BUILTINS[builtin_key]
        correction_id = int(
            connection.execute(
                """INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,time_category,label_id,label_name,started_at,ended_at,is_estimated)
                   VALUES(?,?,?,?,?,?,?,?,1)""",
                (
                    day,
                    task["id"],
                    "counted_label" if category == "distraction" else "interrupt_label",
                    category,
                    builtin["id"],
                    builtin["name"],
                    start_text,
                    now,
                ),
            ).lastrowid
        )
        check_segment_overlap(connection, day, task["id"], now, None)
        continuation_id = int(
            connection.execute(
                """INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,time_category,label_id,label_name,started_at,included,auto_stop_at)
                   VALUES(?,?,?,?,?,?,?,?,?)""",
                (
                    day,
                    task["id"],
                    "effective",
                    active["time_category"],
                    active["label_id"],
                    active["label_name"],
                    now,
                    active["included"],
                    active["auto_stop_at"],
                ),
            ).lastrowid
        )
        connection.execute("UPDATE task_execution_segments SET auto_stop_at=NULL WHERE id=?", (active["id"],))
        connection.execute(
            """INSERT INTO execution_quick_corrections(plan_date,request_id,source_segment_id,correction_segment_id,continuation_segment_id,minutes,time_category,created_at)
               VALUES(?,?,?,?,?,?,?,?)""",
            (day, payload.request_id, active["id"], correction_id, continuation_id, payload.minutes, category, now),
        )
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (task["plan_id"],))
        sync_plan_tasks_to_db(connection, task["plan_id"])
        return build_execution_payload(connection, day)


@router.post("/correction-shortcuts")
def add_correction_shortcut(payload: CorrectionShortcutInput, request: Request):
    with db_session(request) as connection:
        begin_immediate(connection)
        return add_shortcut_item(connection, payload.label_id, payload.minutes)


@router.delete("/correction-shortcuts/{shortcut_id}")
def remove_correction_shortcut(shortcut_id: str, request: Request):
    with db_session(request) as connection:
        begin_immediate(connection)
        items = [item for item in correction_shortcuts(connection) if item["id"] != shortcut_id]
        return save_correction_shortcuts(connection, items)


@router.post("/daily-execution/{plan_date}/time-corrections")
def correct_execution_time(plan_date: date, payload: TimeCorrectionInput, request: Request):
    day = plan_date.isoformat()
    signature = payload.model_dump(mode="json")
    with db_session(request) as connection:
        begin_immediate(connection)
        previous = connection.execute(
            "SELECT * FROM execution_quick_corrections WHERE request_id=?",
            (payload.request_id,),
        ).fetchone()
        if previous:
            if not previous["request_json"] or json.loads(previous["request_json"]) != signature:
                raise HTTPException(409, "这个请求已用于其他修正，请核对记录后重新打开")
            return build_execution_payload(connection, day) | {"correction_segment_id": previous["correction_segment_id"]}
        active = get_active_execution_segment(connection)
        if not active or active["id"] != payload.source_segment_id or active["plan_date"] != day or not active["included"]:
            raise HTTPException(409, "当前计时已停止或切换，请核对后重新打开修正时间")
        original = dict(
            connection.execute("SELECT * FROM task_execution_segments WHERE id=?", (active["id"],)).fetchone()
        )
        now = now_iso()
        now_dt = parse_iso_datetime(now)
        assert now_dt is not None
        end = now_dt - timedelta(minutes=payload.offset_minutes)
        start = end - timedelta(minutes=payload.minutes)
        active_start = parse_iso_datetime(active["started_at"])
        if active_start and start < active_start:
            raise HTTPException(409, "修正范围超过当前这段记录，请选择更短的时长；原记录保留")
        auto_stop = parse_iso_datetime(active["auto_stop_at"]) if active["auto_stop_at"] else None
        if auto_stop and auto_stop <= now_dt:
            raise HTTPException(409, "已经到自动停止时刻，请先核对记录")
        settings = get_settings(connection)
        if payload.mode == "segment":
            if active["segment_kind"] != "effective":
                raise HTTPException(409, "当前在记录其他活动，请使用“补一次切换”补回学习")
            label = correction_activities(settings).get(payload.label_id or "")
            if not label:
                raise HTTPException(404, "请选择刚才实际做的活动")
            task = get_task_row_for_execution(connection, day, active["task_id"])
            category, label_id, label_name = label["time_category"], label["id"], label["name"]
            kind = "counted_label" if category == "distraction" else "interrupt_label"
            continued = dict(original)
        else:
            if active["segment_kind"] == "effective" or payload.offset_minutes:
                raise HTTPException(422, "回溯切回学习用于当前非学习计时，且应持续到现在")
            task = get_task_row_for_execution(connection, day, payload.task_id or active["task_id"])
            prepare_execution_task(connection, task)
            category, kind = "learning", "effective"
            if payload.effective_label_id:
                label_id, label_name = resolve_segment_label(settings, task["category"], payload.effective_label_id, kind)
            else:
                last = connection.execute(
                    "SELECT label_id,label_name FROM task_execution_segments "
                    "WHERE task_id=? AND segment_kind='effective' AND included=1 ORDER BY started_at DESC,id DESC LIMIT 1",
                    (task["id"],),
                ).fetchone()
                label_id, label_name = (last["label_id"], last["label_name"]) if last else (None, None)
            if is_vocabulary_word_segment(task["category"], label_id, kind) and list_duration_records(connection, day):
                raise HTTPException(409, "当天已有背单词分钟记录，请先核对重复来源后再修正")
            continued = dict(original) | {
                "task_id": task["id"],
                "segment_kind": kind,
                "time_category": category,
                "label_id": label_id,
                "label_name": label_name,
                "is_estimated": 0,
                "auto_stop_at": None,
            }
        start_text, end_text = local_iso(start), local_iso(end)
        cancel_reminders(connection, active["id"])
        connection.execute(
            "UPDATE task_execution_segments SET ended_at=?,auto_stop_at=NULL WHERE id=?",
            (start_text, active["id"]),
        )
        check_segment_overlap(connection, day, task["id"], start_text, end_text)
        correction_id = int(
            connection.execute(
                """INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,time_category,label_id,label_name,started_at,ended_at,is_estimated)
                   VALUES(?,?,?,?,?,?,?,?,1)""",
                (day, task["id"], kind, category, label_id, label_name, start_text, end_text),
            ).lastrowid
        )
        check_segment_overlap(connection, day, continued["task_id"], end_text, None)
        continuation_id = int(
            connection.execute(
                """INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,time_category,label_id,label_name,started_at,auto_stop_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (
                    day,
                    continued["task_id"],
                    continued["segment_kind"],
                    continued["time_category"],
                    continued["label_id"],
                    continued["label_name"],
                    end_text,
                    continued["auto_stop_at"],
                ),
            ).lastrowid
        )
        snapshot = None
        if payload.mode == "switch":
            snapshot = json.dumps(
                {
                    "original": original,
                    "expected": {
                        str(identity): dict(
                            connection.execute("SELECT * FROM task_execution_segments WHERE id=?", (identity,)).fetchone()
                        )
                        for identity in (active["id"], correction_id, continuation_id)
                    },
                },
                ensure_ascii=False,
            )
        connection.execute(
            """INSERT INTO execution_quick_corrections(plan_date,request_id,source_segment_id,correction_segment_id,continuation_segment_id,minutes,time_category,created_at,request_json,original_state_json)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (
                day,
                payload.request_id,
                active["id"],
                correction_id,
                continuation_id,
                payload.minutes,
                category,
                now,
                json.dumps(signature),
                snapshot,
            ),
        )
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (task["plan_id"],))
        sync_plan_tasks_to_db(connection, task["plan_id"])
        return build_execution_payload(connection, day) | {"correction_segment_id": correction_id}


@router.put("/daily-execution/{plan_date}/auto-stop")
def set_execution_auto_stop(plan_date: date, payload: ExecutionAutoStopInput, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        active = get_active_execution_segment(connection, day)
        if not active or active["id"] != payload.segment_id:
            raise HTTPException(409, "当前计时已停止或切换，请核对后重新设置")
        due = parse_iso_datetime(payload.due_at.isoformat()) if payload.due_at else None
        now = parse_iso_datetime(now_iso())
        assert now is not None
        auto_stop = parse_iso_datetime(active["auto_stop_at"]) if active["auto_stop_at"] else None
        if auto_stop and auto_stop <= now:
            raise HTTPException(409, "已到自动停止时刻，请先核对记录")
        active_start = parse_iso_datetime(active["started_at"])
        if due and (due <= now or (active_start and due <= active_start) or due > now + timedelta(days=1)):
            raise HTTPException(422, "请选择未来24小时内、晚于计时开始的停止时间")
        connection.execute(
            "UPDATE task_execution_segments SET auto_stop_at=? WHERE id=?",
            (local_iso(due) if due else None, active["id"]),
        )
        return build_execution_payload(connection, day)


@router.post("/daily-execution/{plan_date}/stop")
def stop_execution(plan_date: date, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        plan = get_plan_row(connection, day)
        closed_task_id = close_active_execution_segment(connection, day)
        if closed_task_id is None:
            raise HTTPException(409, "当前没有正在计时的记录")
        if plan:
            sync_plan_tasks_to_db(connection, plan["id"])
        return build_execution_payload(connection, day)


@router.post("/daily-execution/{plan_date}/segments")
def create_execution_segment(plan_date: date, payload: ExecutionSegmentCreateInput, request: Request):
    assert_segment_time_window(payload.started_at, payload.ended_at)
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        task = get_task_row_for_execution(connection, day, payload.task_id)
        prepare_execution_task(connection, task)
        settings = get_settings(connection)
        label_id, label_name = resolve_segment_label(settings, task["category"], payload.label_id, payload.segment_kind)
        exclude_new = handle_word_segment_conflict(
            connection, day, task["category"], label_id, payload.segment_kind, payload.duplicate_choice
        )
        start_str, end_str = local_iso(payload.started_at), local_iso(payload.ended_at)
        check_segment_overlap(connection, day, task["id"], start_str, end_str)
        connection.execute(
            """INSERT INTO task_execution_segments(
                   plan_date,task_id,segment_kind,label_id,label_name,started_at,ended_at,time_category,included
               ) VALUES(?,?,?,?,?,?,?,?,?)""",
            (
                day,
                task["id"],
                payload.segment_kind,
                label_id,
                label_name,
                start_str,
                end_str,
                resolve_segment_category(settings, payload.segment_kind, label_id, payload.time_category),
                0 if exclude_new else 1,
            ),
        )
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (task["plan_id"],))
        sync_plan_tasks_to_db(connection, task["plan_id"])
        return build_execution_payload(connection, day)


@router.put("/daily-execution/{plan_date}/segments/{segment_id}")
def update_execution_segment(
    plan_date: date,
    segment_id: int,
    payload: ExecutionSegmentUpdateInput,
    request: Request,
):
    if payload.ended_at is not None:
        assert_segment_time_window(payload.started_at, payload.ended_at)
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        existing = connection.execute(
            """SELECT s.*, t.plan_id, t.category AS task_category
               FROM task_execution_segments s
               JOIN tasks t ON t.id=s.task_id
               WHERE s.id=? AND s.plan_date=?""",
            (segment_id, day),
        ).fetchone()
        if not existing:
            raise HTTPException(404, "时间段不存在")
        running = existing["ended_at"] is None
        if payload.expected_state is not None:
            for key, value in payload.expected_state.model_dump().items():
                expected = local_iso(value) if isinstance(value, datetime) else value
                actual = existing[key]
                if key in ("started_at", "ended_at") and actual is not None:
                    parsed_actual = parse_iso_datetime(actual)
                    actual = local_iso(parsed_actual) if parsed_actual else actual
                if expected != actual:
                    raise HTTPException(409, "这段记录已变化，请重新打开后编辑；当前输入未保存")
        if payload.ended_at is None and not running:
            raise HTTPException(409, "这段计时已停止或切换，请重新打开后编辑，不会恢复旧计时")
        start_str = local_iso(payload.started_at)
        end_str = local_iso(payload.ended_at) if payload.ended_at is not None else None
        if running:
            start_dt = parse_iso_datetime(start_str)
            now_dt = parse_iso_datetime(now_iso())
            if start_dt and now_dt and start_dt > now_dt:
                raise HTTPException(422, "正在计时的开始时间不能晚于当前时间")
            auto_stop = parse_iso_datetime(existing["auto_stop_at"]) if existing["auto_stop_at"] else None
            if start_dt and auto_stop and start_dt >= auto_stop:
                raise HTTPException(422, "开始时间必须早于已设置的自动停止时间，请先修改自动停止设置")
            if payload.ended_at is not None:
                raise HTTPException(409, "运行段保存后继续计时；如需结束，请使用停止按钮")
            linked = connection.execute(
                "SELECT 1 FROM execution_quick_corrections WHERE continuation_segment_id=?",
                (segment_id,),
            ).fetchone()
            if linked and (
                payload.task_id != existing["task_id"]
                or payload.segment_kind != "effective"
                or start_str != existing["started_at"]
            ):
                raise HTTPException(409, "这段连接着补记，请先撤销补记，再改任务、归类或开始时间")
        task = get_task_row_for_execution(connection, day, payload.task_id)
        prepare_execution_task(connection, task)
        settings = get_settings(connection)
        keep_label_snapshot = (
            payload.label_id == existing["label_id"]
            and payload.segment_kind == existing["segment_kind"]
            and (payload.segment_kind != "effective" or task["category"] == existing["task_category"])
        )
        if keep_label_snapshot:
            label_id, label_name = existing["label_id"], existing["label_name"]
        else:
            label_id, label_name = resolve_segment_label(settings, task["category"], payload.label_id, payload.segment_kind)
        if existing["is_estimated"]:
            assert end_str is not None
            resize_correction(connection, existing, payload, start_str, end_str, now_iso())
        exclude_updated = handle_word_segment_conflict(
            connection, day, task["category"], label_id, payload.segment_kind, payload.duplicate_choice
        )
        check_segment_overlap(connection, day, task["id"], start_str, end_str, skip_segment_id=segment_id)
        new_time_category = (
            existing["time_category"]
            if keep_label_snapshot and payload.time_category is None
            else resolve_segment_category(settings, payload.segment_kind, label_id, payload.time_category)
        )
        included = existing["included"] if label_id == existing["label_id"] and payload.duplicate_choice is None else 1
        if exclude_updated:
            included = 0
        connection.execute(
            """UPDATE task_execution_segments
               SET task_id=?, segment_kind=?, label_id=?, label_name=?, started_at=?, ended_at=?, time_category=?, included=?
               WHERE id=?""",
            (
                task["id"],
                payload.segment_kind,
                label_id,
                label_name,
                start_str,
                end_str,
                new_time_category,
                included,
                segment_id,
            ),
        )
        if running and (
            payload.task_id != existing["task_id"]
            or payload.segment_kind != existing["segment_kind"]
            or label_id != existing["label_id"]
            or start_str != existing["started_at"]
            or payload.time_category not in (None, existing["time_category"])
        ):
            cancel_reminders(connection, segment_id)
            if (
                payload.task_id != existing["task_id"]
                or payload.segment_kind != existing["segment_kind"]
                or label_id != existing["label_id"]
            ):
                connection.execute("UPDATE task_execution_segments SET auto_stop_at=NULL WHERE id=?", (segment_id,))
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (existing["plan_id"],))
        sync_plan_tasks_to_db(connection, existing["plan_id"])
        if existing["plan_id"] != task["plan_id"]:
            connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (task["plan_id"],))
            sync_plan_tasks_to_db(connection, task["plan_id"])
        return build_execution_payload(connection, day)


@router.delete("/daily-execution/{plan_date}/segments/{segment_id}")
def delete_execution_segment(plan_date: date, segment_id: int, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        existing = connection.execute(
            """SELECT s.*, t.plan_id
               FROM task_execution_segments s
               JOIN tasks t ON t.id=s.task_id
               WHERE s.id=? AND s.plan_date=?""",
            (segment_id, day),
        ).fetchone()
        if not existing:
            raise HTTPException(404, "时间段不存在")
        if existing["ended_at"] is None:
            raise HTTPException(409, "请先停止当前正在计时的记录，再删除它")
        if existing["is_estimated"]:
            undo_correction(connection, existing, now_iso())
        else:
            connection.execute("DELETE FROM task_execution_segments WHERE id=?", (segment_id,))
        connection.execute("UPDATE plans SET status='approved' WHERE id=? AND status='submitted'", (existing["plan_id"],))
        sync_plan_tasks_to_db(connection, existing["plan_id"])
        return build_execution_payload(connection, day)


@router.post("/daily-execution/{plan_date}/tasks", status_code=201)
def add_temporary_task(plan_date: date, payload: TemporaryTaskInput, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        plan = ensure_recordable_plan(connection, day)
        append_temporary_task(connection, plan, payload)
        connection.execute("UPDATE plans SET status='approved' WHERE id=?", (plan["id"],))
        return build_execution_payload(connection, day)


@router.get("/vocabulary-counts/{plan_date}")
def get_vocabulary_counts(plan_date: date, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        return {"date": day, "vocabulary_counts": vocabulary_counts(connection, day)}


@router.put("/vocabulary-counts/{plan_date}")
def save_vocabulary_counts(plan_date: date, payload: VocabularyCountsInput, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        connection.execute(
            """INSERT INTO vocabulary_daily_counts(plan_date,new_words,review_words,updated_at) VALUES(?,?,?,?)
               ON CONFLICT(plan_date) DO UPDATE SET new_words=excluded.new_words,
               review_words=excluded.review_words,updated_at=excluded.updated_at""",
            (day, payload.new_words, payload.review_words, now_iso()),
        )
        return {"date": day, "vocabulary_counts": vocabulary_counts(connection, day)}


@router.delete("/vocabulary-counts/{plan_date}")
def delete_vocabulary_counts(plan_date: date, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        connection.execute("DELETE FROM vocabulary_daily_counts WHERE plan_date=?", (day,))
        return {"date": day, "vocabulary_counts": vocabulary_counts(connection, day)}


@router.post("/daily-execution/{plan_date}/vocabulary", status_code=201)
def create_vocabulary_record(plan_date: date, payload: DurationRecordInput, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        plan = ensure_recordable_plan(connection, day)
        apply_vocabulary_choice(connection, day, payload.duplicate_choice)
        task = connection.execute(
            "SELECT * FROM tasks WHERE plan_id=? AND category='english' ORDER BY is_sub,position,id LIMIT 1",
            (plan["id"],),
        ).fetchone()
        if not task:
            settings = get_settings(connection)
            english_title = settings["task_titles"].get("english", "英语")
            task = append_temporary_task(connection, plan, TemporaryTaskInput(title=english_title, category="english"))
        prepare_execution_task(connection, task)
        connection.execute(
            "INSERT INTO task_duration_records(task_id,minutes,included) VALUES(?,?,?)",
            (task["id"], payload.minutes, int(payload.duplicate_choice != "timer")),
        )
        connection.execute("UPDATE plans SET status='approved' WHERE id=?", (plan["id"],))
        sync_plan_tasks_to_db(connection, plan["id"])
        return build_execution_payload(connection, day)


@router.put("/daily-execution/{plan_date}/vocabulary/{record_id}")
def update_vocabulary_record(plan_date: date, record_id: int, payload: DurationRecordInput, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        plan = ensure_recordable_plan(connection, day)
        if not any(row["id"] == record_id for row in list_duration_records(connection, day)):
            raise HTTPException(404, "时长记录不存在")
        apply_vocabulary_choice(connection, day, payload.duplicate_choice)
        connection.execute("UPDATE task_duration_records SET minutes=? WHERE id=?", (payload.minutes, record_id))
        connection.execute("UPDATE plans SET status='approved' WHERE id=?", (plan["id"],))
        sync_plan_tasks_to_db(connection, plan["id"])
        return build_execution_payload(connection, day)


@router.delete("/daily-execution/{plan_date}/vocabulary/{record_id}")
def delete_vocabulary_record(plan_date: date, record_id: int, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        plan = ensure_recordable_plan(connection, day)
        if not any(row["id"] == record_id for row in list_duration_records(connection, day)):
            raise HTTPException(404, "时长记录不存在")
        connection.execute("DELETE FROM task_duration_records WHERE id=?", (record_id,))
        connection.execute("UPDATE plans SET status='approved' WHERE id=?", (plan["id"],))
        sync_plan_tasks_to_db(connection, plan["id"])
        return build_execution_payload(connection, day)
