# 今日航线

一个本地优先的每日任务审阅与执行 Web App。它根据晨间状态和长期规划生成任务草稿，只有经过你本人修改并确认后，任务才会进入正式清单。

## 当前功能

- 保底、普通、充足三档任务生成，并受可用时间约束
- DeepSeek 兼容接口生成建议；失败时自动退回本地规则
- 草稿编辑、人工审批、逐项勾选
- 未完成任务进入待审池，不自动顺延
- 重排、拆小、放弃三种待审处理
- 三行晚间复盘与七日统计
- 本地 SQLite 持久化、响应式电脑/手机页面
- 敏感原文不发送给 AI，康复安全边界由本地规则控制

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

如果暂时不配置 DeepSeek，应用仍会正常生成规则版任务。配置时编辑 `.env`：

```dotenv
DEEPSEEK_BASE_URL=你的兼容接口地址
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_MODEL=你的模型名
```

密钥只用于后端请求，不会进入网页、SQLite 或周复盘。

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
5. 晚上保存三句话复盘。
6. 每周查看七日复盘，自主决定是否调量。

PushDeer 和 Termux 常驻部署属于下一阶段：建议先实际使用 7 天并校准任务量，再接入提醒与移动端常驻服务。
