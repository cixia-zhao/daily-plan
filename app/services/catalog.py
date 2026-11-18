"""统一科目能力元数据、默认标签与业务规则常量，消除前后端散落的魔法分支。"""
from __future__ import annotations

from typing import Any

MAX_DAILY_TASKS = 15
VOCABULARY_WORD_LABEL_ID = "effective_english_words"

DEFAULT_MAIN_CATEGORIES: tuple[str, ...] = ("math", "english", "computer", "rehab")
DEFAULT_SUB_CATEGORIES: tuple[str, ...] = ("vibe_coding", "algorithm", "reading", "writing")

CATEGORY_DEFINITIONS: dict[str, dict[str, Any]] = {
    "math": {
        "id": "math",
        "default_title": "数学",
        "default_task_type": "daily_goal",
        "counts_as_study_goal": True,
        "supports_word_count": False,
        "word_label_id": None,
        "sub_categories": [],
        "default_sub_category": None,
        "common_minutes": [90, 180, 240, 300],
        "energy_minutes": {"minimum": 30, "normal": 60, "ample": 90},
        "energy_criteria": {
            "minimum": "完成一个明确知识点或 2 道题",
            "normal": "完成 1 个 35 分钟学习块并整理卡点",
            "ample": "完成两个学习块并记录检查点",
        },
        "default_priority": 1,
        "palette_index": 0,
        "icon_key": "calculator",
    },
    "english": {
        "id": "english",
        "default_title": "英语",
        "default_task_type": "daily_goal",
        "counts_as_study_goal": True,
        "supports_word_count": True,
        "word_label_id": VOCABULARY_WORD_LABEL_ID,
        "sub_categories": [],
        "default_sub_category": None,
        "common_minutes": [15, 30, 45, 60],
        "energy_minutes": {"minimum": 20, "normal": 30, "ample": 45},
        "energy_criteria": {
            "minimum": "完成单词或短阅读一组",
            "normal": "完成当天单词与一段阅读",
            "ample": "完成单词与阅读训练",
        },
        "default_priority": 2,
        "palette_index": 1,
        "icon_key": "languages",
    },
    "computer": {
        "id": "computer",
        "default_title": "408",
        "default_task_type": "daily_goal",
        "counts_as_study_goal": True,
        "supports_word_count": False,
        "word_label_id": None,
        "sub_categories": ["数据结构", "计算机网络", "操作系统", "计算机组成原理"],
        "default_sub_category": "数据结构",
        "common_minutes": [60, 90, 120, 180],
        "energy_minutes": {"minimum": 30, "normal": 50, "ample": 60},
        "energy_criteria": {
            "minimum": "读懂并手写一个小知识点",
            "normal": "完成一个具体章节或代码练习",
            "ample": "学习一个主题并亲手完成代码练习",
        },
        "default_priority": 1,
        "palette_index": 2,
        "icon_key": "cpu",
    },
    "rehab": {
        "id": "rehab",
        "default_title": "运动",
        "default_task_type": "habit",
        "counts_as_study_goal": False,
        "supports_word_count": False,
        "word_label_id": None,
        "sub_categories": [],
        "default_sub_category": None,
        "common_minutes": [15, 30, 45, 60],
        "energy_minutes": {"minimum": 20, "normal": 20, "ample": 20},
        "energy_criteria": {
            "minimum": "完成今天安排的运动",
            "normal": "完成今天安排的运动",
            "ample": "完成今天安排的运动",
        },
        "default_priority": 3,
        "palette_index": 3,
        "icon_key": "activity",
    },
    "ai_project": {
        "id": "ai_project",
        "default_title": "AI 项目",
        "default_task_type": "daily_goal",
        "counts_as_study_goal": True,
        "supports_word_count": False,
        "word_label_id": None,
        "sub_categories": [],
        "default_sub_category": None,
        "common_minutes": [30, 60, 90, 120],
        "default_criteria": "推进一个可验证的小步骤",
        "default_priority": 3,
        "palette_index": 4,
        "icon_key": "code",
    },
    "sleep": {
        "id": "sleep",
        "default_title": "睡眠",
        "default_task_type": "habit",
        "counts_as_study_goal": False,
        "supports_word_count": False,
        "word_label_id": None,
        "sub_categories": [],
        "default_sub_category": None,
        "common_minutes": [15, 30, 45, 60],
        "default_criteria": "按时收尾并保证休息",
        "default_priority": 4,
        "palette_index": 5,
        "icon_key": "moon",
    },
    "vibe_coding": {
        "id": "vibe_coding",
        "default_title": "vibe coding",
        "default_task_type": "daily_goal",
        "counts_as_study_goal": True,
        "supports_word_count": False,
        "word_label_id": None,
        "sub_categories": [],
        "default_sub_category": None,
        "common_minutes": [30, 60, 90, 120],
        "default_criteria": "做自己想用的小工具，读懂代码",
        "default_priority": 4,
        "palette_index": 4,
        "icon_key": "code",
    },
    "algorithm": {
        "id": "algorithm",
        "default_title": "算法",
        "default_task_type": "daily_goal",
        "counts_as_study_goal": True,
        "supports_word_count": False,
        "word_label_id": None,
        "sub_categories": [],
        "default_sub_category": None,
        "common_minutes": [30, 45, 60, 90],
        "default_criteria": "刷算法题，重在理解思路",
        "default_priority": 4,
        "palette_index": 2,
        "icon_key": "git-branch",
    },
    "reading": {
        "id": "reading",
        "default_title": "阅读",
        "default_task_type": "daily_goal",
        "counts_as_study_goal": True,
        "supports_word_count": False,
        "word_label_id": None,
        "sub_categories": [],
        "default_sub_category": None,
        "common_minutes": [20, 30, 45, 60],
        "default_criteria": "阅读书籍/文章，做一些积累",
        "default_priority": 5,
        "palette_index": 5,
        "icon_key": "book",
    },
    "writing": {
        "id": "writing",
        "default_title": "练字",
        "default_task_type": "daily_goal",
        "counts_as_study_goal": True,
        "supports_word_count": False,
        "word_label_id": None,
        "sub_categories": ["中文", "英文"],
        "default_sub_category": "中文",
        "common_minutes": [15, 20, 30, 45],
        "default_criteria": "每天练字，静心提神",
        "default_priority": 5,
        "palette_index": 3,
        "icon_key": "pen",
    },
}

DEFAULT_TASK_TITLES: dict[str, str] = {
    key: meta["default_title"] for key, meta in CATEGORY_DEFINITIONS.items()
}

DEFAULT_DRAFT_MAIN_MINUTES_BY_CATEGORY: dict[str, int] = {
    key: 0 for key in DEFAULT_MAIN_CATEGORIES
}

DEFAULT_EXECUTION_LABELS: list[dict[str, Any]] = [
    {"id": "counted_toilet", "name": "上厕所", "bucket": "counted", "is_system": True},
    {"id": "counted_walk", "name": "走动", "bucket": "counted", "is_system": True},
    {"id": "counted_game", "name": "打游戏", "bucket": "counted", "is_system": True},
    {"id": "interrupt_meal", "name": "吃饭", "bucket": "interrupt", "is_system": True},
    {"id": "interrupt_incident", "name": "突发", "bucket": "interrupt", "is_system": True},
    {"id": "interrupt_pause", "name": "手动暂停", "bucket": "interrupt", "is_system": True},
]

DEFAULT_EFFECTIVE_LABELS_BY_CATEGORY: dict[str, list[dict[str, Any]]] = {
    "math": [
        {"id": "effective_math_course", "name": "网课", "is_system": True},
        {"id": "effective_math_practice", "name": "刷题", "is_system": True},
    ],
    "english": [
        {"id": "effective_english_reading", "name": "阅读", "is_system": True},
        {"id": VOCABULARY_WORD_LABEL_ID, "name": "单词", "is_system": True},
    ],
}

QUICK_CORRECTION_BUILTINS: dict[str, dict[str, str]] = {
    "quick_distraction": {"id": "quick_distraction", "name": "分心", "time_category": "distraction"},
    "quick_life": {"id": "quick_life", "name": "其他生活", "time_category": "life"},
}

DEFAULT_CORRECTION_SHORTCUTS: list[dict[str, Any]] = [
    {"id": "meal_30", "label_id": "interrupt_meal", "minutes": 30},
    {"id": "distraction_5", "label_id": "quick_distraction", "minutes": 5},
]


def get_category_meta(category: str, custom_titles: dict[str, str] | None = None) -> dict[str, Any]:
    base = CATEGORY_DEFINITIONS.get(category)
    if base is not None:
        result = dict(base)
        if custom_titles and category in custom_titles:
            result["title"] = custom_titles[category]
        else:
            result["title"] = base["default_title"]
        return result
    title = (custom_titles or {}).get(category) or "自定义项目"
    return {
        "id": category,
        "title": title,
        "default_title": title,
        "default_task_type": "daily_goal",
        "counts_as_study_goal": True,
        "supports_word_count": False,
        "word_label_id": None,
        "sub_categories": [],
        "default_sub_category": None,
        "common_minutes": [30, 60, 90, 120],
        "default_criteria": "完成今天设定的目标",
        "default_priority": 3,
        "palette_index": None,
        "icon_key": "bookmark",
    }


def default_task_type_for(category: str) -> str:
    return str(get_category_meta(category)["default_task_type"])


def counts_as_study_goal(category: str) -> bool:
    return bool(get_category_meta(category)["counts_as_study_goal"])


def is_vocabulary_word_segment(category: str, label_id: str | None, segment_kind: str = "effective") -> bool:
    if segment_kind != "effective" or not label_id:
        return False
    meta = get_category_meta(category)
    return bool(meta.get("supports_word_count")) and label_id == meta.get("word_label_id")


def serialize_category_catalog(settings: dict[str, Any]) -> dict[str, dict[str, Any]]:
    titles = settings.get("task_titles") or DEFAULT_TASK_TITLES
    keys = list(CATEGORY_DEFINITIONS.keys())
    for key in (settings.get("main_project_categories") or []):
        if key not in keys:
            keys.append(key)
    for key in titles:
        if key not in keys:
            keys.append(key)
    catalog: dict[str, dict[str, Any]] = {}
    for key in keys:
        meta = get_category_meta(key, titles)
        catalog[key] = {
            "id": key,
            "title": meta["title"],
            "default_title": meta["default_title"],
            "default_task_type": meta["default_task_type"],
            "counts_as_study_goal": meta["counts_as_study_goal"],
            "supports_word_count": meta["supports_word_count"],
            "word_label_id": meta["word_label_id"],
            "sub_categories": list(meta["sub_categories"]),
            "default_sub_category": meta["default_sub_category"],
            "common_minutes": list(meta["common_minutes"]),
            "palette_index": meta["palette_index"],
            "icon_key": meta["icon_key"],
        }
    return catalog
