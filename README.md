# 今日航线

一个单用户的每日计划与执行 Web App，把“早上生成草稿、人工确认、白天记录执行、晚上复盘”串成一条航线。

## 当前状态

- 线上站点：`https://daily-plan-aliyun.tail095eb1.ts.net/`
- GitHub：`https://github.com/cixia-zhao/daily-plan`，当前为公开仓库
- 主分支：`main`
- 主要开发设备：Arch 主机
- 接力开发设备：小米平板 Linux
- 阿里云：只负责运行、数据和备份，不承担日常开发
- 生产服务：`daily-plan.service`，监听 `127.0.0.1:8000`
- 生产数据：`/var/lib/daily-plan/daily_plan.db`
- 自动备份：每天 03:30，保存在 `/var/backups/daily-plan`

```text
Arch / 小米平板  -- Commit + Push -->  GitHub
                                            |
                                            +--> 阿里云部署已确认版本

GitHub：源码版本中心
阿里云：运行程序 + SQLite 真实数据 + 备份
```

## 核心使用流程

1. 在“今天”页选择精力、可用时间和当天类型。
2. 本地规则生成草稿，由用户修改和确认。
3. 进入执行台，记录有效时间、计总标签和中断。
4. 晚上完成单日复盘，需要时再做七日复盘。

项目坚持：草稿必须人工确认；未完成任务只进入待审池，不自动顺延。

GPT 协作目前是手工链路：复制提示词到外部对话，再把有用结果贴回项目留档；它不会自动替用户做决策。

## 技术与目录

- FastAPI + Jinja2
- SQLite
- 原生 JavaScript + CSS
- Python 3.11+；生产当前使用 Python 3.12

```text
app/main.py          应用入口、页面路由和登录
app/api.py           计划、执行、复盘、设置和备份接口
app/services/        本地规则与可选 AI 兼容逻辑
app/templates/       页面模板
app/static/          前端脚本和样式
tests/               自动测试
deploy/              服务器运行与备份脚本
```

## 本地开发

```bash
git clone git@github.com:cixia-zhao/daily-plan.git
cd daily-plan
python -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"
.venv/bin/python -m uvicorn app.main:app --reload
```

本地默认地址是 `http://127.0.0.1:8000`。开发模式默认不要求生产登录密码。

提交前验证：

```bash
.venv/bin/python -m pytest -q
node --check app/static/app.js
.venv/bin/python -m compileall -q app tests
```

2026-09-27 状态：服务器 Python 3.12 下 64 项测试全部通过。Arch 的 Python 3.14 与当前 FastAPI/Starlette `TestClient` 组合会卡住，开发测试建议优先使用与生产一致的 Python 3.12。

## 生产环境

“生产环境”是服务器上正在给用户使用的那一份：

```text
/srv/workspaces/daily-plan             部署用源码副本，不在这里开发
/opt/daily-plan/current                正在运行的程序
/etc/daily-plan/daily-plan.env         生产配置与 Secret
/var/lib/daily-plan/daily_plan.db      真实运行数据
/var/backups/daily-plan                服务器本机备份
```

不要在生产目录直接开发，不要把 `.env`、密码、API Key 或 SQLite 数据库提交到 Git。部署前先备份数据库并确认 GitHub 版本已测试。

## 文档

- [Tutor.md](Tutor.md)：日常操作、多设备接力和 Agent 快速概览
- [HANDOFF.md](HANDOFF.md)：当前状态、风险和未完成事项
- [docs/README.md](docs/README.md)：模块文档索引
- [docs/cloud-private-deploy.md](docs/cloud-private-deploy.md)：服务器部署历史说明；其中“私有入口”与当前 Funnel 入口不完全一致
- [docs/termux-guide.md](docs/termux-guide.md)：历史手机 Termux 方案，已不是当前主架构
