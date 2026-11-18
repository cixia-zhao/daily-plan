# 今日航线（Daily Plan）

一套面向个人深度学习与秩序重建的日常闭环 Web 应用。围绕**晨间定目标 → 执行台真实计时 → 日周复盘与 GPT 协作**三条主线运转，采用暖沙纸书刊视觉风格、SQLite 单文件存储与零构建原生前后端架构。

---

## 核心闭环能力

1. **今天（`/`）**：按自定主航线科目填写当日目标分钟（支持历史常用分钟快捷候选），一键生成规则或 AI 辅助草稿；支持主副航线互换、子科目切换，以及无原生弹窗的内联纸面待审池（重排、拆小、放下）。
2. **执行（`/execute`）**：专注课程推进与秒级时间段记录。支持有效学习细分切换、分心与休息/生活活动归类、活动到点提醒（`ntfy`）、计时卡圆角周长目标进度、预设自动停止、一键「修正时间」（支持划出刚才活动或补回已开始学习，可随时撤销）、英语背单词词数累计，以及历史日期只读回顾与时间段补记（`/execute?date=YYYY-MM-DD`）。
3. **复盘（`/review`）**：同页整合自然周进度条、日复盘与周复盘。自动核算学习有效率（`有效 ÷ (有效 + 分心)`，休息与生活单列不惩罚有效率）、前一日/上周同期对比图表；收尾表单本机防丢暂存，支持一键复制结构化事实与 ChatGPT 深聊并留档。
4. **GPT 工作台（`/gpt-workbench`）与设置（`/settings`）**：管理单日/单周协作提示词模板（支持防抖自动保存与历史留档查阅）；自定义主航线项目（最多 11 项）、晨间偏好、执行与有效细分标签，随时一键导出完整 SQLite 数据库快照。
5. **可安装 PWA**：支持桌面与手机主屏幕独立窗口安装、断网友好提示页与网络恢复自动重连探测，绝不在后台偷偷重放写入请求。

---

## 目录结构

```text
daily-plan/
├── app/
│   ├── main.py                  # FastAPI 应用工厂、认证与缓存头中间件、页面与 PWA 路由
│   ├── api.py                   # 兼容导出门面
│   ├── auth.py                  # 单用户 Argon2 密码校验与签名 Cookie 会话
│   ├── database.py              # SQLite 连接管理（busy_timeout）与幂等 Schema 演进
│   ├── models.py                # 完整数据表与索引定义
│   ├── schemas.py               # Pydantic 请求与响应契约
│   ├── routers/                 # 按领域拆分的 API 路由（plans / execution / reviews / settings）
│   ├── services/                # 核心领域服务（clock / catalog / prompts / execution_engine / review_engine 等）
│   ├── templates/               # Jinja2 服务端模板
│   └── static/                  # 原生 CSS 设计系统与按需拆分的页面 JS 模块、SVG 精灵图、PWA 资源
├── deploy/                      # 阿里云 systemd/Nginx 配置、release.py 原子发布与数据零损迁移校验脚本
├── tests/                       # Pytest 后端/契约测试 + Playwright 隔离多视口回归脚本（.cjs）
├── docs/                        # 现役架构、接口、设计偏好、运维手册（历史归档位于 docs/archive/）
├── preview-ui.sh                # 独立测试库 UI 预览启动脚本
└── HANDOFF.md                   # 当前线上发布状态、回退方式与最新开发交接单
```

---

## 本地开发与独立预览

### 1. 环境准备（Python 3.12）
```bash
python3.12 -m venv .venv-preview
.venv-preview/bin/pip install -e ".[dev]"
cp -n .env.example .env
```

### 2. 启动独立 UI 预览（推荐验收方式）
使用独立预览数据库 `data/ui-preview.db`，与正式数据完全隔离：
```bash
./preview-ui.sh --lan
```
启动后终端会输出本机与局域网访问地址（默认端口 `8765`，页面顶部带有「UI 预览 · 独立测试数据」横幅）。

### 3. 运行隔离测试套件
```bash
# 1. JS 语法与前端网络恢复单元测试
for f in app/static/*.js app/static/pwa/*.js; do node --check "$f"; done
node tests/network_recovery.cjs

# 2. 全量 Python 单元与接口契约测试（强制使用临时库）
TMP_DB=$(mktemp -d) && APP_RUNTIME=development DATABASE_PATH="$TMP_DB/test.db" DAILY_PLAN_BACKUP_DIR="$TMP_DB/backups" .venv-preview/bin/python -m pytest -q && rm -rf "$TMP_DB"

# 3. 真实 Chromium 多视口隔离端到端测试
.venv-preview/bin/python tests/run_isolated_browser.py tests/mobile_flows.cjs
.venv-preview/bin/python tests/run_pwa_browser.py

# 提醒交互专项：仅在临时库模拟通知，不外发
.venv-preview/bin/python tests/run_isolated_browser.py tests/notification_time_flows.cjs --preview-notifications
```

全量浏览器回归覆盖 `tests/*_flows.cjs`：普通场景使用 `run_isolated_browser.py`，`notification_time_flows.cjs` 额外传入 `--preview-notifications`，`pwa_flows.cjs` 使用专用 `run_pwa_browser.py`。局域网预览地址每次按当前默认路由动态识别，切换手机热点后以新启动输出为准。

---

## 生产部署与回退简述

正式环境运行于阿里云 Linux（`systemd` + `Nginx` + SQLite 单文件）。最新线上提交哈希、备份快照校验与原子回退步骤统一以 [HANDOFF.md](HANDOFF.md) 和 [docs/releases/2026-11-18-full-stack-refactor.md](docs/releases/2026-11-18-full-stack-refactor.md) 为准。
