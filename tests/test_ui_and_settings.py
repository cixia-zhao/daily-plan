from datetime import date

from fastapi.testclient import TestClient

from app.main import create_app


def make_client(tmp_path):
    return TestClient(create_app(database_path=tmp_path / "ui.db", disable_ai=True))


def test_pages_are_available(tmp_path):
    client = make_client(tmp_path)
    for path, marker in [("/", "生成今天的草稿"), ("/weekly", "七日复盘"), ("/settings", "任务设置")]:
        response = client.get(path)
        assert response.status_code == 200
        assert marker in response.text


def test_settings_change_generated_task_title(tmp_path):
    client = make_client(tmp_path)
    saved = client.put("/api/settings", json={
        "current_stage": "期末恢复期",
        "ai_project_weekly_frequency": 2,
        "rehab_enabled": True,
        "task_titles": {
            "math": "高数今日任务", "english": "英语不断线", "computer": "C 与数据结构",
            "ai_project": "每日工具", "rehab": "身体重建", "sleep": "夜间收尾"
        }
    })
    assert saved.status_code == 200
    draft = client.post("/api/daily-plans/draft", json={
        "date": date.today().isoformat(), "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    }).json()
    assert any(task["title"] == "高数今日任务" for task in draft["tasks"])
