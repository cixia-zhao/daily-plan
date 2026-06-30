import json
from pathlib import Path

import httpx

from app.schemas import MorningCheckIn
from app.services.ai_planner import AIPlanner
from app.services.task_rules import build_rule_plan
from app.services.weekly_review_analyzer import WeeklyReviewAnalyzer


def test_ai_payload_contains_only_abstract_state():
    captured = {}

    def handler(request: httpx.Request):
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"tasks": []}'}}]})

    planner = AIPlanner("https://example.test/v1", "secret", "deepseek", transport=httpx.MockTransport(handler))
    checkin = MorningCheckIn(energy="normal", available_minutes=120, day_type="normal")
    planner.generate(checkin, build_rule_plan(checkin).tasks)
    serialized = json.dumps(captured, ensure_ascii=False)
    assert "secret" not in serialized
    assert "NSFW" not in serialized
    assert "手淫" not in serialized


def test_ai_uses_prompt_loaded_from_text_file(tmp_path):
    prompt_path = tmp_path / "daily_planner_v1.txt"
    prompt_path.write_text("FILE BASED PROMPT", encoding="utf-8")
    captured = {}

    def handler(request: httpx.Request):
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"tasks": []}'}}]})

    planner = AIPlanner("https://example.test/v1", "secret", "deepseek", transport=httpx.MockTransport(handler), prompt_path=prompt_path)
    checkin = MorningCheckIn(energy="normal", available_minutes=120, day_type="normal")
    planner.generate(checkin, build_rule_plan(checkin).tasks)
    assert captured["messages"][0]["content"] == "FILE BASED PROMPT"


def test_ai_falls_back_to_builtin_prompt_when_text_file_missing():
    captured = {}

    def handler(request: httpx.Request):
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"tasks": []}'}}]})

    missing_path = Path("Z:/definitely-missing/daily_planner_v1.txt")
    planner = AIPlanner("https://example.test/v1", "secret", "deepseek", transport=httpx.MockTransport(handler), prompt_path=missing_path)
    checkin = MorningCheckIn(energy="normal", available_minutes=120, day_type="normal")
    planner.generate(checkin, build_rule_plan(checkin).tasks)
    assert captured["messages"][0]["content"] == planner.system_prompt
    assert "Return JSON only" in planner.system_prompt


def test_invalid_ai_response_falls_back_to_rules():
    def handler(_request: httpx.Request):
        return httpx.Response(200, json={"choices": [{"message": {"content": "not-json"}}]})

    planner = AIPlanner("https://example.test/v1", "secret", "deepseek", transport=httpx.MockTransport(handler))
    checkin = MorningCheckIn(energy="normal", available_minutes=120, day_type="normal")
    rule_plan = build_rule_plan(checkin)
    result = planner.generate(checkin, rule_plan.tasks)
    assert result.degraded is True
    assert [task.title for task in result.tasks] == [task.title for task in rule_plan.tasks]


def test_ai_retries_once_after_temporary_server_error():
    attempts = 0
    checkin = MorningCheckIn(energy="minimum", available_minutes=90, day_type="normal")
    rule_plan = build_rule_plan(checkin)

    def handler(_request: httpx.Request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(503)
        content = json.dumps({"tasks": [task.model_dump() for task in rule_plan.tasks]}, ensure_ascii=False)
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    planner = AIPlanner("https://example.test/v1", "secret", "deepseek", transport=httpx.MockTransport(handler))
    result = planner.generate(checkin, rule_plan.tasks)
    assert attempts == 2
    assert result.degraded is False


def test_weekly_review_analyzer_returns_structured_result():
    payload = {
        "summary_title": "这周先稳住节奏",
        "load_advice": "先持平，不要加量。",
        "drag_factors": "起步拖延和晚间分心。",
        "effective_patterns": "先写目标再开做更稳。",
        "real_progress_assessment": "数学主线有真实推进。",
        "next_week_focus": "先保住数学和英语不断线。",
    }

    captured = {}

    def handler(request: httpx.Request):
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]})

    analyzer = WeeklyReviewAnalyzer("https://example.test/v1", "secret", "deepseek", transport=httpx.MockTransport(handler))
    result, error = analyzer.analyze({"days": [], "task_count": 0}, custom_prompt="请特别关注拖延模式。")
    assert error is None
    assert result is not None
    assert result.summary_title == payload["summary_title"]
    assert captured["messages"][0]["content"] == "请特别关注拖延模式。"


def test_weekly_review_analyzer_gracefully_handles_invalid_json():
    def handler(_request: httpx.Request):
        return httpx.Response(200, json={"choices": [{"message": {"content": "not-json"}}]})

    analyzer = WeeklyReviewAnalyzer("https://example.test/v1", "secret", "deepseek", transport=httpx.MockTransport(handler))
    result, error = analyzer.analyze({"days": [], "task_count": 0})
    assert result is None
    assert error == "JSONDecodeError"
