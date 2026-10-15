# 后端接口与数据层速查文档

> 本日改动已于2026-10-15 23:52:54随应用384d3ce正式发布，验收见[发布记录](releases/2026-10-15-saving-execution.md)。下方本机未发布字样为开发阶段记录。

## 有效细分管理（2026-10-15，本机未发布）

- POST /api/settings/effective-labels/{category}、PATCH /api/settings/effective-labels/{category}/{label_id}，正文为name；DELETE同一标签路径。创建201，其他成功200，返回最新设置。名称去首尾空白、1至50字，同科目重名409，未知科目422、未知标签404。
- 每次在写事务中读取最新设置，仅更新指定标签，保留其他科目与设置。deleted_effective_label_ids为设置JSON内按科目的显式删除列表；默认合并过滤已删标签，旧设置保存合并已有删除信息，不清空。不存在数据库补表迁移。
- 改名和删除不改历史执行段快照，正在运行的段同样保留；新开始不能选择已删除标签。原记录编辑使用旧快照，跨类别仍按原规则校验。

> 2026-10-15 追加本机未发布修复：学习科目 daily_goal 按有效分钟达标，其他事项类型和人工覆盖保持。新增 daily_reset_snapshots 表，只补表不批量改记录；DELETE /api/daily-data/{date} 在同一事务先保存当日快照，再清空，响应 reset_snapshot 元数据；GET /api/daily-data/{date}/reset-snapshots 返回待恢复元数据，POST /api/daily-data/{date}/reset-snapshots/{id}/restore 按日恢复。已有新数据、重复恢复、ID 或跨日时间冲突返回 409，不覆盖现有记录；错误归属返回 404。原激活段恢复为重置时停止。GPT 与周最终稿不在删除范围。
>
> 月历允许起始日前已有计划、复盘、执行或待恢复快照的日期；空白历史与未来日期保持原限制。补表已先在合成旧库及预览备份副本初始化两次验证；生产迁移尚未执行。


> 2026-10-15 本机未发布修复：内部按秒汇总后再输出整数分钟，时间段及细分新增 seconds，看板新增 total_seconds／effective_seconds／counted_label_seconds／interrupt_seconds／bar_total_seconds，日周新增相应精度字段；任务的 actual_minutes 仍为兼容整数缓存。日汇总与周汇总各自从秒数合计取整，展示的分项整数之和可能小于汇总，原秒数完整保留。GPT 导出附秒级合计。
>
> 重叠保护覆盖全部计划日期和激活段；无时区值按中国时间解释，带时区新输入转换为中国时间保存。精确相接允许，跨午夜仍归原计划日期；不自动修改历史异常。导入 app.main／app.preview 不初始化默认库，实际获取 app 或调用 create_app 才初始化。
>
> 新增 GET /api/review-navigation?anchor_date=日期，只返回周日期与记录／复盘状态。读取周接口和保存最终稿／GPT 不调用分析器、不因查看创建周快照；显式 POST /api/weekly-reports/{end_date}/refresh 才生成分析，未启用返回 409，分析失败返回 502 并保留旧结果。外部调用不持有数据库连接／事务；analysis_stale 表示已有分析基于旧快照。

> 2026-10-15 正式发布（应用 125a0ac）：周统计自动纳入 `approved`／`submitted` 日期的已保存记录，排除未来日期和草稿；提交仅表示收尾，补记修改不再令分钟消失。日／周、导出和 GPT 共用原执行聚合，背单词不重复累加。
>
> 日复盘新增 `main_total_minutes`、`sub_total_minutes`、`sub_completed_count`、`has_review`；周复盘新增 `total_minutes`、`total_sub_minutes`、`effective_ratio` 与按类别聚合的 `task_distribution`。主航线有效率为整周有效分钟总和／总计分钟总和，不平均每日比率，也不包含副航线和中断。原字段继续兼容，历史最终复盘正文保留。
>
> 周内进度区分已保存复盘与已有执行记录，过去无复盘日期也可打开补写；保存空复盘与月历的已复盘状态一致。设置新增 `weekly_review_mode`（`separate`／`replace_day`）与 `weekly_review_day`（0–6，默认 6）；旧设置读取有默认值，其他设置保存时缺失这些字段不会覆盖用户选择。
>
> 不改数据库结构，不删除旧任务类别 ID 或兼容字段。移除晨间膝盖异常输入、运动限制、AI 状态字段及内置相关提示；运动作为普通习惯继续使用。时间段严格相接允许，真正重叠（包括未结束计时）拒绝，前端编辑保留秒数。

---

> 最后更新：2026-10-11
> 覆盖文件：`app/main.py`、`app/api.py`、`app/database.py`、`app/models.py`、`app/schemas.py`、`app/launcher.py`、`启动今日航线.cmd`、`termux-install.sh`、`termux-start.sh`、`termux-update.sh`、`termux-register-commands.sh`、`share-to-phone.ps1`

## 模块职责

负责应用启动、SQLite 持久化、计划状态机、执行时间段聚合、单日/单周复盘数据、GPT 协作留档，以及 Windows 与 Termux 的本地运行辅助链路。

## 文件索引

### `app/main.py`

- **职责**：FastAPI 应用工厂、数据库初始化、可选 DeepSeek 客户端注入和页面路由。
- **关键函数/组件**：
  - `create_app()` — 创建可注入数据库路径、可禁用 AI 的应用实例，并挂载模板与静态资源版本号。
  - `today_page()` — `GET /`，渲染今天页。
  - `review_page()` — `GET /review`，渲染单日复盘页。
  - `execute_page()` — `GET /execute`，渲染执行台。
  - `weekly_page()` — `GET /weekly`，渲染七日复盘页。
  - `gpt_workbench_page()` — `GET /gpt-workbench`，渲染 GPT 工作台。
  - `settings_page()` — `GET /settings`，渲染设置页。
- **依赖**：`api.py`、`database.py`、`services/ai_planner.py`、Jinja2 模板。
- **被依赖**：Uvicorn、测试客户端、Windows 启动器、Termux 启动脚本。

### `app/api.py`

- **职责**：全部 JSON API、计划状态机、执行时间段编排、有效细分标签聚合、复盘聚合、设置持久化和 GPT 留档。
- **关键函数/组件**：
  - `_list_execution_segments()` — 把时间段统一序列化为 Python 侧分钟值，开着的段和已结束的段都走同一口径。
  - `_effective_minutes_by_task()` — 聚合每个任务的有效分钟，只统计 `effective` 段。
  - `_aggregate_execution_board()` — 生成执行台和复盘页共用的任务时间结构看板，并产出有效细分占比。
  - `_apply_draft_main_minutes()` — 按设置里的 `draft_main_minutes_by_category` 覆盖主航线草稿默认分钟。
  - `_sync_plan_actual_minutes_from_execution()` — 把主任务 `actual_minutes` 同步为有效分钟；副航线仍按有效时间 `>= 30` 自动完成。
  - `create_draft()` — `POST /api/daily-plans/draft`，根据晨间输入生成本地规则草稿，并兼容可选 AI 增强。
  - `get_plan()` — `GET /api/daily-plans/{date}`，读取单日计划。
  - `update_plan()` — `PUT /api/daily-plans/{date}`，仅允许编辑草稿，并在这里做“单任务不超当天可用时间、主航线总分钟不超当天可用时间”的业务校验。
  - `approve_plan()` — `POST /api/daily-plans/{date}/approve`，确认今日清单。
  - `submit_plan()` — `POST /api/daily-plans/{date}/submit`，要求当前没有激活段，并把主任务 `actual_minutes` 同步成有效时间后提交。
  - `update_task()` — `PATCH /api/tasks/{id}`，主任务仍由用户手动勾选；副航线按有效时间 `>= 30` 自动完成；若原计划已提交，会回退到 `approved`。
  - `daily_execution()` — `GET /api/daily-execution/{date}`，返回执行台整页需要的聚合数据。
  - `start_execution_task()` — `POST /api/daily-execution/{date}/tasks/start`，关闭旧段后开启任务有效时间，可选带上有效细分标签。
  - `start_execution_label()` — `POST /api/daily-execution/{date}/labels/start`，关闭旧段后切入计总标签或中断标签。
  - `stop_execution()` — `POST /api/daily-execution/{date}/stop`，停止当前激活段。
  - `create_execution_segment()` — `POST /api/daily-execution/{date}/segments`，补记一段历史时间。
  - `update_execution_segment()` — `PUT /api/daily-execution/{date}/segments/{id}`，编辑时间段。
  - `delete_execution_segment()` — `DELETE /api/daily-execution/{date}/segments/{id}`，删除时间段并重算聚合。
  - `daily_review()` — `GET /api/daily-review/{date}`，返回单日复盘、顶部统计、GPT 提示词和任务执行看板。
  - `weekly_review()` — `GET /api/weekly-review`，按所选日期所在自然周聚合。
  - `get_gpt_workbench()` — `GET /api/gpt-workbench`，返回单日/单周模板与历史协作留档。
  - `get_settings()` / `save_settings()` — `GET/PUT /api/settings`，持久化预算、任务名称、项目起始日、执行标签和各类 GPT 模板配置。
- **依赖**：`schemas.py`、`database.py`、`services/task_rules.py`、可选 `AIPlanner`。
- **被依赖**：`app/static/app.js`、API 测试。
- **注意**：
  - 这轮已经修掉“刚开始计时时有效分钟显示负数”的 bug。现在不再使用 SQLite `CURRENT_TIMESTAMP` 与本地 naive ISO 时间直接做差。
  - 执行台任务卡、`task_execution_board`、提交前同步、标签切换后的刷新，都共用同一套 Python 聚合结果。
  - `rehab_enabled=false` 时，`create_draft()` 会在草稿保存前把 `rehab` 类主航线过滤掉。

### `app/database.py`

- **职责**：SQLite 文件初始化、连接生命周期和旧库补表。
- **关键函数/组件**：
  - `initialize()` — 创建父目录、执行 `models.SCHEMA`，并补齐旧库缺失字段。
  - `connect()` — 统一开启外键、提交、异常回滚和关闭连接。
- **注意**：这里除了初始化已有表，还会补建 `task_execution_segments` 和缺失的 GPT 留档列，避免旧数据库直接起不来。

### `app/models.py`

- **职责**：保存完整 SQLite 建表 SQL。
- **关键结构**：
  - `plans` — 每日计划、晨间状态、审批状态与降级信息。
  - `tasks` — 任务内容、排序、完成状态、实际分钟与主副航线归属。
  - `carryovers` — 未完成任务的待审与处理结果。
  - `reviews` — 单日结构化复盘与补充正文。
  - `weekly_reports` — 周快照、兼容旧分析、GPT 提示词与最终周报正文。
  - `gpt_collab_records` — 单日/单周 GPT 提示词、回复全文、采用备注与时间戳。
  - `task_execution_segments` — 执行时间段明细，存 `plan_date`、`task_id`、`segment_kind`、标签快照和起止时间。
  - `app_settings` — 单行 JSON 设置。
- **注意**：没有迁移框架；任何改表都要先考虑备份 `data/daily_plan.db`。

### `app/schemas.py`

- **职责**：Pydantic 输入输出模型与枚举边界。
- **关键模型**：
  - `EffectiveLabelItem` — 任务类别级的有效细分标签配置项，仅含 `id / name / is_system`。
  - `ExecutionLabelItem` — 设置页里的执行标签配置项，含 `bucket(counted|interrupt)` 与 `is_system`。
  - `TaskDraft` / `PlanTaskInput` — `estimated_minutes` 当前基础上限是 `720`，允许单任务先通过 schema，再交给业务层按当天可用时长精确校验。
  - `ExecutionTaskStartInput` — 开始任务有效时间，当前支持 `task_id + optional label_id`。
  - `ExecutionLabelStartInput` — 切到标签时间。
  - `ExecutionSegmentCreateInput` — 补记一段时间。
  - `ExecutionSegmentUpdateInput` — 编辑时间段。
  - `SettingsInput` — 当前阶段、预算、任务名称、主航线草稿默认分钟、执行标签、有效细分标签与各类 GPT 模板。
- **注意**：执行标签和时间段类型的枚举已经固定，前后端都依赖这些取值。

### `启动今日航线.cmd` 与 `app/launcher.py`

- **职责**：Windows 双击启动、前台日志与浏览器自动打开。
- **关键函数/组件**：
  - `启动今日航线.cmd` — `--check` 只做环境自检；普通模式直接前台起 Uvicorn。
  - `wait_and_open()` — 最多轮询 60 次，主页就绪后打开浏览器。
- **注意**：批处理正文必须保持纯 ASCII；文件名可以用中文。

### `termux-install.sh` 与 `termux-start.sh`

- **职责**：给安卓手机的 Termux 提供最小安装与日常启动入口。
- **关键行为**：
  - `termux-install.sh` — 安装 `python`、`git`、项目依赖，初始化 `.env`，并注册 `dp / spdp`。
  - `termux-start.sh` — 导出 `DATABASE_PATH`，用 `uvicorn` 监听 `127.0.0.1:8000`，并在可用时尝试唤起浏览器。
- **注意**：
  - `termux-install.sh` 已去掉 `pip install --upgrade pip`，避免触发 Termux 的 pip 保护报错。
  - 当前仍是“Termux 手动拉起后端 + 浏览器访问”的方案，不包含常驻、自启动、通知守护或 APK 壳。

### `termux-update.sh` 与 `termux-register-commands.sh`

- **职责**：提供手机侧可持续更新链路，而不是每次重新覆盖目录。
- **关键行为**：
  - `termux-update.sh` — 要求当前目录是 Git 工作区；若代码有未提交修改则停止；更新前备份数据库到 `backups/`；然后执行 `git pull --ff-only`、`python -m pip install -e ".[dev]"`，最后刷新快捷命令。
  - `termux-update.sh` — 如果检测到 `127.0.0.1 / localhost` 回环代理，会先清掉环境变量和 Git 全局代理，再继续拉取。
  - `termux-register-commands.sh` — 在 `$PREFIX/bin` 注册正式命令：
    - `dp`：直接执行 `termux-start.sh`
    - `spdp`：先执行 `termux-update.sh`，再执行 `termux-start.sh`
- **注意**：这套链路默认只更新代码，不覆盖 `data/daily_plan.db`。

### `share-to-phone.ps1`

- **职责**：从电脑打包当前工作区，并可临时起下载服务给手机下载。
- **关键行为**：
  - 默认生成 `dist/daily-plan-termux.zip`。
  - 排除 `.git`、`data`、`.env`、缓存目录，避免把本地真实数据库和密钥带到手机。
  - `-Serve` 模式会优先挑有真实网关的局域网地址，避免打印出像 `198.18.*` 这种手机打不开的地址。
- **注意**：它仍然可用，但现在更适合首次临时传机，不再是后续长期更新主链路。

## 模块间关系

```text
app.js → /api/* → api.py → database.py → SQLite
                       ├─→ services/task_rules.py
                       ├─→ services/ai_planner.py → 可选 DeepSeek
                       ├─→ services/weekly_review_analyzer.py
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
- `effective` 段现在也允许带 `label_id / label_name`，但它取的是“任务类别级有效细分标签”，不是计总 / 中断标签。
- 任务总时间实时聚合为：有效时间段 + 正常时长录入 + 计总标签；actual_minutes 缓存有效分钟（含正常录入），不含计总与中断。
- 标签次数不单独建表，直接按同标签时间段条数累计。
- 标签名采用“写入时间段时快照保存”，避免后续改名导致历史记录失真。
- 同一时刻全局只允许一个未结束段；任何开始/切换动作都会先关闭旧段。
- 有效分钟同步合并 effective 段、时长录入和旧版无明细分钟，尊重 included；计总和中断不写回 actual_minutes。

## 执行接口返回范围

- `GET /api/daily-execution/{date}` 会返回：
  - 当日计划与任务列表
  - 执行标签配置
  - 按任务类别分组的有效细分标签配置
  - 当前激活段
  - 当天时间段明细
  - 按任务聚合的执行看板
- 执行页只对 `approved` / `submitted` 状态开放；草稿和无计划日期会返回空态引导，而不是允许直接开始记录。
- 中断标签默认仍挂在切入前的当前任务下面，不存在“当天公共中断池”。
- 看板里现在会多返回：
  - `effective_labels`
  - `effective_ratio`
  - 各有效细分项的 `effective_share`
  - 无标签有效时间会落到 `未细分`

## 单日复盘与周复盘返回范围

- `GET /api/daily-review/{date}` 在当天无计划时也返回 200，并带空态数据。
- 单日复盘返回值现在除了原来的顶部统计、结构化复盘、GPT 提示词和 GPT 留档，还包含 `task_execution_board`，供中部任务看板使用。
- 顶部主任务分钟汇总仍显示 `actual_minutes`，而主任务的 `actual_minutes` 现在来源于执行台里的有效时间同步值。
- `GET /api/weekly-review` 仍按 `anchor_date` 所在自然周统计，不是最近 7 个实际执行日。

## 设置与脚本注意事项

- `GET/PUT /api/settings` 现在会持久化：
  - `execution_labels`
  - `effective_labels_by_category`
  - `draft_main_minutes_by_category`
  系统默认有效细分标签和系统执行标签都不应该被实现成可直接删除。
- `.env` 里的 `DEEPSEEK_*` 变量只由后端读取，不得加到设置页、接口返回值或前端脚本。
- `share-to-phone.ps1` 和 Termux 脚本属于“本地运行辅助链路”，不是部署流水线；当前项目仍没有正式打包步骤。
- 手机推荐链路已经从“每次手动 bash 启动”升级成“首次装好后用 `dp`，需要拉新版本时用 `spdp`”。

## 已知问题与注意事项

- 已确认计划不重建草稿结构；临时添加只追加 0 目标任务，保留任务 ID 与已有执行明细。
- 主航线草稿默认分钟现在可以被设置成 0，所以不少旧逻辑里的“主航线一定 > 0 分钟”假设已经不成立。
- “重置今日”会真正删除该日期数据，而不是只把完成状态归零。
- 今天页不再鼓励直接填主任务实际分钟；白天执行应该走执行台。
- 若提交前仍有激活段，`submit_plan()` 会直接拒绝提交，必须先停止。
- `PUT /api/daily-plans/{date}` 现在既可能返回字符串错误，也可能返回 FastAPI 的数组型 `detail`；前端已经兼容这两类返回。
- ChatGPT Plus 仍只通过手工复制提示词使用，不走项目内 API 调用。
- `main.py` 的兼容 `app` 属性只在实际获取时创建；导入工厂与预览模块不会初始化默认数据库。

## 2026-10-11 接口与数据约定

- DraftRequest.target_minutes 按类别接收 0–720 分目标；available_minutes 可省略，保留兼容字段但不约束合计。PlanUpdate、规则和 AI 校验均取消时间硬上限，仍校验任务数量和核心类别，运动作为普通习惯。
- TaskDraft/TaskUpdate.task_type 为 habit、daily_goal、todo；TaskUpdate.habit_status 为 done、missed、rest。习惯和具体待办不因分钟达标自动完成。新 0 目标任务不因有效分钟达 30 自动完成。
- POST /daily-execution/{date}/tasks 接收 title/category/task_type，追加临时活动。当天最多 15 项，草稿不可执行，运动作为普通习惯。
- POST /daily-execution/{date}/vocabulary 接收 minutes（1–1440）；PUT/DELETE /vocabulary/{id} 按日期校验归属。默认当前日英语任务，缺失时追加英语 0 目标任务，默认背单词细分及墨墨来源；不保存虚构时间段。
- 同日明确背单词计时与录入同时存在时，duplicate_choice 必须显式选 both/manual/timer；新增真实计时、导入或编辑时间段也有反向校验。只影响英语 effective_english_words 时间段和该日墨墨条目，不影响英语阅读。不计入的明细保留 included=0。
- GET 执行台返回 segments（真实时间段）和 duration_records（只有分钟数）；聚合用内部统一记录列表，但录入不会混入时间轴。日周 english_minutes 包含 vocabulary_minutes，不能再相加；正式旧版周汇总只包含 submitted；当前正式版改为自动纳入已保存记录。
- initialize 只补字段与表，原始字段不更新，旧 task_type 保持 NULL；旧待审项可处理，新增生成仅查询显式 todo。详见 tests/test_product_flows.py 的副本迁移验收。
