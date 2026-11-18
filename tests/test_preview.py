from pathlib import Path
import json

from fastapi.testclient import TestClient

from app import preview


def test_lan_address_prefers_default_route_source_over_vpn(monkeypatch):
    monkeypatch.setattr(preview.subprocess, "check_output", lambda *args, **kwargs: json.dumps([
        {"gateway": "10.0.0.1", "prefsrc": "10.0.0.22", "metric": 600},
        {"gateway": "10.1.0.1", "prefsrc": "10.1.0.22", "metric": 700},
    ]))
    assert preview.lan_address() == "10.0.0.22"


def test_lan_address_probes_local_gateway_when_route_has_no_source(monkeypatch):
    monkeypatch.setattr(preview.subprocess, "check_output", lambda *args, **kwargs: '[{"gateway":"10.0.0.1"}]')
    class ProbeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def connect(self, address):
            assert address == ("10.0.0.1", 80)

        def getsockname(self):
            return ("10.0.0.22", 12345)

    monkeypatch.setattr(preview.socket, "socket", lambda *args: ProbeSocket())
    assert preview.lan_address() == "10.0.0.22"


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
