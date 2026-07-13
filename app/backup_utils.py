from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path


BACKUP_PREFIX = "daily_plan"


def parse_retention_days(value: str | int | None, default: int = 14) -> int:
    try:
        return max(1, int(value or default))
    except (TypeError, ValueError):
        return default


def resolve_backup_dir(database_path: str | Path, backup_dir: str | Path | None = None) -> Path:
    if backup_dir:
        return Path(backup_dir)
    env_value = os.getenv("DAILY_PLAN_BACKUP_DIR")
    if env_value:
        return Path(env_value)
    return Path(database_path).parent / "backups"


def backup_filename(now: datetime | None = None) -> str:
    current = now or datetime.now()
    return f"{BACKUP_PREFIX}-{current.strftime('%Y-%m-%d-%H%M%S')}.db"


def create_sqlite_backup(
    database_path: str | Path,
    backup_dir: str | Path | None = None,
    now: datetime | None = None,
) -> Path:
    source_path = Path(database_path)
    target_dir = resolve_backup_dir(source_path, backup_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / backup_filename(now)

    with sqlite3.connect(source_path) as source_connection:
        with sqlite3.connect(target_path) as destination_connection:
            source_connection.backup(destination_connection)

    return target_path


def list_backup_files(backup_dir: str | Path) -> list[Path]:
    directory = Path(backup_dir)
    if not directory.exists():
        return []
    return sorted(
        [path for path in directory.iterdir() if path.is_file() and path.name.startswith(f"{BACKUP_PREFIX}-") and path.suffix == ".db"],
        key=lambda path: path.name,
    )


def prune_old_backups(
    backup_dir: str | Path,
    retention_days: int,
    now: datetime | None = None,
) -> list[Path]:
    cutoff = (now or datetime.now()) - timedelta(days=max(1, retention_days))
    removed: list[Path] = []
    for path in list_backup_files(backup_dir):
        timestamp = parse_backup_timestamp(path.name)
        if timestamp and timestamp < cutoff:
            path.unlink(missing_ok=True)
            removed.append(path)
    return removed


def parse_backup_timestamp(filename: str) -> datetime | None:
    if not filename.startswith(f"{BACKUP_PREFIX}-") or not filename.endswith(".db"):
        return None
    raw = filename[len(BACKUP_PREFIX) + 1 : -3]
    try:
        return datetime.strptime(raw, "%Y-%m-%d-%H%M%S")
    except ValueError:
        return None
