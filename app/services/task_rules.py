from __future__ import annotations

from app.schemas import MorningCheckIn, RulePlan, TaskDraft
from app.services.catalog import (
    DEFAULT_MAIN_CATEGORIES,
    DEFAULT_SUB_CATEGORIES,
    MAX_DAILY_TASKS,
    get_category_meta,
)


def _task(
    title: str,
    category: str,
    minutes: int,
    priority: int,
    criteria: str,
    reason: str = "规则生成",
    sub_category: str | None = None,
    is_sub: int = 0,
    task_type: str | None = None,
) -> TaskDraft:
    return TaskDraft(
        title=title,
        category=category,
        estimated_minutes=minutes,
        priority=priority,
        completion_criteria=criteria,
        reason=reason,
        sub_category=sub_category,
        is_sub=is_sub,
        task_type=task_type,
    )


def build_rule_plan(checkin: MorningCheckIn) -> RulePlan:
    energy = checkin.energy
    main_tasks: list[TaskDraft] = []
    for category in DEFAULT_MAIN_CATEGORIES:
        meta = get_category_meta(category)
        minutes = int(meta["energy_minutes"][energy])
        criteria = str(meta["energy_criteria"][energy])
        main_tasks.append(
            _task(
                meta["default_title"],
                category,
                minutes,
                int(meta["default_priority"]),
                criteria,
                sub_category=meta["default_sub_category"],
                is_sub=0,
                task_type=meta["default_task_type"],
            )
        )

    sub_tasks: list[TaskDraft] = []
    for category in DEFAULT_SUB_CATEGORIES:
        meta = get_category_meta(category)
        sub_tasks.append(
            _task(
                meta["default_title"],
                category,
                0,
                int(meta["default_priority"]),
                str(meta["default_criteria"]),
                sub_category=meta["default_sub_category"],
                is_sub=1,
                task_type=meta["default_task_type"],
            )
        )

    return RulePlan(
        tasks=main_tasks + sub_tasks,
        methods=[
            "学习块开始前写清目标和结束标准",
            "手机放入书包，休息不刷推荐流",
            "数学只在关键检查点检查",
        ],
        safety_notice=None,
    )


def validate_ai_tasks(
    tasks: list[TaskDraft],
    available_minutes: int | None = None,
    required_main_categories: set[str] | None = None,
) -> bool:
    del available_minutes  # 保留参数签名兼容调用方；时长不再限制用户目标
    if not tasks or len(tasks) > MAX_DAILY_TASKS:
        return False
    main_cats = {task.category for task in tasks if not task.is_sub}
    required = {"math", "english", "computer"} if required_main_categories is None else required_main_categories
    return required.issubset(main_cats)
