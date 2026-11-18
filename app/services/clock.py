"""统一时间与时区基础设施（默认中国标准时间 Asia/Shanghai）。"""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

APP_TIMEZONE = ZoneInfo(os.getenv("DAILY_PLAN_TIMEZONE", "Asia/Shanghai"))


def now_local() -> datetime:
    return datetime.now(APP_TIMEZONE)


def today_date() -> date:
    api_mod = sys.modules.get("app.api")
    if api_mod is not None:
        patched_date = getattr(api_mod, "date", None)
        if patched_date is not None and patched_date is not date:
            return patched_date.today()
    return now_local().date()


def today_iso() -> str:
    return today_date().isoformat()


def default_now_iso() -> str:
    return now_local().replace(tzinfo=None, microsecond=0).isoformat()


def now_iso() -> str:
    api_mod = sys.modules.get("app.api")
    if api_mod is not None:
        hook = getattr(api_mod, "_now_iso", None)
        if callable(hook) and hook is not now_iso:
            return hook()
    return default_now_iso()


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=APP_TIMEZONE)
    return parsed


def local_iso(value: datetime) -> str:
    parsed = parse_iso_datetime(value.replace(microsecond=0).isoformat())
    assert parsed is not None
    return parsed.astimezone(APP_TIMEZONE).replace(tzinfo=None).isoformat()


def seconds_between(started_at: str, ended_at: str | None = None, *, reference_now: str | None = None) -> int:
    start = parse_iso_datetime(started_at)
    end = parse_iso_datetime(ended_at or reference_now or now_iso())
    if start is None or end is None:
        return 0
    return max(0, int((end - start).total_seconds()))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds")
