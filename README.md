# 今日航线

一个单用户、本地优先、先确认再执行的每日任务 Web App。

它不是“自动替你安排一切”的 AI 产品。当前更真实的定位是：把晨间输入、任务草稿、人工确认、白天执行记录、单日复盘和周整理串成一个能长期跑的本地闭环；GPT 协作已经接上，但还不是当前主要实际使用路径。

## 当前真实状态

- 当前工作区：`C:\Users\cixia\Desktop\project\daily plan`
- 当前手机部署目录：`/storage/emulated/0/daily-plan`
- 当前主路径：Windows 本地运行，或 Android 上通过 `Termux + 手机浏览器` 运行
- 当前最成熟的实际使用链路：
  - 早上选择状态
  - 本地规则生成草稿
  - 人工修改并确认清单
  - 执行台记录白天时间段与统计
  - 晚上写单日复盘
- 当前已经做了但还不是主要实战主路径的部分：
  - GPT 协作留档
  - 七日复盘与周报沉淀
  - DeepSeek 兼容入口

## 已实际使用过的主流程

### 1. 今天页生成草稿

早上输入这些信息后，系统会优先用本地规则生成一版任务草稿：

- 精力档位
- 可用时间
- 当天类型
- 膝盖是否异常

这一段不依赖外部 API，不需要账号，不联网也能跑主流程。

### 2. 草稿和正式执行分离

草稿生成后不会自动变成正式清单。你需要自己修改、确认，确认后才进入执行阶段。

这条边界是当前产品最重要的原则之一：

- 不绕过人工确认
- 不自动把草稿变成正式执行清单
- 不把“生成能力”误当成“决策能力”

### 3. 执行台记录白天真实发生的事

确认后的日期会进入执行台，当前已经支持：

- 开始任务有效时间
- 切到计总标签或中断标签
- 补记、编辑、删除时间段
- 自动汇总任务执行统计
- 已确认日期在桌面端和手机端共用同一套执行台语义

执行台现在是白天真实记录的主入口，不再鼓励在今天页直接维护主任务实际分钟。

### 4. 单日复盘

晚上可以在单日复盘页回看当天任务执行看板，并填写结构化复盘内容，例如：

- 情绪
- 最卡点
- 有效方法
- 小优化
- 真实推进感
- 明天继续保持的一条
- 补充正文

这部分已经是实际使用过的链路，不只是演示能力。

## 已实现但未充分实战验证的部分

### GPT 协作

当前已经实现：

- 单日复盘页可复制 GPT 提示词
- 七日复盘页可复制 GPT 提示词
- 可以把 GPT 回复贴回项目留档
- 可以保存“准备采用的内容”
- `GPT 工作台` 可统一管理模板和历史记录

但当前不要把它理解成下面这些能力：

- 项目内自动调用 GPT
- 自动解析 GPT 回复
- 自动把 GPT 结论改写成任务
- 自动替你做审批或决策

也就是说，当前 GPT 更像“项目整理上下文，你在外部对话，结果再带回项目”的手工协作链路。

### 七日复盘与周报

当前已经实现：

- 按所选日期所在自然周查看统计
- 回看和编辑周内某一天复盘
- 保存最终周报正文
- 留存历史周报

但这部分虽然功能已在，仍应视为“已实现但未充分长期实战验证”，不要直接包装成成熟的 AI 周教练系统。

### DeepSeek 兼容入口

代码里仍保留兼容 OpenAI 风格接口的 `DEEPSEEK_*` 配置：

- 每日草稿可选 AI 调整
- 周复盘可选自动分析

但当前第一主路径并不依赖它，也不建议把它当作项目的核心卖点。

## 技术栈与运行结构

### 技术栈

- 后端：FastAPI
- 模板层：Jinja2
- 数据库：SQLite
- 前端：原生 JavaScript + CSS
- 运行时：Python 3.11

### 项目结构

- `app/main.py`：FastAPI 入口与页面路由
- `app/api.py`：计划、执行、复盘、设置与 GPT 留档接口
- `app/services/`：本地规则、AI 兼容入口、周分析服务
- `app/templates/`：今天页、执行台、复盘页、设置页等模板
- `app/static/`：前端脚本和样式
- `data/daily_plan.db`：默认 SQLite 数据文件

## 使用与部署

### Windows 本地运行

首次安装：

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
Copy-Item .env.example .env
```

日常启动：

- 直接双击根目录的 `启动今日航线.cmd`
- 或手动运行：

```powershell
.venv\Scripts\python -m uvicorn app.main:app --reload
```

默认访问地址：

```text
http://127.0.0.1:8000
```

### Android + Termux 运行

当前手机推荐方案不是 APK，也不是先做打包壳，而是：

1. 用 Termux 启动本地 Python 后端
2. 用手机浏览器访问 `http://127.0.0.1:8000`
3. 跑通后把网页添加到主屏幕

首次安装和后续更新的完整说明见 [docs/termux-guide.md](docs/termux-guide.md)。

当前手机日常最短操作：

- 平时启动：`dp`
- 更新并启动：`spdp`

### 当前推荐部署形态

- 电脑：本地工作区直接运行
- 手机：`Git 工作区 + Termux + dp/spdp + 浏览器`
- 不推荐再把“电脑打 zip 覆盖到手机”当成长期主链路

如果只是临时把电脑当前未提交版本带到手机，仍然可以使用：

```powershell
& "C:\Users\cixia\AppData\Local\Programs\PowerShell\7\pwsh.exe" -File .\share-to-phone.ps1 -Serve
```

但这条路径是备用方案，不是当前推荐的长期部署方式。

## 配置与数据

### `.env`

项目根目录可复制 `.env.example` 为 `.env`。当前主要配置项：

```dotenv
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_TIMEOUT=20
DATABASE_PATH=data/daily_plan.db
```

### 配置说明

- `DATABASE_PATH`
  - 默认值是 `data/daily_plan.db`
  - Windows 和 Termux 都默认用这一路径
- `DEEPSEEK_*`
  - 只由后端读取
  - 不会进入网页、SQLite 或设置接口
  - 当前不是主流程必需项

### 数据与备份

- 默认数据库文件：`data/daily_plan.db`
- 直接备份这个文件即可完成最核心的数据备份
- 手机侧 `spdp` 更新前会先备份数据库到 `backups/`

## 测试与最小验证

常用测试命令：

```powershell
python -m pytest -q
python -m compileall app tests
```

文档层最小验证建议：

1. Windows 上双击 `启动今日航线.cmd`，确认能打开主页。
2. 今天页完成一轮“晨间输入 -> 草稿 -> 确认”。
3. 执行台记录至少一段有效时间，确认统计正常刷新。
4. 单日复盘页确认能看到任务执行看板并保存复盘。
5. 如在手机侧使用，再验证一次 `dp` 或 `spdp`。

## 文档导航

- [HANDOFF.md](HANDOFF.md)：给后续接手开发的人看当前状态、红线和优先级
- [docs/README.md](docs/README.md)：模块文档索引
- [docs/cloud-deployment-primer.md](docs/cloud-deployment-primer.md)：给小白看的云端部署概念说明
- [docs/cloud-private-deploy.md](docs/cloud-private-deploy.md)：阿里云 + Tailscale 私有部署步骤
- [docs/termux-guide.md](docs/termux-guide.md)：手机 Termux 安装、迁移、更新、排错总说明
- [docs/backend-api.md](docs/backend-api.md)：后端接口与脚本链路
- [docs/backend-services.md](docs/backend-services.md)：规则、AI 兼容入口与安全边界
- [docs/frontend.md](docs/frontend.md)：前端页面结构与交互

## 一句话给 GPT 的背景

如果你要把项目背景发给 GPT，最接近当前真实状态的说法是：

> 我有一个本地优先的个人任务执行 Web App，叫“今日航线”。它当前已经稳定跑通的主流程是：早上选状态、生成本地规则草稿、我手动修改并确认清单、白天在执行台记录时间段和统计、晚上写单日复盘。它也已经接上了 GPT 协作链路，但现在主要是复制提示词到外部 GPT 对话，再把回复贴回项目留档，而不是项目内自动调用 GPT 或自动替我生成任务决策。
