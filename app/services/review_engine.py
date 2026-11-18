"""单日/整周复盘批量聚合、月历与导航状态及 GPT 提示词导出服务。"""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta

from app.services.catalog import VOCABULARY_WORD_LABEL_ID, default_task_type_for
from app.services.clock import now_iso, today_date, today_iso
from app.services.execution_engine import (
    aggregate_execution_board,
    compute_task_progress,
    execution_records,
    has_saved_execution,
    list_execution_segments,
    serialize_execution_segment_row,
    vocabulary_counts,
)
from app.services.prompts import CHATGPT_EXPORT_SYSTEM_PROMPT
from app.services.reminders import reminders_for_segments
from app.services.settings_store import resolve_prompt_content
from app.services.time_accounting import combine_summaries, summary_text

EMPTY_REVIEW = {
    "learning_outcome": "",
    "mood": "",
    "hardest_point": "",
    "effective_method": "",
    "optimization_note": "",
    "real_progress": "",
    "tomorrow_focus": "",
    "reflection_text": "",
}

WEEKDAY_LABELS = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")


def is_planned_main_task(row) -> bool:
    return not row["is_sub"] and row["estimated_minutes"] > 0


def week_bounds(anchor: date) -> tuple[date, date]:
    start = anchor - timedelta(days=anchor.weekday())
    end = start + timedelta(days=6)
    return start, end


def parse_month_start(month: str) -> date:
    return datetime.strptime(f"{month}-01", "%Y-%m-%d").date()


def serialize_review_row(review) -> dict:
    if not review:
        return dict(EMPTY_REVIEW)
    return {
        "mood": review["mood"] or "",
        "learning_outcome": review["learning_outcome"] or "",
        "hardest_point": review["hardest_point"] or review["distraction"] or "",
        "effective_method": review["effective_method"] or "",
        "optimization_note": review["optimization_note"] or "",
        "real_progress": review["real_progress"] or "",
        "tomorrow_focus": review["tomorrow_focus"] or "",
        "reflection_text": review["reflection_text"] or "",
    }


def _assemble_daily_review(
    plan_date: str,
    plan_row,
    raw_tasks: list,
    records: list[dict],
    review_row,
    vocab_counts: dict | None,
) -> dict:
    projected_tasks: list[dict] = []
    task_board: list[dict] = []
    if plan_row:
        projected_tasks = compute_task_progress(raw_tasks, records)
        task_board = aggregate_execution_board(
            [dict(row) | {"completed": bool(row["completed"]), "is_sub": bool(row["is_sub"])} for row in projected_tasks],
            records,
        )

    main_tasks = [row for row in projected_tasks if is_planned_main_task(row)]
    sub_tasks = [row for row in projected_tasks if row["is_sub"]]
    status = plan_row["status"] if plan_row else None
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
        "vocabulary": sum(
            label["seconds"]
            for t in task_board
            for label in t["effective_labels"]
            if label["label_id"] == VOCABULARY_WORD_LABEL_ID
        ),
    }
    return {
        **{f"{key}_seconds": value for key, value in seconds.items()},
        "date": plan_date,
        "status": status,
        "status_label": status_label,
        "main_task_count": len(main_tasks),
        "main_completed_count": sum(int(bool(row["completed"])) for row in main_tasks),
        "main_planned_minutes": sum(row["estimated_minutes"] for row in main_tasks),
        "english_minutes": seconds["english"] // 60,
        "vocabulary_minutes": seconds["vocabulary"] // 60,
        "vocabulary_counts": vocab_counts,
        "main_actual_minutes": seconds["main_actual"] // 60,
        "sub_actual_minutes": seconds["sub_actual"] // 60,
        "main_total_minutes": seconds["main_total"] // 60,
        "sub_total_minutes": seconds["sub_total"] // 60,
        "sub_completed_count": sum(int(bool(row["completed"])) for row in sub_tasks),
        "time_summary": combine_summaries([board["time_summary"] for board in task_board]),
        "has_review": bool(review_row),
        "has_execution": has_saved_execution(projected_tasks, records),
        "task_execution_board": task_board,
        "review": serialize_review_row(review_row),
        "_projected_tasks": projected_tasks,
    }


def serialize_daily_review(connection, plan_date: str) -> dict:
    plan = connection.execute("SELECT * FROM plans WHERE plan_date=?", (plan_date,)).fetchone()
    review = connection.execute(
        """SELECT distraction,mood,hardest_point,effective_method,optimization_note,
                  real_progress,tomorrow_focus,reflection_text,learning_outcome
           FROM reviews WHERE review_date=?""",
        (plan_date,),
    ).fetchone()
    raw_tasks = (
        connection.execute("SELECT * FROM tasks WHERE plan_id=? ORDER BY position,id", (plan["id"],)).fetchall()
        if plan
        else []
    )
    records = execution_records(connection, plan_date) if plan else []
    vocab = vocabulary_counts(connection, plan_date)
    result = _assemble_daily_review(plan_date, plan, raw_tasks, records, review, vocab)
    result.pop("_projected_tasks", None)
    return result


def serialize_daily_reviews_range(connection, start: date, end: date) -> list[dict]:
    """批量预取日期区间内的全部计划、任务、片段、时长、复盘与词数，将周复盘 150+ 次查询降为 6 次只读查询。"""
    start_iso, end_iso = start.isoformat(), end.isoformat()
    plans_by_date = {
        row["plan_date"]: row
        for row in connection.execute(
            "SELECT * FROM plans WHERE plan_date BETWEEN ? AND ?",
            (start_iso, end_iso),
        ).fetchall()
    }
    plan_ids = [row["id"] for row in plans_by_date.values()]
    tasks_by_plan: dict[int, list] = {}
    if plan_ids:
        placeholders = ",".join("?" for _ in plan_ids)
        for row in connection.execute(
            f"SELECT * FROM tasks WHERE plan_id IN ({placeholders}) ORDER BY position,id",
            tuple(plan_ids),
        ).fetchall():
            tasks_by_plan.setdefault(row["plan_id"], []).append(row)

    seg_rows = connection.execute(
        """SELECT s.*, t.title AS task_title
           FROM task_execution_segments s
           JOIN tasks t ON t.id=s.task_id
           WHERE s.plan_date BETWEEN ? AND ?
           ORDER BY s.started_at, s.id""",
        (start_iso, end_iso),
    ).fetchall()
    ref_now = now_iso()
    reminder_map = reminders_for_segments(connection, [row["id"] for row in seg_rows])
    records_by_date: dict[str, list[dict]] = {}
    for row in seg_rows:
        records_by_date.setdefault(row["plan_date"], []).append(
            serialize_execution_segment_row(row, reference_now=ref_now) | {"reminder": reminder_map.get(row["id"])}
        )

    for row in connection.execute(
        """SELECT r.*, t.title AS task_title, p.plan_date
           FROM task_duration_records r
           JOIN tasks t ON t.id=r.task_id
           JOIN plans p ON p.id=t.plan_id
           WHERE p.plan_date BETWEEN ? AND ?
           ORDER BY r.id""",
        (start_iso, end_iso),
    ).fetchall():
        item = dict(row)
        day_key = item.pop("plan_date")
        item["segment_kind"] = "effective"
        records_by_date.setdefault(day_key, []).append(item)

    reviews_by_date = {
        row["review_date"]: row
        for row in connection.execute(
            """SELECT review_date,distraction,mood,hardest_point,effective_method,optimization_note,
                      real_progress,tomorrow_focus,reflection_text,learning_outcome
               FROM reviews WHERE review_date BETWEEN ? AND ?""",
            (start_iso, end_iso),
        ).fetchall()
    }
    vocab_by_date = {
        row["plan_date"]: dict(row)
        for row in connection.execute(
            "SELECT * FROM vocabulary_daily_counts WHERE plan_date BETWEEN ? AND ?",
            (start_iso, end_iso),
        ).fetchall()
    }

    output: list[dict] = []
    total_days = (end - start).days + 1
    for offset in range(total_days):
        day_iso = (start + timedelta(days=offset)).isoformat()
        plan = plans_by_date.get(day_iso)
        raw_tasks = tasks_by_plan.get(plan["id"], []) if plan else []
        records = records_by_date.get(day_iso, []) if plan else []
        assembled = _assemble_daily_review(
            day_iso,
            plan,
            raw_tasks,
            records,
            reviews_by_date.get(day_iso),
            vocab_by_date.get(day_iso),
        )
        assembled.pop("_projected_tasks", None)
        output.append(assembled)
    return output


def daily_prompt_settings(settings: dict) -> dict:
    return {
        "daily_gpt_prompts": settings["daily_gpt_prompts"],
        "daily_gpt_active_prompt_id": settings["daily_gpt_active_prompt_id"],
    }


def weekly_prompt_settings(settings: dict) -> dict:
    return {
        "project_start_date": settings["project_start_date"],
        "weekly_analysis_prompts": settings["weekly_analysis_prompts"],
        "weekly_analysis_active_prompt_id": settings["weekly_analysis_active_prompt_id"],
        "chatgpt_export_prompts": settings["chatgpt_export_prompts"],
        "chatgpt_export_active_prompt_id": settings["chatgpt_export_active_prompt_id"],
        "weekly_gpt_prompts": settings["weekly_gpt_prompts"],
        "weekly_gpt_active_prompt_id": settings["weekly_gpt_active_prompt_id"],
    }


def get_gpt_record(connection, record_type: str, anchor_key: str, date_label: str, prompt_text: str) -> dict:
    row = connection.execute(
        """SELECT record_type,anchor_key,date_label,prompt_text,response_text,adopted_text,created_at,updated_at
           FROM gpt_collab_records WHERE record_type=? AND anchor_key=?""",
        (record_type, anchor_key),
    ).fetchone()
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


def save_gpt_record(
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
    return get_gpt_record(connection, record_type, anchor_key, date_label, prompt_text)


def list_gpt_records(connection, record_type: str) -> list[dict]:
    rows = connection.execute(
        """SELECT record_type,anchor_key,date_label,prompt_text,response_text,adopted_text,created_at,updated_at
           FROM gpt_collab_records
           WHERE record_type=? AND (response_text <> '' OR adopted_text <> '')
           ORDER BY updated_at DESC, id DESC LIMIT 24""",
        (record_type,),
    ).fetchall()
    return [dict(row) for row in rows]


def compute_weekly_metrics(connection, start: date, end: date, days: list[dict] | None = None) -> dict:
    days = days if days is not None else serialize_daily_reviews_range(connection, start, end)
    current_iso = today_iso()
    eligible = [
        day for day in days if day["date"] <= current_iso and day["status"] in ("approved", "submitted")
    ]
    task_count = sum(day["main_task_count"] for day in eligible)
    completed = sum(day["main_completed_count"] for day in eligible)
    effective = sum(day["main_actual_seconds"] for day in eligible)
    total = sum(day["main_total_seconds"] for day in eligible)
    distribution: dict[str, dict] = {}
    for day in eligible:
        for task in day["task_execution_board"]:
            if task["is_sub"]:
                continue
            item = distribution.setdefault(
                task["category"],
                {
                    "category": task["category"],
                    "title": task["task_title"],
                    "total_seconds": 0,
                    "effective_seconds": 0,
                },
            )
            item["total_seconds"] += task["total_seconds"]
            item["effective_seconds"] += task["effective_seconds"]
    for item in distribution.values():
        item["total_minutes"] = item["total_seconds"] // 60
        item["effective_minutes"] = item["effective_seconds"] // 60
    return {
        "time_summary": combine_summaries([day["time_summary"] for day in eligible]),
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "review_days": sum(int(bool(day["has_review"])) for day in days if day["date"] <= current_iso),
        "task_count": task_count,
        "completed_count": completed,
        "completed_sub_count": sum(day["sub_completed_count"] for day in eligible),
        "completion_rate": round(completed / task_count, 3) if task_count else 0,
        "planned_minutes": sum(day["main_planned_minutes"] for day in eligible),
        "actual_minutes": effective // 60,
        "total_minutes": total // 60,
        "actual_seconds": effective,
        "total_seconds": total,
        "effective_ratio": round(effective / total, 4) if total else 0,
        "actual_sub_minutes": sum(day["sub_actual_seconds"] for day in eligible) // 60,
        "total_sub_minutes": sum(day["sub_total_seconds"] for day in eligible) // 60,
        "total_sub_seconds": sum(day["sub_total_seconds"] for day in eligible),
        "english_minutes": sum(day["english_seconds"] for day in eligible) // 60,
        "vocabulary_minutes": sum(day["vocabulary_seconds"] for day in eligible) // 60,
        "task_distribution": sorted(distribution.values(), key=lambda item: item["total_minutes"], reverse=True),
    }


def build_weekly_snapshot(connection, start: date, end: date, *, prefetched_days: list[dict] | None = None) -> dict:
    days = prefetched_days if prefetched_days is not None else serialize_daily_reviews_range(connection, start, end)
    return compute_weekly_metrics(connection, start, end, days) | {"days": days}


def compare_projects(current: list[dict], previous: list[dict]) -> list[dict]:
    projects: dict[str, dict] = {}
    for source, key in ((previous, "previous_seconds"), (current, "current_seconds")):
        for item in source:
            category = item["category"]
            project = projects.setdefault(
                category,
                {"category": category, "title": "", "current_seconds": 0, "previous_seconds": 0},
            )
            project["title"] = item.get("task_title", item.get("title", category))
            project[key] += item["effective_seconds"]
    return sorted(projects.values(), key=lambda item: max(item["current_seconds"], item["previous_seconds"]), reverse=True)


def weekly_comparison(connection, snapshot: dict, *, previous_days: list[dict] | None = None) -> dict:
    start, end = date.fromisoformat(snapshot["start_date"]), date.fromisoformat(snapshot["end_date"])
    current_day = today_date()
    through = min(end, current_day)
    if through < start:
        return {"available": False, "in_progress": False}
    previous_start, previous_end = start - timedelta(days=7), through - timedelta(days=7)
    prev_days = (
        previous_days
        if previous_days is not None
        else serialize_daily_reviews_range(connection, previous_start, previous_start + timedelta(days=6))
    )
    previous = compute_weekly_metrics(
        connection,
        previous_start,
        previous_end,
        [day for day in prev_days if day["date"] <= str(previous_end)],
    )
    current_seconds, previous_seconds = snapshot["total_seconds"], previous["total_seconds"]
    return {
        "available": True,
        "in_progress": start <= current_day <= end,
        "start_date": str(start),
        "through_date": str(through),
        "previous_start_date": str(previous_start),
        "previous_end_date": str(previous_end),
        "current_seconds": current_seconds,
        "previous_seconds": previous_seconds,
        "difference_seconds": current_seconds - previous_seconds,
        "change_ratio": round((current_seconds - previous_seconds) / previous_seconds, 4) if previous_seconds else None,
        "previous_days": [
            {
                "date": day["date"],
                "effective_seconds": (
                    day["main_actual_seconds"]
                    if day["has_execution"] and day["status"] in ("approved", "submitted")
                    else None
                ),
            }
            for day in prev_days
        ],
        "effective_difference_seconds": (
            snapshot["time_summary"]["categories"]["learning"] - previous["time_summary"]["categories"]["learning"]
        ),
        "distraction_difference_seconds": (
            snapshot["time_summary"]["categories"]["distraction"]
            - previous["time_summary"]["categories"]["distraction"]
        ),
        "current_has_execution": any(
            day["has_execution"] and day["status"] in ("approved", "submitted")
            for day in snapshot["days"]
            if day["date"] <= str(through)
        ),
        "previous_has_execution": any(
            day["has_execution"] and day["status"] in ("approved", "submitted")
            for day in prev_days
            if day["date"] <= str(previous_end)
        ),
        "projects": compare_projects(snapshot["task_distribution"], previous["task_distribution"]),
    }


def daily_comparison(connection, daily: dict, *, previous_daily: dict | None = None) -> dict:
    previous_date = date.fromisoformat(daily["date"]) - timedelta(days=1)
    previous = previous_daily if previous_daily is not None else serialize_daily_review(connection, str(previous_date))
    current_iso = today_iso()
    available = daily["date"] <= current_iso
    current_has = available and daily["has_execution"] and daily["status"] in ("approved", "submitted")
    previous_has = previous["has_execution"] and previous["status"] in ("approved", "submitted")
    current_summary, previous_summary = daily["time_summary"], previous["time_summary"]
    comparable = current_has and previous_has
    ratio, previous_ratio = current_summary["effective_ratio"], previous_summary["effective_ratio"]
    return {
        "available": available,
        "previous_date": str(previous_date),
        "in_progress": daily["date"] == current_iso,
        "current_has_execution": bool(current_has),
        "previous_has_execution": bool(previous_has),
        "effective_difference_seconds": (
            current_summary["categories"]["learning"] - previous_summary["categories"]["learning"]
            if comparable
            else None
        ),
        "distraction_difference_seconds": (
            current_summary["categories"]["distraction"] - previous_summary["categories"]["distraction"]
            if comparable
            else None
        ),
        "efficiency_difference_points": (
            round((ratio - previous_ratio) * 100, 2)
            if comparable and ratio is not None and previous_ratio is not None
            else None
        ),
        "projects": compare_projects(
            daily["task_execution_board"] if current_has else [],
            previous["task_execution_board"] if previous_has else [],
        ),
    }


def build_calendar_status(connection, month_start: date, project_start: date) -> dict:
    next_month = date(month_start.year + (1 if month_start.month == 12 else 0), 1 if month_start.month == 12 else month_start.month + 1, 1)
    month_end = next_month - timedelta(days=1)
    today = today_date()
    start_iso, end_iso = month_start.isoformat(), month_end.isoformat()

    plan_statuses = {
        row["plan_date"]: row["status"]
        for row in connection.execute(
            "SELECT plan_date,status FROM plans WHERE plan_date BETWEEN ? AND ?",
            (start_iso, end_iso),
        ).fetchall()
    }
    review_dates = {
        row["review_date"]
        for row in connection.execute(
            "SELECT review_date FROM reviews WHERE review_date BETWEEN ? AND ?",
            (start_iso, end_iso),
        ).fetchall()
    }
    execution_dates = {
        row[0]
        for row in connection.execute(
            "SELECT DISTINCT plan_date FROM task_execution_segments WHERE plan_date BETWEEN ? AND ?",
            (start_iso, end_iso),
        )
    }
    reset_dates = {
        row[0]
        for row in connection.execute(
            "SELECT DISTINCT plan_date FROM daily_reset_snapshots WHERE restored_at IS NULL AND plan_date BETWEEN ? AND ?",
            (start_iso, end_iso),
        )
    }
    count_dates = {
        row[0]
        for row in connection.execute(
            "SELECT plan_date FROM vocabulary_daily_counts WHERE plan_date BETWEEN ? AND ?",
            (start_iso, end_iso),
        )
    }
    history_dates = set(plan_statuses) | review_dates | execution_dates | reset_dates | count_dates

    days = []
    cursor = month_start
    while cursor <= month_end:
        iso_day = cursor.isoformat()
        has_review = iso_day in review_dates
        has_history = iso_day in history_dates
        plan_status = plan_statuses.get(iso_day)
        if cursor > today or (cursor < project_start and not has_history):
            state = {
                "visibility": "out_of_range",
                "status": None,
                "is_today": cursor == today,
                "is_future": cursor > today,
            }
        else:
            status_value = (
                "reviewed"
                if has_review
                else "submitted"
                if plan_status == "submitted"
                else "planned"
                if plan_status == "approved"
                else "empty"
            )
            state = {
                "visibility": "in_range",
                "status": status_value,
                "is_today": cursor == today,
                "is_future": False,
            }
        days.append({"date": iso_day, "day": cursor.day, **state})
        cursor += timedelta(days=1)

    return {
        "month": month_start.strftime("%Y-%m"),
        "month_start": start_iso,
        "month_end": end_iso,
        "project_start_date": project_start.isoformat(),
        "days": days,
    }


def build_chatgpt_prompt(snapshot: dict, deepseek_analysis: dict | None, export_template: str) -> str:
    lines = [
        export_template,
        "",
        f"周范围：{snapshot['start_date']} 到 {snapshot['end_date']}",
        f"主任务完成率：{round(snapshot['completion_rate'] * 100)}%",
        f"主任务完成数：{snapshot['completed_count']} / {snapshot['task_count']}",
        f"主任务计划分钟：{snapshot['planned_minutes']} 分",
        f"主任务实际分钟：{snapshot['actual_minutes']} 分",
        f"主航线总计投入：{snapshot['total_minutes']} 分",
        summary_text(snapshot["time_summary"]),
        f"秒级合计：主航线有效 {snapshot['actual_seconds']} 秒，总计 {snapshot['total_seconds']} 秒（分钟显示向下取整，零头未丢失）",
        f"主航线有效率：{round(snapshot['effective_ratio'] * 100)}%（有效时间总和 / 总计时间总和）",
        "统计包含已保存执行记录，提交仅表示收尾完成。",
        f"副航线实际分钟：{snapshot['actual_sub_minutes']} 分",
        f"英语 {snapshot['english_minutes']} 分，其中背单词 {snapshot['vocabulary_minutes']} 分（已包含在实际分钟中）",
        f"本周写复盘的天数：{snapshot['review_days']} 天",
        "",
    ]
    if deepseek_analysis:
        lines.extend(
            [
                "这是系统自动生成的一版周分析草稿，你可以参考也可以推翻：",
                json.dumps(deepseek_analysis, ensure_ascii=False, indent=2),
                "",
            ]
        )
    lines.append("下面是逐日记录：")
    for day in snapshot["days"]:
        review = day["review"]
        lines.extend(
            [
                f"- 日期：{day['date']}",
                f"  计划状态：{day['status_label']}",
                f"  主任务完成：{day['main_completed_count']} / {day['main_task_count']}",
                f"  主任务分钟：计划 {day['main_planned_minutes']} / 实际 {day['main_actual_minutes']}",
                f"  副航线实际：{day['sub_actual_minutes']} 分",
                f"  英语 {day['english_minutes']} 分，其中背单词 {day['vocabulary_minutes']} 分",
                f"  具体成果：{review.get('learning_outcome') or '未写'}",
                f"  情绪：{review['mood'] or '未写'}",
                f"  最卡点：{review['hardest_point'] or '未写'}",
                f"  有效方法：{review['effective_method'] or '未写'}",
                f"  小优化：{review['optimization_note'] or '未写'}",
                f"  推进感：{review['real_progress'] or '未写'}",
                f"  明天保持：{review['tomorrow_focus'] or '未写'}",
                f"  补充复盘：{review['reflection_text'] or '未写'}",
                "",
            ]
        )
    return "\n".join(lines)


def build_daily_gpt_prompt(
    connection,
    plan_date: str,
    export_template: str,
    *,
    daily: dict | None = None,
) -> str:
    daily_data = daily if daily is not None else serialize_daily_review(connection, plan_date)
    plan = connection.execute("SELECT id FROM plans WHERE plan_date=?", (plan_date,)).fetchone()
    tasks = []
    if plan:
        records = execution_records(connection, plan_date)
        raw_rows = connection.execute(
            "SELECT * FROM tasks WHERE plan_id=? ORDER BY position,id",
            (plan["id"],),
        ).fetchall()
        for row in compute_task_progress(raw_rows, records):
            tasks.append(
                {
                    "task_type": row["task_type"] or default_task_type_for(row["category"]),
                    "habit_status": row["habit_status"],
                    "title": row["title"],
                    "category": row["category"],
                    "estimated_minutes": row["estimated_minutes"],
                    "actual_minutes": row["actual_minutes"] or 0,
                    "completed": bool(row["completed"]),
                    "is_sub": bool(row["is_sub"]),
                    "sub_category": row["sub_category"] or "",
                }
            )

    lines = [
        export_template,
        "",
        f"日期：{plan_date}",
        f"计划状态：{daily_data['status_label']}",
        f"主任务完成：{daily_data['main_completed_count']} / {daily_data['main_task_count']}",
        f"主任务分钟：计划 {daily_data['main_planned_minutes']} / 实际 {daily_data['main_actual_minutes']}",
        summary_text(daily_data["time_summary"]),
        f"秒级合计：主航线有效 {daily_data['main_actual_seconds']} 秒，总计 {daily_data['main_total_seconds']} 秒（分钟显示向下取整，零头未丢失）",
        f"副航线实际：{daily_data['sub_actual_minutes']} 分",
        f"英语 {daily_data['english_minutes']} 分，其中背单词 {daily_data['vocabulary_minutes']} 分（已包含在实际分钟中）",
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

    review = daily_data["review"]
    lines.extend(
        [
            "",
            "今天的结构化复盘：",
            f"- 具体成果：{review.get('learning_outcome') or '未写'}",
            f"- 情绪：{review['mood'] or '未写'}",
            f"- 最卡点：{review['hardest_point'] or '未写'}",
            f"- 有效方法：{review['effective_method'] or '未写'}",
            f"- 小优化：{review['optimization_note'] or '未写'}",
            f"- 推进感：{review['real_progress'] or '未写'}",
            f"- 明天保持：{review['tomorrow_focus'] or '未写'}",
            f"- 补充复盘：{review['reflection_text'] or '未写'}",
        ]
    )
    return "\n".join(lines)


def snapshot_hash(snapshot: dict) -> tuple[str, str]:
    snapshot_json = json.dumps(snapshot, ensure_ascii=False, sort_keys=True)
    digest = hashlib.sha256(snapshot_json.encode("utf-8")).hexdigest()
    return snapshot_json, digest


def serialize_weekly_report_row(row) -> dict | None:
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


def get_weekly_report_row(connection, end_date: str) -> dict | None:
    row = connection.execute("SELECT * FROM weekly_reports WHERE end_date=?", (end_date,)).fetchone()
    return serialize_weekly_report_row(row)


def upsert_weekly_report(
    connection,
    snapshot: dict,
    snapshot_json: str,
    digest: str,
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
            digest,
            json.dumps(deepseek_analysis, ensure_ascii=False) if deepseek_analysis else None,
            chatgpt_prompt_text,
            final_report_text,
            ai_status,
            ai_error,
        ),
    )


def build_weekday_progress(snapshot: dict) -> dict:
    current_iso = today_iso()
    days = []
    saved_count = 0
    for index, day in enumerate(snapshot["days"]):
        has_content = bool(day["has_review"]) and day["date"] <= current_iso
        if has_content:
            saved_count += 1
        days.append(
            {
                "date": day["date"],
                "label": WEEKDAY_LABELS[index],
                "has_review": has_content,
                "is_future": day["date"] > current_iso,
                "is_clickable": day["date"] <= current_iso,
                "has_execution": bool(day["has_execution"]),
            }
        )
    return {
        "saved_count": saved_count,
        "total": 7,
        "progress_ratio": round(saved_count / 7, 3),
        "days": days,
    }


def read_weekly_report(connection, snapshot: dict, settings: dict) -> dict:
    existing = get_weekly_report_row(connection, snapshot["end_date"])
    analysis = existing["deepseek_analysis"] if existing else None
    prompt = resolve_prompt_content(
        settings,
        "chatgpt_export_prompts",
        "chatgpt_export_active_prompt_id",
        "chatgpt_export_system_default",
        CHATGPT_EXPORT_SYSTEM_PROMPT,
    )
    return {
        "start_date": snapshot["start_date"],
        "end_date": snapshot["end_date"],
        "snapshot": snapshot,
        "deepseek_analysis": analysis,
        "chatgpt_prompt_text": build_chatgpt_prompt(snapshot, analysis, prompt),
        "final_report_text": existing["final_report_text"] if existing else "",
        "ai_status": existing["ai_status"] if existing else "unavailable",
        "ai_error": existing["ai_error"] if existing else None,
        "updated_at": existing["updated_at"] if existing else None,
        "has_final_report": bool(existing and existing["has_final_report"]),
        "has_ai_draft": analysis is not None,
        "analysis_stale": bool(analysis and snapshot_hash(existing["snapshot"])[1] != snapshot_hash(snapshot)[1]),
    }


def list_weekly_reports(connection) -> list[dict]:
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


def build_review_navigation(connection, anchor_date: date) -> dict:
    start, end = week_bounds(anchor_date)
    start_iso, end_iso = str(start), str(end)
    plans = {
        row["plan_date"]: row["status"]
        for row in connection.execute(
            "SELECT plan_date,status FROM plans WHERE plan_date BETWEEN ? AND ?",
            (start_iso, end_iso),
        )
    }
    reviews = {
        row[0]
        for row in connection.execute(
            "SELECT review_date FROM reviews WHERE review_date BETWEEN ? AND ?",
            (start_iso, end_iso),
        )
    }
    recorded = {
        row[0]
        for row in connection.execute(
            """SELECT plan_date FROM task_execution_segments WHERE plan_date BETWEEN ? AND ?
               UNION SELECT p.plan_date FROM task_duration_records r JOIN tasks t ON t.id=r.task_id
               JOIN plans p ON p.id=t.plan_id WHERE p.plan_date BETWEEN ? AND ?
               UNION SELECT p.plan_date FROM tasks t JOIN plans p ON p.id=t.plan_id
               WHERE p.plan_date BETWEEN ? AND ?
                 AND (t.actual_minutes>0 OR t.legacy_actual_minutes>0 OR t.habit_status IS NOT NULL OR t.completed=1)""",
            (start_iso, end_iso, start_iso, end_iso, start_iso, end_iso),
        )
    }
    days = [
        {
            "date": str(start + timedelta(days=i)),
            "label": label,
            "has_review": str(start + timedelta(days=i)) in reviews,
            "has_execution": str(start + timedelta(days=i)) in recorded,
            "status": plans.get(str(start + timedelta(days=i))),
        }
        for i, label in enumerate(WEEKDAY_LABELS)
    ]
    return {"start_date": start_iso, "end_date": end_iso, "days": days, "weekday_progress": {"days": days}}


def resolve_return_today_url(connection, today: str | None = None) -> str:
    """只读判定『回到今天』跳转目标，供页面路由直接调用，避免路由层混入复杂多表 SQL。"""
    day = today or today_iso()
    plan = connection.execute("SELECT id, status FROM plans WHERE plan_date=?", (day,)).fetchone()
    segments = list_execution_segments(connection, day)
    running = any(segment["ended_at"] is None for segment in segments)
    recorded = bool(segments) or connection.execute(
        """SELECT 1 FROM vocabulary_daily_counts WHERE plan_date=?
           UNION ALL SELECT 1 FROM task_duration_records r JOIN tasks t ON t.id=r.task_id
               JOIN plans p ON p.id=t.plan_id WHERE p.plan_date=?
           UNION ALL SELECT 1 FROM tasks t JOIN plans p ON p.id=t.plan_id
               WHERE p.plan_date=? AND (t.actual_minutes>0 OR t.legacy_actual_minutes>0
                   OR t.habit_status IS NOT NULL OR t.completed=1)
           LIMIT 1""",
        (day, day, day),
    ).fetchone()
    if running:
        target = "/execute"
    elif recorded:
        target = "/review"
    elif plan and plan["status"] in ("approved", "submitted"):
        target = "/execute"
    else:
        target = "/"
    suffix = "&scope=daily" if target == "/review" else ""
    return f"{target}?date={day}{suffix}"
