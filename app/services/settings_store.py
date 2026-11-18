"""应用设置、标签字典、科目目录与快捷修正配置存取服务。"""
from __future__ import annotations

import json
from datetime import date
from uuid import uuid4

from fastapi import HTTPException

from app.schemas import EffectiveLabelItem, ExecutionLabelItem, SettingsInput, TaskDraft
from app.services.catalog import (
    DEFAULT_CORRECTION_SHORTCUTS,
    DEFAULT_DRAFT_MAIN_MINUTES_BY_CATEGORY,
    DEFAULT_EFFECTIVE_LABELS_BY_CATEGORY,
    DEFAULT_EXECUTION_LABELS,
    DEFAULT_TASK_TITLES,
    QUICK_CORRECTION_BUILTINS,
    default_task_type_for,
    serialize_category_catalog,
)
from app.services.clock import today_date, today_iso
from app.services.prompts import (
    CHATGPT_EXPORT_SYSTEM_PROMPT,
    DAILY_GPT_SYSTEM_PROMPT,
    WEEKLY_ANALYSIS_SYSTEM_PROMPT,
    WEEKLY_GPT_SYSTEM_PROMPT,
)
from app.services.time_accounting import label_category


def build_default_settings() -> dict:
    """每次按需生成默认设置，避免模块导入期固化当天日期或可变列表污染。"""
    return {
        "current_stage": "恢复秩序期",
        "ai_project_weekly_frequency": 3,
        "rehab_enabled": True,
        "show_energy_selector": False,
        "show_day_type_selector": False,
        "main_project_categories": None,
        "weekly_review_mode": "separate",
        "weekly_review_day": 6,
        "project_start_date": today_iso(),
        "task_titles": dict(DEFAULT_TASK_TITLES),
        "draft_main_minutes_by_category": dict(DEFAULT_DRAFT_MAIN_MINUTES_BY_CATEGORY),
        "budget_minimum": 90,
        "budget_normal": 150,
        "budget_ample": 210,
        "execution_labels": [dict(item) for item in DEFAULT_EXECUTION_LABELS],
        "effective_labels_by_category": {
            cat: [dict(item) for item in items]
            for cat, items in DEFAULT_EFFECTIVE_LABELS_BY_CATEGORY.items()
        },
        "deleted_effective_label_ids": {},
        "weekly_analysis_prompts": [
            {
                "id": "weekly_analysis_system_default",
                "name": "系统默认",
                "content": WEEKLY_ANALYSIS_SYSTEM_PROMPT,
                "is_system": True,
            }
        ],
        "weekly_analysis_active_prompt_id": "weekly_analysis_system_default",
        "chatgpt_export_prompts": [
            {
                "id": "chatgpt_export_system_default",
                "name": "系统默认",
                "content": CHATGPT_EXPORT_SYSTEM_PROMPT,
                "is_system": True,
            }
        ],
        "chatgpt_export_active_prompt_id": "chatgpt_export_system_default",
        "daily_gpt_prompts": [
            {
                "id": "daily_gpt_system_default",
                "name": "系统默认",
                "content": DAILY_GPT_SYSTEM_PROMPT,
                "is_system": True,
            }
        ],
        "daily_gpt_active_prompt_id": "daily_gpt_system_default",
        "weekly_gpt_prompts": [
            {
                "id": "weekly_gpt_system_default",
                "name": "系统默认",
                "content": WEEKLY_GPT_SYSTEM_PROMPT,
                "is_system": True,
            }
        ],
        "weekly_gpt_active_prompt_id": "weekly_gpt_system_default",
    }


def earliest_business_date(connection) -> str | None:
    row = connection.execute(
        """SELECT MIN(record_date) AS record_date FROM (
               SELECT plan_date AS record_date FROM plans
               UNION ALL SELECT review_date AS record_date FROM reviews
               UNION ALL SELECT plan_date AS record_date FROM task_execution_segments
           )"""
    ).fetchone()
    return row["record_date"] if row and row["record_date"] else None


def effective_labels_by_category(settings: dict) -> dict[str, list[dict]]:
    raw = settings.get("effective_labels_by_category") or DEFAULT_EFFECTIVE_LABELS_BY_CATEGORY
    merged: dict[str, list[dict]] = {}
    category_keys = {*(DEFAULT_EFFECTIVE_LABELS_BY_CATEGORY.keys()), *(str(key) for key in raw.keys())}
    for category in category_keys:
        default_items = [dict(item) for item in DEFAULT_EFFECTIVE_LABELS_BY_CATEGORY.get(category, [])]
        raw_items = [dict(item) for item in (raw.get(category) or raw.get(str(category)) or [])]
        raw_by_id = {item["id"]: item for item in raw_items}
        combined = [raw_by_id.pop(item["id"], item) for item in default_items]
        combined.extend(raw_by_id.values())
        deleted = set(settings.get("deleted_effective_label_ids", {}).get(category, []))
        merged[category] = [item for item in combined if item["id"] not in deleted]
    return merged


def draft_main_minutes_by_category(settings: dict) -> dict[str, int]:
    raw = settings.get("draft_main_minutes_by_category") or DEFAULT_DRAFT_MAIN_MINUTES_BY_CATEGORY
    merged = dict(DEFAULT_DRAFT_MAIN_MINUTES_BY_CATEGORY)
    titles = settings.get("task_titles") or {}
    for category, value in raw.items():
        if category not in titles and not str(category).startswith("custom_"):
            continue
        try:
            merged[category] = max(0, min(720, int(value)))
        except (TypeError, ValueError):
            continue
    return merged


def get_settings(connection) -> dict:
    defaults = build_default_settings()
    row = connection.execute("SELECT value_json FROM app_settings WHERE key='main'").fetchone()
    stored_settings = json.loads(row["value_json"]) if row else {}
    settings = defaults | stored_settings
    if "task_titles" in stored_settings and isinstance(stored_settings["task_titles"], dict):
        settings["task_titles"] = {**DEFAULT_TASK_TITLES, **stored_settings["task_titles"]}
    settings["deleted_effective_label_ids"] = {
        category: list(ids) for category, ids in settings.get("deleted_effective_label_ids", {}).items()
    }
    settings["project_start_date"] = (
        stored_settings.get("project_start_date")
        or earliest_business_date(connection)
        or today_iso()
    )
    settings["effective_labels_by_category"] = effective_labels_by_category(settings)
    settings["draft_main_minutes_by_category"] = draft_main_minutes_by_category(settings)
    if settings.get("main_project_categories") is None:
        settings["main_project_categories"] = list(DEFAULT_DRAFT_MAIN_MINUTES_BY_CATEGORY)
    settings["category_catalog"] = serialize_category_catalog(settings)
    return settings


def save_settings_record(connection, payload: SettingsInput) -> dict:
    defaults = build_default_settings()
    existing = get_settings(connection)
    data = payload.model_dump(mode="json")
    for key in (
        "show_energy_selector",
        "show_day_type_selector",
        "main_project_categories",
        "weekly_review_mode",
        "weekly_review_day",
        "execution_labels",
        "effective_labels_by_category",
        "deleted_effective_label_ids",
        "draft_main_minutes_by_category",
        "weekly_analysis_prompts",
        "weekly_analysis_active_prompt_id",
        "chatgpt_export_prompts",
        "chatgpt_export_active_prompt_id",
        "daily_gpt_prompts",
        "daily_gpt_active_prompt_id",
        "weekly_gpt_prompts",
        "weekly_gpt_active_prompt_id",
    ):
        if key not in payload.model_fields_set:
            data[key] = existing.get(key, defaults[key])
    projects = data.get("main_project_categories")
    if projects is not None:
        if len(set(projects)) != len(projects):
            raise HTTPException(422, "主项目不能重复")
        data["task_titles"] = {**existing["task_titles"], **data["task_titles"]}
        data["draft_main_minutes_by_category"] = {
            **existing["draft_main_minutes_by_category"],
            **data["draft_main_minutes_by_category"],
        }
        for category in projects:
            title = data["task_titles"].get(category, "").strip()
            if not title or len(title) > 100:
                raise HTTPException(422, "每个主项目请填写1～100字的名称")
            data["task_titles"][category] = title
    else:
        data["task_titles"] = {**DEFAULT_TASK_TITLES, **data["task_titles"]}
    previous_labels = {label["id"]: label for label in existing.get("execution_labels", [])}
    for label in data.get("execution_labels", []):
        if label.get("time_category") is None and previous_labels.get(label["id"], {}).get("time_category"):
            label["time_category"] = previous_labels[label["id"]]["time_category"]
    old_deleted = existing.get("deleted_effective_label_ids", {})
    new_deleted = data.get("deleted_effective_label_ids", {})
    data["deleted_effective_label_ids"] = {
        category: sorted(set(old_deleted.get(category, [])) | set(new_deleted.get(category, [])))
        for category in old_deleted.keys() | new_deleted.keys()
    }
    connection.execute(
        """INSERT INTO app_settings(key,value_json) VALUES('main',?)
           ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP""",
        (json.dumps(data, ensure_ascii=False),),
    )
    return get_settings(connection)


def store_effective_label_settings(connection, settings: dict) -> dict:
    persisted = {key: value for key, value in settings.items() if key != "category_catalog"}
    connection.execute(
        """INSERT INTO app_settings(key,value_json) VALUES('main',?)
           ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP""",
        (json.dumps(persisted, ensure_ascii=False),),
    )
    return get_settings(connection)


def assert_unique_effective_name(labels: list[dict], name: str, skip_id: str | None = None) -> None:
    if any(item["id"] != skip_id and item["name"].strip().casefold() == name.casefold() for item in labels):
        raise HTTPException(409, "这个科目已有同名细分，请换一个名称")


def build_execution_label_map(settings: dict) -> dict[str, dict]:
    labels = settings.get("execution_labels") or DEFAULT_EXECUTION_LABELS
    return {item["id"]: item for item in labels}


def build_effective_label_map(settings: dict, category: str) -> dict[str, dict]:
    labels = effective_labels_by_category(settings).get(category) or []
    return {item["id"]: item for item in labels}


def serialize_execution_labels(settings: dict) -> list[dict]:
    labels = settings.get("execution_labels") or DEFAULT_EXECUTION_LABELS
    return [
        ExecutionLabelItem(**(item | {"time_category": label_category(item)})).model_dump(mode="json")
        for item in labels
    ]


def main_project_categories(settings: dict) -> list[str]:
    categories = settings.get("main_project_categories")
    if categories is None:
        categories = list(DEFAULT_DRAFT_MAIN_MINUTES_BY_CATEGORY)
    return [category for category in categories if category != "rehab" or settings.get("rehab_enabled", True)]


def configure_main_projects(tasks: list[TaskDraft], settings: dict) -> list[TaskDraft]:
    categories = main_project_categories(settings)
    if not categories:
        raise HTTPException(422, "请先在设置中保留至少一个主项目")
    by_category = {task.category: task for task in tasks}
    main: list[TaskDraft] = []
    for category in categories:
        task = by_category.get(category) or TaskDraft(
            title=settings["task_titles"].get(category, "新项目"),
            category=category,
            estimated_minutes=0,
            priority=3,
            completion_criteria="完成今天设定的目标",
            task_type=default_task_type_for(category),
        )
        main.append(task.model_copy(update={"is_sub": 0}))
    return main + [task for task in tasks if task.is_sub and task.category not in categories]


def apply_draft_main_minutes(tasks: list[TaskDraft], settings: dict) -> list[TaskDraft]:
    defaults = draft_main_minutes_by_category(settings)
    output: list[TaskDraft] = []
    for task in tasks:
        if task.is_sub or task.source == "carryover" or task.category not in defaults:
            output.append(task)
            continue
        output.append(task.model_copy(update={"estimated_minutes": defaults[task.category]}))
    return output


def resolve_prompt_content(settings: dict, prompt_key: str, active_key: str, default_id: str, default_content: str) -> str:
    prompts = settings.get(prompt_key) or []
    active_id = settings.get(active_key) or default_id
    for prompt in prompts:
        if prompt.get("id") == active_id and (prompt.get("content") or "").strip():
            return prompt["content"]
    return default_content


def project_start_date(settings: dict) -> date:
    raw = settings.get("project_start_date") or today_iso()
    if isinstance(raw, date):
        return raw
    return date.fromisoformat(str(raw))


def correction_activities(settings: dict) -> dict[str, dict]:
    activities = {
        label["id"]: dict(label) | {"time_category": label_category(label)}
        for label in serialize_execution_labels(settings)
    }
    for key, value in QUICK_CORRECTION_BUILTINS.items():
        activities[key] = dict(value)
    return activities


def correction_shortcuts(connection) -> list[dict]:
    row = connection.execute("SELECT value_json FROM app_settings WHERE key='correction_shortcuts'").fetchone()
    return json.loads(row["value_json"]) if row else [dict(item) for item in DEFAULT_CORRECTION_SHORTCUTS]


def save_correction_shortcuts(connection, items: list[dict]) -> list[dict]:
    connection.execute(
        "INSERT INTO app_settings(key,value_json) VALUES('correction_shortcuts',?) "
        "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP",
        (json.dumps(items, ensure_ascii=False),),
    )
    return items


def add_shortcut_item(connection, label_id: str, minutes: int) -> list[dict]:
    if label_id not in correction_activities(get_settings(connection)):
        raise HTTPException(404, "活动已不存在，请重新选择")
    items = correction_shortcuts(connection)
    if any(item["label_id"] == label_id and item["minutes"] == minutes for item in items):
        return items
    if len(items) >= 24:
        raise HTTPException(422, "最多保存24个快捷键，请先移除不用的快捷键")
    items.append({"id": uuid4().hex, "label_id": label_id, "minutes": minutes})
    return save_correction_shortcuts(connection, items)
