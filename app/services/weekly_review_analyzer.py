from __future__ import annotations

import json
import logging

import httpx
from pydantic import ValidationError

from app.schemas import WeeklyAnalysisResult
from app.services.prompts import WEEKLY_ANALYSIS_SYSTEM_PROMPT, parse_llm_json

logger = logging.getLogger(__name__)

# 保持旧常量别名向后兼容
WEEKLY_REVIEW_SYSTEM_PROMPT = WEEKLY_ANALYSIS_SYSTEM_PROMPT


class WeeklyReviewAnalyzer:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 20, transport=None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.transport = transport

    def analyze(self, snapshot: dict, custom_prompt: str | None = None) -> tuple[WeeklyAnalysisResult | None, str | None]:
        system_prompt = custom_prompt or WEEKLY_ANALYSIS_SYSTEM_PROMPT
        body = {
            "model": self.model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(snapshot, ensure_ascii=False)},
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
                assert response is not None
                response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            parsed = parse_llm_json(content)
            return WeeklyAnalysisResult.model_validate(parsed), None
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError, ValidationError) as exc:
            logger.warning("周复盘 AI 分析失败 (%s)", type(exc).__name__)
            return None, type(exc).__name__
