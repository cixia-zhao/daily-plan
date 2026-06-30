from datetime import date
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app


def make_client(tmp_path):
    return TestClient(create_app(database_path=tmp_path / "ui.db", disable_ai=True))


def test_pages_are_available(tmp_path):
    client = make_client(tmp_path)
    for path, marker in [("/", "生成今天的草稿"), ("/execute", "执行台"), ("/review", "单日复盘"), ("/weekly", "七日复盘"), ("/gpt-workbench", "GPT 协作工作台"), ("/settings", "任务设置")]:
        response = client.get(path)
        assert response.status_code == 200
        assert marker in response.text


def test_settings_change_generated_task_title(tmp_path):
    client = make_client(tmp_path)
    saved = client.put("/api/settings", json={
        "current_stage": "期末恢复期",
        "ai_project_weekly_frequency": 2,
        "rehab_enabled": True,
        "project_start_date": date.today().isoformat(),
        "budget_minimum": 90,
        "budget_normal": 150,
        "budget_ample": 210,
        "task_titles": {
            "math": "高数今日任务", "english": "英语不断线", "computer": "C 与数据结构",
            "ai_project": "每日工具", "rehab": "身体重建", "sleep": "夜间收尾",
            "vibe_coding": "vibe coding", "algorithm": "算法", "reading": "阅读", "writing": "练字",
        }
    })
    assert saved.status_code == 200
    draft = client.post("/api/daily-plans/draft", json={
        "date": date.today().isoformat(), "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    }).json()
    assert any(task["title"] == "高数今日任务" for task in draft["tasks"])


def test_today_assets_use_five_slots_and_button_exchange():
    script = Path("app/static/app.js").read_text(encoding="utf-8")
    styles = Path("app/static/style.css").read_text(encoding="utf-8")
    base = Path("app/templates/base.html").read_text(encoding="utf-8")
    today = Path("app/templates/index.html").read_text(encoding="utf-8")

    assert "const ROUTE_SLOT_COUNT = 5" in script
    assert "route-placeholder" in script
    assert "route-swap-button" in script
    assert "updateTimeSummary" in script
    assert "resetDailyDataFor" in script
    assert "/api/daily-data/" in script
    assert "confirmAction" in script
    assert "window.confirm" not in script
    assert "toggleCarryoverPopover" in script
    assert "closeCarryoverPopover" in script
    assert "carryover-button" in script
    assert "carryover-dot" in script
    assert 'href="/execute"' in base
    assert 'href="/review"' in base
    assert "style.css?v={{ static_version('style.css') }}" in base
    assert "app.js?v={{ static_version('app.js') }}" in base
    assert 'id="confirm-modal"' in base
    assert 'id="time-summary"' in today
    assert 'id="reset-day"' in today
    assert 'id="carryover-button"' in today
    assert 'id="carryover-popover"' in today
    assert 'id="carryover-popover-list"' in today
    assert 'id="carryover-section"' not in today
    assert "setAttribute('draggable'" not in script
    assert "grid-template-rows: repeat(5, minmax(0, 1fr))" in styles
    assert ".confirm-dialog" in styles
    assert ".carryover-popover" in styles
    assert ".carryover-dot" in styles


def test_date_change_reloads_the_selected_plan():
    index_page = Path("app/templates/index.html").read_text(encoding="utf-8")
    script = Path("app/static/app.js").read_text(encoding="utf-8")

    assert "async function loadPlanForDate" in script
    assert "bindSharedCalendarTrigger(dateButton" in script
    assert 'id="plan-date-button"' in index_page
    assert 'type="date"' not in index_page


def test_review_page_assets_exist():
    script = Path("app/static/app.js").read_text(encoding="utf-8")
    review = Path("app/templates/review.html").read_text(encoding="utf-8")
    base = Path("app/templates/base.html").read_text(encoding="utf-8")

    assert "if (page === 'review')" in script
    assert "async function loadDailyReview" in script
    assert "copy-daily-gpt-prompt" in script
    assert "save-daily-gpt-record" in script
    assert 'id="daily-review-form"' in review
    assert 'id="copy-daily-gpt-prompt"' in review
    assert 'id="daily-gpt-response"' in review
    assert 'id="daily-gpt-adopted"' in review
    assert 'id="reset-day"' in review
    assert 'id="review-date-button"' in review
    assert 'id="daily-execution-board"' in review
    assert 'id="daily-execution-board-empty"' in review
    assert 'type="date"' not in review
    assert 'name="mood"' in review
    assert 'name="reflection_text"' in review
    assert 'id="calendar-modal"' in base
    assert 'id="calendar-grid"' in base
    assert 'href="/gpt-workbench"' in base


def test_execute_page_assets_exist():
    script = Path("app/static/app.js").read_text(encoding="utf-8")
    execute = Path("app/templates/execute.html").read_text(encoding="utf-8")
    styles = Path("app/static/style.css").read_text(encoding="utf-8")

    assert "if (page === 'execute')" in script
    assert "/api/daily-execution/" in script
    assert "Array.isArray(rawDetail)" in script
    assert 'id="execute-date-button"' in execute
    assert 'id="execute-task-list"' in execute
    assert 'id="execute-mobile-toolbar"' in execute
    assert 'id="mobile-counted-toggle"' in execute
    assert 'id="mobile-interrupt-toggle"' in execute
    assert 'id="mobile-return-effective"' in execute
    assert 'id="mobile-counted-label-list"' in execute
    assert 'id="mobile-interrupt-label-list"' in execute
    assert 'id="counted-label-list"' in execute
    assert 'id="interrupt-label-list"' in execute
    assert 'id="timeline-list"' in execute
    assert 'id="execute-submit"' in execute
    assert ".execute-layout" in styles
    assert ".execution-mobile-toolbar" in styles
    assert ".execution-task-section" in styles
    assert ".execution-section-toggle" in styles
    assert ".execution-board-card" in styles
    assert ".timeline-card" in styles


def test_zero_minute_main_tasks_hide_execution_controls_in_approved_view():
    script = Path("app/static/app.js").read_text(encoding="utf-8")

    assert "const zeroMinuteMain = approved && !isSub && Number(task.estimated_minutes) === 0;" in script
    assert "'<span class=\"task-index\" aria-hidden=\"true\">—</span>'" in script
    assert "'<span>计划 0 分钟</span><span class=\"execution-locked\">今天无需打勾或记录时间</span>'" in script


def test_weekly_page_supports_gpt_collaboration_and_history():
    script = Path("app/static/app.js").read_text(encoding="utf-8")
    weekly = Path("app/templates/weekly.html").read_text(encoding="utf-8")
    styles = Path("app/static/style.css").read_text(encoding="utf-8")

    assert "if (page === 'weekly')" in script
    assert "copy-chatgpt-prompt" in script
    assert "save-weekly-report" in script
    assert "save-weekly-gpt-record" in script
    assert "renderWeeklyProgress" in script
    assert "calendar-status?month=" in script
    assert "weekly-review?anchor_date=" in script
    assert "weekly_gpt_prompts" in script
    assert 'id="weekly-date-button"' in weekly
    assert 'id="weekly-title-text"' in weekly
    assert 'id="weekly-title-range"' in weekly
    assert 'id="weekly-progress-days"' in weekly
    assert 'id="weekly-inline-review-form"' in weekly
    assert 'id="weekly-gpt-response"' in weekly
    assert 'id="weekly-gpt-adopted"' in weekly
    assert 'id="save-weekly-gpt-record"' in weekly
    assert 'id="weekly-final-report"' in weekly
    assert 'id="weekly-history"' in weekly
    assert ".analysis-card" in styles
    assert ".weekly-title-range" in styles
    assert ".weekly-progress-track" in styles
    assert ".gpt-collab-panel" in styles
    assert ".calendar-day" in styles
    assert ".calendar-legend" in styles


def test_gpt_workbench_assets_exist():
    script = Path("app/static/app.js").read_text(encoding="utf-8")
    template = Path("app/templates/gpt_workbench.html").read_text(encoding="utf-8")
    styles = Path("app/static/style.css").read_text(encoding="utf-8")

    assert "if (page === 'gpt-workbench')" in script
    assert "/api/gpt-workbench" in script
    assert "daily-template-tab" in template
    assert "weekly-template-tab" in template
    assert 'id="gpt-record-list"' in template
    assert 'id="prompt-content-input"' in template
    assert ".workbench-grid" in styles
    assert ".archive-card" in styles


def test_settings_budget_inputs_use_fifteen_minute_steps():
    settings_page = Path("app/templates/settings.html").read_text(encoding="utf-8")
    script = Path("app/static/app.js").read_text(encoding="utf-8")

    assert 'name="budget_minimum" type="number" min="30" max="720" step="15"' in settings_page
    assert 'name="budget_normal" type="number" min="30" max="720" step="15"' in settings_page
    assert 'name="budget_ample" type="number" min="30" max="720" step="15"' in settings_page
    assert 'name="project_start_date" type="date" required' in settings_page
    assert 'id="execution-label-fields"' in settings_page
    assert 'id="add-counted-label"' in settings_page
    assert 'id="add-interrupt-label"' in settings_page
    assert "{minimum:90, normal:150, ample:210}" in script


def test_settings_and_copy_text_deemphasize_deepseek():
    settings_page = Path("app/templates/settings.html").read_text(encoding="utf-8")
    weekly_page = Path("app/templates/weekly.html").read_text(encoding="utf-8")

    assert "GPT 协作偏好" in settings_page
    assert "DeepSeek 连接" not in settings_page
    assert "复制给 ChatGPT" in weekly_page
    assert "DeepSeek" not in weekly_page
