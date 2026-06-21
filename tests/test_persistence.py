from datetime import date

from fastapi.testclient import TestClient

from app.main import create_app


def test_confirmed_plan_survives_application_restart(tmp_path):
    database = tmp_path / "persistent.db"
    day = date.today().isoformat()
    with TestClient(create_app(database_path=database, disable_ai=True)) as client:
        client.post("/api/daily-plans/draft", json={
            "date": day, "energy": "minimum", "available_minutes": 90, "day_type": "normal"
        })
        client.post(f"/api/daily-plans/{day}/approve")

    with TestClient(create_app(database_path=database, disable_ai=True)) as restarted:
        plan = restarted.get(f"/api/daily-plans/{day}").json()
        assert plan["status"] == "approved"
        assert len(plan["tasks"]) >= 3
