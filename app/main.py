from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, quote

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

from .api import router
from .auth import build_auth_settings, verify_password
from .database import connect, initialize
from .services.ai_planner import AIPlanner
from .services.clock import today_iso
from .services.pwa import asset_version, manifest
from .services.reminders import NtfySender, run_reminders
from .services.review_engine import resolve_return_today_url
from .services.weekly_review_analyzer import WeeklyReviewAnalyzer

BASE_DIR = Path(__file__).resolve().parent
AUTH_EXEMPT_PATHS = ("/login", "/manifest.webmanifest", "/sw.js", "/offline", "/favicon.ico")
CACHE_EXEMPT_PATHS = ("/manifest.webmanifest", "/sw.js", "/offline", "/favicon.ico")


def _int_from_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _safe_static_version(static_dir: Path, filename: str) -> int:
    try:
        return int((static_dir / filename).stat().st_mtime)
    except OSError:
        return 0


def create_app(
    database_path: str | Path | None = None,
    disable_ai: bool = False,
    backup_dir: str | Path | None = None,
    runtime_mode: str | None = None,
    auth_password_hash: str | None = None,
    session_secret: str | None = None,
    disable_notifications: bool | None = None,
) -> FastAPI:
    if database_path is None and runtime_mode is None:
        load_dotenv()

    @asynccontextmanager
    async def lifespan(application):
        worker = asyncio.create_task(run_reminders(application))
        try:
            yield
        finally:
            worker.cancel()
            with suppress(asyncio.CancelledError):
                await worker

    app = FastAPI(title="今日航线", version="0.2.0", lifespan=lifespan)
    resolved_mode = runtime_mode or os.getenv("APP_RUNTIME", "development")
    app.state.runtime_mode = resolved_mode
    if disable_notifications is None:
        effective_disable_notifications = database_path is not None and resolved_mode != "production"
    else:
        effective_disable_notifications = disable_notifications
    app.state.reminder_sender = None if effective_disable_notifications else NtfySender.from_environment()
    app.state.database_path = Path(database_path or os.getenv("DATABASE_PATH", "data/daily_plan.db"))
    app.state.backup_dir = Path(
        backup_dir or os.getenv("DAILY_PLAN_BACKUP_DIR", app.state.database_path.parent / "backups")
    )
    app.state.backup_retention_days = _int_from_env("DAILY_PLAN_BACKUP_RETENTION_DAYS", 14)
    app.state.auth = build_auth_settings(
        resolved_mode,
        auth_password_hash if auth_password_hash is not None else os.getenv("APP_AUTH_PASSWORD_HASH"),
        session_secret if session_secret is not None else os.getenv("APP_SESSION_SECRET"),
    )
    initialize(app.state.database_path)

    app.state.ai_planner = None
    app.state.weekly_review_analyzer = None
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not disable_ai and api_key:
        base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1")
        model_name = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
        timeout_sec = float(os.getenv("DEEPSEEK_TIMEOUT", "20"))
        app.state.ai_planner = AIPlanner(base_url, api_key, model_name, timeout_sec)
        app.state.weekly_review_analyzer = WeeklyReviewAnalyzer(base_url, api_key, model_name, timeout_sec)

    app.include_router(router)
    templates_dir = BASE_DIR / "templates"
    static_dir = BASE_DIR / "static"
    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    templates = Jinja2Templates(directory=templates_dir)
    templates.env.globals["static_version"] = lambda filename: _safe_static_version(static_dir, filename)

    @app.get("/manifest.webmanifest")
    def pwa_manifest():
        return JSONResponse(
            manifest(),
            media_type="application/manifest+json",
            headers={"Cache-Control": "no-cache"},
        )

    @app.get("/sw.js")
    def pwa_worker():
        version = asset_version(static_dir)
        source = (static_dir / "pwa/sw.js").read_text(encoding="utf-8").replace("__PWA_VERSION__", version)
        return Response(
            source,
            media_type="application/javascript",
            headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
        )

    @app.get("/offline")
    def pwa_offline():
        return FileResponse(
            static_dir / "pwa/offline.html",
            media_type="text/html",
            headers={"Cache-Control": "no-cache"},
        )

    @app.get("/favicon.ico")
    def favicon():
        return FileResponse(static_dir / "pwa/favicon.ico", media_type="image/x-icon")

    def safe_next_path(value: str | None) -> str:
        if value and value.startswith("/") and not value.startswith("//") and not value.startswith("/login"):
            return value
        return "/"

    @app.middleware("http")
    async def require_authentication(request: Request, call_next):
        if (
            not app.state.auth.required
            or request.url.path in AUTH_EXEMPT_PATHS
            or request.url.path.startswith("/static/")
        ):
            return await call_next(request)
        if request.session.get("authenticated") is True:
            return await call_next(request)
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": "需要登录"}, status_code=401)
        next_path = request.url.path
        if request.url.query:
            next_path = f"{next_path}?{request.url.query}"
        return RedirectResponse(url=f"/login?next={quote(next_path, safe='/?=&')}", status_code=303)

    @app.middleware("http")
    async def prevent_private_caching(request: Request, call_next):
        response = await call_next(request)
        if request.url.path not in CACHE_EXEMPT_PATHS and not request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response

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

    @app.get("/return-today")
    def return_today():
        with connect(app.state.database_path) as connection:
            return RedirectResponse(resolve_return_today_url(connection), status_code=303)

    @app.get("/execute", response_class=HTMLResponse)
    def execute_page(request: Request):
        today = today_iso()
        requested = request.query_params.get("date")
        if requested:
            try:
                parsed = datetime.strptime(requested, "%Y-%m-%d").date()
                if parsed.isoformat() != requested:
                    raise ValueError("非标准日期")
            except ValueError:
                raise HTTPException(422, "日期格式应为YYYY-MM-DD且为有效日期")
        if requested and requested != today:
            return templates.TemplateResponse(
                request,
                "execution_history.html",
                {
                    "execution_date": requested,
                    "records_only": True,
                    "inline_records": True,
                    "is_past": requested < today,
                },
            )
        return templates.TemplateResponse(request, "execute.html", {"execution_date": today})

    @app.get("/weekly", response_class=HTMLResponse)
    def weekly_page(request: Request):
        anchor = (
            request.query_params.get("anchor_date")
            or request.query_params.get("date")
            or request.query_params.get("end_date")
        )
        target = "/review?scope=weekly"
        if anchor:
            target += "&date=" + quote(anchor, safe="")
        return RedirectResponse(target, status_code=303)

    @app.get("/gpt-workbench", response_class=HTMLResponse)
    def gpt_workbench_page(request: Request):
        return templates.TemplateResponse(request, "gpt_workbench.html", {})

    @app.get("/settings", response_class=HTMLResponse)
    def settings_page(request: Request):
        return templates.TemplateResponse(request, "settings.html", {})

    return app


def __getattr__(name: str):
    if name == "app":
        application = create_app()
        globals()["app"] = application
        return application
    raise AttributeError(name)
