# 今日航线交接

> 最后更新：2026-10-10
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
| 当前入口 | `https://120.55.53.215/`，可信 HTTPS |
| 原入口 | `https://daily-plan-aliyun.tail095eb1.ts.net/`，配置保留，公共 DNS 记录缺失 |
| HTTPS 转发 | Nginx，监听服务器内网地址 `172.25.63.250:80/443` |
| 证书续期 | `daily-plan-cert-renew.timer`，每天检查两次，失败后 30 分钟重试 |
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

## 2026-10-10 入口修复

- 使用现有服务器授权完成维护；入口和提权方式记录在 [服务器 HTTPS 入口](docs/server-https-entry.md)，不依赖某台设备的全局提示词。
- 未修改业务源码、生产密码、SQLite 数据或备份任务。
- 当前 Tailscale Funnel 的公共 DNS 记录缺失；服务器本地访问成功不能作为外网可达证据。保留旧配置，新增公网 IP HTTPS 入口。
- 本次提交保存已运行的 Nginx 配置、续期服务、定时器和重载脚本；不是业务程序重新部署。
- 平板直连和手机代理均验证登录页 200、证书校验通过；静态样式 200、未登录 `/api/tasks` 返回 401、HTTP 跳转 HTTPS。
- 证书续期演练及 Nginx 重载通过，续期服务执行结果成功；应用、Nginx、续期定时器均在运行。
- 未使用真实账号执行登录或修改学习记录；业务测试沿用以下历史结果，没有把它当成本次新测试。
- 续期演练曾遇到远端次级验证连接超时，重试通过；已配置自动重试。服务器之前卡死的根因尚未确认。

## 代码与验证（2026-09-27 历史基线）

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
