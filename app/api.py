"""API 路由汇总入口。业务逻辑已按职责拆分至 app.routers 与 app.services。"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter

from app.routers import execution, plans, reviews, settings
from app.services.clock import default_now_iso
from app.services.execution_engine import assert_no_segment_overlap, sync_plan_tasks_to_db

# 保留可测试钩子以兼容既有测试的时钟与重叠冲突注入
_now_iso = default_now_iso
_assert_no_segment_overlap = assert_no_segment_overlap
_sync_plan_actual_minutes_from_execution = sync_plan_tasks_to_db
__all__ = ["router", "date", "_now_iso", "_assert_no_segment_overlap"]

router = APIRouter(prefix="/api")
router.include_router(plans.router)
router.include_router(execution.router)
router.include_router(reviews.router)
router.include_router(settings.router)
