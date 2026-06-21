from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


Energy = Literal["minimum", "normal", "ample"]
DayType = Literal["normal", "early_class"]
Category = Literal["math", "english", "computer", "ai_project", "rehab", "sleep"]


class MorningCheckIn(BaseModel):
    energy: Energy
    available_minutes: int = Field(ge=30, le=720)
    day_type: DayType
    knee_alert: bool = False
    plan_date: date | None = None


class DraftRequest(MorningCheckIn):
    date: date


class TaskDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=100)
    category: Category
    estimated_minutes: int = Field(ge=5, le=240)
    priority: int = Field(ge=1, le=5)
    completion_criteria: str = Field(min_length=1, max_length=240)
    reason: str = Field(default="", max_length=240)
    source: Literal["rule", "ai", "carryover"] = "rule"


class RulePlan(BaseModel):
    tasks: list[TaskDraft]
    methods: list[str]
    safety_notice: str | None = None


class AIPlanResult(BaseModel):
    tasks: list[TaskDraft]
    degraded: bool = False
    degraded_reason: str | None = None


class TaskUpdate(BaseModel):
    completed: bool
    actual_minutes: int | None = Field(default=None, ge=0, le=720)


class PlanTaskInput(TaskDraft):
    id: int | None = None


class PlanUpdate(BaseModel):
    tasks: list[PlanTaskInput] = Field(min_length=1, max_length=10)


class ReviewInput(BaseModel):
    date: date
    distraction: str = Field(max_length=300)
    effective_method: str = Field(max_length=300)
    tomorrow_focus: str = Field(max_length=300)


class CarryoverResolution(BaseModel):
    action: Literal["reschedule", "split", "discard"]
    target_date: date | None = None
    split_title: str | None = Field(default=None, max_length=100)


class SettingsInput(BaseModel):
    current_stage: str = Field(min_length=1, max_length=100)
    ai_project_weekly_frequency: int = Field(ge=0, le=7)
    rehab_enabled: bool = True
    task_titles: dict[Category, str]
