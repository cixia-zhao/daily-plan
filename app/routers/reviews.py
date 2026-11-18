"""单日复盘、周复盘、导航月历与 GPT 协作工作台路由。"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Request

from app.routers.deps import begin_immediate, db_session
from app.schemas import GPTRecordSaveInput, ReviewInput, WeeklyReportSaveInput
from app.services.clock import today_date
from app.services.prompts import (
    CHATGPT_EXPORT_SYSTEM_PROMPT,
    DAILY_GPT_SYSTEM_PROMPT,
    WEEKLY_ANALYSIS_SYSTEM_PROMPT,
    WEEKLY_GPT_SYSTEM_PROMPT,
)
from app.services.review_engine import (
    build_calendar_status,
    build_chatgpt_prompt,
    build_daily_gpt_prompt,
    build_review_navigation,
    build_weekday_progress,
    build_weekly_snapshot,
    daily_comparison,
    daily_prompt_settings,
    get_gpt_record,
    get_weekly_report_row,
    list_gpt_records,
    list_weekly_reports,
    parse_month_start,
    read_weekly_report,
    save_gpt_record,
    serialize_daily_reviews_range,
    snapshot_hash,
    upsert_weekly_report,
    week_bounds,
    weekly_comparison,
    weekly_prompt_settings,
)
from app.services.settings_store import get_settings, project_start_date, resolve_prompt_content

router = APIRouter()


@router.post("/daily-reviews")
def save_review(payload: ReviewInput, request: Request):
    day = payload.date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        previous = connection.execute(
            "SELECT learning_outcome FROM reviews WHERE review_date=?",
            (day,),
        ).fetchone()
        outcome = (
            payload.learning_outcome
            if "learning_outcome" in payload.model_fields_set
            else (previous["learning_outcome"] if previous else "")
        )
        connection.execute(
            """INSERT INTO reviews(
                   review_date,distraction,mood,hardest_point,effective_method,
                   optimization_note,real_progress,tomorrow_focus,reflection_text,learning_outcome
               ) VALUES(?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(review_date) DO UPDATE SET
                   distraction=excluded.distraction,
                   mood=excluded.mood,
                   hardest_point=excluded.hardest_point,
                   effective_method=excluded.effective_method,
                   optimization_note=excluded.optimization_note,
                   real_progress=excluded.real_progress,
                   tomorrow_focus=excluded.tomorrow_focus,
                   reflection_text=excluded.reflection_text,
                   learning_outcome=excluded.learning_outcome""",
            (
                day,
                payload.hardest_point,
                payload.mood,
                payload.hardest_point,
                payload.effective_method,
                payload.optimization_note,
                payload.real_progress,
                payload.tomorrow_focus,
                payload.reflection_text,
                outcome,
            ),
        )
        return {"saved": True}


@router.get("/daily-review/{plan_date}")
def daily_review(plan_date: date, request: Request):
    day = plan_date.isoformat()
    prev_date = plan_date - timedelta(days=1)
    with db_session(request) as connection:
        settings = get_settings(connection)
        previous_daily, daily = serialize_daily_reviews_range(connection, prev_date, plan_date)
        prompt_text = build_daily_gpt_prompt(
            connection,
            day,
            resolve_prompt_content(
                settings,
                "daily_gpt_prompts",
                "daily_gpt_active_prompt_id",
                "daily_gpt_system_default",
                DAILY_GPT_SYSTEM_PROMPT,
            ),
            daily=daily,
        )
        return daily | {
            "comparison": daily_comparison(connection, daily, previous_daily=previous_daily),
            "gpt_prompt_text": prompt_text,
            "gpt_record": get_gpt_record(connection, "daily", day, day, prompt_text),
            "prompt_settings": daily_prompt_settings(settings),
        }


@router.put("/daily-review/{plan_date}/gpt-record")
def save_daily_gpt_record(plan_date: date, payload: GPTRecordSaveInput, request: Request):
    day = plan_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        settings = get_settings(connection)
        prompt_text = build_daily_gpt_prompt(
            connection,
            day,
            resolve_prompt_content(
                settings,
                "daily_gpt_prompts",
                "daily_gpt_active_prompt_id",
                "daily_gpt_system_default",
                DAILY_GPT_SYSTEM_PROMPT,
            ),
        )
        return save_gpt_record(
            connection,
            "daily",
            day,
            day,
            prompt_text,
            payload.response_text,
            payload.adopted_text,
        )


@router.get("/review-navigation")
def review_navigation(request: Request, anchor_date: date):
    with db_session(request) as connection:
        return build_review_navigation(connection, anchor_date)


@router.get("/weekly-review")
def weekly_review(request: Request, end_date: date | None = None, anchor_date: date | None = None):
    anchor = anchor_date or end_date or today_date()
    start, end = week_bounds(anchor)
    previous_start = start - timedelta(days=7)
    with db_session(request) as connection:
        settings = get_settings(connection)
        # 一次性批量预取上周 + 本周共 14 天数据，消除 14 次逐日全量查询风暴
        fourteen_days = serialize_daily_reviews_range(connection, previous_start, end)
        prev_days, curr_days = fourteen_days[:7], fourteen_days[7:]
        snapshot = build_weekly_snapshot(connection, start, end, prefetched_days=curr_days)
        report = read_weekly_report(connection, snapshot, settings)
        progress = build_weekday_progress(snapshot)
        gpt_prompt_text = build_chatgpt_prompt(
            snapshot,
            report["deepseek_analysis"],
            resolve_prompt_content(
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
            "comparison": weekly_comparison(connection, snapshot, previous_days=prev_days),
            "analysis": report["deepseek_analysis"],
            "analysis_stale": report["analysis_stale"],
            "ai_status": report["ai_status"],
            "ai_error": report["ai_error"],
            "chatgpt_prompt_text": report["chatgpt_prompt_text"],
            "gpt_prompt_text": gpt_prompt_text,
            "gpt_record": get_gpt_record(connection, "weekly", week_key, week_label, gpt_prompt_text),
            "final_report_text": report["final_report_text"],
            "history": list_weekly_reports(connection),
            "weekday_progress": progress,
            "anchor_date": anchor.isoformat(),
            "prompt_settings": weekly_prompt_settings(settings),
        }


@router.get("/calendar-status")
def calendar_status(month: str, request: Request):
    try:
        month_start = parse_month_start(month)
    except ValueError:
        raise HTTPException(422, "月份格式应为 YYYY-MM")
    with db_session(request) as connection:
        settings = get_settings(connection)
        return build_calendar_status(connection, month_start, project_start_date(settings))


@router.get("/weekly-reports")
def get_weekly_reports(request: Request):
    with db_session(request) as connection:
        return list_weekly_reports(connection)


@router.get("/weekly-reports/{end_date}")
def get_weekly_report(end_date: date, request: Request):
    start = end_date - timedelta(days=6)
    with db_session(request) as connection:
        settings = get_settings(connection)
        snapshot = build_weekly_snapshot(connection, start, end_date)
        report = read_weekly_report(connection, snapshot, settings)
        gpt_prompt_text = build_chatgpt_prompt(
            snapshot,
            report["deepseek_analysis"],
            resolve_prompt_content(
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
            "gpt_record": get_gpt_record(connection, "weekly", end_date.isoformat(), week_label, gpt_prompt_text),
            "weekday_progress": build_weekday_progress(snapshot),
        }


@router.post("/weekly-reports/{end_date}/refresh")
def refresh_weekly_report(end_date: date, request: Request):
    start = end_date - timedelta(days=6)
    with db_session(request) as connection:
        settings = get_settings(connection)
        snapshot = build_weekly_snapshot(connection, start, end_date)
    analyzer = getattr(request.app.state, "weekly_review_analyzer", None)
    if not analyzer:
        raise HTTPException(409, "AI 分析未启用；可复制本周事实给 ChatGPT 整理")
    prompt = resolve_prompt_content(
        settings,
        "weekly_analysis_prompts",
        "weekly_analysis_active_prompt_id",
        "weekly_analysis_system_default",
        WEEKLY_ANALYSIS_SYSTEM_PROMPT,
    )
    model, error = analyzer.analyze(snapshot, prompt)
    analysis = model.model_dump() if model else None
    export_prompt = resolve_prompt_content(
        settings,
        "chatgpt_export_prompts",
        "chatgpt_export_active_prompt_id",
        "chatgpt_export_system_default",
        CHATGPT_EXPORT_SYSTEM_PROMPT,
    )
    snapshot_json, digest = snapshot_hash(snapshot)
    with db_session(request) as connection:
        begin_immediate(connection)
        if not analysis:
            connection.execute(
                "UPDATE weekly_reports SET ai_status='error', ai_error=? WHERE end_date=?",
                (error or "AI 分析失败", str(end_date)),
            )
        else:
            upsert_weekly_report(
                connection,
                snapshot,
                snapshot_json,
                digest,
                analysis,
                build_chatgpt_prompt(snapshot, analysis, export_prompt),
                "ready",
                None,
            )
    if not analysis:
        raise HTTPException(502, error or "AI 分析失败，已保留原来的内容")
    return {"saved": True}


@router.put("/weekly-reports/{end_date}")
def save_weekly_report(end_date: date, payload: WeeklyReportSaveInput, request: Request):
    end_iso = end_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        report = get_weekly_report_row(connection, end_iso)
        if not report:
            start = end_date - timedelta(days=6)
            snapshot = build_weekly_snapshot(connection, start, end_date)
            settings = get_settings(connection)
            report = read_weekly_report(connection, snapshot, settings)
            snapshot_json, digest = snapshot_hash(snapshot)
            upsert_weekly_report(
                connection,
                snapshot,
                snapshot_json,
                digest,
                None,
                report["chatgpt_prompt_text"],
                "unavailable",
                None,
            )
        connection.execute(
            "UPDATE weekly_reports SET final_report_text=?, updated_at=CURRENT_TIMESTAMP WHERE end_date=?",
            (payload.final_report_text, end_iso),
        )
        return get_weekly_report_row(connection, end_iso)


@router.put("/weekly-review/{end_date}/gpt-record")
def save_weekly_gpt_record(end_date: date, payload: GPTRecordSaveInput, request: Request):
    start = end_date - timedelta(days=6)
    end_iso = end_date.isoformat()
    with db_session(request) as connection:
        begin_immediate(connection)
        settings = get_settings(connection)
        snapshot = build_weekly_snapshot(connection, start, end_date)
        report = read_weekly_report(connection, snapshot, settings)
        prompt_text = build_chatgpt_prompt(
            snapshot,
            report["deepseek_analysis"],
            resolve_prompt_content(
                settings,
                "weekly_gpt_prompts",
                "weekly_gpt_active_prompt_id",
                "weekly_gpt_system_default",
                WEEKLY_GPT_SYSTEM_PROMPT,
            ),
        )
        return save_gpt_record(
            connection,
            "weekly",
            end_iso,
            f"{start.isoformat()} → {end_iso}",
            prompt_text,
            payload.response_text,
            payload.adopted_text,
        )


@router.get("/gpt-workbench")
def get_gpt_workbench(request: Request):
    with db_session(request) as connection:
        settings = get_settings(connection)
        return {
            "prompt_settings": {
                **daily_prompt_settings(settings),
                "weekly_gpt_prompts": settings["weekly_gpt_prompts"],
                "weekly_gpt_active_prompt_id": settings["weekly_gpt_active_prompt_id"],
            },
            "daily_records": list_gpt_records(connection, "daily"),
            "weekly_records": list_gpt_records(connection, "weekly"),
        }
