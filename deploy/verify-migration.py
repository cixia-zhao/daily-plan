#!/usr/bin/env python3
"""只迁移备份副本，校验全部原字段／记录保持；不改源库。"""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.database import initialize


def snapshot(path):
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        result = {}
        for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            columns = [r[1] for r in db.execute(f'PRAGMA table_info("{table}")')]
            rows = db.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
            result[table] = (columns, rows)
        return result


def verify(source, target):
    source, target = Path(source).resolve(), Path(target).resolve()
    if source == target or target.exists():
        raise ValueError('副本必须是不存在的新路径，不能覆盖源库或已有文件')
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
    before = snapshot(target)
    for _ in range(2):
        initialize(target)
        with sqlite3.connect(target) as db:
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            assert db.execute('PRAGMA foreign_key_check').fetchall() == []
            for table, (columns, rows) in before.items():
                names = ','.join(f'"{column}"' for column in columns)
                assert db.execute(f'SELECT {names} FROM "{table}" ORDER BY rowid').fetchall() == rows, f'{table}原记录变化'
            for table in set(snapshot(target)) - set(before):
                assert db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] == 0, f'{table}新增表不为空'
            if 'is_estimated' not in before.get('task_execution_segments', ([], []))[0]:
                assert db.execute('SELECT COUNT(*) FROM task_execution_segments WHERE is_estimated!=0').fetchone()[0] == 0
    return {'source': str(source), 'validated_copy': str(target), 'migration_runs': 2,
            'old_tables': {table: len(rows) for table, (_, rows) in before.items()},
            'original_data_sha256': hashlib.sha256(repr(before).encode()).hexdigest(),
            'integrity': 'ok', 'foreign_keys': 'ok', 'old_values_unchanged': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('copy')
    args = parser.parse_args()
    print(json.dumps(verify(args.source, args.copy), ensure_ascii=False))
