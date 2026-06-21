from __future__ import annotations

from datetime import date

from app.schemas import MorningCheckIn, RulePlan, TaskDraft


UNSAFE_REHAB_WORDS = ("冲刺", "跳绳", "跳跃", "1000", "大重量", "急停")


def _task(title, category, minutes, priority, criteria, reason="规则生成"):
    return TaskDraft(
        title=title,
        category=category,
        estimated_minutes=minutes,
        priority=priority,
        completion_criteria=criteria,
        reason=reason,
    )


def _fit_to_budget(tasks: list[TaskDraft], budget: int) -> list[TaskDraft]:
    optional_order = ("ai_project", "rehab")
    fitted = list(tasks)
    for category in optional_order:
        if sum(t.estimated_minutes for t in fitted) <= budget:
            break
        fitted = [t for t in fitted if t.category != category]
    total = sum(t.estimated_minutes for t in fitted)
    if total <= budget:
        return fitted
    scalable = [t for t in fitted if t.category in {"math", "english", "computer"}]
    fixed = total - sum(t.estimated_minutes for t in scalable)
    available = max(budget - fixed, 30)
    original = sum(t.estimated_minutes for t in scalable)
    ratio = min(1.0, available / original)
    output = []
    for task in fitted:
        if task in scalable:
            minutes = max(10, int(task.estimated_minutes * ratio // 5 * 5))
            output.append(task.model_copy(update={"estimated_minutes": minutes}))
        else:
            output.append(task)
    while sum(t.estimated_minutes for t in output) > budget:
        largest = max((t for t in output if t.category in {"math", "english", "computer"} and t.estimated_minutes > 10), key=lambda t: t.estimated_minutes, default=None)
        if largest is None:
            break
        index = output.index(largest)
        output[index] = largest.model_copy(update={"estimated_minutes": largest.estimated_minutes - 5})
    return output


def build_rule_plan(checkin: MorningCheckIn) -> RulePlan:
    day = checkin.plan_date or date.today()
    if checkin.energy == "minimum":
        tasks = [
            _task("数学保底", "math", 30, 1, "完成一个明确知识点或 2 道题"),
            _task("英语不断线", "english", 20, 2, "完成单词或短阅读一组"),
            _task("C语言 / 数据结构保底", "computer", 30, 1, "读懂并手写一个小知识点"),
            _task("夜间收尾", "sleep", 10, 1, "00:40 后不再打开新内容"),
        ]
    elif checkin.energy == "normal":
        tasks = [
            _task("数学主任务", "math", 60, 1, "完成 1 个 35 分钟学习块并整理卡点"),
            _task("英语任务", "english", 30, 2, "完成当天单词与一段阅读"),
            _task("C语言 / 数据结构", "computer", 50, 1, "完成一个具体章节或代码练习"),
            _task("夜间收尾", "sleep", 10, 1, "00:40 后不再打开新内容"),
        ]
    else:
        tasks = [
            _task("数学深度学习", "math", 90, 1, "完成两个学习块并记录检查点"),
            _task("英语任务", "english", 45, 2, "完成单词与阅读训练"),
            _task("C语言 / 数据结构", "computer", 60, 1, "学习一个主题并亲手完成代码练习"),
            _task("AI 小工具", "ai_project", 45, 4, "读懂一处代码并亲手修改一个小地方"),
            _task("夜间收尾", "sleep", 10, 1, "00:40 后不再打开新内容"),
        ]

    if not checkin.knee_alert and day.weekday() in {0, 1, 2, 4, 5, 6}:
        title = "康复训练 A" if day.weekday() in {0, 4} else "康复训练 B" if day.weekday() in {2, 6} else "稳定快走"
        criteria = "完成既定低强度动作；出现疼痛或不稳立即停止" if "训练" in title else "小步幅稳定行走 15 分钟，无疼痛或错位感"
        tasks.append(_task(title, "rehab", 20, 3, criteria, "固定康复规则"))

    wake_time = "07:30" if checkin.day_type == "early_class" else "08:30"
    tasks = [t.model_copy(update={"completion_criteria": f"{t.completion_criteria}；次日 {wake_time} 起床"}) if t.category == "sleep" else t for t in tasks]
    safety = "今天记录了膝盖异常：停止相关训练；如有疼痛、卡住、打软或肿胀，请寻求专业评估。" if checkin.knee_alert else None
    return RulePlan(
        tasks=_fit_to_budget(tasks, checkin.available_minutes),
        methods=["学习块开始前写清目标和结束标准", "手机放入书包，休息不刷推荐流", "数学只在关键检查点检查"],
        safety_notice=safety,
    )


def validate_ai_tasks(tasks: list[TaskDraft], available_minutes: int) -> bool:
    if not tasks or len(tasks) > 10:
        return False
    if sum(task.estimated_minutes for task in tasks) > available_minutes:
        return False
    if not {"math", "english", "computer"}.issubset({task.category for task in tasks}):
        return False
    for task in tasks:
        if task.category == "rehab" and any(word in f"{task.title}{task.completion_criteria}" for word in UNSAFE_REHAB_WORDS):
            return False
    return True
