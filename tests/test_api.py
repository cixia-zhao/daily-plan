import sqlite3
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
    assert len(pool) == len([t for t in first["tasks"] if not t["is_sub"]])
    assert not {item["title"] for item in first["tasks"] if not item["is_sub"]} & {item["title"] for item in second["tasks"] if item.get("source") == "carryover"}


def test_review_and_weekly_summary_persist(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    client.post("/api/daily-reviews", json={
        "date": today,
        "mood": "疲惫",
        "hardest_point": "等 AI 时想刷视频",
        "effective_method": "手机放进书包",
        "optimization_note": "晚饭后不要直接刷推荐流",
        "real_progress": "有一点推进",
        "tomorrow_focus": "学习块前写目标",
        "reflection_text": "今天勉强稳住了主线，但是起步还是太慢。",
    })
    summary = client.get("/api/weekly-review").json()
    assert summary["review_days"] == 1


def test_calendar_status_classifies_business_states(tmp_path):
    client = make_client(tmp_path)
    today = date.today()
    if today.day >= 10:
        project_start = date(today.year, today.month, 5)
    else:
        previous_month_end = date(today.year, today.month, 1) - timedelta(days=1)
        project_start = date(previous_month_end.year, previous_month_end.month, 5)
    empty_day = project_start
    planned_day = project_start + timedelta(days=1)
    submitted_day = project_start + timedelta(days=2)
    reviewed_day = project_start + timedelta(days=3)

    settings = client.get("/api/settings").json()
    settings["project_start_date"] = project_start.isoformat()
    saved_settings = client.put("/api/settings", json=settings)
    assert saved_settings.status_code == 200

    client.post("/api/daily-plans/draft", json={
        "date": empty_day.isoformat(), "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    })

    client.post("/api/daily-plans/draft", json={
        "date": planned_day.isoformat(), "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    })
    client.post(f"/api/daily-plans/{planned_day.isoformat()}/approve")

    client.post("/api/daily-plans/draft", json={
        "date": submitted_day.isoformat(), "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    })
    client.post(f"/api/daily-plans/{submitted_day.isoformat()}/approve")
    client.post(f"/api/daily-plans/{submitted_day.isoformat()}/submit")

    client.post("/api/daily-plans/draft", json={
        "date": reviewed_day.isoformat(), "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    })
    client.post(f"/api/daily-plans/{reviewed_day.isoformat()}/approve")
    client.post(f"/api/daily-plans/{reviewed_day.isoformat()}/submit")
    client.post("/api/daily-reviews", json={
        "date": reviewed_day.isoformat(),
        "mood": "平稳",
        "hardest_point": "卡住",
        "effective_method": "先写目标",
        "optimization_note": "早点开始",
        "real_progress": "明显推进",
        "tomorrow_focus": "继续保持",
        "reflection_text": "今天有推进。",
    })

    month = project_start.strftime("%Y-%m")
    response = client.get(f"/api/calendar-status?month={month}")
    assert response.status_code == 200
    body = response.json()
    status_map = {item["date"]: item for item in body["days"]}

    assert body["project_start_date"] == project_start.isoformat()
    assert status_map[(project_start - timedelta(days=1)).isoformat()]["visibility"] == "out_of_range"
    assert status_map[empty_day.isoformat()]["status"] == "empty"
    assert status_map[planned_day.isoformat()]["status"] == "planned"
    assert status_map[submitted_day.isoformat()]["status"] == "submitted"
    assert status_map[reviewed_day.isoformat()]["status"] == "reviewed"


def test_calendar_status_marks_future_dates_out_of_range(tmp_path):
    client = make_client(tmp_path)
    today = date.today()
    next_month = date(today.year + (1 if today.month == 12 else 0), 1 if today.month == 12 else today.month + 1, 1)
    response = client.get(f"/api/calendar-status?month={next_month.strftime('%Y-%m')}")
    assert response.status_code == 200
    body = response.json()
    assert all(item["visibility"] == "out_of_range" and item["status"] is None for item in body["days"])


def test_daily_review_returns_empty_review_fields_without_saved_review(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    })

    result = client.get(f"/api/daily-review/{today}")
    assert result.status_code == 200
    body = result.json()
    assert body["status"] == "draft"
    assert body["review"] == {
        "mood": "",
        "hardest_point": "",
        "effective_method": "",
        "optimization_note": "",
        "real_progress": "",
        "tomorrow_focus": "",
        "reflection_text": "",
    }


def test_daily_review_summarizes_plan_and_saved_review(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "normal", "available_minutes": 160, "day_type": "normal"
    }).json()
    client.post(f"/api/daily-plans/{today}/approve")

    main_task = next(t for t in draft["tasks"] if not t["is_sub"])
    sub_task = next(t for t in draft["tasks"] if t["is_sub"])
    client.patch(f"/api/tasks/{main_task['id']}", json={"completed": True})
    client.patch(f"/api/tasks/{sub_task['id']}", json={"actual_minutes": 30})
    client.post("/api/daily-reviews", json={
        "date": today,
        "mood": "平稳",
        "hardest_point": "等 AI 时想刷视频",
        "effective_method": "手机放进书包",
        "optimization_note": "今天最后一块开始太晚",
        "real_progress": "明显推进",
        "tomorrow_focus": "学习块前写目标",
        "reflection_text": "数学推进还不错，副航线没怎么展开。",
    })

    result = client.get(f"/api/daily-review/{today}")
    assert result.status_code == 200
    body = result.json()
    assert body["status"] == "approved"
    assert body["status_label"] == "已确认"
    assert body["main_task_count"] == len([task for task in draft["tasks"] if not task["is_sub"]])
    assert body["main_completed_count"] == 1
    assert body["main_planned_minutes"] == sum(task["estimated_minutes"] for task in draft["tasks"] if not task["is_sub"])
    assert body["main_actual_minutes"] == main_task["estimated_minutes"]
    assert body["sub_actual_minutes"] == 30
    assert body["review"]["mood"] == "平稳"
    assert body["review"]["hardest_point"] == "等 AI 时想刷视频"
    assert body["review"]["effective_method"] == "手机放进书包"
    assert body["review"]["tomorrow_focus"] == "学习块前写目标"
    assert today in body["gpt_prompt_text"]
    assert body["gpt_record"]["record_type"] == "daily"
    assert body["gpt_record"]["response_text"] == ""


def test_daily_gpt_record_can_be_saved_and_read_back(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    client.post("/api/daily-reviews", json={
        "date": today,
        "mood": "平稳",
        "hardest_point": "起步慢",
        "effective_method": "先写目标",
        "optimization_note": "晚饭后不要刷视频",
        "real_progress": "有一点推进",
        "tomorrow_focus": "先保住数学",
        "reflection_text": "今天主要问题是起步拖沓。",
    })

    saved = client.put(f"/api/daily-review/{today}/gpt-record", json={
        "response_text": "这是 ChatGPT 给我的单日复盘反馈",
        "adopted_text": "我决定明天先做 25 分钟启动块",
    })
    assert saved.status_code == 200
    assert saved.json()["record_type"] == "daily"
    assert saved.json()["response_text"] == "这是 ChatGPT 给我的单日复盘反馈"
    assert today in saved.json()["prompt_text"]

    fetched = client.get(f"/api/daily-review/{today}")
    assert fetched.status_code == 200
    assert fetched.json()["gpt_record"]["response_text"] == "这是 ChatGPT 给我的单日复盘反馈"
    assert fetched.json()["gpt_record"]["adopted_text"] == "我决定明天先做 25 分钟启动块"


def test_clear_daily_data_removes_plan_and_review(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    })
    client.post("/api/daily-reviews", json={
        "date": today,
        "mood": "烦躁",
        "hardest_point": "等 AI 时想刷视频",
        "effective_method": "手机放进书包",
        "optimization_note": "不要边等 AI 边刷视频",
        "real_progress": "基本没推进",
        "tomorrow_focus": "学习块前写目标",
        "reflection_text": "今天节奏不太对。",
    })

    cleared = client.delete(f"/api/daily-data/{today}")
    assert cleared.status_code == 200
    assert cleared.json()["deleted_plan"] is True
    assert cleared.json()["deleted_review"] is True

    daily = client.get(f"/api/daily-review/{today}").json()
    assert daily["status"] is None
    assert daily["main_task_count"] == 0
    assert daily["review"]["hardest_point"] == ""


def test_clear_daily_data_removes_day_from_weekly_review(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "normal", "available_minutes": 160, "day_type": "normal"
    }).json()
    client.post(f"/api/daily-plans/{today}/approve")
    main_task = next(t for t in draft["tasks"] if not t["is_sub"])
    client.patch(f"/api/tasks/{main_task['id']}", json={"completed": True})
    client.post(f"/api/daily-plans/{today}/submit")

    before = client.get("/api/weekly-review").json()
    assert before["task_count"] > 0

    cleared = client.delete(f"/api/daily-data/{today}")
    assert cleared.status_code == 200
    assert cleared.json()["deleted_plan"] is True

    after = client.get("/api/weekly-review").json()
    assert after["task_count"] == 0
    assert after["completed_count"] == 0


def test_clear_daily_data_succeeds_when_date_is_already_empty(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()

    cleared = client.delete(f"/api/daily-data/{today}")
    assert cleared.status_code == 200
    assert cleared.json()["deleted_plan"] is False
    assert cleared.json()["deleted_review"] is False


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


def test_submit_flow_and_sub_route_rules(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "normal", "available_minutes": 160, "day_type": "normal"
    }).json()

    client.post(f"/api/daily-plans/{today}/approve")

    main_task = next(t for t in draft["tasks"] if not t["is_sub"])
    sub_task = next(t for t in draft["tasks"] if t["is_sub"])

    res1 = client.patch(f"/api/tasks/{main_task['id']}", json={"completed": True})
    assert res1.json()["completed"] is True
    assert res1.json()["actual_minutes"] == main_task["estimated_minutes"]

    res2 = client.patch(f"/api/tasks/{sub_task['id']}", json={"actual_minutes": 29})
    assert res2.json()["completed"] is False

    res3 = client.patch(f"/api/tasks/{sub_task['id']}", json={"actual_minutes": 30})
    assert res3.json()["completed"] is True

    review = client.get("/api/weekly-review").json()
    assert review["task_count"] == 0
    assert review["completed_count"] == 0

    submitted = client.post(f"/api/daily-plans/{today}/submit")
    assert submitted.json()["status"] == "submitted"

    review = client.get("/api/weekly-review").json()
    assert review["task_count"] == len([t for t in draft["tasks"] if not t["is_sub"]])
    assert review["completed_count"] == 1
    assert review["completed_sub_count"] == 1

    res4 = client.patch(f"/api/tasks/{main_task['id']}", json={"completed": False})
    assert res4.json()["actual_minutes"] == 0
    plan = client.get(f"/api/daily-plans/{today}").json()
    assert plan["status"] == "approved"


def test_execution_segments_aggregate_into_daily_execution_and_review_board(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "normal", "available_minutes": 160, "day_type": "normal"
    }).json()
    client.post(f"/api/daily-plans/{today}/approve")
    main_task = next(t for t in draft["tasks"] if not t["is_sub"])

    for payload in [
        {
            "task_id": main_task["id"],
            "segment_kind": "effective",
            "started_at": f"{today}T09:35:00",
            "ended_at": f"{today}T10:35:00",
        },
        {
            "task_id": main_task["id"],
            "segment_kind": "counted_label",
            "label_id": "counted_toilet",
            "started_at": f"{today}T10:35:00",
            "ended_at": f"{today}T10:45:00",
        },
        {
            "task_id": main_task["id"],
            "segment_kind": "interrupt_label",
            "label_id": "interrupt_meal",
            "started_at": f"{today}T11:50:00",
            "ended_at": f"{today}T12:35:00",
        },
    ]:
        response = client.post(f"/api/daily-execution/{today}/segments", json=payload)
        assert response.status_code == 200

    execution = client.get(f"/api/daily-execution/{today}")
    assert execution.status_code == 200
    body = execution.json()
    assert body["labels"]
    assert body["active_segment"] is None
    assert len(body["segments"]) == 3
    board = body["task_execution_board"][0]
    assert board["task_id"] == main_task["id"]
    assert board["effective_minutes"] == 60
    assert board["total_minutes"] == 70
    assert board["interrupt_minutes"] == 45
    assert board["counted_labels"][0]["label_name"] == "上厕所"
    assert board["counted_labels"][0]["count"] == 1
    assert board["interrupt_labels"][0]["label_name"] == "吃饭"

    review = client.get(f"/api/daily-review/{today}")
    assert review.status_code == 200
    assert review.json()["task_execution_board"][0]["total_minutes"] == 70


def test_execution_active_segment_switch_and_submit_guard(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "normal", "available_minutes": 160, "day_type": "normal"
    }).json()
    client.post(f"/api/daily-plans/{today}/approve")
    main_task = next(t for t in draft["tasks"] if not t["is_sub"])

    started = client.post(f"/api/daily-execution/{today}/tasks/start", json={"task_id": main_task["id"]})
    assert started.status_code == 200
    assert started.json()["active_segment"]["segment_kind"] == "effective"

    blocked_submit = client.post(f"/api/daily-plans/{today}/submit")
    assert blocked_submit.status_code == 409

    switched = client.post(f"/api/daily-execution/{today}/labels/start", json={"task_id": main_task["id"], "label_id": "counted_game"})
    assert switched.status_code == 200
    assert switched.json()["active_segment"]["segment_kind"] == "counted_label"
    assert switched.json()["active_segment"]["label_name"] == "打游戏"
    assert len(switched.json()["segments"]) == 2
    assert switched.json()["segments"][0]["ended_at"] is not None

    stopped = client.post(f"/api/daily-execution/{today}/stop")
    assert stopped.status_code == 200
    assert stopped.json()["active_segment"] is None


def test_execution_open_effective_segment_never_reports_negative_minutes(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "normal", "available_minutes": 160, "day_type": "normal"
    }).json()
    client.post(f"/api/daily-plans/{today}/approve")
    main_task = next(t for t in draft["tasks"] if not t["is_sub"])
    future_start = f"{(date.today() + timedelta(days=1)).isoformat()}T09:00:00"

    with sqlite3.connect(tmp_path / "test.db") as connection:
      connection.execute(
          """INSERT INTO task_execution_segments(plan_date,task_id,segment_kind,started_at)
             VALUES(?,?,?,?)""",
          (today, main_task["id"], "effective", future_start),
      )
      connection.commit()

    execution = client.get(f"/api/daily-execution/{today}")
    assert execution.status_code == 200
    body = execution.json()
    active = body["active_segment"]
    assert active is not None
    assert active["minutes"] == 0
    synced_main = next(task for task in body["tasks"] if task["id"] == main_task["id"])
    assert synced_main["actual_minutes"] == 0


def test_execution_submit_syncs_effective_minutes_and_sub_completion(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "normal", "available_minutes": 160, "day_type": "normal"
    }).json()
    client.post(f"/api/daily-plans/{today}/approve")
    main_task = next(t for t in draft["tasks"] if not t["is_sub"])
    sub_task = next(t for t in draft["tasks"] if t["is_sub"])
    client.patch(f"/api/tasks/{main_task['id']}", json={"completed": True})

    client.post(f"/api/daily-execution/{today}/segments", json={
        "task_id": main_task["id"],
        "segment_kind": "effective",
        "started_at": f"{today}T09:00:00",
        "ended_at": f"{today}T10:10:00",
    })
    client.post(f"/api/daily-execution/{today}/segments", json={
        "task_id": sub_task["id"],
        "segment_kind": "effective",
        "started_at": f"{today}T10:20:00",
        "ended_at": f"{today}T10:50:00",
    })

    submitted = client.post(f"/api/daily-plans/{today}/submit")
    assert submitted.status_code == 200
    plan = submitted.json()
    synced_main = next(task for task in plan["tasks"] if task["id"] == main_task["id"])
    synced_sub = next(task for task in plan["tasks"] if task["id"] == sub_task["id"])
    assert synced_main["actual_minutes"] == 70
    assert synced_sub["actual_minutes"] == 30
    assert synced_sub["completed"] is True


def test_execution_segment_can_be_updated_deleted_and_cannot_overlap(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "normal", "available_minutes": 160, "day_type": "normal"
    }).json()
    client.post(f"/api/daily-plans/{today}/approve")
    main_task = next(t for t in draft["tasks"] if not t["is_sub"])

    created = client.post(f"/api/daily-execution/{today}/segments", json={
        "task_id": main_task["id"],
        "segment_kind": "effective",
        "started_at": f"{today}T09:00:00",
        "ended_at": f"{today}T09:30:00",
    })
    assert created.status_code == 200
    segment_id = created.json()["segments"][0]["id"]

    updated = client.put(f"/api/daily-execution/{today}/segments/{segment_id}", json={
        "task_id": main_task["id"],
        "segment_kind": "interrupt_label",
        "label_id": "interrupt_pause",
        "started_at": f"{today}T09:05:00",
        "ended_at": f"{today}T09:35:00",
    })
    assert updated.status_code == 200
    assert updated.json()["segments"][0]["label_name"] == "手动暂停"

    client.post(f"/api/daily-execution/{today}/segments", json={
        "task_id": main_task["id"],
        "segment_kind": "effective",
        "started_at": f"{today}T10:00:00",
        "ended_at": f"{today}T10:30:00",
    })
    overlapped = client.post(f"/api/daily-execution/{today}/segments", json={
        "task_id": main_task["id"],
        "segment_kind": "effective",
        "started_at": f"{today}T10:10:00",
        "ended_at": f"{today}T10:40:00",
    })
    assert overlapped.status_code == 409

    deleted = client.delete(f"/api/daily-execution/{today}/segments/{segment_id}")
    assert deleted.status_code == 200
    assert len(deleted.json()["segments"]) == 1


def test_saving_draft_keeps_original_available_time_capacity(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "normal", "available_minutes": 180, "day_type": "normal"
    }).json()
    editable_fields = {
        "id", "title", "category", "estimated_minutes", "priority",
        "completion_criteria", "reason", "source", "sub_category", "is_sub",
    }
    tasks = [{key: value for key, value in task.items() if key in editable_fields} for task in draft["tasks"]]
    first_main = next(task for task in tasks if not task["is_sub"])
    first_main["estimated_minutes"] -= 10

    saved = client.put(f"/api/daily-plans/{today}", json={"tasks": tasks})
    assert saved.status_code == 200
    assert saved.json()["available_minutes"] == 180

    first_main["estimated_minutes"] += 10
    restored = client.put(f"/api/daily-plans/{today}", json={"tasks": tasks})
    assert restored.status_code == 200
    assert restored.json()["available_minutes"] == 180


def test_saving_draft_rejects_main_route_minutes_over_available_time(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "normal", "available_minutes": 160, "day_type": "normal"
    }).json()
    editable_fields = {
        "id", "title", "category", "estimated_minutes", "priority",
        "completion_criteria", "reason", "source", "sub_category", "is_sub",
    }
    tasks = [{key: value for key, value in task.items() if key in editable_fields} for task in draft["tasks"]]
    main_tasks = [task for task in tasks if not task["is_sub"]]
    main_tasks[0]["estimated_minutes"] = 240
    main_tasks[1]["estimated_minutes"] = 0
    main_tasks[2]["estimated_minutes"] = 0

    saved = client.put(f"/api/daily-plans/{today}", json={"tasks": tasks})
    assert saved.status_code == 422
    assert saved.json()["detail"] == "单个主航线任务不能超过当天可用时间"


def test_saving_draft_allows_single_main_task_to_use_full_available_time(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "ample", "available_minutes": 300, "day_type": "normal"
    }).json()
    editable_fields = {
        "id", "title", "category", "estimated_minutes", "priority",
        "completion_criteria", "reason", "source", "sub_category", "is_sub",
    }
    tasks = [{key: value for key, value in task.items() if key in editable_fields} for task in draft["tasks"]]
    for task in tasks:
        if task["is_sub"]:
            continue
        task["estimated_minutes"] = 300 if task["category"] == "math" else 0

    saved = client.put(f"/api/daily-plans/{today}", json={"tasks": tasks})
    assert saved.status_code == 200
    approved = client.post(f"/api/daily-plans/{today}/approve")
    assert approved.status_code == 200
    planned_math = next(task for task in approved.json()["tasks"] if task["category"] == "math")
    assert planned_math["estimated_minutes"] == 300


def test_saving_draft_rejects_single_main_task_above_available_time(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "ample", "available_minutes": 300, "day_type": "normal"
    }).json()
    editable_fields = {
        "id", "title", "category", "estimated_minutes", "priority",
        "completion_criteria", "reason", "source", "sub_category", "is_sub",
    }
    tasks = [{key: value for key, value in task.items() if key in editable_fields} for task in draft["tasks"]]
    for task in tasks:
        if task["is_sub"]:
            continue
        task["estimated_minutes"] = 301 if task["category"] == "math" else 0

    saved = client.put(f"/api/daily-plans/{today}", json={"tasks": tasks})
    assert saved.status_code == 422
    assert saved.json()["detail"] == "单个主航线任务不能超过当天可用时间"


def test_zero_minute_main_tasks_are_excluded_from_daily_and_weekly_review_counts(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "normal", "available_minutes": 160, "day_type": "normal"
    }).json()
    editable_fields = {
        "id", "title", "category", "estimated_minutes", "priority",
        "completion_criteria", "reason", "source", "sub_category", "is_sub",
    }
    tasks = [{key: value for key, value in task.items() if key in editable_fields} for task in draft["tasks"]]
    main_tasks = [task for task in tasks if not task["is_sub"]]
    main_tasks[1]["estimated_minutes"] = 0
    main_tasks[2]["estimated_minutes"] = 0

    saved = client.put(f"/api/daily-plans/{today}", json={"tasks": tasks})
    assert saved.status_code == 200
    client.post(f"/api/daily-plans/{today}/approve")

    planned_main = next(task for task in saved.json()["tasks"] if not task["is_sub"] and task["estimated_minutes"] > 0)
    client.patch(f"/api/tasks/{planned_main['id']}", json={"completed": True})
    client.post(f"/api/daily-plans/{today}/submit")

    daily = client.get(f"/api/daily-review/{today}")
    assert daily.status_code == 200
    daily_body = daily.json()
    assert daily_body["main_task_count"] == 2
    assert daily_body["main_completed_count"] == 1
    assert daily_body["main_planned_minutes"] == 80

    weekly = client.get("/api/weekly-review")
    assert weekly.status_code == 200
    weekly_body = weekly.json()
    assert weekly_body["task_count"] == 2
    assert weekly_body["completed_count"] == 1
    assert weekly_body["completion_rate"] == 0.5
    assert weekly_body["planned_minutes"] == 80


def test_zero_minute_main_tasks_do_not_enter_carryover_pool(tmp_path):
    client = make_client(tmp_path)
    first_day = date.today()
    second_day = first_day + timedelta(days=1)
    draft = client.post("/api/daily-plans/draft", json={
        "date": first_day.isoformat(), "energy": "normal", "available_minutes": 160, "day_type": "normal"
    }).json()
    editable_fields = {
        "id", "title", "category", "estimated_minutes", "priority",
        "completion_criteria", "reason", "source", "sub_category", "is_sub",
    }
    tasks = [{key: value for key, value in task.items() if key in editable_fields} for task in draft["tasks"]]
    main_tasks = [task for task in tasks if not task["is_sub"]]
    main_tasks[1]["estimated_minutes"] = 0
    main_tasks[2]["estimated_minutes"] = 0

    saved = client.put(f"/api/daily-plans/{first_day.isoformat()}", json={"tasks": tasks})
    assert saved.status_code == 200
    client.post(f"/api/daily-plans/{first_day.isoformat()}/approve")
    client.post("/api/daily-plans/draft", json={
        "date": second_day.isoformat(), "energy": "normal", "available_minutes": 160, "day_type": "normal"
    })

    carryovers = client.get("/api/carryovers")
    assert carryovers.status_code == 200
    pool = carryovers.json()
    assert len(pool) == 2
    assert {item["estimated_minutes"] for item in pool} == {20, 60}


def test_weekly_review_returns_report_archive_and_prompt(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    draft = client.post("/api/daily-plans/draft", json={
        "date": today, "energy": "minimum", "available_minutes": 90, "day_type": "normal"
    }).json()
    client.post(f"/api/daily-plans/{today}/approve")
    main_task = next(t for t in draft["tasks"] if not t["is_sub"])
    client.patch(f"/api/tasks/{main_task['id']}", json={"completed": True})
    client.post(f"/api/daily-plans/{today}/submit")
    client.post("/api/daily-reviews", json={
        "date": today,
        "mood": "平稳",
        "hardest_point": "起步慢",
        "effective_method": "先写目标",
        "optimization_note": "晚上不要拖到太晚",
        "real_progress": "明显推进",
        "tomorrow_focus": "先保住数学",
        "reflection_text": "今天真正推进了一块数学。",
    })

    weekly = client.get("/api/weekly-review")
    assert weekly.status_code == 200
    body = weekly.json()
    assert "history" in body
    assert "gpt_prompt_text" in body
    assert "gpt_record" in body
    assert "weekday_progress" in body
    assert body["weekday_progress"]["saved_count"] == 1
    assert len(body["weekday_progress"]["days"]) == 7
    assert any(day["date"] == today and day["has_review"] is True and day["is_clickable"] is True for day in body["weekday_progress"]["days"])
    assert "prompt_settings" in body
    assert body["prompt_settings"]["weekly_analysis_active_prompt_id"] == "weekly_analysis_system_default"
    assert body["prompt_settings"]["chatgpt_export_active_prompt_id"] == "chatgpt_export_system_default"
    assert today in body["gpt_prompt_text"]
    assert body["gpt_record"]["record_type"] == "weekly"
    assert body["history"]


def test_weekly_review_anchor_date_switches_to_anchor_week(tmp_path):
    client = make_client(tmp_path)
    anchor = date.today() - timedelta(days=date.today().weekday())
    response = client.get(f"/api/weekly-review?anchor_date={anchor.isoformat()}")
    assert response.status_code == 200
    body = response.json()
    assert body["start_date"] == anchor.isoformat()
    assert body["end_date"] == (anchor + timedelta(days=6)).isoformat()
    assert body["anchor_date"] == anchor.isoformat()


def test_weekly_report_can_be_saved_and_read_back(tmp_path):
    client = make_client(tmp_path)
    end_day = date.today().isoformat()
    client.get("/api/weekly-review")

    saved = client.put(f"/api/weekly-reports/{end_day}", json={"final_report_text": "这是我最终确认的本周周报"})
    assert saved.status_code == 200
    assert saved.json()["final_report_text"] == "这是我最终确认的本周周报"

    fetched = client.get(f"/api/weekly-reports/{end_day}")
    assert fetched.status_code == 200
    assert fetched.json()["final_report_text"] == "这是我最终确认的本周周报"


def test_weekly_gpt_record_can_be_saved_and_read_back(tmp_path):
    client = make_client(tmp_path)
    end_day = (date.today() + timedelta(days=6 - date.today().weekday())).isoformat()
    weekly = client.get("/api/weekly-review")
    assert weekly.status_code == 200

    saved = client.put(f"/api/weekly-review/{end_day}/gpt-record", json={
        "response_text": "这是 ChatGPT 给我的本周反馈",
        "adopted_text": "下周先保住起步时间，再考虑加量",
    })
    assert saved.status_code == 200
    assert saved.json()["record_type"] == "weekly"
    assert end_day in saved.json()["anchor_key"]

    fetched = client.get("/api/weekly-review")
    assert fetched.status_code == 200
    assert fetched.json()["gpt_record"]["response_text"] == "这是 ChatGPT 给我的本周反馈"
    assert fetched.json()["gpt_record"]["adopted_text"] == "下周先保住起步时间，再考虑加量"


def test_settings_persist_weekly_prompt_templates(tmp_path):
    client = make_client(tmp_path)

    response = client.put("/api/settings", json={
        "current_stage": "恢复秩序期",
        "ai_project_weekly_frequency": 3,
        "rehab_enabled": True,
        "project_start_date": date.today().isoformat(),
        "budget_minimum": 90,
        "budget_normal": 150,
        "budget_ample": 210,
        "execution_labels": [
            {"id": "counted_toilet", "name": "上厕所", "bucket": "counted", "is_system": True},
            {"id": "custom_break", "name": "放空", "bucket": "interrupt", "is_system": False},
        ],
        "task_titles": {
            "math": "数学", "english": "英语", "computer": "408",
            "vibe_coding": "vibe coding", "algorithm": "算法",
            "reading": "阅读", "writing": "练字", "rehab": "运动",
        },
        "weekly_analysis_prompts": [
            {
                "id": "weekly_analysis_system_default",
                "name": "系统默认",
                "content": "系统分析提示词",
                "is_system": True,
            },
            {
                "id": "weekly_analysis_custom_1",
                "name": "更严格",
                "content": "请更严格地指出问题。",
                "is_system": False,
            },
        ],
        "weekly_analysis_active_prompt_id": "weekly_analysis_custom_1",
        "chatgpt_export_prompts": [
            {
                "id": "chatgpt_export_system_default",
                "name": "系统默认",
                "content": "系统导出模板",
                "is_system": True,
            },
            {
                "id": "chatgpt_export_custom_1",
                "name": "偏行动",
                "content": "请输出更偏行动建议的周报。",
                "is_system": False,
            },
        ],
        "chatgpt_export_active_prompt_id": "chatgpt_export_custom_1",
        "daily_gpt_prompts": [
            {
                "id": "daily_gpt_system_default",
                "name": "系统默认",
                "content": "单日 GPT 模板",
                "is_system": True,
            },
            {
                "id": "daily_gpt_custom_1",
                "name": "追问更强",
                "content": "请继续追问我今天卡住的根因。",
                "is_system": False,
            },
        ],
        "daily_gpt_active_prompt_id": "daily_gpt_custom_1",
        "weekly_gpt_prompts": [
            {
                "id": "weekly_gpt_system_default",
                "name": "系统默认",
                "content": "周 GPT 模板",
                "is_system": True,
            },
            {
                "id": "weekly_gpt_custom_1",
                "name": "偏行动",
                "content": "请更偏向下周执行建议。",
                "is_system": False,
            },
        ],
        "weekly_gpt_active_prompt_id": "weekly_gpt_custom_1",
    })
    assert response.status_code == 200

    saved = response.json()
    assert saved["weekly_analysis_active_prompt_id"] == "weekly_analysis_custom_1"
    assert saved["chatgpt_export_active_prompt_id"] == "chatgpt_export_custom_1"
    assert saved["daily_gpt_active_prompt_id"] == "daily_gpt_custom_1"
    assert saved["weekly_gpt_active_prompt_id"] == "weekly_gpt_custom_1"
    assert any(label["id"] == "custom_break" for label in saved["execution_labels"])
    assert any(prompt["id"] == "weekly_analysis_custom_1" for prompt in saved["weekly_analysis_prompts"])
    assert any(prompt["id"] == "chatgpt_export_custom_1" for prompt in saved["chatgpt_export_prompts"])
    assert any(prompt["id"] == "daily_gpt_custom_1" for prompt in saved["daily_gpt_prompts"])
    assert any(prompt["id"] == "weekly_gpt_custom_1" for prompt in saved["weekly_gpt_prompts"])

    weekly = client.get("/api/weekly-review")
    assert weekly.status_code == 200
    prompt_settings = weekly.json()["prompt_settings"]
    assert prompt_settings["weekly_analysis_active_prompt_id"] == "weekly_analysis_custom_1"
    assert prompt_settings["chatgpt_export_active_prompt_id"] == "chatgpt_export_custom_1"
    assert prompt_settings["weekly_gpt_active_prompt_id"] == "weekly_gpt_custom_1"

    daily = client.get(f"/api/daily-review/{date.today().isoformat()}")
    assert daily.status_code == 200
    assert daily.json()["prompt_settings"]["daily_gpt_active_prompt_id"] == "daily_gpt_custom_1"


def test_gpt_workbench_returns_daily_and_weekly_archives(tmp_path):
    client = make_client(tmp_path)
    today = date.today().isoformat()
    client.post("/api/daily-reviews", json={
        "date": today,
        "mood": "平稳",
        "hardest_point": "起步慢",
        "effective_method": "先写目标",
        "optimization_note": "晚饭后不要刷视频",
        "real_progress": "有一点推进",
        "tomorrow_focus": "先保住数学",
        "reflection_text": "今天主要问题是起步拖沓。",
    })
    client.put(f"/api/daily-review/{today}/gpt-record", json={
        "response_text": "单日回复",
        "adopted_text": "单日采用",
    })
    client.get("/api/weekly-review")
    client.put(f"/api/weekly-review/{today}/gpt-record", json={
        "response_text": "周回复",
        "adopted_text": "周采用",
    })

    workbench = client.get("/api/gpt-workbench")
    assert workbench.status_code == 200
    body = workbench.json()
    assert body["daily_records"]
    assert body["weekly_records"]
    assert body["daily_records"][0]["record_type"] == "daily"
    assert body["weekly_records"][0]["record_type"] == "weekly"


def test_settings_persist_project_start_date(tmp_path):
    client = make_client(tmp_path)
    target_date = (date.today() - timedelta(days=10)).isoformat()
    settings = client.get("/api/settings").json()
    settings["project_start_date"] = target_date

    response = client.put("/api/settings", json=settings)
    assert response.status_code == 200
    assert response.json()["project_start_date"] == target_date
