# 🌟 项目交接文档

> 最后更新：2026-06-21
> 交接方向：Codex → Antigravity IDE

## 📌 1. 项目概览与环境

- **项目名称**：今日航线
- **工作区路径**：`C:\Users\cixia\Desktop\daily plan`
- **项目定位**：单用户、本地优先的每日任务审阅与执行 Web App
- **核心流程**：晨间三项输入 → 规则候选 → 可选 DeepSeek 调整 → 人工审阅 → 确认清单 → 勾选执行 → 晚间复盘
- **技术栈**：Python 3.11+、FastAPI、Jinja2、原生 JavaScript/CSS、SQLite、httpx、pytest
- **运行数据**：默认保存到 `data/daily_plan.db`
- **当前状态**：第一阶段核心闭环已实现；真实 DeepSeek 接口、PushDeer、Termux 尚未完成
- **版本管理**：当前目录不是 Git 仓库

### 环境切换纪律

- 当前交接目标是 Antigravity IDE；接手后应按根目录 `AGENTS.md` 判断当前环境。
- Antigravity 环境只允许读取 `.gemini/antigravity-ide/skills/`，不要读取 `.agents/skills/`。
- 本文记录的是项目事实，不替代 `AGENTS.md` 中的对齐、计划、审批、测试和验证流程。

### 首选运行方式

1. 首次安装依赖：`python -m pip install -e ".[dev]"`
2. 如需 AI：复制 `.env.example` 为 `.env` 并填写 DeepSeek 配置。
3. 日常启动：双击根目录 `启动今日航线.cmd`。
4. 启动器会保留可见日志窗口，服务就绪后自动打开 `http://127.0.0.1:8000`。
5. 停止服务：在启动窗口按 `Ctrl+C` 或关闭窗口。

### 手动排错方式

```powershell
python -m uvicorn app.main:app --reload
python -m pytest -q
python -m compileall -q app tests
```

---

## 🚀 2. 本次会话已完成的工作（最新会话）

### A. Windows 双击启动器

**文件**：`启动今日航线.cmd`、`app/launcher.py`、`tests/test_launcher.py`、`README.md`

- 在项目根目录新增可双击启动器，自动切换到脚本目录、检查 Python 和依赖、启动 Uvicorn，并保持日志窗口可见。
- `app.launcher.wait_and_open()` 轮询本地服务，确认主页可访问后才打开默认浏览器。
- 增加 `--check` 模式，可验证 Python、应用模块、Uvicorn 与端口 8000 状态，而不常驻启动服务。
- 已覆盖“服务就绪后才打开浏览器”的自动化测试。

### B. 启动与打包问题修复

**文件**：`pyproject.toml`、`启动今日航线.cmd`

- 修复 setuptools 平铺目录自动发现问题：明确只包含 `app*`，排除 `data*`、`docs*`、`tests*` 和规划文档。
- 将模板、静态资源和提示词纳入包数据，`pip install -e ".[dev]"` 已验证成功。
- Windows `cmd.exe` 会误解析 UTF-8 无 BOM 的中文批处理正文，因此启动器文件名保留中文，正文强制保持纯 ASCII。
- 放弃脆弱的批处理括号嵌套和 Python 路径捕获，改用标签跳转与直接 `python` 命令。

### C. 文档交接与模块索引

**文件**：`HANDOFF.md`、`docs/README.md`、`docs/backend-api.md`、`docs/backend-services.md`、`docs/frontend.md`

- 新建本交接文档，记录当前能力、真实限制、待办与红线。
- 重新校准模块文档，补充关键函数行号、依赖关系和最新启动器信息。
- 明确标记计划与实现的差异，避免后续代理把尚未完成的能力当成既有功能。

---

## 🕰️ 3. 历史工作沉淀

### 每日计划核心闭环

- 已实现保底、普通、充足三档任务，受可用分钟数限制。
- 晨间输入只有精力档、可用时间、普通日/早课日；膝盖异常是额外安全开关。
- 任务必须先生成草稿并由用户确认，未经确认不能勾选。
- 未完成项进入待审池，用户可重排、拆小或放弃，不自动形成任务债务。

### AI 与安全边界

- DeepSeek 使用兼容 OpenAI 的 `/chat/completions` 接口，由后端环境变量配置。
- AI 只接收抽象晨间状态和规则候选，不接收规划原文、敏感原文或晚间自由文本复盘。
- AI 超时、服务端错误、非法 JSON、超量任务或违反康复规则时，自动退回规则版草稿。
- AI 不得删除数学、英语、C语言/数据结构三条每日学习主线。

### 数据与页面

- SQLite 保存计划、任务、待审项、每日复盘和设置。
- 页面包括今日页、七日复盘页和设置页，使用服务端模板与原生前端资源。
- 设置支持当前阶段文本、AI 项目每周上限、康复开关和各类别任务名称。
- 前端动态文本通过 `esc()` 转义；不要重新引入未转义的 `innerHTML`。

### 测试状态

- 最近一次完整验证：`python -m pytest -q`，18 项通过。
- 启动器自检：`启动今日航线.cmd --check`，退出码 0。
- 已覆盖规则、API 状态机、持久化、AI 降级/重试、页面、设置和启动器。

---

## 📂 4. 核心文件地图

```text
daily plan/
├── AGENTS.md                         # 项目最高优先级协作规范
├── HANDOFF.md                        # 当前交接上下文
├── implementation_plan.md            # 已审批的第一阶段实施蓝图
├── task.md                           # 已完成任务清单
├── README.md                         # 用户安装、启动与备份说明
├── pyproject.toml                    # 依赖、pytest 与 setuptools 配置
├── .env.example                      # DeepSeek 和数据库配置示例
├── 启动今日航线.cmd                  # Windows 双击启动器，正文必须纯 ASCII
├── app/
│   ├── main.py                       # FastAPI 工厂、页面路由、AI 初始化
│   ├── api.py                        # 全部 JSON API 与业务编排
│   ├── database.py                   # SQLite 连接与初始化
│   ├── models.py                     # SQLite 建表语句
│   ├── schemas.py                    # Pydantic 输入输出模型
│   ├── launcher.py                   # 等待服务并打开浏览器
│   ├── services/
│   │   ├── task_rules.py             # 三档规则、预算裁剪、安全校验
│   │   └── ai_planner.py             # DeepSeek 调用、重试、校验、降级
│   ├── prompts/daily_planner_v1.md   # 可读提示词草案，当前未被运行时加载
│   ├── templates/                    # 今日、复盘、设置页面
│   └── static/                       # 原生 CSS 与 JavaScript
├── tests/                            # 18 项后端、前端冒烟和启动器测试
├── docs/                             # 模块速查文档
├── data/daily_plan.db                # 本地真实数据，处理前先备份
└── 规划文档/                         # 四部分原始长期规划，只作为方向来源
```

---

## ⏳ 5. 当前进度与待办事项

1. **最高优先级：用户手动体验与问题收集**
   - 双击启动器，实际生成、编辑、确认和勾选一天任务。
   - 检查任务量、文字、移动端宽度和待审池交互是否符合真实习惯。

2. **接入真实 DeepSeek 接口**
   - 当前 `.env` 存在，但 `DEEPSEEK_API_KEY` 尚未配置。
   - 配置后需验证第三方兼容接口的地址、模型名、响应结构和超时行为。
   - 不要把真实密钥写进代码、SQLite、页面、测试或交接文档。

3. **统一提示词运行方式**
   - 当前 `app/prompts/daily_planner_v1.md` 只是文档草案。
   - 运行时实际使用 `app/services/ai_planner.py` 中的 `SYSTEM_PROMPT` 常量。
   - 后续应决定是否从 Markdown 加载，并增加提示词版本与加载失败测试。

4. **修正七日复盘口径**
   - 产品计划要求“最近 7 个实际执行日”。
   - 当前 `weekly_review()` 实际查询最近 7 个自然日，需在修改前再次与用户确认。

5. **启动器环境优化**
   - 当前启动器使用 PATH 中的 `python`，本机已验证可用。
   - 若要提高可移植性，可优先使用 `.venv\Scripts\python.exe`，不存在时再回退 PATH。

6. **后续阶段**
   - 用户实际使用并校准后，再单独规划 PushDeer 提醒和 Termux 常驻部署。
   - 当前不做账号、云同步或外网公开访问。

7. **工程清理**
   - `pip install -e` 生成了 `daily_plan_webapp.egg-info/`，目前未加入 `.gitignore`。
   - 当前没有 Git 仓库；如需版本管理，应先按用户意愿初始化并确认忽略项。

---

## ⚠️ 6. 不可触碰的红线

- **🚫 DO NOT 绕过人工审批**：AI 只能给草稿，不能直接发布或自动确认任务。
- **🚫 DO NOT 自动顺延未完成任务**：未完成项必须进入待审池，由用户决定重排、拆小或放弃。
- **🚫 DO NOT 向 AI 发送敏感原文**：只允许发送抽象状态、候选任务和非敏感统计。
- **🚫 DO NOT 让 AI 修改康复安全边界**：疼痛、卡住、打软、肿胀等情况只能停止训练并提示专业评估。
- **🚫 DO NOT 在前端或数据库保存 API 密钥**：密钥只从 `.env` 读取。
- **🚫 DO NOT 删除或覆盖 `data/daily_plan.db`**：这是用户真实本地数据，修改模型或清理前先备份并确认。
- **🚫 DO NOT 在 `启动今日航线.cmd` 正文加入中文**：UTF-8 无 BOM 会被 `cmd.exe` 拆成乱码命令；文件名可以保持中文。
- **🚫 DO NOT 删除 `pyproject.toml` 的 setuptools 包发现配置**：否则会再次出现多个顶层包发现错误。
- **🚫 DO NOT 把计划文档当成当前实现**：以代码、测试和本交接文档记录的真实差异为准。
- **🚫 DO NOT 使用自动浏览器代理替代用户 UI 验证**：按根目录规范写明手动测试步骤，由用户亲自确认体验。
- **务必重视环境锁定**：Antigravity 接手后只读 `.gemini/antigravity-ide/skills/`，不得跨读 `.agents/skills/`。

---

## 🔑 7. 关键配置与外部依赖

| 配置项 | 说明 |
|---|---|
| `DEEPSEEK_BASE_URL` | 兼容 OpenAI API 的服务地址，默认 `https://api.deepseek.com/v1` |
| `DEEPSEEK_API_KEY` | DeepSeek 密钥；当前未配置，严禁提交或记录到文档 |
| `DEEPSEEK_MODEL` | 模型名称，示例值为 `deepseek-chat`，需按实际供应商确认 |
| `DEEPSEEK_TIMEOUT` | AI 请求超时秒数，默认 20 |
| `DATABASE_PATH` | SQLite 路径，默认 `data/daily_plan.db` |
| Python | 要求 3.11 或更高版本 |
| 端口 8000 | 本地网页默认端口；被占用时启动器自检会报告 |

## 交接后的建议读取顺序

1. `AGENTS.md`
2. `HANDOFF.md`
3. `docs/README.md`
4. 与下一项任务相关的单份模块文档
5. 对应源码和测试文件

