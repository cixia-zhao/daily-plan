from __future__ import annotations

import json

import httpx
from pydantic import ValidationError

from app.schemas import AIPlanResult, MorningCheckIn, TaskDraft
from app.services.task_rules import validate_ai_tasks


SYSTEM_PROMPT = """You arrange a small daily task list from approved candidates.
Return JSON only: {"tasks": [...]}. Keep every task within the supplied categories and time budget.
Do not diagnose health conditions, increase physical intensity, or publish tasks without user review.
Each task must contain title, category, estimated_minutes, priority, completion_criteria, reason and source.
"""


class AIPlanner:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 20, transport=None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.transport = transport

    def generate(self, checkin: MorningCheckIn, candidates: list[TaskDraft]) -> AIPlanResult:
        fallback = AIPlanResult(tasks=candidates, degraded=True)
        payload_state = {
            "energy": checkin.energy,
            "available_minutes": checkin.available_minutes,
            "day_type": checkin.day_type,
            "knee_alert": checkin.knee_alert,
        }
        body = {
            "model": self.model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps({"state": payload_state, "candidates": [t.model_dump() for t in candidates]}, ensure_ascii=False)},
            ],
        }
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport) as client:
                response = None
                for attempt in range(2):
                    response = client.post(
                        f"{self.base_url}/chat/completions",
                        headers={"Authorization": f"Bearer {self.api_key}"},
                        json=body,
                    )
                    if response.status_code < 500 or attempt == 1:
                        break
                response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            tasks = [TaskDraft.model_validate({**item, "source": "ai"}) for item in parsed["tasks"]]
            if not validate_ai_tasks(tasks, checkin.available_minutes) or (checkin.knee_alert and any(task.category == "rehab" for task in tasks)):
                raise ValueError("AI task list violates local constraints")
            return AIPlanResult(tasks=tasks)
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError, ValidationError) as exc:
            return fallback.model_copy(update={"degraded_reason": type(exc).__name__})
