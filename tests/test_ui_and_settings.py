import re
import sqlite3
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.clock import now_local, today_iso


def make_client(tmp_path):
    return TestClient(create_app(database_path=tmp_path / "ui.db", disable_ai=True))


def test_pages_are_available_and_load_modular_scripts(tmp_path):
    client = make_client(tmp_path)
    expectations = [
        ("/", "生成今天的草稿", "/static/today.js", ["/static/settings.js", "/static/workbench.js"]),
        ("/execute", "完成与复盘", "/static/execution.js", ["/static/today.js", "/static/settings.js", "/static/workbench.js"]),
        ("/review", "本周复盘导航", "/static/review.js", ["/static/today.js", "/static/settings.js", "/static/workbench.js"]),
        ("/weekly", "本周复盘导航", "/static/review.js", ["/static/today.js", "/static/settings.js"]),
        ("/gpt-workbench", "GPT 协作工作台", "/static/workbench.js", ["/static/today.js", "/static/execution.js", "/static/settings.js"]),
        ("/settings", "任务设置", "/static/settings.js", ["/static/today.js", "/static/execution.js", "/static/workbench.js"]),
    ]
    for path, marker, expected_script, excluded_scripts in expectations:
        response = client.get(path)
        assert response.status_code == 200
        assert marker in response.text
        assert "/static/app.js" in response.text
        assert expected_script in response.text
        for excluded in excluded_scripts:
            assert excluded not in response.text


def test_settings_change_generated_task_title(tmp_path):
    client = make_client(tmp_path)
    today = today_iso()
    saved = client.put("/api/settings", json={
        "current_stage": "期末恢复期",
        "ai_project_weekly_frequency": 2,
        "rehab_enabled": True,
        "project_start_date": today,
        "task_titles": {
            "math": "高数今日任务", "english": "英语不断线", "computer": "C 与数据结构",
            "ai_project": "每日工具", "rehab": "身体重建", "sleep": "夜间收尾",
            "vibe_coding": "vibe coding", "algorithm": "算法", "reading": "阅读", "writing": "练字",
        },
    })
    assert saved.status_code == 200
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "minimum", "day_type": "normal",
    }).json()
    assert any(task["title"] == "高数今日任务" for task in draft["tasks"])


def test_settings_expose_unified_category_catalog(tmp_path):
    client = make_client(tmp_path)
    initial = client.get("/api/settings").json()
    catalog = initial["category_catalog"]
    for key in ("math", "english", "computer", "rehab", "ai_project", "sleep", "vibe_coding", "algorithm", "reading", "writing"):
        assert key in catalog
    assert catalog["english"]["supports_word_count"] is True
    assert catalog["english"]["word_label_id"] == "effective_english_words"
    assert catalog["computer"]["sub_categories"] == ["数据结构", "计算机网络", "操作系统", "计算机组成原理"]
    assert catalog["rehab"]["default_task_type"] == "habit"

    saved = client.put("/api/settings", json={
        "current_stage": initial["current_stage"],
        "ai_project_weekly_frequency": initial["ai_project_weekly_frequency"],
        "rehab_enabled": True,
        "project_start_date": initial["project_start_date"],
        "main_project_categories": ["custom_guitar", "math"],
        "task_titles": {**initial["task_titles"], "custom_guitar": "古典吉他"},
        "draft_main_minutes_by_category": {"custom_guitar": 45, "math": 90},
    })
    assert saved.status_code == 200
    updated_catalog = saved.json()["category_catalog"]
    assert updated_catalog["custom_guitar"]["title"] == "古典吉他"
    assert updated_catalog["custom_guitar"]["common_minutes"] == [30, 60, 90, 120]
    assert updated_catalog["custom_guitar"]["default_task_type"] == "daily_goal"


def test_today_and_carryover_assets_use_inline_dialogs_without_browser_prompts():
    shared_js = Path("app/static/app.js").read_text(encoding="utf-8")
    today_js = Path("app/static/today.js").read_text(encoding="utf-8")
    styles = Path("app/static/style.css").read_text(encoding="utf-8")
    base = Path("app/templates/base.html").read_text(encoding="utf-8")
    today = Path("app/templates/index.html").read_text(encoding="utf-8")

    assert "const ROUTE_SLOT_COUNT = 5" in today_js
    assert "route-placeholder" in today_js
    assert "route-swap-button" in today_js
    assert "updateTimeSummary" in today_js
    assert "resetDailyDataFor" in shared_js
    assert "confirmAction" in shared_js
    assert "window.confirm" not in shared_js and "window.confirm" not in today_js
    assert "prompt(" not in today_js
    assert "carryover-inline-editor" in today_js
    assert "async function loadPlanForDate" in today_js
    assert "bindSharedCalendarTrigger(dateButton" in today_js
    assert "error.status !== 404" in today_js
    assert "const zeroMinuteMain = approved && !isSub && Number(task.estimated_minutes) === 0;" in today_js
    assert "可在执行台开始" in today_js
    assert 'id="open-execution-desk"' in today
    assert 'id="plan-date-button"' in today
    assert 'type="date"' not in today
    assert 'id="carryover-button"' in today
    assert 'id="carryover-popover"' in today
    assert 'id="carryover-close"' in today
    assert 'id="confirm-modal"' in base
    assert 'id="calendar-modal"' in base
    assert ".confirm-dialog" in styles
    assert ".carryover-popover" in styles
    assert ".carryover-inline-editor" in styles


def test_execute_and_review_templates_eliminate_hidden_duplicate_workspaces(tmp_path):
    client = make_client(tmp_path)
    exec_js = Path("app/static/execution.js").read_text(encoding="utf-8")
    review_html = client.get("/review").text
    history_html = client.get("/execute?date=2026-10-12").text
    execute_html = client.get("/execute").text

    assert 'id="review-records-workspace"' not in review_html
    assert 'id="history-records-workspace"' not in history_html
    assert 'id="execute-task-list"' not in review_html
    assert 'id="execute-task-list"' not in history_html
    assert 'id="execute-task-list"' in execute_html
    assert 'id="execution-controls"' in execute_html
    assert 'id="execution-controls"' in review_html
    assert 'id="execution-controls"' in history_html
    assert "window.DailyPlanRecords" in exec_js
    assert "今日未安排（随时可以开始）" in exec_js
    assert "collapsedZeroMinuteSubmit" in exec_js


def test_weekly_links_keep_dates_and_share_the_review_workspace(tmp_path):
    client = make_client(tmp_path)
    redirected = client.get("/weekly?date=2026-10-13", follow_redirects=False)
    assert redirected.status_code == 303
    assert redirected.headers["location"] == "/review?scope=weekly&date=2026-10-13"
    page = client.get(redirected.headers["location"]).text
    for marker in [
        "review-week-steps", "weekly-total-time", "weekly-effective-ratio",
        "weekly-final-report", "weekly-history", "weekly-gpt-response",
        "weekly-gpt-adopted", "save-weekly-gpt-record", "daily-review-form",
    ]:
        assert f'id="{marker}"' in page
    assert "周报" not in page


def test_settings_and_workbench_clean_ux_contracts():
    settings_page = Path("app/templates/settings.html").read_text(encoding="utf-8")
    settings_js = Path("app/static/settings.js").read_text(encoding="utf-8")
    workbench_page = Path("app/templates/gpt_workbench.html").read_text(encoding="utf-8")
    workbench_js = Path("app/static/workbench.js").read_text(encoding="utf-8")
    weekly_page = Path("app/templates/weekly_reflection.html").read_text(encoding="utf-8")

    # 移除废弃的精力预算框与底部教程卡片
    assert 'name="budget_minimum"' not in settings_page
    assert 'name="budget_normal"' not in settings_page
    assert 'name="budget_ample"' not in settings_page
    assert "DeepSeek" not in settings_page
    assert "DeepSeek" not in weekly_page
    assert "复制给 ChatGPT" in weekly_page
    assert 'id="main-project-fields"' in settings_page
    assert 'id="execution-label-fields"' in settings_page
    assert 'id="effective-label-category-fields"' in settings_page
    assert 'id="export-backup"' in settings_page
    assert 'id="settings-dirty-hint"' in settings_page
    assert "effective-label-category-card" in settings_js
    assert "downloadBackupFile" in settings_js

    # 工作台具备中文输入法保护与防抖状态栏
    assert 'id="prompt-save-status"' in workbench_page
    assert "compositionstart" in workbench_js
    assert "compositionend" in workbench_js
    assert "confirmAction" in workbench_js


@pytest.mark.parametrize("timer_state", ["closed", "running", "overdue"])
def test_readonly_get_endpoints_never_mutate_sqlite(tmp_path, timer_state):
    db_path = tmp_path / "ui.db"
    client = TestClient(create_app(database_path=db_path, disable_ai=True))
    day = today_iso()
    plan = client.post("/api/daily-plans/draft", json={
        "date": day, "energy": "normal", "day_type": "normal", "target_minutes": {"math": 60},
    }).json()
    client.post(f"/api/daily-plans/{day}/approve")
    math_id = next(t["id"] for t in plan["tasks"] if t["category"] == "math")
    client.post(f"/api/daily-execution/{day}/segments", json={
        "task_id": math_id,
        "segment_kind": "effective",
        "started_at": f"{day}T09:00:00",
        "ended_at": f"{day}T09:30:00",
    })
    if timer_state != "closed":
        now = now_local().replace(tzinfo=None, microsecond=0)
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "UPDATE task_execution_segments SET started_at=?,ended_at=NULL,auto_stop_at=?",
                (
                    (now - timedelta(minutes=20)).isoformat(),
                    (now - timedelta(minutes=10)).isoformat() if timer_state == "overdue" else None,
                ),
            )

    def dump_db():
        with sqlite3.connect(db_path) as conn:
            return list(conn.iterdump())

    before = dump_db()
    for url in (
        "/api/settings",
        "/api/system/health",
        "/api/gpt-workbench",
        f"/api/daily-plans/{day}",
        f"/api/daily-execution/{day}",
        f"/api/daily-review/{day}",
        f"/api/review-navigation?anchor_date={day}",
        f"/api/weekly-review?anchor_date={day}",
        f"/api/calendar-status?month={day[:7]}",
        "/return-today",
    ):
        resp = client.get(url, follow_redirects=False)
        assert resp.status_code in (200, 303), url
        assert dump_db() == before, url
        if url == "/return-today":
            expected = f"/execute?date={day}" if timer_state == "running" else f"/review?date={day}&scope=daily"
            assert resp.headers["location"] == expected
    if timer_state == "overdue":
        execution = client.get(f"/api/daily-execution/{day}").json()
        assert execution["active_segment"] is None
        assert execution["segments"][0]["stopped_automatically"] is True
        assert execution["segments"][0]["seconds"] == 600


def test_segment_overlap_window_catches_neighbor_days_and_allows_clean_slots(tmp_path):
    client = make_client(tmp_path)
    d1, d2 = "2026-10-12", "2026-10-13"
    for d in (d1, d2):
        client.post("/api/daily-plans/draft", json={"date": d, "energy": "normal", "day_type": "normal", "target_minutes": {"math": 60}})
        client.post(f"/api/daily-plans/{d}/approve")
    t1 = client.get(f"/api/daily-plans/{d1}").json()["tasks"][0]["id"]
    t2 = client.get(f"/api/daily-plans/{d2}").json()["tasks"][0]["id"]

    # 跨午夜时间段（10-12 23:30 -> 10-13 00:30）
    r1 = client.post(f"/api/daily-execution/{d1}/segments", json={
        "task_id": t1, "segment_kind": "effective",
        "started_at": f"{d1}T23:30:00", "ended_at": f"{d2}T00:30:00",
    })
    assert r1.status_code == 200

    # 10-13 00:15 -> 00:45 与跨夜段重叠，必须被 ±2 天窗口拦截
    conflict = client.post(f"/api/daily-execution/{d2}/segments", json={
        "task_id": t2, "segment_kind": "effective",
        "started_at": f"{d2}T00:15:00", "ended_at": f"{d2}T00:45:00",
    })
    assert conflict.status_code == 409

    # 10-13 00:30 -> 01:00 紧邻不重叠，正常通过
    clean = client.post(f"/api/daily-execution/{d2}/segments", json={
        "task_id": t2, "segment_kind": "effective",
        "started_at": f"{d2}T00:30:00", "ended_at": f"{d2}T01:00:00",
    })
    assert clean.status_code == 200


def test_stylesheets_contain_no_legacy_green_tokens():
    legacy_greens = {"#2f5d50", "#dfe9e3", "#c7d3c9", "#2d6a4f", "#e3e9e2", "#cfe3da"}
    for css_path in Path("app/static").rglob("*.css"):
        text = css_path.read_text(encoding="utf-8").lower()
        found = {hex_code for hex_code in legacy_greens if hex_code in text}
        assert not found, f"{css_path} 仍残留旧绿色色值: {found}"
        assert not re.search(r"backdrop-filter\s*:\s*(?!none)", text), f"{css_path} 不应包含毛玻璃特效"
