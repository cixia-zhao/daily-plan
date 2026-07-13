from __future__ import annotations

import argparse
import os
from pathlib import Path

from .backup_utils import create_sqlite_backup, parse_retention_days, prune_old_backups, resolve_backup_dir


def main() -> int:
    parser = argparse.ArgumentParser(description="Create and prune Daily Plan SQLite backups.")
    parser.add_argument(
        "--database-path",
        default=os.getenv("DATABASE_PATH", "data/daily_plan.db"),
        help="Path to the main SQLite database.",
    )
    parser.add_argument(
        "--backup-dir",
        default=os.getenv("DAILY_PLAN_BACKUP_DIR"),
        help="Directory to store backup snapshots.",
    )
    parser.add_argument(
        "--retention-days",
        type=int,
        default=parse_retention_days(os.getenv("DAILY_PLAN_BACKUP_RETENTION_DAYS", "14")),
        help="How many days of backup history to keep.",
    )
    parser.add_argument(
        "--skip-prune",
        action="store_true",
        help="Only create the current backup, do not delete old snapshots.",
    )
    args = parser.parse_args()

    database_path = Path(args.database_path)
    backup_dir = resolve_backup_dir(database_path, args.backup_dir)
    backup_path = create_sqlite_backup(database_path, backup_dir)

    if not args.skip_prune:
        prune_old_backups(backup_dir, parse_retention_days(args.retention_days))

    print(backup_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
