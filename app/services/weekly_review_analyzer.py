from __future__ import annotations

import json

import httpx
from pydantic import ValidationError

from app.schemas import WeeklyAnalysisResult


WEEKLY_REVIEW_SYSTEM_PROMPT = """你是一个帮助用户做周复盘的分析助手。
你会收到最近 7 天的执行数据和每日复盘内容。
只输出 JSON，格式必须是：
{
  "summary_title": "...",
  "load_advice": "...",
  "drag_factors": "...",
  "effective_patterns": "...",
  "real_progress_assessment": "...",
  "next_week_focus": "..."
}
要求：
1. 基于事实，不夸张，不说空话。
2. 不要替用户自动决定，只给审阅参考。
3. 优先回答：要不要调量、为什么没完成、什么方法有效、这周是否真实推进、下周该抓什么。
4. 不要输出 Markdown，不要输出额外解释。
"""


class WeeklyReviewAnalyzer:
    def __init__(self, base_url: str, api_key: str, model: str, timeout: float = 20, transport=None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.transport = transport

    def analyze(self, snapshot: dict, custom_prompt: str | None = None) -> tuple[WeeklyAnalysisResult | None, str | None]:
        system_prompt = custom_prompt or WEEKLY_REVIEW_SYSTEM_PROMPT
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
                response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            return WeeklyAnalysisResult.model_validate(parsed), None
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError, ValidationError) as exc:
            return None, type(exc).__name__
