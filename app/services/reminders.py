"""持久化到点提醒：网页关闭不影响调度；发送不改变计时。"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException

from ..database import connect
from .clock import utc_iso as iso
from .clock import utc_now

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class NtfySender:
    base_url: str
    topic: str
    token: str
    click_url: str | None = None

    @classmethod
    def from_environment(cls):
        base = os.getenv("DAILY_PLAN_NTFY_URL", "").rstrip("/")
        topic = os.getenv("DAILY_PLAN_NTFY_TOPIC", "")
        token = os.getenv("DAILY_PLAN_NTFY_TOKEN", "")
        parsed = urlsplit(base)
        if not (parsed.scheme in ("https", "http") and parsed.hostname and topic and token):
            return None
        if any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in topic):
            return None
        return cls(base, topic, token, os.getenv("DAILY_PLAN_PUBLIC_URL", "").rstrip("/") or None)

    def __call__(self, reminder):
        body = {
            "topic": self.topic,
            "title": "该回来学习了",
            "message": f"{reminder['label_name'] or '休息'}时间到了，方便时回来继续学习。计时仍在继续。",
            "tags": ["hourglass_done"],
        }
        if self.click_url:
            body["click"] = f"{self.click_url}/execute?date={reminder['plan_date']}"
        # 凭据只存在服务端环境；不经过数据库、浏览器或日志。
        with httpx.Client(timeout=10, follow_redirects=False, trust_env=False) as client:
            response = client.post(self.base_url, json=body, headers={"Authorization": f"Bearer {self.token}"})
            response.raise_for_status()
            data = response.json()
            if not data.get("id"):
                raise RuntimeError("通知服务没有确认接收")


def notification_status(app):
    preview = bool(getattr(app.state, "ui_preview", False))
    configured = getattr(app.state, "reminder_sender", None) is not None
    return {
        "configured": configured and not preview,
        "preview": preview,
        "message": (
            "独立预览只演示提醒设置，不发送手机通知。"
            if preview
            else "手机通知通道已配置，送达仍需手机验证。"
            if configured
            else "手机通知尚未配置；当前只能记录时间，不能发送到点通知。"
        ),
    }


def schedule_reminder(connection, segment_id: int, minutes: int | None, app):
    if minutes is None:
        return
    status = notification_status(app)
    if not status["configured"] and not status["preview"]:
        raise HTTPException(409, "手机通知尚未配置，请先完成通知设置，或留空提醒分钟数")
    segment = connection.execute(
        "SELECT time_category FROM task_execution_segments WHERE id=?",
        (segment_id,),
    ).fetchone()
    if segment["time_category"] not in ("rest", "life"):
        raise HTTPException(422, "第一版只支持生活活动或主动休息的到点提醒")
    connection.execute(
        "INSERT INTO execution_reminders(segment_id,due_at) VALUES(?,?)",
        (segment_id, iso(utc_now() + timedelta(minutes=minutes))),
    )


def cancel_reminders(connection, segment_id: int):
    connection.execute(
        "UPDATE execution_reminders SET status='cancelled' WHERE segment_id=? AND status IN ('pending','sending')",
        (segment_id,),
    )


def reminder_for_segment(connection, segment_id: int) -> dict | None:
    row = connection.execute(
        "SELECT id,due_at,status,sent_at,error FROM execution_reminders WHERE segment_id=?",
        (segment_id,),
    ).fetchone()
    return dict(row) if row else None


def reminders_for_segments(connection, segment_ids: list[int]) -> dict[int, dict]:
    if not segment_ids:
        return {}
    placeholders = ",".join("?" for _ in segment_ids)
    rows = connection.execute(
        f"SELECT segment_id,id,due_at,status,sent_at,error FROM execution_reminders WHERE segment_id IN ({placeholders})",
        tuple(segment_ids),
    ).fetchall()
    return {
        row["segment_id"]: {
            "id": row["id"],
            "due_at": row["due_at"],
            "status": row["status"],
            "sent_at": row["sent_at"],
            "error": row["error"],
        }
        for row in rows
    }


def _has_actionable_reminders(database_path, now_iso: str) -> bool:
    with connect(database_path) as db:
        row = db.execute(
            """SELECT 1 FROM execution_reminders
               WHERE status='sending'
                  OR (status='pending' AND (due_at<=? OR segment_id IN (
                      SELECT id FROM task_execution_segments WHERE ended_at IS NOT NULL
                  )))
               LIMIT 1""",
            (now_iso,),
        ).fetchone()
        return row is not None


def dispatch_due(database_path, sender, *, now=None, preview: bool = False):
    """先轻量只读检查；确有待处理提醒时再短事务领取外发，避免空闲抢占写锁。"""
    now = now or utc_now()
    now_str = iso(now)
    if not _has_actionable_reminders(database_path, now_str):
        return 0
    claimed = []
    with connect(database_path) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "UPDATE execution_reminders SET status='cancelled' WHERE status IN ('pending','sending') "
            "AND segment_id IN (SELECT id FROM task_execution_segments WHERE ended_at IS NOT NULL)"
        )
        db.execute(
            "UPDATE execution_reminders SET status='failed',error='发送结果未确认；请核对手机通知' "
            "WHERE status='sending' AND claimed_at<?",
            (iso(now - timedelta(minutes=2)),),
        )
        rows = db.execute(
            """SELECT r.*,s.label_name,s.plan_date FROM execution_reminders r
               JOIN task_execution_segments s ON s.id=r.segment_id
               WHERE r.status='pending' AND r.due_at<=? AND s.ended_at IS NULL
               ORDER BY r.due_at LIMIT 20""",
            (now_str,),
        ).fetchall()
        for row in rows:
            if datetime.fromisoformat(row["due_at"]) < now - timedelta(minutes=10):
                db.execute(
                    "UPDATE execution_reminders SET status='expired',error='已错过提醒时间，不补发迟到通知' WHERE id=?",
                    (row["id"],),
                )
                continue
            if sender is None and not preview:
                db.execute(
                    "UPDATE execution_reminders SET status='failed',error='手机通知通道未配置' WHERE id=?",
                    (row["id"],),
                )
                continue
            db.execute("UPDATE execution_reminders SET status='sending',claimed_at=? WHERE id=?", (now_str, row["id"]))
            claimed.append(dict(row))
    for reminder in claimed:
        with connect(database_path) as db:
            current = db.execute(
                "SELECT r.status,s.ended_at FROM execution_reminders r "
                "JOIN task_execution_segments s ON s.id=r.segment_id WHERE r.id=?",
                (reminder["id"],),
            ).fetchone()
            if not current or current["status"] != "sending" or current["ended_at"] is not None:
                continue
        try:
            if not preview:
                sender(reminder)
            state, error = ("simulated", None) if preview else ("sent", None)
        except Exception as exc:
            # HTTP 异常可能含请求头或目标 URL，仅记录异常类型名，不记录原始消息。
            logger.warning("提醒外发未确认 (%s)", type(exc).__name__)
            state, error = "failed", "发送未确认，请检查通知通道；计时继续，记录保留"
        with connect(database_path) as db:
            db.execute(
                "UPDATE execution_reminders SET status=?,sent_at=?,error=? WHERE id=? AND status='sending'",
                (state, now_str if state in ("sent", "simulated") else None, error, reminder["id"]),
            )
    return len(claimed)


async def run_reminders(app):
    from .auto_stop import dispatch_auto_stops

    while True:
        try:
            await asyncio.to_thread(dispatch_auto_stops, app.state.database_path)
            await asyncio.to_thread(
                dispatch_due,
                app.state.database_path,
                app.state.reminder_sender,
                preview=bool(getattr(app.state, "ui_preview", False)),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("后台计时与提醒调度异常 (%s)，将在下一轮重试", type(exc).__name__)
        await asyncio.sleep(3)
