SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_date TEXT NOT NULL UNIQUE,
    energy TEXT NOT NULL,
    available_minutes INTEGER NOT NULL,
    day_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    methods_json TEXT NOT NULL DEFAULT '[]',
    safety_notice TEXT,
    degraded_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    estimated_minutes INTEGER NOT NULL,
    actual_minutes INTEGER,
    priority INTEGER NOT NULL,
    completion_criteria TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'rule',
    position INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    sub_category TEXT,
    is_sub INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS carryovers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    estimated_minutes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    resolution TEXT,
    target_date TEXT,
    split_title TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reviews (
    review_date TEXT PRIMARY KEY,
    distraction TEXT NOT NULL DEFAULT '',
    mood TEXT NOT NULL DEFAULT '',
    hardest_point TEXT NOT NULL DEFAULT '',
    effective_method TEXT NOT NULL,
    optimization_note TEXT NOT NULL DEFAULT '',
    real_progress TEXT NOT NULL DEFAULT '',
    tomorrow_focus TEXT NOT NULL,
    reflection_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS weekly_reports (
    end_date TEXT PRIMARY KEY,
    start_date TEXT NOT NULL,
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    snapshot_hash TEXT NOT NULL DEFAULT '',
    deepseek_analysis_json TEXT,
    chatgpt_prompt_text TEXT NOT NULL DEFAULT '',
    final_report_text TEXT NOT NULL DEFAULT '',
    ai_status TEXT NOT NULL DEFAULT 'idle',
    ai_error TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS gpt_collab_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_type TEXT NOT NULL,
    anchor_key TEXT NOT NULL,
    date_label TEXT NOT NULL DEFAULT '',
    prompt_text TEXT NOT NULL DEFAULT '',
    response_text TEXT NOT NULL DEFAULT '',
    adopted_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(record_type, anchor_key)
);
CREATE TABLE IF NOT EXISTS task_execution_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_date TEXT NOT NULL,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    segment_kind TEXT NOT NULL,
    label_id TEXT,
    label_name TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_execution_segments_plan_date ON task_execution_segments(plan_date);
CREATE INDEX IF NOT EXISTS idx_execution_segments_task_id ON task_execution_segments(task_id);
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""
