from pathlib import Path

from app.launcher import wait_and_open


def test_windows_launcher_contains_required_safety_and_startup_steps():
    launcher = Path(__file__).parents[1] / "启动今日航线.cmd"
    content = launcher.read_text(encoding="utf-8")

    assert 'cd /d "%~dp0"' in content
    assert 'if /I "%~1"=="--check"' in content
    assert "-m uvicorn app.main:app" in content
    assert "-m app.launcher" in content
    assert "http://127.0.0.1:8000" in content


def test_browser_opens_only_after_service_is_ready(monkeypatch):
    attempts = []
    opened = []

    def fake_urlopen(_url, timeout):
        attempts.append(timeout)
        if len(attempts) < 2:
            raise OSError("not ready")
        return object()

    monkeypatch.setattr("app.launcher.urlopen", fake_urlopen)
    monkeypatch.setattr("app.launcher.webbrowser.open", opened.append)
    monkeypatch.setattr("app.launcher.time.sleep", lambda _delay: None)

    assert wait_and_open("http://127.0.0.1:8000", attempts=3) is True
    assert len(attempts) == 2
    assert opened == ["http://127.0.0.1:8000"]


def test_termux_scripts_contain_minimal_mobile_startup_flow():
    install_script = (Path(__file__).parents[1] / "termux-install.sh").read_text(encoding="utf-8")
    start_script = (Path(__file__).parents[1] / "termux-start.sh").read_text(encoding="utf-8")

    assert "pkg install -y python git" in install_script
    assert 'python -m pip install -e ".[dev]"' in install_script
    assert "python -m uvicorn app.main:app" in start_script
    assert 'HOST="${HOST:-127.0.0.1}"' in start_script
    assert 'PORT="${PORT:-8000}"' in start_script
    assert 'termux-open-url "${APP_URL}"' in start_script
