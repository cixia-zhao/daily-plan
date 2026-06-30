# 今日航线

一个本地优先的每日任务审阅与执行 Web App。它根据晨间状态和长期规划生成任务草稿，只有经过你本人修改并确认后，任务才会进入正式清单；复盘阶段则优先通过和 ChatGPT 的手工协作来整理结论，而不是依赖项目内自动调用外部 API。

## 当前功能

- 保底、普通、充足三档任务生成，并受可用时间约束
- 本地规则优先生成今日草稿；不配置外部接口也能完整使用
- 草稿编辑、人工审批、逐项勾选
- 未完成任务进入待审池，不自动顺延
- 重排、拆小、放弃三种待审处理
- 结构化晚间复盘、单日/单周 GPT 协作导出、粘贴回存档与最终稿沉淀
- 七日复盘纸张感周进度条、周内当天复盘回看编辑、GPT 工作台模板管理
- 三个页面共用自定义弹出月历，可按日期状态跳转和切周
- 周报归档：保存每周原始快照与最终周报正文，可回看历史
- 本地 SQLite 持久化、响应式电脑/手机页面
- 每日复盘原文可进入周分析；康复安全边界仍由本地规则控制

## Windows 本地启动

首次使用时，在终端安装依赖：

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev]"
Copy-Item .env.example .env
```

之后直接双击项目根目录的 `启动今日航线.cmd`。启动窗口会保持可见，后端就绪后自动打开 `http://127.0.0.1:8000`；按 `Ctrl+C` 或关闭窗口即可停止。

如果需要手动排错，仍可运行：

```powershell
.venv\Scripts\python -m uvicorn app.main:app --reload
```

如果暂时不配置外部模型接口，应用仍会正常生成规则版任务。需要兼容旧能力时仍可在 `.env` 中配置：

```dotenv
DEEPSEEK_BASE_URL=你的兼容接口地址
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_MODEL=你的模型名
```

密钥只用于后端请求，不会进入网页、SQLite 或 GPT 协作存档。

## 安卓手机 + Termux 启动

如果你明天只带手机，当前最推荐的形态是：

- `Termux` 起本地后端
- 手机浏览器访问 `http://127.0.0.1:8000`
- 跑通后用“添加到主屏幕”当轻量 App

先不要急着打包 APK。因为后端仍然要靠 Termux 启动，先打包只会增加复杂度。

### 第一次安装

把项目放到手机后，在 Termux 里进入项目目录：

```bash
cd ~/daily-plan
bash ./termux-install.sh
```

### 每次启动

```bash
cd ~/daily-plan
bash ./termux-start.sh
```

### 以后更新

如果手机这一份已经改成 Git 工作区，之后更新可以直接：

```bash
cd /storage/emulated/0/daily-plan
bash ./termux-update.sh
```

它会先备份本地数据库，再拉最新代码，并保留你的 `data/` 不变。

然后在手机浏览器打开：

```text
http://127.0.0.1:8000
```

更完整的手机落地步骤见：

- `docs/termux-quickstart.md`
- `docs/termux-git-update.md`

## 从电脑把当前项目传到手机

如果你要把**当前电脑里的真实工作区**带到手机上，优先不要直接 `git clone`。

原因很简单：你现在本地有未提交改动，直接 clone 只能拿到远端版本，拿不到电脑里这份最新状态。

### 最省事的方式

在电脑项目根目录运行：

```powershell
& "C:\Users\cixia\AppData\Local\Programs\PowerShell\7\pwsh.exe" -File .\share-to-phone.ps1 -Serve
```

它会自动：

- 生成一个给 Termux 用的压缩包
- 排除 `.git`、`data`、`.env` 和缓存目录
- 启一个临时下载地址

然后用手机浏览器访问脚本打印出来的地址，例如：

```text
http://你的电脑局域网IP:8765/daily-plan-termux.zip
```

下载后在手机上解压，再进入项目目录执行：

```bash
bash ./termux-install.sh
bash ./termux-start.sh
```

## 测试

```powershell
python -m pytest -q
python -m compileall app tests
```

## 数据备份与恢复

关闭服务后复制 `data/daily_plan.db` 即可完成备份。恢复时将备份文件放回相同路径；也可以在 `.env` 中通过 `DATABASE_PATH` 指定其他位置。

## 使用顺序

1. 处理待审池中的旧任务。
2. 选择精力档、可用时间和当天类型。
3. 生成并修改草稿。
4. 确认后逐项勾选。
5. 晚上保存结构化复盘和补充正文。
6. 每周查看七日复盘，自主决定是否调量。

现在更推荐的协作方式是：

1. 在单日复盘页或七日复盘页先整理事实。
2. 复制项目自动生成的 GPT 提示词到 ChatGPT Plus。
3. 把整段回复和你准备采用的内容贴回项目留档。
4. 在 `GPT 工作台` 里分别管理单日模板、单周模板和历史协作记录。

设置页现在还支持维护 `项目起始日`，用于区分“项目启动前空白日期”和正式使用区间。

兼容旧版 DeepSeek 接口的能力仍然保留，但第一版产品主路径不再强调它。PushDeer 和更进一步的 Termux 常驻/自启动属于下一阶段：建议先把“手机浏览器 + Termux”这条最小链路跑顺，再考虑提醒与常驻。
