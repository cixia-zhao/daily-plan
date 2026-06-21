from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .api import router
from .database import initialize
from .services.ai_planner import AIPlanner


BASE_DIR = Path(__file__).resolve().parent


def create_app(database_path: str | Path | None = None, disable_ai: bool = False) -> FastAPI:
    load_dotenv()
    app = FastAPI(title="每日任务", version="0.1.0")
    app.state.database_path = Path(database_path or os.getenv("DATABASE_PATH", "data/daily_plan.db"))
    initialize(app.state.database_path)
    app.state.ai_planner = None
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not disable_ai and api_key:
        app.state.ai_planner = AIPlanner(
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

    @app.get("/", response_class=HTMLResponse)
    def today_page(request: Request):
        return templates.TemplateResponse(request, "index.html", {})

    @app.get("/weekly", response_class=HTMLResponse)
    def weekly_page(request: Request):
        return templates.TemplateResponse(request, "weekly.html", {})

    @app.get("/settings", response_class=HTMLResponse)
    def settings_page(request: Request):
        return templates.TemplateResponse(request, "settings.html", {"ai_enabled": app.state.ai_planner is not None})

    return app


app = create_app()
