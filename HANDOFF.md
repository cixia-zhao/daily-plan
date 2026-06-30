# 项目交接文档

> 最后更新：2026-06-30
> 当前环境：Codex / 常规环境
> 交接方向：先把“本地执行记录 + 手机实用链路”跑顺，再根据首日真实使用反馈微调

## 1. 项目概览与环境

- 项目名称：今日航线
- 工作区路径：`C:\Users\cixia\Desktop\daily plan`
- 技术栈：FastAPI + Jinja2 + SQLite + 原生 JavaScript / CSS
- 当前产品定位：单用户、本地优先的每日任务执行与复盘 Web App
- 当前主流程：晨间输入 → 生成草稿 → 人工确认 → 执行台记录时间段 → 晚间提交与复盘 → 需要时复制给 GPT 协作
- Windows 启动方式：双击 `启动今日航线.cmd`，或手动运行 `uvicorn app.main:app --reload`
- 安卓手机启动方式：Termux 进入项目目录后执行 `bash ./termux-start.sh`，浏览器访问 `http://127.0.0.1:8000`
- 当前“传到手机”方式：电脑运行 `share-to-phone.ps1 -Serve` 打包并临时开下载地址，手机下载压缩包后解压到 `/storage/emulated/0/daily-plan`
- 构建与部署现状：没有前端构建链，也没有正式 APK；当前最稳方案仍是“Termux 起后端 + 手机浏览器访问”

## 2. 本次会话已完成的工作

### A. 执行台与任务时间看板第一版

**文件**：`app/main.py`、`app/api.py`、`app/database.py`、`app/models.py`、`app/schemas.py`、`app/templates/base.html`、`app/templates/index.html`、`app/templates/execute.html`、`app/templates/review.html`、`app/templates/settings.html`、`app/static/app.js`、`app/static/style.css`、`tests/test_api.py`、`tests/test_ui_and_settings.py`

- 新增独立 `/execute` 页面，白天执行不再主要依赖今天页，而是在执行台里开始任务有效时间、切换标签、补记时间段、勾选完成并直接提交今日情况。
- 新增 `task_execution_segments` 时间段模型，按 `effective`、`counted_label`、`interrupt_label` 三类存明细；任务总时间实时聚合为“有效时间 + 计总标签时间”。
- 设置新增 `execution_labels`，内置“上厕所 / 走动 / 打游戏 / 吃饭 / 突发 / 手动暂停”，支持自定义；系统标签可改名不可删。
- 单日复盘页新增任务执行看板；今天页确认后主按钮改成“进入执行台”，主任务实际分钟改为只读展示，避免出现两套数据源。
- `POST /api/daily-plans/{date}/submit` 现在会先拦截未停止的激活段，再把主任务 `actual_minutes` 同步为有效时间；副航线仍按有效时间 `>= 30` 自动完成。

### B. 手机落地最小链路

**文件**：`termux-install.sh`、`termux-start.sh`、`share-to-phone.ps1`、`docs/termux-quickstart.md`、`docs/phone-transfer.md`、`README.md`、`docs/README.md`、`tests/test_launcher.py`

- 增加 Termux 最小安装与启动脚本，手机上只需要进项目目录后运行安装脚本和启动脚本即可，不依赖电脑端启动器。
- 新增 `share-to-phone.ps1`，会打出 `dist/daily-plan-termux.zip`，排除 `.git`、`data`、`.env` 和缓存目录，并可临时起下载服务给手机下载。
- `termux-quickstart.md` 已重写成“只有手机也能照着走”的版本，路径默认是 `/storage/emulated/0/daily-plan`，并专门处理了 `termux-setup-storage` 的 `y/n` 提示坑。
- 当前结论已经明确：先不要把这版说成 APK 或原生 App；明天最稳妥的真实用法就是 Termux 起本地后端，再把网页添加到主屏幕。

### C. 交接与模块文档同步

**文件**：`HANDOFF.md`、`docs/README.md`、`docs/backend-api.md`、`docs/frontend.md`

- 这几份文档已同步到“执行台 + 时间段 + Termux 手机链路”的当前真实状态，供明天新窗口直接恢复上下文，不必再从旧的 GPT 工作台版本脑补现状。

## 3. 历史工作沉淀

### A. 本地草稿与人工确认主流程

- 今天页已经稳定为“晨间输入 -> 草稿 -> 手动调整 -> 审阅确认”的流程，未完成任务只进入待审池，不自动滚入下一天。
- 主副航线仍保持五槽位心智，桌面端对齐优先；主任务是否完成仍由用户手动判断。

### B. GPT 手工协作与留档

- 单日复盘、七日复盘和 GPT 工作台都已经支持“复制提示词给 GPT -> 把回复贴回项目留档”的手工协作闭环。
- GPT 回复原文和采用备注走独立 `gpt_collab_records` 表，不会直接污染正式复盘字段。

### C. 周视角与当前边界

- 七日复盘现在按所选日期所在自然周统计，不是最近 7 个实际执行日。
- DeepSeek 兼容入口仍保留，但它不再是当前第一主叙事；更值得继续打磨的是本地执行闭环和手机可用性。

## 4. 核心文件地图

```text
daily plan/
├── HANDOFF.md                     # 新窗口优先读取的交接文档
├── README.md                      # 项目总说明与启动入口
├── share-to-phone.ps1             # 电脑打包并临时分享给手机下载
├── termux-install.sh              # 安卓 Termux 第一次安装依赖
├── termux-start.sh                # 安卓 Termux 每日启动本地服务
├── docs/
│   ├── README.md                  # 模块文档索引
│   ├── backend-api.md             # 后端接口、状态机、时间段模型速查
│   ├── backend-services.md        # 本地规则、GPT 协作与兼容旧 AI 逻辑
│   ├── frontend.md                # 页面、交互与执行台前端速查
│   ├── termux-quickstart.md       # 只有手机时的 Termux 实操说明
│   └── phone-transfer.md          # 电脑传到手机的最省事步骤
├── app/
│   ├── main.py                    # FastAPI 应用工厂与页面路由
│   ├── api.py                     # JSON API、计划状态机、执行聚合
│   ├── database.py                # SQLite 初始化与补表逻辑
│   ├── models.py                  # 全量建表 SQL
│   ├── schemas.py                 # Pydantic 输入输出模型
│   ├── services/
│   │   ├── ai_planner.py          # 兼容旧 DeepSeek 日计划入口
│   │   └── task_rules.py          # 本地规则与任务草稿生成
│   ├── templates/
│   │   ├── index.html             # 今天页
│   │   ├── execute.html           # 执行台
│   │   ├── review.html            # 单日复盘页
│   │   ├── weekly.html            # 七日复盘页
│   │   ├── gpt_workbench.html     # GPT 协作工作台
│   │   └── settings.html          # 设置页与执行标签配置
│   └── static/
│       ├── app.js                 # 全部页面交互
│       └── style.css              # 页面视觉与响应式布局
└── tests/                         # API、页面资产和脚本验证
```

## 5. 当前进度与待办事项

1. **首日真机试用校准**：明天按真实一天去跑执行台，重点观察“有效时间 / 计总标签 / 中断标签”的切换语义是否顺手。
2. **手机端细节打磨**：根据真机反馈继续修表单触控、时间轴编辑、按钮文案和空态提示。
3. **传机与启动体验补坑**：如果明天还遇到目录、端口、下载地址或浏览器入口问题，优先修文档和脚本，不急着上 APK。
4. **复盘统计再迭代**：如果任务执行看板的数据已经足够有用，再考虑更细分类或更强图形化；当前先不要上复杂图表库。

## 6. 不可触碰的红线

- 🚫 DO NOT 绕过人工确认直接开始正式执行：今天页的草稿必须先由用户确认，不能自动变成正式清单。
- 🚫 DO NOT 恢复“未完成任务自动顺延”：未完成任务只进待审池，不自动滚入下一天。
- 🚫 DO NOT 把 GPT 回复自动写回正式复盘字段：GPT 回复只能留档或手动采用，不能自动当成结构化真相。
- 🚫 DO NOT 把密钥写进前端、数据库或设置接口：`.env` 仍只由后端读取。
- 🚫 DO NOT 覆盖或删除用户本地 `data/daily_plan.db`：这个库是真实数据，改表前要先考虑备份。
- 🚫 DO NOT 破坏“同一时刻只有一个激活段”的前提：执行台任何开始或切换都必须先关掉旧段再开新段。
- 🚫 DO NOT 把中断标签并入任务总时间：任务总时间只等于“有效时间 + 计总标签”，中断标签只展示不并入。
- 🚫 DO NOT 假定手机项目目录是 `~/daily-plan`：当前文档和脚本默认以 `/storage/emulated/0/daily-plan` 为主路径。
- 🚫 DO NOT 把当前方案宣传成 APK、PWA、离线缓存或自启动已完成：这些都还没做，现在只是浏览器壳式本地网页。

## 7. 关键配置与外部依赖

| 配置项 | 说明 |
|---|---|
| `DATABASE_PATH` | 后端数据库路径；默认是 `data/daily_plan.db`，Termux 启动脚本也依赖它 |
| `PORT` | 服务端口；Termux 默认 `8000`，需要时可临时切到别的端口 |
| `DEEPSEEK_BASE_URL` | 兼容旧 AI 入口地址；当前不是主流程必需 |
| `DEEPSEEK_API_KEY` | 启用兼容旧 AI 入口时才需要；为空时应用照样可本地运行 |
| `DEEPSEEK_MODEL` | 兼容旧 AI 使用的模型名；默认 `deepseek-chat` |
| `dist/daily-plan-termux.zip` | `share-to-phone.ps1` 生成的手机分发包，不包含真实数据库和密钥 |

## 8. 当前验证状态

本轮与这轮功能相关的验证已跑过：

- `python -m pytest -q`
- `python -m compileall app tests`
- `node --check app/static/app.js`
- 浏览器侧已做过执行台主流程验证：开始任务、切标签、停止、补记、提交、复盘页看板展示
