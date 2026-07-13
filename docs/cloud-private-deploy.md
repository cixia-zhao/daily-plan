# 阿里云私有部署步骤

这份文档写的是当前推荐路线：

- 阿里云服务器长期运行后端
- 手机和电脑通过 `Tailscale` 私有访问
- 不买域名
- 不做公网直开
- 云端 SQLite 做主库
- 每日自动备份 + 项目内手动导出

如果你只想先记一句话，可以记这个：

> 这条路线的目标不是把它变成公开网站，而是把它变成“你自己随时能打开、又不再依赖手机本地 Termux”的私人网页应用。

## 1. 部署后的最终形态

部署完成后，整体会变成这样：

- 服务器一直开着，负责跑这个项目
- 手机不再本地跑 Python 后端
- 手机只负责访问这个项目
- 数据主库放在服务器上
- 服务器每天自动留备份
- 你自己还能从项目里再手动下载一份备份

## 2. 服务器上的推荐目录

建议统一成下面这套：

```text
/opt/daily-plan/current          # 项目代码
/etc/daily-plan/daily-plan.env   # 生产环境变量
/var/lib/daily-plan/daily_plan.db
/var/backups/daily-plan
/var/log/daily-plan/app.log
```

其中最重要的是：

- 数据库：`/var/lib/daily-plan/daily_plan.db`
- 备份目录：`/var/backups/daily-plan`
- 日志：`/var/log/daily-plan/app.log`

## 3. 第一次在服务器上准备项目

先在服务器上准备基础环境：

```bash
sudo apt update
sudo apt install -y python3 python3-venv git
```

把项目放到服务器上后，进入项目目录：

```bash
cd /opt/daily-plan/current
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"
```

然后准备环境变量文件：

```bash
sudo mkdir -p /etc/daily-plan
sudo cp deploy/daily-plan.env.example /etc/daily-plan/daily-plan.env
```

至少把这些值确认好：

```dotenv
APP_RUNTIME=production
APP_HOST=127.0.0.1
APP_PORT=8000
DATABASE_PATH=/var/lib/daily-plan/daily_plan.db
DAILY_PLAN_BACKUP_DIR=/var/backups/daily-plan
DAILY_PLAN_BACKUP_RETENTION_DAYS=14
```

这一步的核心意义是：

- 明确服务器正式使用哪份数据库
- 明确备份存哪里
- 明确这是生产模式，不再是本地开发模式

## 4. 启用长期运行

项目里已经准备好了这些文件：

- `deploy/run-daily-plan.sh`
- `deploy/systemd/daily-plan.service`
- `deploy/systemd/daily-plan-backup.service`
- `deploy/systemd/daily-plan-backup.timer`

先给脚本执行权限：

```bash
chmod +x deploy/run-daily-plan.sh
chmod +x deploy/backup-daily-plan.sh
```

再把 `systemd` 文件装到系统里：

```bash
sudo cp deploy/systemd/daily-plan.service /etc/systemd/system/
sudo cp deploy/systemd/daily-plan-backup.service /etc/systemd/system/
sudo cp deploy/systemd/daily-plan-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now daily-plan.service
sudo systemctl enable --now daily-plan-backup.timer
```

常用检查命令：

```bash
systemctl status daily-plan.service
systemctl status daily-plan-backup.timer
tail -n 50 /var/log/daily-plan/app.log
```

## 5. Tailscale 私有访问

这一步的目的不是“再装一个复杂系统”，而是：

- 不用买域名
- 不用公网裸露
- 手机仍然能很顺手地打开它

服务器装好 `Tailscale` 并登录到你的 tailnet 后，再让应用只监听本机：

- 应用继续跑在 `127.0.0.1:8000`
- 不直接对公网开放业务端口

然后在服务器上配置私有转发入口：

```bash
sudo tailscale serve --bg 8000
```

这样你的手机和电脑只要登录到同一个 Tailscale 网络，就能通过私有入口访问这个项目，而不是靠手机本地 Termux 起服务。

手机侧实际体验应该尽量收敛成：

1. 打开 Tailscale，确认已连接
2. 点浏览器书签或主屏幕图标
3. 直接进入项目

## 6. 自动备份和手动导出

### 自动备份

自动备份由这个命令完成：

```bash
deploy/backup-daily-plan.sh
```

它最终会调用：

```bash
python -m app.backup_cli
```

行为是：

- 先从当前数据库做一份稳定快照
- 放进备份目录
- 再按保留天数清理旧备份

### 手动导出

项目里新增了一个后端接口：

- `GET /api/system/backup-export`

设置页也补了“导出数据库备份”按钮。  
以后你可以直接在项目里点一下，把当前备份下载到自己电脑或手机。

## 7. 健康检查

项目里还新增了一个健康检查接口：

- `GET /api/system/health`

它不是给普通使用看的，主要用来判断：

- 服务是不是还活着
- 数据库路径是不是当前那一份
- 备份目录是不是当前那一份
- 当前是不是生产模式

## 8. 恢复思路

如果以后要从备份恢复，核心思路很简单：

1. 先停服务
2. 选一份备份数据库
3. 用它替换当前主库
4. 再重启服务

典型流程大概是：

```bash
sudo systemctl stop daily-plan.service
cp /var/backups/daily-plan/某份备份.db /var/lib/daily-plan/daily_plan.db
sudo systemctl start daily-plan.service
```

恢复后优先做两件事：

- 打开项目确认数据是否正常
- 访问 `/api/system/health` 确认服务正常

## 9. 第一阶段不要做的事

这阶段先不要急着做这些：

- 公网裸露项目端口
- 为它单独做域名和备案
- 一上来就重写成原生 App
- 一上来就引入更复杂的数据库
- 先做 PWA 包装再说

因为你当前最核心的目标不是“更像产品”，而是：

- 手机比 Termux 更顺手
- 数据别再轻易丢
- 服务器能长期稳定跑

## 10. 当前这条路线最适合你的原因

你现在最强的需求顺序其实是：

1. 手机使用更顺
2. 数据更稳、更不容易丢
3. 以后再考虑更像 App

而这套路线正好对应：

- 云服务器解决“项目一直活着”
- Tailscale 解决“不买域名也能私有访问”
- 自动备份 + 手动导出解决“数据保命”
- 保持 Web 形态为以后包成 App 留最小铺垫
