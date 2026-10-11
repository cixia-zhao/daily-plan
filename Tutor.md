# 今日航线使用与维护教程

> 前面给项目主人看，最后一节给 Agent 快速接手。
> 登录密码、API Key 和数据库不写进文档。

## 1. 平时使用网站

1. 打开并收藏 `https://120.55.53.215/`。
2. 输入已保存的访问密码。
3. 早上填写各项目目标，看计划合计；生成草稿，修改后点“确认今日清单”。
4. 在执行台记录实际时间；未安排的 0 分钟项目也可以开始。
5. 晚上进入单日复盘。

网站长期运行在阿里云。手机、Arch 和小米平板都只需浏览器，不用各自启动一份程序。

2026-10-10 更换了访问入口，账号密码和学习数据没有变化。新地址需要重新登录。旧 Tailscale 地址缺少公共 DNS 记录，暂不作为书签；当前入口不需要设备加入 Tailscale。维护方式见 [服务器 HTTPS 入口](docs/server-https-entry.md)。

忘记密码时，旧密码无法从哈希还原。让 Agent 在服务器上“备份配置 -> 替换密码哈希 -> 重启 -> 真实登录验证”，不要手工盲改 `.env`。

## 新操作方式（开发完成，待部署）

- **晨间**：直接填数学、英语、408、运动目标，不再选择几小时可用时间。合计 330 分也能确认；实际超过目标可继续记录。精力三档仍保留。
- **未安排也能做**：在执行台展开“今日未安排”，点开始有效时间，结束后点停止。原目标仍为 0，不会自动完成。需要新增当天没列出的活动时，点“临时添加活动”，填名称、类别与事项类型，再点开始；已有记录不会丢失。
- **当天目标与具体事情分开**：普通科目时长选“每日目标”，运动选“习惯”；习惯在卡片中选择做了、没做或休息，休息不等于做了。提交报名表、完成某套试卷等明确事情，请主动选“具体待办”，做完主动勾完成。习惯和每日目标不会自动变成第二天的待审项；旧待审项仍可重排、拆小、放弃。
- **墨墨背单词**：在英语卡片旁或执行台顶部点“背单词 · 录入分钟”，输入墨墨显示的学习分钟数，保存即可。默认当前查看日期，无须选任务或起止时间。一天多次学习就新增多条，列表显示合计；修改按钮更新原条，删除会扣减统计。
- **两种背单词记录**：明确选择了背单词细分的计时与墨墨录入同时存在时，选“分别学习，保留两份”或只保留其中一种。选择作用于当天背单词记录，保留原明细并标注是否计入；英语阅读不受影响。删掉某份记录不会自动恢复之前排除的另一份，要主动重新选择保留方式。
- **复盘**：查看原目标与实际，英语和背单词分钟会展示在单日和周页，背单词已经包含在英语实际中。周统计沿用“提交今日情况”后的日期统计；改动已提交记录后需再提交。

勾“完成”或习惯“做了”不会凭空填写分钟数；实际时长请用计时、已有通用记录入口或背单词分钟录入。

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
手机只浏览网站时：不用 Pull，直接访问服务器上的同一份学习数据
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

项目变更、部署配置和维护记录应提交到这个仓库，不记在某一台设备的全局提示词里。Git 不会实时自动同步文件：切换开发设备前确认上一台设备已经 Push，新设备再 Pull。每台设备分别配置自己的 GitHub/服务器访问授权，密钥和生产配置不进入仓库。

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
业务测试基线：2026-09-27，Python 3.12 下 64 tests passed
当前访问入口：https://120.55.53.215/
部署维护说明：docs/server-https-entry.md
入口验证：2026-10-10，登录页、HTTPS、未登录访问保护及证书续期演练通过
已知环境问题：Arch Python 3.14 TestClient 卡住
请勿读取或输出 Secret，请勿直改生产数据库
```
