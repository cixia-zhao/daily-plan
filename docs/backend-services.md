# 任务规则与 AI 服务速查文档

> 最后更新：2026-06-27
> 覆盖文件：`app/services/task_rules.py`、`app/services/ai_planner.py`、`app/services/weekly_review_analyzer.py`、`app/prompts/daily_planner_v1.txt`

## 模块职责

从晨间状态生成稳定候选任务，并在 AI 调整后执行本地二次校验。同时负责单日/单周 GPT 协作提示词和兼容旧周分析能力。外部 AI 失败、超时、格式错误或违反本地边界时，系统必须保留可降级结果。

## 文件索引

### `app/services/task_rules.py`

- **职责**：主/副航线三档规则定义、任务智能裁剪缩减、康复动作安全词过滤校验。
- **关键函数/组件**：
  - `_task()` (L11) — 创建统一 `TaskDraft`，支持 `is_sub` 与 `sub_category` 属性。
  - `_fit_to_budget()` (L24) — 将主航线任务限制在精力档可用分钟数预算内，优先移除或等比缩减。
  - `build_rule_plan()` (L59) — 根据精力档生成 4 项主航线任务（数学/英语/408/运动）及 4 项 0 预算副航线任务（vibe coding/算法/阅读/练字）。
  - `validate_ai_tasks()` (L108) — 限制任务总数、核对主线、过滤异常动作名、防止越界。
- **依赖**：`app.schemas`。
- **被依赖**：`app.api`、`AIPlanner`、规则测试。

### `app/services/ai_planner.py`

- **职责**：调用兼容 OpenAI 的 DeepSeek 接口，解析、校验并降级。
- **关键函数/组件**：
  - `load_system_prompt()` — 优先读取 `app/prompts/daily_planner_v1.txt`，失败时回退到内置默认提示词。
  - `AIPlanner` (L19) — 保存接口地址、密钥、模型、超时和可注入传输层。
  - `AIPlanner.generate()` (L27) — 发送抽象状态和候选任务；5xx 重试一次；失败返回规则任务。
- **依赖**：httpx、Pydantic、`validate_ai_tasks()`。
- **被依赖**：`main.py`、`api.py`、AI 测试。

### `app/services/weekly_review_analyzer.py`

- **职责**：调用兼容 OpenAI 的 DeepSeek 接口，基于 7 天统计与每日复盘生成结构化周分析。
- **关键函数/组件**：
  - `WEEKLY_REVIEW_SYSTEM_PROMPT` — 约束 DeepSeek 返回固定 JSON 结构。
  - `WeeklyReviewAnalyzer.analyze()` — 发送一周快照；支持注入当前激活的自定义周分析提示词；5xx 重试一次；失败时返回错误类型供接口降级。
- **被依赖**：`main.py`、`api.py`、AI 测试。

### `app/prompts/daily_planner_v1.txt`

- **职责**：每日规划运行时真实使用的 system prompt 纯文本文件。
- **当前状态**：`AIPlanner` 初始化时会读取该文件；为空、缺失或读取失败时自动回退到内置默认提示词。
- **注意**：修改后无需再同步 Python 常量，但应保留 UTF-8 编码与自动化测试覆盖。

## 数据与安全边界

- AI 请求包含：精力档、可用分钟数、当天类型、膝盖异常布尔值、规则候选。
- 每日草稿 AI 请求不包含：规划原文、性行为相关原文、API 密钥正文。
- 周分析 AI 请求允许包含：每日复盘结构化字段与补充正文。
- 单日 GPT 模板、单周 GPT 模板、周分析提示词与旧 ChatGPT 导出模板都由 `app_settings` 持久化，但后端各自保留默认常量，前端传空值时必须回退。
- AI 不能删除数学、英语、C语言/数据结构主线。
- 膝盖异常时 AI 输出不得包含康复任务。
- AI 结果不合规时只能降级，不能放宽本地校验。
- ChatGPT Plus 不由项目自动调用；项目只负责生成可复制提示词，并保存贴回来的回复全文与采用备注。

## 已知问题与注意事项

- 尚未使用真实 DeepSeek 密钥完成在线集成测试。
- 供应商若不是官方 DeepSeek，需要确认兼容接口地址、模型名和响应结构。
- 每日规划提示词已收敛为单一文件来源，避免了设计稿与运行时双源漂移。
