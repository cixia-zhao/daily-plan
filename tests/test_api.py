from datetime import date, timedelta

from fastapi.testclient import TestClient

from app.main import create_app


def make_client(tmp_path):
    app = create_app(database_path=tmp_path / "test.db", disable_ai=True)
    return TestClient(app)


def test_draft_must_be_approved_before_tasks_can_be_checked(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    response = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    })
    assert response.status_code == 201
    draft = response.json()
    task_id = draft["tasks"][0]["id"]

    blocked = client.patch(f"/api/tasks/{task_id}", json={"completed": True})
    assert blocked.status_code == 409

    approved = client.post(f"/api/daily-plans/{today}/approve")
    assert approved.status_code == 200
    checked = client.patch(f"/api/tasks/{task_id}", json={"completed": True, "actual_minutes": 25})
    assert checked.status_code == 200
    assert checked.json()["completed"] is True


def test_unfinished_tasks_enter_review_pool_without_automatic_rollover(tmp_path):
    client = make_client(tmp_path)
    first_day = date.today()
    second_day = first_day + timedelta(days=1)
    first = client.post("/api/daily-plans/draft", json={
        "date": first_day.isoformat(), "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    }).json()
    client.post(f"/api/daily-plans/{first_day.isoformat()}/approve")

    second = client.post("/api/daily-plans/draft", json={
        "date": second_day.isoformat(), "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    }).json()
    pool = client.get("/api/carryovers").json()
    assert len(pool) == len(first["tasks"])
    assert not {item["title"] for item in first["tasks"]} & {item["title"] for item in second["tasks"] if item.get("source") == "carryover"}


def test_review_and_weekly_summary_persist(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    client.post("/api/daily-reviews", json={
        "date": today,
        "distraction": "等 AI 时想刷视频",
        "effective_method": "手机放进书包",
        "tomorrow_focus": "学习块前写目标"
    })
    summary = client.get("/api/weekly-review").json()
    assert summary["review_days"] == 1


def test_health_report_blocks_rehab_generation(tmp_path):
    client = make_client(tmp_path)
    response = client.post("/api/daily-plans/draft", json={
        "date": date.today().isoformat(), "energy": "normal", "available_minutes": 180,
        "day_type": "normal", "knee_alert": True
    })
    assert response.status_code == 201
    body = response.json()
    assert not any(task["category"] == "rehab" for task in body["tasks"])
    assert body["safety_notice"]


def test_explicitly_rescheduled_task_is_added_on_target_day(tmp_path):
    client = make_client(tmp_path)
    day1 = date.today()
    day2 = day1 + timedelta(days=1)
    day3 = day1 + timedelta(days=2)
    first = client.post("/api/daily-plans/draft", json={
        "date": day1.isoformat(), "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    }).json()
    client.post(f"/api/daily-plans/{day1.isoformat()}/approve")
    client.post("/api/daily-plans/draft", json={
        "date": day2.isoformat(), "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    })
    carryover = client.get("/api/carryovers").json()[0]
    client.post(f"/api/carryovers/{carryover['id']}/resolve", json={
        "action": "reschedule", "target_date": day3.isoformat()
    })
    third = client.post("/api/daily-plans/draft", json={
        "date": day3.isoformat(), "energy": "normal", "available_minutes": 240, "day_type": "normal"
    }).json()
    assert any(task["source"] == "carryover" and task["title"] == first["tasks"][0]["title"] for task in third["tasks"])
