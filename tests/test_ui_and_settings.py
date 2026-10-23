from datetime import date
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app


def make_client(tmp_path):
    return TestClient(create_app(database_path=tmp_path / "ui.db", disable_ai=True))


def test_pages_are_available(tmp_path):
    client = make_client(tmp_path)
    for path, marker in [("/", "生成今天的草稿"), ("/execute", "完成与复盘"), ("/review", "本周复盘导航"), ("/weekly", "本周复盘导航"), ("/gpt-workbench", "GPT 协作工作台"), ("/settings", "任务设置")]:
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
    script = Path("app/static/review.js").read_text(encoding="utf-8")
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
    execute = "\n".join(Path(path).read_text(encoding="utf-8") for path in ["app/templates/execute.html", "app/templates/execution_tasks.html", "app/templates/execution_overlay.html"])
    styles = Path("app/static/style.css").read_text(encoding="utf-8")

    assert "if (page === 'execute' || $('#review-records-workspace'))" in script
    assert "/api/daily-execution/" in script
    assert "Array.isArray(rawDetail)" in script
    assert 'id="execute-date-button"' not in execute
    assert 'id="execute-task-list"' in execute
    assert 'id="execute-mobile-toolbar"' in execute
    assert 'id="mobile-counted-toggle"' in execute
    assert 'id="mobile-interrupt-toggle"' in execute
    assert 'id="mobile-return-effective"' in execute
    assert 'id="mobile-counted-label-list"' in execute
    assert 'id="mobile-interrupt-label-list"' in execute
    assert 'id="timeline-list"' not in execute
    assert 'id="timeline-toggle"' not in execute
    assert 'id="timeline-content"' not in execute
    assert 'id="execute-submit-zero-toggle"' in execute
    assert 'id="enter-review"' in execute
    assert 'id="execute-submit"' not in execute
    assert "effectiveLabelSelections" in script
    assert "latestEffectiveLabelIdForTask" in script
    assert "effective_labels_by_category" in script
    assert "effective-label-button" in script
    assert "有效细分" in script
    assert "window.DailyPlanRecords" in script
    assert "collapsedZeroMinuteSubmit" in script
    assert "今日原计划为 0 分的项目" in script
    assert ".execute-layout" in styles
    assert ".execution-mobile-toolbar" in styles
    assert ".execution-task-section" in styles
    assert ".execution-section-toggle" in styles
    assert ".execution-board-card" in styles
    assert ".timeline-card" in styles
    assert ".section-toggle-button" in styles
    assert ".submit-zero-group" in styles


def test_zero_minute_main_tasks_invite_execution_in_approved_view():
    script = Path("app/static/app.js").read_text(encoding="utf-8")

    assert "const zeroMinuteMain = approved && !isSub && Number(task.estimated_minutes) === 0;" in script
    assert "'<span class=\"task-index\" aria-hidden=\"true\">—</span>'" in script
    assert "可在执行台开始" in script
    assert "今日未安排（随时可以开始）" in script
    assert "const disabled = Number(task.estimated_minutes) === 0" not in script


def test_weekly_links_keep_dates_and_share_the_review_workspace(tmp_path):
    client = make_client(tmp_path)
    redirected = client.get('/weekly?date=2026-10-13', follow_redirects=False)
    assert redirected.status_code == 303
    assert redirected.headers['location'] == '/review?scope=weekly&date=2026-10-13'
    page = client.get(redirected.headers['location']).text
    for marker in ['review-week-steps', 'weekly-total-time', 'weekly-effective-ratio',
                   'weekly-final-report', 'weekly-history', 'weekly-gpt-response',
                   'weekly-gpt-adopted', 'save-weekly-gpt-record', 'daily-review-form']:
        assert f'id="{marker}"' in page
    assert 'id="daily-status"' not in page
    assert 'id="metric-days"' not in page
    assert '周报' not in page


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
    assert 'id="main-project-fields"' in settings_page
    assert 'id="execution-label-fields"' in settings_page
    assert 'id="add-execution-label"' in settings_page
    assert 'id="effective-label-category-fields"' in settings_page
    assert 'id="export-backup"' in settings_page
    assert "draft_main_minutes_by_category" in script
    assert "data-draft-main-category" in script
    assert "renderEffectiveLabelFields" in script
    assert "effective_labels_by_category" in script
    assert "downloadBackupFile" in script
    assert "available-minutes" not in script


def test_today_page_has_execution_entry_after_confirmation():
    today = Path("app/templates/index.html").read_text(encoding="utf-8")
    script = Path("app/static/app.js").read_text(encoding="utf-8")

    assert 'id="open-execution-desk"' in today
    assert "const button = $('#open-execution-desk');" in script
    assert "$('#open-execution-desk').onclick = openExecutionDesk;" in script
    assert "$('#draft-actions').classList.remove('hidden');" in script
    assert "$('#save-draft').classList.toggle('hidden', plan.status !== 'draft');" in script
    assert "$('#approve-plan').classList.toggle('hidden', plan.status !== 'draft');" in script


def test_settings_and_copy_text_deemphasize_deepseek():
    settings_page = Path("app/templates/settings.html").read_text(encoding="utf-8")
    weekly_page = Path("app/templates/weekly_reflection.html").read_text(encoding="utf-8")
    styles = Path("app/static/style.css").read_text(encoding="utf-8")

    assert "GPT 协作偏好" in settings_page
    assert "主航线包含运动" in settings_page
    assert "DeepSeek 连接" not in settings_page
    assert "复制给 ChatGPT" in weekly_page
    assert "DeepSeek" not in weekly_page
    assert "body[data-page=settings]" in styles
    assert "overflow-x: clip" in styles
    assert ".execution-label-row" in styles
