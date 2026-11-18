from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .models import SCHEMA

_COLUMN_MIGRATIONS: dict[str, tuple[tuple[str, str], ...]] = {
    "tasks": (
        ("sub_category", "TEXT"),
        ("is_sub", "INTEGER DEFAULT 0"),
        ("completion_override", "INTEGER"),
        ("task_type", "TEXT"),
        ("habit_status", "TEXT"),
        ("legacy_actual_minutes", "INTEGER"),
    ),
    "task_execution_segments": (
        ("time_category", "TEXT"),
        ("included", "INTEGER NOT NULL DEFAULT 1"),
        ("is_estimated", "INTEGER NOT NULL DEFAULT 0"),
        ("auto_stop_at", "TEXT"),
        ("stopped_automatically", "INTEGER NOT NULL DEFAULT 0"),
    ),
    "execution_quick_corrections": (
        ("request_json", "TEXT"),
        ("original_state_json", "TEXT"),
    ),
    "reviews": (
        ("mood", "TEXT NOT NULL DEFAULT ''"),
        ("hardest_point", "TEXT NOT NULL DEFAULT ''"),
        ("optimization_note", "TEXT NOT NULL DEFAULT ''"),
        ("real_progress", "TEXT NOT NULL DEFAULT ''"),
        ("reflection_text", "TEXT NOT NULL DEFAULT ''"),
        ("learning_outcome", "TEXT NOT NULL DEFAULT ''"),
    ),
    "gpt_collab_records": (
        ("date_label", "TEXT NOT NULL DEFAULT ''"),
        ("prompt_text", "TEXT NOT NULL DEFAULT ''"),
        ("response_text", "TEXT NOT NULL DEFAULT ''"),
        ("adopted_text", "TEXT NOT NULL DEFAULT ''"),
        ("created_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"),
        ("updated_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"),
    ),
}


def initialize(path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path, timeout=15.0) as connection:
        connection.execute("PRAGMA busy_timeout = 5000")
        cursor = connection.cursor()
        # 先对已存在的历史表补齐列，再统一创建表与索引（包含依赖新列的局部索引）。
        existing_tables = {
            row[0]
            for row in cursor.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        for table, additions in _COLUMN_MIGRATIONS.items():
            if table not in existing_tables:
                continue
            columns = {row[1] for row in cursor.execute(f'PRAGMA table_info("{table}")').fetchall()}
            for name, ddl_suffix in additions:
                if name not in columns:
                    cursor.execute(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {ddl_suffix}')
        connection.executescript(SCHEMA)


@contextmanager
def connect(path: str | Path):
    connection = sqlite3.connect(path, timeout=15.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
