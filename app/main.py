from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qs, quote

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from .api import router
from .auth import build_auth_settings, verify_password
from .database import initialize
from .services.ai_planner import AIPlanner
from .services.weekly_review_analyzer import WeeklyReviewAnalyzer


BASE_DIR = Path(__file__).resolve().parent


def _int_from_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def create_app(
    database_path: str | Path | None = None,
    disable_ai: bool = False,
    backup_dir: str | Path | None = None,
    runtime_mode: str | None = None,
    auth_password_hash: str | None = None,
    session_secret: str | None = None,
) -> FastAPI:
    load_dotenv()
    app = FastAPI(title="每日任务", version="0.1.0")
    app.state.database_path = Path(database_path or os.getenv("DATABASE_PATH", "data/daily_plan.db"))
    app.state.backup_dir = Path(backup_dir or os.getenv("DAILY_PLAN_BACKUP_DIR", app.state.database_path.parent / "backups"))
    app.state.backup_retention_days = _int_from_env("DAILY_PLAN_BACKUP_RETENTION_DAYS", 14)
    app.state.runtime_mode = runtime_mode or os.getenv("APP_RUNTIME", "development")
    app.state.auth = build_auth_settings(
        app.state.runtime_mode,
        auth_password_hash if auth_password_hash is not None else os.getenv("APP_AUTH_PASSWORD_HASH"),
        session_secret if session_secret is not None else os.getenv("APP_SESSION_SECRET"),
    )
    initialize(app.state.database_path)
    app.state.ai_planner = None
    app.state.weekly_review_analyzer = None
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not disable_ai and api_key:
        app.state.ai_planner = AIPlanner(
            os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
            api_key,
            os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
            float(os.getenv("DEEPSEEK_TIMEOUT", "20")),
        )
        app.state.weekly_review_analyzer = WeeklyReviewAnalyzer(
            os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
            api_key,
            os.getenv("DEEPSEEK_MODEL", "deepseek-chat"),
            float(os.getenv("DEEPSEEK_TIMEOUT", "20")),
        )
    app.include_router(router)
    templates_dir = BASE_DIR / "templates"
    static_dir = BASE_DIR / "static"
    templates_dir.mkdir(exist_ok=True)
    static_dir.mkdir(exist_ok=True)
    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    templates = Jinja2Templates(directory=templates_dir)
    templates.env.globals["static_version"] = lambda filename: int((static_dir / filename).stat().st_mtime)

    def safe_next_path(value: str | None) -> str:
        if value and value.startswith("/") and not value.startswith("//") and not value.startswith("/login"):
            return value
        return "/"

    @app.middleware("http")
    async def require_authentication(request: Request, call_next):
        if not app.state.auth.required or request.url.path == "/login" or request.url.path.startswith("/static/"):
            return await call_next(request)
        if request.session.get("authenticated") is True:
            return await call_next(request)
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": "需要登录"}, status_code=401)
        next_path = request.url.path
        if request.url.query:
            next_path = f"{next_path}?{request.url.query}"
        return RedirectResponse(url=f"/login?next={quote(next_path, safe='/?=&')}", status_code=303)

    app.add_middleware(
        SessionMiddleware,
        secret_key=app.state.auth.session_secret,
        session_cookie="daily_plan_session",
        max_age=app.state.auth.session_max_age,
        same_site="strict",
        https_only=app.state.auth.required,
    )

    @app.get("/login", response_class=HTMLResponse)
    def login_page(request: Request, next: str | None = None):
        if app.state.auth.required and request.session.get("authenticated") is True:
            return RedirectResponse(url=safe_next_path(next), status_code=303)
        return templates.TemplateResponse(request, "login.html", {"next_path": safe_next_path(next), "error": None})

    @app.post("/login", response_class=HTMLResponse)
    async def login(request: Request):
        if not app.state.auth.required:
            return RedirectResponse(url="/", status_code=303)
        form = parse_qs((await request.body()).decode("utf-8", "replace"), keep_blank_values=True)
        next_path = safe_next_path(form.get("next", ["/"])[0])
        password = form.get("password", [""])[0]
        if not verify_password(password, app.state.auth.password_hash or ""):
            return templates.TemplateResponse(
                request,
                "login.html",
                {"next_path": next_path, "error": "访问密码不正确，请重试。"},
                status_code=401,
            )
        request.session.clear()
        request.session["authenticated"] = True
        return RedirectResponse(url=next_path, status_code=303)

    @app.post("/logout")
    def logout(request: Request):
        request.session.clear()
        return RedirectResponse(url="/login", status_code=303)

    @app.get("/", response_class=HTMLResponse)
    def today_page(request: Request):
        return templates.TemplateResponse(request, "index.html", {})

    @app.get("/review", response_class=HTMLResponse)
    def review_page(request: Request):
        return templates.TemplateResponse(request, "review.html", {})

    @app.get("/execute", response_class=HTMLResponse)
    def execute_page(request: Request):
        return templates.TemplateResponse(request, "execute.html", {})

    @app.get("/weekly", response_class=HTMLResponse)
    def weekly_page(request: Request):
        return templates.TemplateResponse(request, "weekly.html", {})

    @app.get("/gpt-workbench", response_class=HTMLResponse)
    def gpt_workbench_page(request: Request):
        return templates.TemplateResponse(request, "gpt_workbench.html", {})

    @app.get("/settings", response_class=HTMLResponse)
    def settings_page(request: Request):
        return templates.TemplateResponse(request, "settings.html", {})

    return app


app = create_app()
