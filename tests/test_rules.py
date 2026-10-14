from app.schemas import MorningCheckIn
from app.services.task_rules import build_rule_plan, validate_ai_tasks


def test_minimum_plan_preserves_goals_despite_old_available_time():
    plan = build_rule_plan(MorningCheckIn(energy="minimum", available_minutes=90, day_type="normal"))
    assert sum(item.estimated_minutes for item in plan.tasks if not item.is_sub) == 100
    assert {item.category for item in plan.tasks if not item.is_sub} >= {"math", "english", "computer"}
    assert not any(item.category == "vibe_coding" and not item.is_sub for item in plan.tasks)


def test_ample_plan_can_include_vibe_coding():
    plan = build_rule_plan(MorningCheckIn(energy="ample", available_minutes=300, day_type="normal"))
    assert any(item.category == "vibe_coding" for item in plan.tasks)


def test_exercise_is_an_ordinary_habit():
    plan = build_rule_plan(MorningCheckIn(energy="normal", available_minutes=180, day_type="normal", knee_alert=True))
    exercise = next(item for item in plan.tasks if item.category == "rehab")
    assert exercise.completion_criteria == "完成今天安排的运动"
    assert plan.safety_notice is None


def test_ai_tasks_allow_goals_and_ordinary_exercise():
    base = build_rule_plan(MorningCheckIn(energy="normal", available_minutes=120, day_type="normal"))
    ai_tasks = [task.model_copy(update={"estimated_minutes": 200}) for task in base.tasks]
    assert validate_ai_tasks(ai_tasks, available_minutes=120) is True

    exercise = [task.model_copy(update={"title": "1000 米跑步"}) if task.category == "rehab" else task for task in base.tasks]
    assert validate_ai_tasks(exercise, available_minutes=120) is True


def test_ai_cannot_remove_daily_learning_baseline():
    base = build_rule_plan(MorningCheckIn(energy="normal", available_minutes=180, day_type="normal"))
    without_english = [task for task in base.tasks if task.category != "english"]
    assert validate_ai_tasks(without_english, available_minutes=180) is False
