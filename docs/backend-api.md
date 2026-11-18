# 后端架构与 HTTP 接口参考

## 一、模块职责划分

| 模块路径 | 核心职责 |
| :--- | :--- |
| `app/main.py` | FastAPI 应用工厂、Argon2 会话认证、私有响应 `Cache-Control: no-store`、PWA 公开壳资源、`/return-today` 与 `/execute` 当日/历史分流 |
| `app/database.py` & `app/models.py` | SQLite 连接管理（`timeout=15.0`、`PRAGMA busy_timeout=5000`、rollback journal）与幂等列/索引迁移 |
| `app/routers/deps.py` | 数据库连接注入、`begin_immediate()` 写锁包装、仅写请求触发 `dispatch_auto_stops` |
| `app/routers/plans.py` | 今日草稿生成（外部 AI 请求脱离数据库锁）、草稿微调、确认批准、待审池处理、任务局部更新、月历状态与目标分钟历史建议 |
| `app/routers/execution.py` | 当日执行状态读取、有效计时启动/切换、分心与休息活动切换、停止计时、自动停止设定、时间段增删改、一键时间修正与快捷按钮管理、背单词词数与墨墨分钟录入 |
| `app/routers/reviews.py` | 单日复盘读写、周复盘导航与聚合看板、AI 周分析刷新、周最终稿与单日/单周 GPT 协作记录、按日重置快照与一键无损恢复 |
| `app/routers/settings.py` | 健康检查、移动端通知状态探测、全局设置与科目目录读写、有效细分标签 CRUD、在线一致 SQLite 数据库备份导出 |
| `app/services/clock.py` | 统一 `Asia/Shanghai` 时区日期与 ISO 时间戳生成 |
| `app/services/catalog.py` | 统一内置 10 科与自定义 `custom_*` 科目的能力元数据、默认标签与快捷修正内置项 |
| `app/services/execution_engine.py` | 纯内存任务进度核算（保证 GET 100% 零写库）、写路径按需同步任务表、`±2 天` 安全窗口重叠检测、时间去向与学习有效率聚合 |
| `app/services/review_engine.py` | 单日/整周 6 条批量只读 SQL 聚合、前一日与上周同期比较、`/return-today` 智能落点决策 |
| `app/services/settings_store.py` | 设置默认值合并、主项目配置、科目目录序列化（`category_catalog`）与快捷修正按钮持久化 |

---

## 二、核心数据不变量与并发契约

1. **只读请求零副作用**：所有 `GET` 端点在计算执行进度时仅使用内存聚合（`compute_task_progress`），已到期但尚未由后台结算的时间段也只在响应中投影为停止状态；`/return-today` 使用相同状态判定跳转。真实结算由后台调度与写请求完成。
2. **单活计时段约束**：任意时刻全库最多只允许存在一条 `ended_at IS NULL` 的运行中时间段；启动新任务或标签前会自动闭合上一段并取消其未发送提醒。
3. **重叠保护**：创建或修改时间段时，服务端在 `plan_date ± 2 天` 索引窗口及所有未闭合段上严格校验秒级区间不重叠（冲突返回 `409`）。
4. **学习有效率口径**：`effective_ratio = learning / (learning + distraction)`。主动休息（`rest`）、生活事务（`life`）与外部打断（`external`）单列统计，不计入有效率分母；未记录空白时段不推断为任何分类。
5. **幂等时间修正**：`POST /api/daily-execution/{plan_date}/time-corrections` 通过 `request_id` 保证网络重试幂等，并将修正前快照写入 `execution_quick_corrections.original_state_json`，删除生成的估计段即可精准还原原计时段。

---

## 三、主要 API 速查

### 1. 计划与待审池
- `POST /api/daily-plans/draft`：生成或重生成指定日期草稿
- `GET /api/daily-plans/{plan_date}` / `PUT /api/daily-plans/{plan_date}`：读取或保存草稿任务列表
- `POST /api/daily-plans/{plan_date}/approve`：确认今日清单，解锁执行台
- `PATCH /api/tasks/{task_id}`：更新单个任务完成状态、副航线实际分钟、事项类型、习惯状态或子科目
- `GET /api/carryovers` / `POST /api/carryovers/{id}/resolve`：查询或处理待审项（`reschedule` / `split` / `discard`）
- `GET /api/target-suggestions?before_date=YYYY-MM-DD`：读取各科目最近使用过的目标分钟
- `GET /api/calendar-status?month=YYYY-MM`：读取月历每日状态圆点

### 2. 执行、修正与词数
- `GET /api/daily-execution/{plan_date}`：获取当日任务、运行段、时间轴片段、看板统计、词数与修正快捷键
- `POST /api/daily-execution/{plan_date}/tasks`：在执行台临时追加当日活动
- `POST /api/daily-execution/{plan_date}/tasks/start`：开始或切换有效学习计时
- `POST /api/daily-execution/{plan_date}/labels/start`：切到分心、休息、生活或外部打断标签（支持 `reminder_minutes`）
- `POST /api/daily-execution/{plan_date}/stop`：停止当前运行段
- `PUT /api/daily-execution/{plan_date}/auto-stop`：设置或取消当前运行段的自动停止时刻
- `POST|PUT|DELETE /api/daily-execution/{plan_date}/segments[/{segment_id}]`：补记、编辑（带乐观锁 `expected_state`）或删除/撤销时间段
- `POST /api/daily-execution/{plan_date}/time-corrections`：执行快捷或详细时间修正
- `POST /api/correction-shortcuts` / `DELETE /api/correction-shortcuts/{shortcut_id}`：增删常用修正快捷按钮
- `GET|PUT|DELETE /api/vocabulary-counts/{plan_date}`：读取、累计更新或清空当日背单词词数

### 3. 复盘、重置快照与设置
- `GET /api/daily-review/{review_date}` / `POST /api/daily-reviews`：读取单日看板或保存日复盘
- `GET /api/review-navigation?anchor_date=YYYY-MM-DD`：轻量获取自然周步骤条状态
- `GET /api/weekly-review?anchor_date=YYYY-MM-DD`：获取完整周复盘看板与上周同期对比
- `POST /api/weekly-reports/{end_date}/refresh` / `PUT /api/weekly-reports/{end_date}`：生成 AI 周分析或保存周最终稿
- `GET /api/gpt-workbench` & `PUT /api/{daily-review|weekly-review}/{key}/gpt-record`：工作台聚合与 GPT 协作留档保存
- `DELETE /api/daily-data/{target_date}` / `GET .../reset-snapshots` / `POST .../restore`：按日安全清空与快照恢复
- `GET /api/settings` / `PUT /api/settings`：读取或保存全局设置（响应内含 `category_catalog`）
- `POST|PATCH|DELETE /api/settings/effective-labels/{category}[/{label_id}]`：执行台内联管理科目有效细分标签
- `GET /api/system/health` / `GET /api/system/backup-export`：系统健康检查与在线导出 SQLite 备份文件
