"""设置管理、有效细分标签 CRUD、系统健康与数据库备份导出路由。"""
from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from app.backup_utils import create_sqlite_backup, prune_old_backups
from app.routers.deps import begin_immediate, db_session
from app.schemas import Category, EffectiveLabelNameInput, SettingsInput
from app.services.reminders import notification_status
from app.services.settings_store import (
    assert_unique_effective_name,
    get_settings,
    save_settings_record,
    store_effective_label_settings,
)

router = APIRouter()


@router.get("/settings")
def read_settings(request: Request):
    with db_session(request) as connection:
        return get_settings(connection)


@router.put("/settings")
def update_settings(payload: SettingsInput, request: Request):
    with db_session(request) as connection:
        begin_immediate(connection)
        return save_settings_record(connection, payload)


@router.post("/settings/effective-labels/{category}", status_code=201)
def create_effective_label(category: Category, payload: EffectiveLabelNameInput, request: Request):
    with db_session(request) as connection:
        begin_immediate(connection)
        settings = get_settings(connection)
        labels = settings["effective_labels_by_category"].setdefault(category, [])
        assert_unique_effective_name(labels, payload.name)
        labels.append({"id": f"effective_{category}_{uuid4().hex}", "name": payload.name, "is_system": False})
        return store_effective_label_settings(connection, settings)


@router.patch("/settings/effective-labels/{category}/{label_id}")
def rename_effective_label(category: Category, label_id: str, payload: EffectiveLabelNameInput, request: Request):
    with db_session(request) as connection:
        begin_immediate(connection)
        settings = get_settings(connection)
        labels = settings["effective_labels_by_category"].get(category, [])
        label = next((item for item in labels if item["id"] == label_id), None)
        if label is None:
            raise HTTPException(404, "有效细分标签不存在，请刷新后重试")
        assert_unique_effective_name(labels, payload.name, label_id)
        label["name"] = payload.name
        return store_effective_label_settings(connection, settings)


@router.delete("/settings/effective-labels/{category}/{label_id}")
def delete_effective_label(category: Category, label_id: str, request: Request):
    with db_session(request) as connection:
        begin_immediate(connection)
        settings = get_settings(connection)
        labels = settings["effective_labels_by_category"].get(category, [])
        if not any(item["id"] == label_id for item in labels):
            raise HTTPException(404, "有效细分标签不存在，请刷新后重试")
        settings["effective_labels_by_category"][category] = [item for item in labels if item["id"] != label_id]
        deleted = settings.setdefault("deleted_effective_label_ids", {}).setdefault(category, [])
        if label_id not in deleted:
            deleted.append(label_id)
        return store_effective_label_settings(connection, settings)


@router.get("/system/health")
def system_health(request: Request):
    with db_session(request) as connection:
        connection.execute("SELECT 1").fetchone()
    return {
        "status": "ok",
        "mode": getattr(request.app.state, "runtime_mode", "development"),
        "database_path": str(request.app.state.database_path),
        "backup_dir": str(request.app.state.backup_dir),
        "backup_retention_days": int(getattr(request.app.state, "backup_retention_days", 14)),
        "ai_enabled": bool(getattr(request.app.state, "ai_planner", None)),
    }


@router.get("/system/backup-export")
def export_backup(request: Request):
    backup_dir = request.app.state.backup_dir
    backup_path = create_sqlite_backup(request.app.state.database_path, backup_dir)
    prune_old_backups(backup_dir, int(getattr(request.app.state, "backup_retention_days", 14)))
    return FileResponse(
        path=backup_path,
        media_type="application/octet-stream",
        filename=backup_path.name,
    )


@router.get("/notifications/status")
def get_notification_status(request: Request):
    return notification_status(request.app)
