# 项目交接文档

> 最后更新：2026-07-06
> 当前环境：Codex / 常规环境
> 当前远端：`https://github.com/cixia-zhao/daily-plan.git`
> 明天接手优先级：先按真实使用继续跑“执行台有效细分 + 草稿默认分钟 + 手机 Git 更新链路”，再根据实际卡点微调

## 1. 当前项目真实状态

- 项目名称：今日航线
- 工作区路径：`C:\Users\cixia\Desktop\project\daily plan`
- 技术栈：FastAPI + Jinja2 + SQLite + 原生 JavaScript / CSS
- 产品定位：单用户、本地优先、先确认再执行的每日任务 Web App
- 当前主流程：晨间输入 → 生成草稿 → 人工确认 → 执行台记录时间段 → 晚间提交 → 单日 / 单周复盘 → 需要时复制给 GPT 协作
- Windows 启动方式：双击 `启动今日航线.cmd`
- 安卓手机启动方式：
  - 首次安装后：`dp`
  - 更新并启动：`spdp`
- 当前手机长期方案：项目已经进入 GitHub 公共仓库，手机推荐走“Git 工作区 + `spdp` 更新”，不再把“每次重新传 zip 覆盖”当成主路径
- 当前手机安装、迁移与更新说明：见 `docs/termux-guide.md`
- 当前临时传机方式仍保留：电脑可运行 `share-to-phone.ps1 -Serve` 生成并分享 `dist/daily-plan-termux.zip`

## 2. 今天这轮收束后的关键结论

### A. 执行台关键 bug 已修正

**文件**：`app/api.py`、`app/schemas.py`、`app/static/app.js`、`tests/test_api.py`、`tests/test_ui_and_settings.py`

- 早上刚点“开始有效时间”时，任务卡出现 `有效 -480 分` 的问题已修掉。
- 现在有效分钟统一走 Python 侧的 `_minutes_between()` 和 `_parse_iso_datetime()` 口径，不再用 SQLite `CURRENT_TIMESTAMP` 去和本地 naive ISO 时间直接做差。
- `task_execution_board`、任务卡里的有效分钟、提交前同步、标签切换后的刷新，已经统一复用同一套聚合逻辑，避免“卡片和统计不一致”。

### B. 执行台现在支持“有效时间细分”

**文件**：`app/api.py`、`app/schemas.py`、`app/static/app.js`、`app/static/style.css`、`app/templates/settings.html`、`tests/test_api.py`、`tests/test_ui_and_settings.py`

- `effective` 时间段现在也可以带 `label_id / label_name`，不再只允许计总 / 中断标签带标签快照。
- 有效细分标签当前按“任务类别”配置：
  - 默认预置：`数学 -> 网课 / 刷题`
  - 默认预置：`英语 -> 阅读 / 单词`
  - 其他类别默认空，用户可在设置页自己加
- 执行台开始有效时间时：
  - 可以直接开始，不强制选细分标签
  - 也可以先选细分标签再开始
  - `切回有效` 会优先回到该任务最近一次用过的有效细分标签
- 时间轴补记 / 编辑现在也支持给 `effective` 段选细分标签。
- 看板现在除了 `有效 / 计总 / 中断` 之外，还会显示：
  - `有效占总计` 百分比
  - 有效细分内部占比
  - 没选细分标签的有效时间会显示成 `未细分`

### C. 今天页草稿默认分钟已改成可配置

**文件**：`app/api.py`、`app/schemas.py`、`app/static/app.js`、`app/templates/settings.html`、`tests/test_api.py`、`tests/test_ui_and_settings.py`

- 设置模型新增 `draft_main_minutes_by_category`，控制主航线草稿生成时的默认分钟。
- 当前默认值已经收束成：
  - 数学 `0`
  - 英语 `0`
  - 408 `0`
  - 运动 `0`
- 产品含义是：草稿先给结构，不强行替用户预填分钟；当天要多少，用户再按真实情况改。
- 设置页现在可以直接改这四项默认分钟，不需要每次新草稿都手动从 `60 / 30 / 50 / 20` 往回改。

### D. 今日清单分钟校验已放宽到真实需求

**文件**：`app/schemas.py`、`app/api.py`、`app/static/app.js`、`tests/test_api.py`

- `300 分钟全给数学、其他主航线为 0` 现在被视为合法需求。
- `PlanTaskInput.estimated_minutes` 的基础输入上限已经放宽到 `720`，不再把 `241+` 之类的值提前拦死。
- 真正的限制现在回到业务校验里：
  - 单个主航线任务不能超过当天 `available_minutes`
  - 主航线总分钟不能超过当天 `available_minutes`
- 前端 `api()` 已兼容 FastAPI 的 `detail: []` 返回结构，错误提示不再显示 `[object Object]`。

### E. 执行台已经统一成跨端同版本

**文件**：`app/templates/execute.html`、`app/static/app.js`、`app/static/style.css`

- 最初方案里“只改手机端”的方向，已经在实现上收束成“桌面端和手机端保持同一套执行台语义”。
- 当前执行台的统一结构是：
  - 顶部快捷条：`计总 / 中断 / 切回有效`
  - `0 分钟主航线` 默认折叠
  - `副航线` 默认折叠
  - `切回有效` 会直接回到当前标签段所挂载的任务，并复用现有 `tasks/start` 接口
- 当前默认产品判断：以后没有特别说明时，桌面端和手机端应尽量保持一致，不再故意分叉成两套版本。

### F. 手机已经具备“更新不丢数据”的正式链路

**文件**：`termux-install.sh`、`termux-start.sh`、`termux-update.sh`、`termux-register-commands.sh`、`docs/termux-guide.md`

- 项目已经上传到 GitHub 公共仓库：`cixia-zhao/daily-plan`
- `termux-install.sh` 已兼容 Termux，不再执行会触发报错的 `pip install --upgrade pip`
- `termux-register-commands.sh` 会在 `$PREFIX/bin` 注册两个正式命令：
  - `dp`：直接启动
  - `spdp`：先更新，再启动
- `termux-update.sh` 的行为：
  - 要求当前目录是 Git 工作区
  - 如检测到本地代码改动则停止
  - 更新前备份 `data/daily_plan.db` 到 `backups/`
  - 如检测到 `127.0.0.1 / localhost` 这类手机本地回环代理，会先自动清掉对应环境变量和 Git 全局代理
  - `git pull --ff-only`
  - `python -m pip install -e ".[dev]"`
  - 刷新 `dp / spdp`
  - 不覆盖本地 `data/`

### G. “运动”主航线现在要看真实设置开关

**文件**：`app/api.py`、`app/templates/settings.html`、`app/static/app.js`

- 草稿规则层仍然会生成第 4 条主航线 `运动`。
- 但如果设置里的 `rehab_enabled=false`，`create_draft()` 会在保存草稿前把 `rehab` 类任务过滤掉。
- 设置页文案已经改成更直白的 `主航线包含运动`，避免用户以为只是影响康复备注，而不是直接影响第 4 条主航线是否出现。

## 3. 当前最值得继续跟进的点

1. 真机继续跑一天，确认统一执行台在桌面和手机上都顺手，尤其是：
   - `切到标签` 后再 `切回有效`
   - 有效细分标签在手机上是不是足够顺手，不会把开始动作搞重
   - `0 分钟主航线` 折叠后是否还足够可见
   - 时间轴补记在手机上的操作负担
2. 用真实手机再验证几次 `spdp`，确认：
   - 数据库备份正常生成
   - 首次遇到旧回环代理时，手动清代理后能成功把修复版脚本拉下来
   - 之后再次更新时，`termux-update.sh` 能自动清掉回环代理
   - 没有误覆盖 `data/daily_plan.db`
   - 更新后 `dp / spdp` 仍然可用
3. 如果后续要继续打磨手机体验，优先修“真实使用摩擦”，不要先跳到 APK、PWA、自启动这些大话题。
4. 如果后续要继续打磨今天页，优先想清楚“草稿默认分钟=0”之后，怎样让用户改分钟更顺，而不是先把默认值重新写死。

## 4. 历史沉淀中仍然有效的产品边界

- 今天页仍然坚持“草稿 -> 人工确认”，不能绕过审批直接开始正式执行。
- 未完成任务只进入待审池，不自动顺延到下一天。
- GPT 协作仍然是“复制提示词 -> 外部对话 -> 粘贴回留档”，不走项目内联网 API。
- 七日复盘当前按所选日期所在自然周统计，不是最近 7 个实际执行日。
- 副航线完成规则仍然是“有效时间 `>= 30` 自动完成”。
- 主任务 `actual_minutes` 仍然只认 `effective` 段，不把计总标签或中断标签写回去。

## 5. 核心文件地图

```text
daily plan/
├── HANDOFF.md                     # 明天新窗口优先读
├── README.md                      # 项目总说明
├── share-to-phone.ps1             # 电脑打包并临时分享 zip 给手机下载
├── termux-install.sh              # Termux 首次安装
├── termux-start.sh                # Termux 启动服务
├── termux-update.sh               # Termux 更新代码但保留本地数据
├── termux-register-commands.sh    # 注册 dp / spdp
├── docs/
│   ├── README.md                  # 模块文档索引
│   ├── backend-api.md             # 后端接口、时间聚合、脚本链路
│   ├── backend-services.md        # 本地规则、AI 兼容入口、周分析服务
│   ├── frontend.md                # 今天页、执行台、复盘页前端结构
│   └── termux-guide.md            # 手机 Termux 安装、迁移、更新与排错总说明
├── app/
│   ├── main.py
│   ├── api.py
│   ├── database.py
│   ├── models.py
│   ├── schemas.py
│   ├── services/
│   │   ├── ai_planner.py
│   │   ├── task_rules.py
│   │   └── weekly_review_analyzer.py
│   ├── templates/
│   │   ├── index.html
│   │   ├── execute.html
│   │   ├── review.html
│   │   ├── weekly.html
│   │   ├── gpt_workbench.html
│   │   └── settings.html
│   └── static/
│       ├── app.js
│       └── style.css
└── tests/
```

## 6. 明天新窗口建议读取顺序

1. `HANDOFF.md`
2. `docs/README.md`
3. 如果是执行台 / 时间统计问题：`docs/backend-api.md` + `docs/frontend.md`
4. 如果是手机更新 / 部署问题：`docs/termux-guide.md`
5. 再按需进代码，不要先全仓无差别扫描

## 7. 不可触碰的红线

- 🚫 不要绕过人工确认，把草稿直接变成正式执行清单
- 🚫 不要恢复“未完成任务自动顺延”
- 🚫 不要把 GPT 回复自动写回正式复盘字段
- 🚫 不要把 `DEEPSEEK_*` 密钥暴露给前端、数据库或设置接口
- 🚫 不要覆盖或删除用户本地 `data/daily_plan.db`
- 🚫 不要破坏“同一时刻只有一个激活段”的执行前提
- 🚫 不要把中断标签并入任务总时间
- 🚫 不要把计总标签写回主任务 `actual_minutes`
- 🚫 不要把“主航线包含运动”开关误写成只影响提示文案，它现在真实影响草稿里第 4 条主航线是否出现
- 🚫 不要再把桌面端和手机端默认当成两套分叉版本
- 🚫 不要把当前方案表述成 APK、PWA、离线缓存、自启动已完成

## 8. 当前验证状态

今天这轮与功能相关的自动验证已经跑过：

- `python -m pytest -q tests/test_api.py tests/test_ui_and_settings.py`
- `node --check app/static/app.js`

今天这次文档更新本身没有改业务代码，所以未再重复跑测试。
