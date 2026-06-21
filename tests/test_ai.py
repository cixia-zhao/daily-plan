import json

import httpx

from app.schemas import MorningCheckIn
from app.services.ai_planner import AIPlanner
from app.services.task_rules import build_rule_plan


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
