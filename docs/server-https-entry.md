# 今日航线服务器 HTTPS 入口

> 最后验证：2026-10-10。本文和 `deploy/` 中的配置随 GitHub 同步，供各开发设备接手；密码、私钥、生产环境变量和数据库不进入仓库。

## 日常访问

当前书签：**https://120.55.53.215/**。

Arch、小米平板和手机访问同一台阿里云服务器，使用原访问密码。切换到新地址需要重新登录，学习数据没有迁移。当前入口不要求客户端加入 Tailscale。

旧入口 `https://daily-plan-aliyun.tail095eb1.ts.net/` 的公共 DNS 记录目前缺失，Funnel 配置保留。排查时必须从客户端验证解析与访问；服务器本地存在解析覆盖，本地成功不等于外网成功。

## 运行结构

```text
浏览器 → 120.55.53.215:443 → Nginx → 127.0.0.1:8000
                                        ↓
                                daily-plan.service
                                        ↓
                          /var/lib/daily-plan/daily_plan.db
```

- 服务器：阿里云 Ubuntu 24.04.2，公网 IP `120.55.53.215`，当前内网地址 `172.25.63.250`。
- Nginx 仅绑定该内网地址的 80、443 端口，由云端公网映射访问；不绑定通配地址的 443，以免与现有 Tailscale 监听冲突。
- HTTP 的 ACME 验证路径提供证书挑战文件，其他请求跳转 HTTPS。
- HTTPS 转发到应用，保留生产密码登录和 Secure 会话 Cookie。
- 应用源码、数据库、生产配置和每日 03:30 备份任务均未修改。
- 目前服务器此前卡死的根因仍未明确；本次解决了恢复运行后的访问入口故障。

## 已运行配置与仓库对应关系

| 仓库文件 | 服务器安装位置 |
| --- | --- |
| `deploy/nginx/daily-plan-ip.conf` | `/etc/nginx/sites-available/daily-plan-ip` |
| `deploy/systemd/daily-plan-cert-renew.service` | `/etc/systemd/system/daily-plan-cert-renew.service` |
| `deploy/systemd/daily-plan-cert-renew.timer` | `/etc/systemd/system/daily-plan-cert-renew.timer` |
| `deploy/reload-daily-plan-cert.sh` | `/usr/local/libexec/daily-plan-cert-reload` |

Nginx 站点通过 `/etc/nginx/sites-enabled/daily-plan-ip` 链接启用。服务器配置快照保存在 `/root/daily-plan-entry-backups/20261010/`，它是现场回退副本，GitHub 才是项目维护记录的正本。

这些文件记录已运行的配置，本次提交不重新部署业务程序。复用到其他服务器时，先核对内网地址、公网 IP、端口和证书路径，不能盲目原样安装。

## 服务器维护授权入口

2026-10-10 已验证现有授权入口：

1. 从已配置 SSH 授权的设备连接 `codexdev@120.55.53.215`；小米平板当前有 `aliyun` 别名，其他设备不一定有。
2. 服务器上的现有密钥路径 `/home/codexdev/.ssh/mistake-review-root` 可认证同机 `root@127.0.0.1`。
3. 进入服务器后，仅执行本次维护所需的有限命令，例如：

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -i /home/codexdev/.ssh/mistake-review-root root@127.0.0.1 \
  'systemctl is-active daily-plan nginx daily-plan-cert-renew.timer'
```

密钥路径在服务器上，不在平板上。不能读取、输出、复制或提交密钥内容，不能关闭主机身份校验。新设备需要独立配置自己的登录授权；Git Pull 不会同步认证凭据。此入口仅用于用户授权的维护，不代表允许修改其他服务或安全策略。

## HTTPS 证书与自动续期

- 证书：Let's Encrypt 公网 IP 证书，`shortlived` 配置，约 160 小时有效期。
- Certbot 5.4.0 安装于独立环境 `/opt/daily-plan-certbot`，不会改变应用 Python 环境。
- 证书名称：`daily-plan-public-ip`，运行文件位于 `/etc/letsencrypt/live/daily-plan-public-ip/`；由 Certbot 管理，不能把私钥放入 Git。
- 验证目录：`/var/lib/daily-plan-acme`，使用 HTTP-01 的 webroot 方式。
- `daily-plan-cert-renew.timer` 每天 00:00、12:00 触发，并随机延后最多一小时；失败后服务每 30 分钟重试。
- 续期成功后先检查 Nginx 配置，再重载证书。
- ACME 请求必须绕过服务器代理；服务命令已移除大小写 HTTP、HTTPS 和 ALL proxy 环境变量。

生产证书首次签发成功；初始证书到期时间为 2026-10-17 05:08:36 UTC。不要将这个时间当成长期固定到期日，以运行证书为准。

首次重建时，先安装 Nginx，并只启用 80 端口的挑战路径和 HTTPS 跳转；没有证书时不要加载最终 HTTPS 配置。确认外部能取到挑战文件后，在管理员会话中签发：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy \
  /opt/daily-plan-certbot/bin/certbot certonly \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --preferred-profile shortlived --webroot \
  -w /var/lib/daily-plan-acme --ip-address 120.55.53.215 \
  --cert-name daily-plan-public-ip
```

签发后再安装最终配置、验证并启用 Nginx 和续期定时器。如果首次安装后的 Nginx 仍占用通配 80 端口，改成指定地址监听时需要重启 Nginx，普通重载可能出现端口冲突；这不会重启应用或覆盖数据库。

续期演练命令（在服务器管理员会话中运行）：

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy \
  /opt/daily-plan-certbot/bin/certbot renew \
  --cert-name daily-plan-public-ip --dry-run \
  --no-random-sleep-on-renew --run-deploy-hooks \
  --deploy-hook /usr/local/libexec/daily-plan-cert-reload
```

演练使用测试签发环境，保留网站正在使用的可信证书。2026-10-10 次级验证曾遇到连接超时，重试后通过；因此不能把一次网络失败认定为服务故障，也不能忽略持续续期失败。

## 验证与回退

2026-10-10 已从小米平板验证：

- 直连和手机代理两种路径：登录页 200，正常证书校验通过，无需跳过证书警告。
- `/static/style.css` 返回 200。
- 未登录 `/api/tasks` 返回 401。
- HTTP 请求跳转 HTTPS。
- 续期演练成功，部署钩子完成 Nginx 验证与重载。
- 续期服务执行结果为成功；应用、Nginx、续期定时器均处于运行状态。

本次没有进行真实密码登录或写入学习数据，也没有重跑业务测试；历史业务测试结果单独保留在 HANDOFF 中。

维护时检查 `systemctl list-timers daily-plan-cert-renew.timer`、续期服务日志与当前证书有效期。不要只检查应用进程，不检查 HTTPS 入口。

回退新入口时，仅停止并禁用 Nginx 和 `daily-plan-cert-renew.timer`；保留应用、数据库、备份及原 Tailscale 配置。回退不会自动恢复旧域名解析，必须先确认旧入口外部可达，否则网站会失去可用入口。
