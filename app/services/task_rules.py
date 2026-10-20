from __future__ import annotations

from datetime import date

from app.schemas import MorningCheckIn, RulePlan, TaskDraft


def _task(title, category, minutes, priority, criteria, reason="规则生成", sub_category=None, is_sub=0):
    return TaskDraft(
        title=title,
        category=category,
        estimated_minutes=minutes,
        priority=priority,
        completion_criteria=criteria,
        reason=reason,
        sub_category=sub_category,
        is_sub=is_sub,
    )


def build_rule_plan(checkin: MorningCheckIn) -> RulePlan:
    day = checkin.plan_date or date.today()

    # 4 Main Route Tasks (is_sub = 0)
    if checkin.energy == "minimum":
        main_tasks = [
            _task("数学", "math", 30, 1, "完成一个明确知识点或 2 道题"),
            _task("英语", "english", 20, 2, "完成单词或短阅读一组"),
            _task("408", "computer", 30, 1, "读懂并手写一个小知识点", sub_category="数据结构"),
        ]
    elif checkin.energy == "normal":
        main_tasks = [
            _task("数学", "math", 60, 1, "完成 1 个 35 分钟学习块并整理卡点"),
            _task("英语", "english", 30, 2, "完成当天单词与一段阅读"),
            _task("408", "computer", 50, 1, "完成一个具体章节或代码练习", sub_category="数据结构"),
        ]
    else:
        main_tasks = [
            _task("数学", "math", 90, 1, "完成两个学习块并记录检查点"),
            _task("英语", "english", 45, 2, "完成单词与阅读训练"),
            _task("408", "computer", 60, 1, "学习一个主题并亲手完成代码练习", sub_category="数据结构"),
        ]

    main_tasks.append(_task("运动", "rehab", 20, 3, "完成今天安排的运动"))

    # 4 Sub Route Tasks (is_sub = 1, default 0 minutes)
    sub_tasks = [
        _task("vibe coding", "vibe_coding", 0, 4, "做自己想用的小工具，读懂代码", is_sub=1),
        _task("算法", "algorithm", 0, 4, "刷算法题，重在理解思路", is_sub=1),
        _task("阅读", "reading", 0, 5, "阅读书籍/文章，做一些积累", is_sub=1),
        _task("练字", "writing", 0, 5, "每天练字，静心提神", sub_category="中文", is_sub=1),
    ]

    tasks = main_tasks + sub_tasks

    return RulePlan(
        tasks=tasks,
        methods=["学习块开始前写清目标和结束标准", "手机放入书包，休息不刷推荐流", "数学只在关键检查点检查"],
        safety_notice=None,
    )


def validate_ai_tasks(tasks: list[TaskDraft], available_minutes: int, required_main_categories: set[str] | None = None) -> bool:
    if not tasks or len(tasks) > 15:
        return False
    # Ensure key main routes exist
    main_cats = {task.category for task in tasks if not task.is_sub}
    required = {"math", "english", "computer"} if required_main_categories is None else required_main_categories
    if not required.issubset(main_cats):
        return False
    return True
