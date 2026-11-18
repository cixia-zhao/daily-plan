"""路由层数据库与环境公共依赖。"""
from __future__ import annotations

from fastapi import Request

from app.database import connect
from app.services.auto_stop import dispatch_auto_stops


def begin_immediate(connection):
    """写路由统一在读取可变业务状态之前获取 SQLite 写锁。"""
    connection.execute("BEGIN IMMEDIATE")


def db_session(request: Request):
    """写请求进入业务连接前结算到期计时；读请求只计算内存投影。"""
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        dispatch_auto_stops(request.app.state.database_path)
    return connect(request.app.state.database_path)
