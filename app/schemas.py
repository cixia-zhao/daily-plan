from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


Energy = Literal["minimum", "normal", "ample"]
DayType = Literal["normal", "early_class"]
Category = Literal["math", "english", "computer", "ai_project", "rehab", "sleep", "vibe_coding", "algorithm", "reading", "writing"]
ReviewMood = Literal["很好", "平稳", "疲惫", "烦躁", "低落", ""]
ReviewProgress = Literal["明显推进", "有一点推进", "原地打转", "基本没推进", ""]
ExecutionLabelBucket = Literal["counted", "interrupt"]
ExecutionSegmentKind = Literal["effective", "counted_label", "interrupt_label"]


class PromptConfigItem(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1, max_length=12000)
    is_system: bool = False


class ExecutionLabelItem(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=50)
    bucket: ExecutionLabelBucket
    is_system: bool = False


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
    estimated_minutes: int = Field(ge=0, le=720)
    priority: int = Field(ge=1, le=5)
    completion_criteria: str = Field(default="", max_length=240)
    reason: str = Field(default="", max_length=240)
    source: Literal["rule", "ai", "carryover"] = "rule"
    sub_category: str | None = Field(default=None, max_length=50)
    is_sub: int = Field(default=0, ge=0, le=1)


class RulePlan(BaseModel):
    tasks: list[TaskDraft]
    methods: list[str]
    safety_notice: str | None = None


class AIPlanResult(BaseModel):
    tasks: list[TaskDraft]
    degraded: bool = False
    degraded_reason: str | None = None


class TaskUpdate(BaseModel):
    completed: bool | None = None
    actual_minutes: int | None = Field(default=None, ge=0, le=720)
    sub_category: str | None = Field(default=None, max_length=50)


class PlanTaskInput(TaskDraft):
    id: int | None = None


class PlanUpdate(BaseModel):
    tasks: list[PlanTaskInput] = Field(min_length=1, max_length=15)


class ReviewInput(BaseModel):
    date: date
    mood: ReviewMood = ""
    hardest_point: str = Field(default="", max_length=300)
    effective_method: str = Field(max_length=300)
    optimization_note: str = Field(default="", max_length=300)
    real_progress: ReviewProgress = ""
    tomorrow_focus: str = Field(max_length=300)
    reflection_text: str = Field(default="", max_length=4000)


class WeeklyAnalysisResult(BaseModel):
    load_advice: str = Field(default="", max_length=600)
    drag_factors: str = Field(default="", max_length=1200)
    effective_patterns: str = Field(default="", max_length=1200)
    real_progress_assessment: str = Field(default="", max_length=1200)
    next_week_focus: str = Field(default="", max_length=1200)
    summary_title: str = Field(default="", max_length=200)


class WeeklyReportSaveInput(BaseModel):
    final_report_text: str = Field(default="", max_length=12000)


class GPTRecordSaveInput(BaseModel):
    response_text: str = Field(default="", max_length=20000)
    adopted_text: str = Field(default="", max_length=20000)


class ExecutionTaskStartInput(BaseModel):
    task_id: int


class ExecutionLabelStartInput(BaseModel):
    label_id: str = Field(min_length=1, max_length=100)
    task_id: int | None = None


class ExecutionSegmentCreateInput(BaseModel):
    task_id: int
    segment_kind: ExecutionSegmentKind
    label_id: str | None = Field(default=None, max_length=100)
    started_at: datetime
    ended_at: datetime


class ExecutionSegmentUpdateInput(BaseModel):
    task_id: int
    segment_kind: ExecutionSegmentKind
    label_id: str | None = Field(default=None, max_length=100)
    started_at: datetime
    ended_at: datetime


class CarryoverResolution(BaseModel):
    action: Literal["reschedule", "split", "discard"]
    target_date: date | None = None
    split_title: str | None = Field(default=None, max_length=100)


class SettingsInput(BaseModel):
    current_stage: str = Field(min_length=1, max_length=100)
    ai_project_weekly_frequency: int = Field(ge=0, le=7)
    rehab_enabled: bool = True
    project_start_date: date = Field(default_factory=date.today)
    task_titles: dict[Category, str]
    budget_minimum: int = Field(default=90, ge=30, le=720)
    budget_normal: int = Field(default=150, ge=30, le=720)
    budget_ample: int = Field(default=210, ge=30, le=720)
    execution_labels: list[ExecutionLabelItem] = Field(default_factory=list)
    weekly_analysis_prompts: list[PromptConfigItem] = Field(default_factory=list)
    weekly_analysis_active_prompt_id: str = "weekly_analysis_system_default"
    chatgpt_export_prompts: list[PromptConfigItem] = Field(default_factory=list)
    chatgpt_export_active_prompt_id: str = "chatgpt_export_system_default"
    daily_gpt_prompts: list[PromptConfigItem] = Field(default_factory=list)
    daily_gpt_active_prompt_id: str = "daily_gpt_system_default"
    weekly_gpt_prompts: list[PromptConfigItem] = Field(default_factory=list)
    weekly_gpt_active_prompt_id: str = "weekly_gpt_system_default"
