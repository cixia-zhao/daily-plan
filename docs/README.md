# 项目模块文档索引

> 最后更新：2026-06-21

“今日航线”是单用户、本地优先的每日任务工具。核心数据流为：晨间三项输入 → 本地候选任务 → 可选 DeepSeek 调整 → 本地安全校验 → 人工审阅 → 正式任务 → 晚间复盘。

## 推荐读取顺序

1. 根目录 `AGENTS.md`：环境锁定与协作流程。
2. 根目录 `HANDOFF.md`：当前进度、差异、待办与红线。
3. 根据任务只读下列相关模块文档。

## 模块文档

- `backend-api.md`：FastAPI 路由、SQLite 模型、状态机与 Windows 启动器。
- `backend-services.md`：三档任务规则、预算裁剪、AI 适配和隐私安全边界。
- `frontend.md`：Jinja2 页面、响应式样式和浏览器交互。

## 模块关系

```text
启动今日航线.cmd
  ├─→ app.launcher：等待服务并打开浏览器
  └─→ app.main：启动 FastAPI
          ├─→ app.api：接口与业务编排
          │      ├─→ app.database / app.models：SQLite
          │      └─→ app.services：规则与 DeepSeek
          └─→ templates + static：页面与交互
```

## 核心约束

- AI 只能生成草稿，不能代替用户审批。
- 未完成任务只进入待审池，不自动滚入下一天。
- 敏感原文不进入 AI 请求；密钥不进入网页或数据库。
- 康复任务的停止条件和禁用动作由本地规则控制。
- PushDeer、Termux、账号和云同步不属于当前阶段。

## 已知实现差异

- 提示词 Markdown 当前未被运行时加载，实际提示词在 `ai_planner.py`。
- 七日复盘当前按最近 7 个自然日统计，不是最近 7 个实际执行日。
- 实施计划中的独立 `weekly_review.py` 未创建，汇总逻辑位于 `api.py`。

