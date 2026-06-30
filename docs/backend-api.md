# 后端接口与数据层速查文档

> 最后更新：2026-06-30
> 覆盖文件：`app/main.py`、`app/api.py`、`app/database.py`、`app/models.py`、`app/schemas.py`、`app/launcher.py`、`启动今日航线.cmd`、`termux-install.sh`、`termux-start.sh`、`share-to-phone.ps1`

## 模块职责

负责应用启动、SQLite 持久化、计划状态机、执行时间段聚合、单日/单周复盘数据、GPT 协作留档，以及 Windows 与 Termux 的本地运行辅助链路。

## 文件索引

### `app/main.py`

- **职责**：FastAPI 应用工厂、数据库初始化、可选 DeepSeek 客户端注入和页面路由。
- **关键函数/组件**：
  - `create_app()` (L21) — 创建可注入数据库路径、可禁用 AI 的应用实例，并挂载模板与静态资源版本号。
  - `today_page()` (约 L44) — `GET /`，渲染今天页。
  - `review_page()` (约 L48) — `GET /review`，渲染单日复盘页。
  - `execute_page()` (约 L52) — `GET /execute`，渲染执行台。
  - `weekly_page()` (约 L56) — `GET /weekly`，渲染七日复盘页。
  - `gpt_workbench_page()` (约 L60) — `GET /gpt-workbench`，渲染 GPT 工作台。
  - `settings_page()` (约 L64) — `GET /settings`，渲染设置页。
- **依赖**：`api.py`、`database.py`、`services/ai_planner.py`、Jinja2 模板。
- **被依赖**：Uvicorn、测试客户端、Windows 启动器、Termux 启动脚本。

### `app/api.py`

- **职责**：全部 JSON API、计划状态机、执行时间段编排、复盘聚合、设置持久化和 GPT 留档。
- **关键函数/组件**：
  - `create_draft()` (L1088) — `POST /api/daily-plans/draft`，根据晨间输入生成本地规则草稿，并兼容可选 AI 增强。
  - `get_plan()` (L1149) — `GET /api/daily-plans/{date}`，读取单日计划。
  - `update_plan()` (L1155) — `PUT /api/daily-plans/{date}`，仅允许编辑草稿。
  - `approve_plan()` (L1171) — `POST /api/daily-plans/{date}/approve`，确认今日清单。
  - `submit_plan()` (L1183) — `POST /api/daily-plans/{date}/submit`，要求当前没有激活段，并把主任务 `actual_minutes` 同步成有效时间后提交。
  - `update_task()` (L1205) — `PATCH /api/tasks/{id}`，主任务仍由用户手动勾选；副航线按有效时间 `>= 30` 自动完成；若原计划已提交，会回退到 `approved`。
  - `daily_execution()` (约 L1246) — `GET /api/daily-execution/{date}`，返回执行台整页需要的聚合数据。
  - `start_execution_task()` (约 L1252) — `POST /api/daily-execution/{date}/tasks/start`，关闭旧段后开启任务有效时间。
  - `start_execution_label()` (约 L1267) — `POST /api/daily-execution/{date}/labels/start`，关闭旧段后切入计总标签或中断标签。
  - `stop_execution()` (L1292) — `POST /api/daily-execution/{date}/stop`，停止当前激活段。
  - `create_execution_segment()` (L1304) — `POST /api/daily-execution/{date}/segments`，补记一段历史时间。
  - `update_execution_segment()` (L1336) — `PUT /api/daily-execution/{date}/segments/{id}`，编辑时间段。
  - `delete_execution_segment()` (L1382) — `DELETE /api/daily-execution/{date}/segments/{id}`，删除时间段并重算聚合。
  - `daily_review()` (L1463) — `GET /api/daily-review/{date}`，返回单日复盘、顶部统计、GPT 提示词和任务执行看板。
  - `weekly_review()` (L1518) — `GET /api/weekly-review`，按所选日期所在自然周聚合。
  - `get_gpt_workbench()` (L1666) — `GET /api/gpt-workbench`，返回单日/单周模板与历史协作留档。
  - `get_settings()` (L1681) / `save_settings()` (L1687) — `GET/PUT /api/settings`，持久化预算、任务名称、项目起始日、执行标签和 GPT 模板配置。
- **依赖**：`schemas.py`、`database.py`、`services/task_rules.py`、可选 `AIPlanner`。
- **被依赖**：`app/static/app.js`、API 测试。

### `app/database.py`

- **职责**：SQLite 文件初始化、连接生命周期和旧库补表。
- **关键函数/组件**：
  - `initialize()` (约 L10) — 创建父目录、执行 `models.SCHEMA`，并补齐旧库缺失字段。
  - `connect()` (约 L18) — 统一开启外键、提交、异常回滚和关闭连接。
- **注意**：这里除了初始化已有表，还会补建 `task_execution_segments` 和缺失的 GPT 留档列，避免旧数据库直接起不来。

### `app/models.py`

- **职责**：保存完整 SQLite 建表 SQL。
- **关键结构**：
  - `plans` — 每日计划、晨间状态、审批状态与降级信息。
  - `tasks` — 任务内容、排序、完成状态、实际分钟与主副航线归属。
  - `carryovers` — 未完成任务的待审与处理结果。
  - `reviews` — 单日结构化复盘与补充正文。
  - `weekly_reports` — 周快照、兼容旧分析、GPT 提示词与最终周报正文。
  - `gpt_collab_records` (L67) — 单日/单周 GPT 提示词、回复全文、采用备注与时间戳。
  - `task_execution_segments` (L79) — 执行时间段明细，存 `plan_date`、`task_id`、`segment_kind`、标签快照和起止时间。
  - `app_settings` (L92) — 单行 JSON 设置。
- **注意**：没有迁移框架；任何改表都要先考虑备份 `data/daily_plan.db`。

### `app/schemas.py`

- **职责**：Pydantic 输入输出模型与枚举边界。
- **关键模型**：
  - `ExecutionLabelItem` (L25) — 设置页里的执行标签配置项，含 `bucket(counted|interrupt)` 与 `is_system`。
  - `ExecutionTaskStartInput` (L113) — 开始任务有效时间。
  - `ExecutionLabelStartInput` (L117) — 切到标签时间。
  - `ExecutionSegmentCreateInput` (L122) — 补记一段时间。
  - `ExecutionSegmentUpdateInput` (L130) — 编辑时间段。
  - `SettingsInput` (L144) — 当前阶段、预算、任务名称、执行标签与各类 GPT 模板。
- **注意**：执行标签和时间段类型的枚举已经固定，前后端都依赖这些取值。

### `启动今日航线.cmd` 与 `app/launcher.py`

- **职责**：Windows 双击启动、前台日志与浏览器自动打开。
- **关键函数/组件**：
  - `启动今日航线.cmd` — `--check` 只做环境自检；普通模式直接前台起 Uvicorn。
  - `wait_and_open()` (约 L9) — 最多轮询 60 次，主页就绪后打开浏览器。
- **注意**：批处理正文必须保持纯 ASCII；文件名可以用中文。

### `termux-install.sh` 与 `termux-start.sh`

- **职责**：给安卓手机的 Termux 提供最小安装与日常启动入口。
- **关键行为**：
  - `termux-install.sh` — 安装 `python`、`git`、项目依赖并初始化 `.env`。
  - `termux-start.sh` — 导出 `DATABASE_PATH`，用 `uvicorn` 监听 `127.0.0.1:8000`，并在可用时尝试唤起浏览器。
- **注意**：当前只支持“Termux 手动启动 + 浏览器访问”，不包含常驻、自启动、通知守护或 APK 壳。

### `share-to-phone.ps1`

- **职责**：从电脑打包当前工作区，并可临时起下载服务给手机下载。
- **关键行为**：
  - 默认生成 `dist/daily-plan-termux.zip`。
  - 排除 `.git`、`data`、`.env`、缓存目录，避免把本地真实数据库和密钥带到手机。
  - `-Serve` 模式会优先挑有真实网关的局域网地址，避免打印出像 `198.18.*` 这种手机打不开的地址。

## 模块间关系

```text
app.js → /api/* → api.py → database.py → SQLite
                       ├─→ services/task_rules.py
                       ├─→ services/ai_planner.py → 可选 DeepSeek
                       └─→ 执行时间段聚合 / 复盘聚合

启动器 → app.launcher + app.main
Termux 脚本 → uvicorn + app.main
share-to-phone.ps1 → zip 打包 + 临时 HTTP 文件服务
```

## 执行时间段模型与聚合规则

- `task_execution_segments` 的 `segment_kind` 固定三类：
  - `effective`：任务有效时间。
  - `counted_label`：计入任务总时间的标签段。
  - `interrupt_label`：不计入任务总时间的中断段。
- 任务总时间不单独存库，而是实时聚合为：`effective + counted_label`。
- 标签次数不单独建表，直接按同标签时间段条数累计。
- 标签名采用“写入时间段时快照保存”，避免后续改名导致历史记录失真。
- 同一时刻全局只允许一个未结束段；任何开始/切换动作都会先关闭旧段。

## 执行接口返回范围

- `GET /api/daily-execution/{date}` 会返回：
  - 当日计划与任务列表
  - 执行标签配置
  - 当前激活段
  - 当天时间段明细
  - 按任务聚合的执行看板
- 执行页只对 `approved` / `submitted` 状态开放；草稿和无计划日期会返回空态引导，而不是允许直接开始记录。
- 中断标签默认仍挂在切入前的当前任务下面，不存在“当天公共中断池”。

## 单日复盘与周复盘返回范围

- `GET /api/daily-review/{date}` 在当天无计划时也返回 200，并带空态数据。
- 单日复盘返回值现在除了原来的顶部统计、结构化复盘、GPT 提示词和 GPT 留档，还包含 `task_execution_board`，供中部任务看板使用。
- 顶部主任务分钟汇总仍显示 `actual_minutes`，而主任务的 `actual_minutes` 现在来源于执行台里的有效时间同步值。
- `GET /api/weekly-review` 仍按 `anchor_date` 所在自然周统计，不是最近 7 个实际执行日。

## 设置与脚本注意事项

- `GET/PUT /api/settings` 现在会持久化 `execution_labels`，系统标签可改名但不可删。
- `.env` 里的 `DEEPSEEK_*` 变量只由后端读取，不得加到设置页、接口返回值或前端脚本。
- `share-to-phone.ps1` 和 Termux 脚本属于“本地运行辅助链路”，不是部署流水线；当前项目仍没有正式打包步骤。

## 已知问题与注意事项

- 已确认计划不可再编辑草稿结构，任务也只能在确认后勾选或进入执行台。
- “重置今日”会真正删除该日期数据，而不是只把完成状态归零。
- 今天页不再鼓励直接填主任务实际分钟；白天执行应该走执行台。
- 若提交前仍有激活段，`submit_plan()` 会直接拒绝提交，必须先停止。
- ChatGPT Plus 仍只通过手工复制提示词使用，不走项目内 API 调用。
- `main.py` 的全局 `app` 会在导入时创建默认数据库。
