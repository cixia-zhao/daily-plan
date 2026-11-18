# AGENTS.md — 开发纪律、架构契约与安全边界

本文件是「今日航线」（`daily-plan`）的最高工程守则。任何 AI 代理或开发者在动手修改前，请按以下顺序快速对齐上下文：

1. **必读顺序**：`AGENTS.md` -> `HANDOFF.md` -> `README.md` -> 按需查阅 `DESIGN.md`、`docs/backend-api.md`、`docs/frontend.md`。
2. **严禁默认扫描冷归档目录**：
   - `docs/archive/` 存放早期单次调研稿、十月份旧发布单、历史截图与废弃脚本，**除非用户明确点名查阅历史背景，否则严禁遍历或读取 `docs/archive/`**，以免浪费上下文。
   - 严禁读取或扫描 `.agents/skills/` 目录。
   - 根目录下的 `规划文档/` 为用户个人长期规划材料，除非用户主动要求，不要移动或改写。

---

## 一、运行环境与工具锁定

1. **Python 解释器**：
   - 本机开发、运行 `pytest`、执行 Playwright 隔离测试与启动独立预览服务，**一律使用 `.venv-preview/bin/python`（Python 3.12）**。不要使用根目录旧 `.venv`。
2. **数据库隔离铁律**：
   - 自动化测试必须显式指定临时目录中的 SQLite 数据库（如 `/tmp/...`），并设置 `APP_RUNTIME=development`、禁用真实 AI 与真实手机通知。
   - 独立 UI 预览统一通过 `./preview-ui.sh --lan` 启动，仅读写 `data/ui-preview.db` 与 `data/ui-preview-backups/`。
   - **生产数据库（`/var/lib/daily-plan/daily_plan.db`）严禁用于任何实验或测试**。
3. **浏览器测试方式**：
   - UI 端到端与多视口回归测试统一使用仓库内置的无头隔离运行器：
     - `.venv-preview/bin/python tests/run_isolated_browser.py tests/<script>.cjs`
     - `.venv-preview/bin/python tests/run_pwa_browser.py`

---

## 二、架构分层与反技术债守则

### 1. 后端分层（`app/`）
- **入口与中间件**：`app/main.py`（会话认证、私有页 `Cache-Control: no-store`、PWA 公开壳资源、按日期分流当日执行页与历史记录页）。
- **门面与路由层**：`app/api.py` 仅作为向后兼容导出门面；HTTP 路由按职责拆分在 `app/routers/{plans,execution,reviews,settings}.py`，共享依赖与事务辅助在 `app/routers/deps.py`。
- **领域引擎与统一基础设施（`app/services/`）**：
  - `clock.py`：**全站唯一东八区（`Asia/Shanghai`）时间源**。严禁在业务代码中裸调 `date.today()` 或在模块导入期固化当天日期。
  - `catalog.py`：**全站唯一科目能力目录**（默认标题、默认事项类型、是否计入学习目标、是否支持背单词词数、子科目、常用分钟候选、色板索引与图标键）。严禁在路由或前端散落 `if category == 'math'` 等硬编码魔法分支。
  - `prompts.py`：集中维护 AI 规划与复盘系统提示词，以及 `parse_llm_json()` 代码围栏剥离解析器。
  - `execution_engine.py` / `review_engine.py` / `settings_store.py`：核心状态机与聚合逻辑。
- **并发与事务纪律**：
  - 所有写接口必须通过 `begin_immediate(connection)`（`BEGIN IMMEDIATE`）获取写锁；**严禁在持有 SQLite 连接或事务期间发起外部 HTTP / LLM 请求**。
  - **所有 `GET` 请求与 `/return-today` 必须保持 100% 纯只读**，严禁在读请求中隐式 `UPDATE` / `INSERT` 数据库（以确保只读快照对比与备份一致性）。
  - 后台轮询（`auto_stop.py`、`reminders.py`）先做轻量只读探测，无到期记录绝不开启写事务。
  - 保持 SQLite 默认 rollback journal + `busy_timeout = 5000`，**不要开启 WAL 模式**（避免破坏 `deploy/release.py` 的 `mode=ro` URI 快照校验）。

### 2. 前端模块化与渐进增强（`app/static/` & `app/templates/`）
- **无构建原生架构**：不使用打包器，也不将浏览器脚本改为 `type="module"`（保持兼容 `node:vm` 单元测试与离线缓存）。全局共享能力收敛在 `app.js`（及 `window.DailyPlan`、`window.PlanUI`、`window.PlanVisuals`），页面逻辑按需加载：
  - 今天页：`today.js` + `today.css`
  - 执行页：`execution.js`
  - 复盘页：`execution.js`（`recordsOnly` 抽屉模式，零常驻轮询）+ `review.js` + `review.css`
  - 历史执行页：`execution.js`（`recordsOnly` 内联模式）+ `history.js` + `history.css`
  - 设置页：`settings.js`
  - GPT 工作台：`workbench.js`
- **交互铁律**：
  - 全站严禁调用原生 `window.confirm()`、`window.alert()`、`window.prompt()`，统一使用纸面弹窗或卡片内联编辑器。
  - 前端获取当天日期统一调用 `todayIso()`（锁定 `Asia/Shanghai` 时区）。
  - 表单与模板编辑必须兼容中文输入法（`compositionstart` / `compositionend`），自动保存不得在编辑态强制重置输入框光标。

---

## 三、视觉与交互红线（详见 `DESIGN.md`）

1. **暖沙纸书刊质感**：全站统一使用暖沙纸底 `#f4f1e9`、浅操作面 `#fffdf8`、暖炭黑 `#29251f`、克制陶土强调色 `#ac624a`。**严禁重新引入早期森林绿/薄荷绿色值、毛玻璃发光、彩虹胶囊徽章或层层嵌套大卡片**。
2. **一屏高度与触控预算**：
   - 今天页已生成清单在手机（`390×844`）与平板视口必须尽量一屏盛放核心主航线与底部确认按钮。
   - 常用按钮、输入框、图标按钮触控热区不小于 `44×44px`；移动端表单字号不小于 `16px`（防止 iOS 自动放大视口）。
   - 全站所有弹窗统一具备右上角线性关闭叉号（`ui-icon-button-close`）、`Esc` 关闭与遮罩外侧点击关闭。
3. **界面文案**：自然克制的简体中文，删掉自嗨口号与冗余长说明，不在中文标签后附带英文括号注释。

---

## 四、Git 提交与生产发布规范

1. **先预览、后推送**：日常需求与界面优化必须先在本地通过全套隔离测试并更新 `./preview-ui.sh --lan` 预览环境，**未经用户明确确认授权，不得执行 `git commit`、`git push` 或登录生产服务器部署**。
2. **生产服务器信息**（仅获授权后执行）：
   - 主机：`aliyun`（`120.55.53.215`），普通运维用户 `codexdev`，服务 `daily-plan.service`
   - 目录：入口 `/opt/daily-plan/current`，版本库 `/opt/daily-plan/releases/<commit>`，生产库 `/var/lib/daily-plan/daily_plan.db`，备份 `/var/backups/daily-plan/`
   - 标准四步发布：`deploy/release.py` 的 `stage` -> `precheck` -> `deploy` -> `verify`（**执行 `deploy` 与 `verify` 必须使用目标发布目录自身的 `.venv/bin/python`**，详见 `docs/releases/2026-11-15-goal-border.md`）。
   - 严禁读取、打印或将 `/etc/daily-plan/daily-plan.env` 中的任何密钥写入仓库或日志。
