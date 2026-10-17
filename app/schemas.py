from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


Energy = Literal["minimum", "normal", "ample"]
DayType = Literal["normal", "early_class"]
Category = Literal["math", "english", "computer", "ai_project", "rehab", "sleep", "vibe_coding", "algorithm", "reading", "writing"]
ReviewMood = Literal["很好", "平稳", "疲惫", "烦躁", "低落", ""]
ReviewProgress = Literal["明显推进", "有一点推进", "原地打转", "基本没推进", ""]
ExecutionLabelBucket = Literal["counted", "interrupt"]
TimeCategory = Literal["learning", "distraction", "rest", "external", "life"]
NonLearningCategory = Literal["distraction", "rest", "external", "life"]
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
    time_category: NonLearningCategory | None = None
    is_system: bool = False


class EffectiveLabelNameInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: str = Field(min_length=1, max_length=50)


class EffectiveLabelItem(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=50)
    is_system: bool = False


class MorningCheckIn(BaseModel):
    energy: Energy
    available_minutes: int = Field(default=240, ge=30, le=720) # 仅兼容历史字段，不限制目标
    day_type: DayType
    plan_date: date | None = None


class DraftRequest(MorningCheckIn):
    date: date
    target_minutes: dict[Category, Annotated[int, Field(ge=0, le=720)]] = Field(default_factory=dict)


class TaskDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=100)
    category: Category
    estimated_minutes: int = Field(ge=0, le=720)
    priority: int = Field(ge=1, le=5)
    completion_criteria: str = Field(default="", max_length=240)
    reason: str = Field(default="", max_length=240)
    source: Literal["rule", "ai", "carryover"] = "rule"
    task_type: Literal["habit", "daily_goal", "todo"] | None = None
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


class DurationRecordInput(BaseModel):
    minutes: int = Field(ge=1, le=1440)
    duplicate_choice: Literal["both", "manual", "timer"] | None = None


class TemporaryTaskInput(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    category: Category
    task_type: Literal["habit", "daily_goal", "todo"] | None = None


class TaskUpdate(BaseModel):
    task_type: Literal["habit", "daily_goal", "todo"] | None = None
    habit_status: Literal["done", "missed", "rest"] | None = None
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
    learning_outcome: str = Field(default="", max_length=300)


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
    duplicate_choice: Literal["both", "manual", "timer"] | None = None
    task_id: int
    label_id: str | None = Field(default=None, max_length=100)


class ExecutionLabelStartInput(BaseModel):
    reminder_minutes: int | None = Field(default=None, ge=1, le=1440)
    label_id: str = Field(min_length=1, max_length=100)
    task_id: int | None = None


class ExecutionSegmentCreateInput(BaseModel):
    time_category: TimeCategory | None = None
    duplicate_choice: Literal["both", "manual", "timer"] | None = None
    task_id: int
    segment_kind: ExecutionSegmentKind
    label_id: str | None = Field(default=None, max_length=100)
    started_at: datetime
    ended_at: datetime


class ExecutionSegmentUpdateInput(BaseModel):
    time_category: TimeCategory | None = None
    duplicate_choice: Literal["both", "manual", "timer"] | None = None
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
    weekly_review_mode: Literal["separate", "replace_day"] = "separate"
    weekly_review_day: int = Field(default=6, ge=0, le=6)
    project_start_date: date = Field(default_factory=date.today)
    task_titles: dict[Category, str]
    draft_main_minutes_by_category: dict[Category, int] = Field(default_factory=dict)
    budget_minimum: int = Field(default=90, ge=30, le=720)
    budget_normal: int = Field(default=150, ge=30, le=720)
    budget_ample: int = Field(default=210, ge=30, le=720)
    execution_labels: list[ExecutionLabelItem] = Field(default_factory=list)
    effective_labels_by_category: dict[Category, list[EffectiveLabelItem]] = Field(default_factory=dict)
    deleted_effective_label_ids: dict[Category, list[str]] = Field(default_factory=dict)
    weekly_analysis_prompts: list[PromptConfigItem] = Field(default_factory=list)
    weekly_analysis_active_prompt_id: str = "weekly_analysis_system_default"
    chatgpt_export_prompts: list[PromptConfigItem] = Field(default_factory=list)
    chatgpt_export_active_prompt_id: str = "chatgpt_export_system_default"
    daily_gpt_prompts: list[PromptConfigItem] = Field(default_factory=list)
    daily_gpt_active_prompt_id: str = "daily_gpt_system_default"
    weekly_gpt_prompts: list[PromptConfigItem] = Field(default_factory=list)
    weekly_gpt_active_prompt_id: str = "weekly_gpt_system_default"
