from pathlib import Path

from fastapi.testclient import TestClient

from app import preview


def test_preview_uses_isolated_data_even_with_production_environment(tmp_path, monkeypatch):
    monkeypatch.setattr(preview, "ROOT", tmp_path)
    production = tmp_path / "real.db"
    production.write_bytes(b"do not touch")
    monkeypatch.setenv("DATABASE_PATH", str(production))
    monkeypatch.setenv("APP_RUNTIME", "production")
    monkeypatch.setenv("DAILY_PLAN_BACKUP_DIR", str(tmp_path / "real-backups"))
    app = preview.create_preview_app()
    assert app.state.database_path == tmp_path / "data" / "ui-preview.db"
    assert app.state.backup_dir == tmp_path / "data" / "ui-preview-backups"
    assert not app.state.auth.required
    assert app.state.ai_planner is None
    assert app.state.weekly_review_analyzer is None
    assert production.read_bytes() == b"do not touch"
    with TestClient(app) as client:
        assert "UI 预览 · 独立测试数据" in client.get("/").text
