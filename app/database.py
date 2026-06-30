from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .models import SCHEMA


def initialize(path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.executescript(SCHEMA)
        cursor = connection.cursor()
        cursor.execute("PRAGMA table_info(tasks)")
        columns = [row[1] for row in cursor.fetchall()]
        if "sub_category" not in columns:
            cursor.execute("ALTER TABLE tasks ADD COLUMN sub_category TEXT")
        if "is_sub" not in columns:
            cursor.execute("ALTER TABLE tasks ADD COLUMN is_sub INTEGER DEFAULT 0")
        cursor.execute("PRAGMA table_info(reviews)")
        review_columns = [row[1] for row in cursor.fetchall()]
        for name, ddl in [
            ("mood", "ALTER TABLE reviews ADD COLUMN mood TEXT NOT NULL DEFAULT ''"),
            ("hardest_point", "ALTER TABLE reviews ADD COLUMN hardest_point TEXT NOT NULL DEFAULT ''"),
            ("optimization_note", "ALTER TABLE reviews ADD COLUMN optimization_note TEXT NOT NULL DEFAULT ''"),
            ("real_progress", "ALTER TABLE reviews ADD COLUMN real_progress TEXT NOT NULL DEFAULT ''"),
            ("reflection_text", "ALTER TABLE reviews ADD COLUMN reflection_text TEXT NOT NULL DEFAULT ''"),
        ]:
            if name not in review_columns:
                cursor.execute(ddl)
        cursor.execute("PRAGMA table_info(gpt_collab_records)")
        gpt_columns = [row[1] for row in cursor.fetchall()]
        if gpt_columns:
            for name, ddl in [
                ("date_label", "ALTER TABLE gpt_collab_records ADD COLUMN date_label TEXT NOT NULL DEFAULT ''"),
                ("prompt_text", "ALTER TABLE gpt_collab_records ADD COLUMN prompt_text TEXT NOT NULL DEFAULT ''"),
                ("response_text", "ALTER TABLE gpt_collab_records ADD COLUMN response_text TEXT NOT NULL DEFAULT ''"),
                ("adopted_text", "ALTER TABLE gpt_collab_records ADD COLUMN adopted_text TEXT NOT NULL DEFAULT ''"),
                ("created_at", "ALTER TABLE gpt_collab_records ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"),
                ("updated_at", "ALTER TABLE gpt_collab_records ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"),
            ]:
                if name not in gpt_columns:
                    cursor.execute(ddl)
        cursor.execute(
            """CREATE TABLE IF NOT EXISTS task_execution_segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                plan_date TEXT NOT NULL,
                task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                segment_kind TEXT NOT NULL,
                label_id TEXT,
                label_name TEXT,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )"""
        )
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_execution_segments_plan_date ON task_execution_segments(plan_date)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_execution_segments_task_id ON task_execution_segments(task_id)")


@contextmanager
def connect(path: str | Path):
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
