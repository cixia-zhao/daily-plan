# 后端接口与数据层速查文档

> 最后更新：2026-06-21
> 覆盖文件：`app/main.py`、`app/api.py`、`app/database.py`、`app/models.py`、`app/schemas.py`、`app/launcher.py`、`启动今日航线.cmd`

## 模块职责

负责应用启动、SQLite 持久化、输入校验和每日计划状态机。草稿生成、审批、任务勾选、待审项、复盘和设置均在本模块编排。

## 文件索引

### `app/main.py`

- **职责**：FastAPI 应用工厂、数据库初始化、DeepSeek 客户端配置和页面路由。
- **关键函数/组件**：
  - `create_app()` (L20) — 创建可注入数据库路径、可禁用 AI 的应用实例。
  - `today_page()` (L42) — `GET /`，渲染今日页。
  - `weekly_page()` (L46) — `GET /weekly`，渲染七日复盘页。
  - `settings_page()` (L50) — `GET /settings`，渲染设置页并传入 AI 配置状态。
  - `app` (L57) — Uvicorn 默认入口；导入时会初始化默认数据库。
- **依赖**：`api.py`、`database.py`、`ai_planner.py`、Jinja2 模板。
- **被依赖**：Uvicorn、测试客户端、根目录启动器。

### `app/api.py`

- **职责**：全部 JSON API、计划状态机、待审项处理、设置和七日汇总。
- **关键函数/组件**：
  - `create_draft()` (L96) — `POST /api/daily-plans/draft`，生成规则/AI 草稿并捕获旧未完成项。
  - `get_plan()` (L154) — `GET /api/daily-plans/{date}`，读取单日计划。
  - `update_plan()` (L160) — `PUT /api/daily-plans/{date}`，只允许编辑草稿。
  - `approve_plan()` (L176) — `POST /api/daily-plans/{date}/approve`，冻结当日清单。
  - `update_task()` (L187) — `PATCH /api/tasks/{id}`，只允许勾选已确认任务。
  - `list_carryovers()` (L205) — `GET /api/carryovers`，读取待审池。
  - `resolve_carryover()` (L213) — `POST /api/carryovers/{id}/resolve`，重排、拆小或放弃。
  - `save_review()` (L231) — `POST /api/daily-reviews`，保存三行复盘。
  - `weekly_review()` (L244) — `GET /api/weekly-review`，汇总最近 7 个自然日。
  - `get_settings()` / `save_settings()` (L273/L279) — 读取与保存非敏感设置。
- **依赖**：`schemas.py`、`database.py`、`task_rules.py`、可选 `AIPlanner`。
- **被依赖**：`app/static/app.js`、API 测试。

### `app/database.py`

- **职责**：SQLite 文件初始化和连接生命周期。
- **关键函数/组件**：
  - `initialize()` (L10) — 创建父目录并执行建表脚本。
  - `connect()` (L18) — 开启外键，成功提交，异常回滚，最后关闭连接。
- **依赖**：`models.SCHEMA`、标准库 `sqlite3`。
- **被依赖**：`main.py`、`api.py`。

### `app/models.py`

- **职责**：保存无迁移框架的 SQLite 建表语句。
- **关键结构**：
  - `plans` (L3) — 每日计划、晨间状态、审批状态与降级信息。
  - `tasks` (L15) — 任务内容、排序、来源、完成状态和实际分钟数。
  - `carryovers` (L29) — 未完成任务的待审与处理结果。
  - `reviews` (L41) — 三行晚间复盘。
  - `app_settings` (L48) — 单行 JSON 设置。
- **注意**：没有数据库迁移机制，改表前必须备份 `data/daily_plan.db`。

### `app/schemas.py`

- **职责**：Pydantic 输入输出模型和枚举边界。
- **关键模型**：
  - `MorningCheckIn` / `DraftRequest` (L14/L22) — 晨间输入和日期。
  - `TaskDraft` (L26) — AI 与规则共享的严格任务结构，禁止额外字段。
  - `PlanUpdate` / `TaskUpdate` (L59/L50) — 草稿编辑与任务勾选。
  - `CarryoverResolution` (L70) — 重排、拆小、放弃。
  - `SettingsInput` (L76) — 阶段、AI 项目频率、康复开关与任务名称。

### `启动今日航线.cmd` 与 `app/launcher.py`

- **职责**：Windows 双击启动、环境自检、可见日志和浏览器自动打开。
- **关键函数/组件**：
  - `启动今日航线.cmd` — `--check` 只自检；普通模式前台运行 Uvicorn。
  - `wait_and_open()` (L9) — 最多轮询 60 次，主页就绪后打开浏览器。
- **注意**：批处理正文必须保持纯 ASCII；文件名可使用中文。

## 模块间关系

```text
app.js → /api/* → api.py → database.py → SQLite
                       ├─→ task_rules.py
                       └─→ ai_planner.py → DeepSeek
启动器 → app.launcher + app.main
```

## 已知问题与注意事项

- 已确认计划不可编辑，任务也只能在确认后勾选。
- `.env` 密钥只由 `main.py` 读取，不得增加到设置接口或返回值。
- `weekly_review()` 当前按自然日窗口统计，与产品目标“7 个实际执行日”不同。
- `main.py` 的全局 `app` 会在导入时创建默认数据库。

