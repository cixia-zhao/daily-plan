# 任务规则与 AI 服务速查文档

> 最后更新：2026-06-21
> 覆盖文件：`app/services/task_rules.py`、`app/services/ai_planner.py`、`app/prompts/daily_planner_v1.md`

## 模块职责

从晨间状态生成稳定候选任务，并在 AI 调整后执行本地二次校验。AI 失败、超时、格式错误或违反时间/康复规则时，系统必须保留规则版任务。

## 文件索引

### `app/services/task_rules.py`

- **职责**：三档任务、预算裁剪、康复轮换和 AI 输出安全校验。
- **关键函数/组件**：
  - `_task()` (L11) — 创建统一 `TaskDraft`。
  - `_fit_to_budget()` (L22) — 先删 AI 项目/康复可选项，再缩短学习任务。
  - `build_rule_plan()` (L53) — 根据精力、分钟数、当天类型、日期和膝盖异常生成任务。
  - `validate_ai_tasks()` (L93) — 校验非空、数量、总时长、三条学习主线与康复禁词。
- **依赖**：`app.schemas`。
- **被依赖**：`app.api`、`AIPlanner`、规则测试。

### `app/services/ai_planner.py`

- **职责**：调用兼容 OpenAI 的 DeepSeek 接口，解析、校验并降级。
- **关键函数/组件**：
  - `SYSTEM_PROMPT` (L12) — 当前运行时实际使用的最小英文提示词。
  - `AIPlanner` (L19) — 保存接口地址、密钥、模型、超时和可注入传输层。
  - `AIPlanner.generate()` (L27) — 发送抽象状态和候选任务；5xx 重试一次；失败返回规则任务。
- **依赖**：httpx、Pydantic、`validate_ai_tasks()`。
- **被依赖**：`main.py`、`api.py`、AI 测试。

### `app/prompts/daily_planner_v1.md`

- **职责**：GPT‑5.5 生成的可读提示词框架和 JSON 示例。
- **当前状态**：仅作为设计文档存在，`AIPlanner` 不会读取它。
- **修改建议**：若改为运行时加载，应增加文件缺失、编码、版本和回退测试。

## 数据与安全边界

- AI 请求包含：精力档、可用分钟数、当天类型、膝盖异常布尔值、规则候选。
- AI 请求不包含：规划原文、性行为相关原文、晚间自由文本复盘、API 密钥正文。
- AI 不能删除数学、英语、C语言/数据结构主线。
- 膝盖异常时 AI 输出不得包含康复任务。
- AI 结果不合规时只能降级，不能放宽本地校验。

## 已知问题与注意事项

- 尚未使用真实 DeepSeek 密钥完成在线集成测试。
- 供应商若不是官方 DeepSeek，需要确认兼容接口地址、模型名和响应结构。
- 完整 Markdown 提示词与 `SYSTEM_PROMPT` 存在双源漂移风险。
