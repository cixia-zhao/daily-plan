# 今日航线使用与维护教程

> 前面给项目主人看，最后一节给 Agent 快速接手。
> 登录密码、API Key 和数据库不写进文档。

## 1. 平时使用网站

1. 打开 `https://daily-plan-aliyun.tail095eb1.ts.net/`。
2. 输入已保存的访问密码。
3. 早上生成草稿，修改后点“确认今日清单”。
4. 在执行台记录实际时间。
5. 晚上进入单日复盘。

网站长期运行在阿里云。手机、Arch 和小米平板都只需浏览器，不用各自启动一份程序。

忘记密码时，旧密码无法从哈希还原。让 Agent 在服务器上“备份配置 -> 替换密码哈希 -> 重启 -> 真实登录验证”，不要手工盲改 `.env`。

## 2. 四个层次

| 东西 | 用途 | 是不是真实用户数据 |
|---|---|---|
| GitHub 仓库 | 源码和版本历史 | 否 |
| Arch / 小米平板 Clone | 写代码、测试、Commit | 否 |
| 服务器生产程序 | 长期运行网站 | 否 |
| 服务器 SQLite | 计划、执行和复盘数据 | **是** |

更新源码不等于同步数据库。GitHub 不用来保存真实 SQLite 数据。

## 3. Arch 主机开发

项目位置：`/home/cixia/项目/daily-plan`

每次开始前：

```bash
cd /home/cixia/项目/daily-plan
git status --short --branch
git pull --ff-only
```

如果 `git status` 显示未提交修改，先别 Pull，让 Agent 判断这些修改是否需要保留。

本地启动：

```bash
.venv/bin/python -m uvicorn app.main:app --reload
```

打开 `http://127.0.0.1:8000`。这是开发副本，不读取服务器真实数据。

完成修改后：

```bash
git status --short
git diff
.venv/bin/python -m pytest -q
node --check app/static/app.js
git add <本次确认要提交的文件>
git commit -m "简洁说明这次修改"
git push origin main
```

Arch 当前的 Python 3.14 会让 FastAPI 测试客户端卡住。暂时优先用 Python 3.12 开发/测试，或让 Agent 用与生产一致的隔离环境验证；不要因此盲改业务代码。

## 4. 小米平板接力

平板第一次准备：

```bash
mkdir -p ~/项目
cd ~/项目
git clone git@github.com:cixia-zhao/daily-plan.git
cd daily-plan
python -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"
```

平板也需要它自己的 GitHub SSH 授权。不要从 Arch 手工复制整个项目文件夹；`.env`、`.venv` 和本地数据库不通过 GitHub 同步。

接力规则：

```text
设备 A：修改 -> 测试 -> Commit -> Push
设备 B：开始工作前 Pull
```

如果两边都改了，不要强制 Push、Reset 或大规模 Merge，先保留现场交给 Agent 比较。

## 5. 更新服务器

服务器不是开发设备，不要在 `/opt/daily-plan/current` 直接改代码。

正式部署顺序：

1. Arch 或平板完成修改和测试。
2. Commit 并 Push 到 GitHub。
3. 确认要部署的 Commit ID。
4. 先备份 `/var/lib/daily-plan/daily_plan.db`。
5. 服务器部署该 Commit。
6. 重启后检查登录页、健康接口和真实登录。
7. 出错时回退程序版本，不要覆盖数据库。

当前还没有收敛成小白可盲跑的一键部署命令。每次部署先让 Agent 列出“Commit、备份位置、将改变什么、如何回退”。

## 6. 备份与安全

- 服务器每天 03:30 自动备份到 `/var/backups/daily-plan`。
- 项目设置页可手动导出 SQLite 快照。
- 当前备份仍在同一台服务器，不等于异地灾备。
- GitHub 只备份源码，不备份运行数据。
- 生产配置在 `/etc/daily-plan/daily-plan.env`，不读出、不上传、不提交。

## 7. Git 操作影响哪一层

| 操作 | 影响范围 |
|---|---|
| 修改文件 | 当前设备工作区 |
| `git add` | 暂存区 |
| `git commit` | 当前设备本地仓库 |
| `git push` | GitHub |
| `git pull --ff-only` | 当前设备工作区和本地仓库 |
| 服务器部署 | 生产程序，有运行影响 |
| 修改 SQLite | 真实用户数据，高风险 |

## 8. 遇到 Git 错误

Pull 时有本地修改：

```bash
git status --short --branch
git diff
```

Push 被拒绝：

```bash
git fetch origin
git status --short --branch
git log --oneline --graph --decorate --all -15
```

把结果给 Agent。不要直接 `reset --hard`、`clean -fd` 或强制 Push。

## 9. 给 Agent 的快速概览

```text
项目：今日航线（FastAPI + Jinja2 + SQLite + 原生 JS）
版本中心：GitHub cixia-zhao/daily-plan，main
主开发机：/home/cixia/项目/daily-plan
接力开发：小米平板独立 Clone
服务器：只运行与备份，不开发
生产：/opt/daily-plan/current
数据：/var/lib/daily-plan/daily_plan.db
配置：/etc/daily-plan/daily-plan.env
备份：/var/backups/daily-plan
边界：草稿必须人工确认；未完成任务不自动顺延
最后验证：Python 3.12 下 64 tests passed
已知环境问题：Arch Python 3.14 TestClient 卡住
请勿读取或输出 Secret，请勿直改生产数据库
```
