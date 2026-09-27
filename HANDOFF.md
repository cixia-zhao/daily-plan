# 今日航线交接

> 最后更新：2026-09-27
> 只记录当前状态、风险和下一步，不再承载庞大工作流。

## Agent 读取顺序

1. `README.md`：项目定位与当前架构。
2. `Tutor.md`：用户操作和多设备工作流。
3. 再按任务读 `docs/` 中对应模块，不要先扫全仓库。

`AGENTS.md` 引用的 `.agents/skills/...` 文件当前不存在。它们是旧模型时期的工作流遗留，不要自行重建或安装。仍需坚持小步修改和明确验证。

## 当前架构

- GitHub 是源码版本中心：`cixia-zhao/daily-plan`
- Arch 主机是主要开发设备：`/home/cixia/项目/daily-plan`
- 小米平板 Linux 是接力开发设备，应使用独立 Clone
- 阿里云只负责运行、数据和备份，不直接开发
- 源码、生产程序、SQLite 数据、Secret 分开保存

## 生产快照

| 项目 | 状态 |
|---|---|
| 入口 | `https://daily-plan-aliyun.tail095eb1.ts.net/` |
| 服务 | `daily-plan.service`，`enabled + active` |
| 应用监听 | `127.0.0.1:8000` |
| 部署目录 | `/opt/daily-plan/current` |
| 服务器源码副本 | `/srv/workspaces/daily-plan` |
| 配置 | `/etc/daily-plan/daily-plan.env`，`600 root:root` |
| 数据库 | `/var/lib/daily-plan/daily_plan.db` |
| 备份 | `/var/backups/daily-plan`，每天 03:30 |

2026-09-27 已重置站点登录密码，并验证登录后首页返回 200。密码不记入 Git 或文档。重置前配置备份：

```text
/etc/daily-plan/daily-plan.env.before-password-reset-20260927-224900
```

## 代码与验证

- 整理前 GitHub `main` 提交：`0bb10a8`。
- 生产部署与该基线的主要 tracked 源码一致。
- 本轮修正了 3 个过时测试：生产模式测试正确登录，今天页测试检查当前的 `open-execution-desk` 按钮。
- Python 3.12：64 项 `pytest` 全部通过。
- `node --check app/static/app.js` 通过。
- `python -m compileall -q app tests` 通过。
- Arch Python 3.14.7 下，最小 FastAPI `TestClient` 也会卡住；这是本机测试栈兼容问题，不是业务接口卡住。

## 仍需决定或处理

1. **GitHub 仓库当前公开**：仓库包含个人规划文档，建议用户确认是否改为 Private；本轮不自动改。
2. **数据库权限**：`daily_plan.db` 当前为 `644 root:root`，同机其他用户可读。
3. **服务以 root 运行**：尚未改成最小权限专用用户。
4. **备份仅在同一台服务器**：有 14 份循环备份，但没有异地备份。
5. **生产历史杂项**：`/opt/daily-plan/current/-C`、`build/` 和旧 ZIP 尚未清理；未确认前不要删除。
6. **部署流程尚未固化**：后续应固定为“本地测试 -> Push -> 备份数据 -> 服务器部署指定 Commit -> 健康检查”。

## 产品与安全红线

- 不绕过人工确认把草稿直接变成正式清单。
- 不恢复“未完成任务自动顺延”。
- 不把 GPT 回复自动写入正式复盘。
- 不把 `.env`、API Key、密码或 SQLite 数据库提交到 Git。
- 不在 `/opt/daily-plan/current` 直接开发。
- 不在未备份数据库时部署新版本。
