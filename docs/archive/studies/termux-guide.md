# Termux 手机部署与使用说明

这份文档统一说明“今日航线”在安卓手机上的 Termux 路线，包括：

- 第一次安装
- 旧目录迁到 Git 工作区
- `dp / spdp` 的日常使用
- 数据保留与更新
- 常见问题排查

当前推荐形态不是 APK，也不是先做壳，而是：

1. 用 `Termux` 启动本地 Python 后端
2. 用手机浏览器访问 `http://127.0.0.1:8000`
3. 跑通后把网页添加到主屏幕

## 先确认目录

当前手机项目目录约定为：

```text
/storage/emulated/0/daily-plan
```

进入这个目录后，第一层应直接能看到：

- `app`
- `README.md`
- `termux-install.sh`
- `termux-start.sh`
- `termux-update.sh`

不要多套一层目录。

正确示例：

```text
/storage/emulated/0/daily-plan/termux-install.sh
```

错误示例：

```text
/storage/emulated/0/daily-plan/daily-plan-termux/termux-install.sh
```

## 第一次安装

### 1. 给 Termux 存储权限

```bash
termux-setup-storage
```

如果看到：

```text
Do you want to continue? (y/n)
```

只输入：

```bash
y
```

然后回车，不要把别的命令接在这一行后面。

### 2. 进入项目目录

```bash
cd /storage/emulated/0/daily-plan
pwd
ls
```

正常应显示：

```text
/storage/emulated/0/daily-plan
```

并且 `ls` 能看到 `app`、`termux-install.sh` 等项目文件。

### 3. 安装依赖并注册快捷命令

```bash
bash ./termux-install.sh
```

这个脚本会自动：

- 安装 `python`
- 安装 `git`
- 安装项目依赖
- 初始化 `.env`
- 注册 `dp / spdp`

如果你以前遇到过：

```text
ERROR: Installing pip is forbidden, this will break the python-pip package (termux).
```

那是旧脚本兼容性问题，不是手机环境坏了；当前仓库里的 `termux-install.sh` 已经绕开了这一步。

## 日常使用

### 启动

```bash
dp
```

它会默认：

- 启动本地服务 `127.0.0.1:8000`
- 使用本地数据库 `data/daily_plan.db`
- 在支持时尝试自动拉起浏览器

如果没有自动打开浏览器，就手动访问：

```text
http://127.0.0.1:8000
```

### 更新并启动

```bash
spdp
```

它会自动：

1. 备份当前数据库到 `backups/`
2. 如检测到 `127.0.0.1 / localhost` 回环代理，先自动清掉
3. 拉取 GitHub 最新代码
4. 同步 Python 依赖
5. 刷新 `dp / spdp`
6. 启动服务

所以日常最短操作就是：

- 平时启动：`dp`
- 更新并启动：`spdp`

## 从旧目录迁到 Git 工作区

如果你手机上的 `daily-plan` 还是旧的手动解压目录，而不是 Git 工作区，那么 `spdp` 不会直接可用。

这时按下面步骤做一次性迁移。

### 1. 给旧目录改名留档

```bash
cd /storage/emulated/0
mv daily-plan daily-plan-old
```

### 2. 从 GitHub 克隆正式目录

```bash
cd /storage/emulated/0
git clone https://github.com/cixia-zhao/daily-plan.git daily-plan
```

### 3. 把旧数据复制回来

```bash
mkdir -p /storage/emulated/0/daily-plan/data
cp /storage/emulated/0/daily-plan-old/data/daily_plan.db /storage/emulated/0/daily-plan/data/
```

如果还有历史备份数据库，也可以一起复制：

```bash
cp /storage/emulated/0/daily-plan-old/data/daily_plan.db.backup_* /storage/emulated/0/daily-plan/data/ 2>/dev/null || true
```

### 4. 在新目录里重新安装依赖

```bash
cd /storage/emulated/0/daily-plan
bash ./termux-install.sh
```

### 5. 启动并确认数据还在

```bash
dp
```

浏览器打开：

```text
http://127.0.0.1:8000
```

确认数据正常后，再决定要不要删除 `daily-plan-old`。

## 为什么更新不会覆盖数据

默认数据库路径是：

```text
data/daily_plan.db
```

这个文件不受 Git 版本覆盖；只要你不手动删除 `data/`，代码更新不会直接抹掉已有数据。

## 明天实际怎么用

### 早上

1. 打开 `Termux`
2. 执行 `dp`
3. 打开浏览器或主屏幕图标
4. 生成草稿
5. 手动确认今日清单
6. 进入执行台

### 白天

1. 开始当前任务的有效时间
2. 需要时切到计总标签或中断标签
3. 忘记切换可以晚上补记时间段

### 晚上

1. 在执行台勾完成并提交今日情况
2. 打开单日复盘页查看执行看板
3. 写晚间收束

## 常见问题

### 1. `cd ~/daily-plan` 报不存在

项目不在 `~/daily-plan`，而是在：

```bash
cd /storage/emulated/0/daily-plan
```

### 2. `bash ./termux-install.sh` 报找不到文件

说明当前不在项目目录。先执行：

```bash
pwd
ls
```

确认当前路径是不是：

```text
/storage/emulated/0/daily-plan
```

### 3. `spdp` 提示“当前目录不是 Git 工作区”

说明当前目录还是旧的手动解压目录，不是真正的 Git 克隆目录。按上面的“迁到 Git 工作区”步骤先做一次性迁移。

### 4. 浏览器打不开 `127.0.0.1:8000`

优先检查：

1. `Termux` 里的服务是否还在运行
2. 是否已经先执行了 `dp` 或 `bash ./termux-start.sh`
3. 地址是否是 `http://127.0.0.1:8000`

### 5. `spdp` 或 `git pull` 提示 `via 127.0.0.1`

如果看到类似：

```text
failed to connect to github.com port 443 via 127.0.0.1
```

说明手机当前 Git 代理指向了本机回环地址，但手机上没有对应代理服务。

新版本 `termux-update.sh` 会自动清理这类回环代理。  
如果你还没拉到这个修复版脚本，先手动执行：

```bash
cd /storage/emulated/0/daily-plan
git config --global --unset-all http.proxy
git config --global --unset-all https.proxy
git pull --ff-only
spdp
```

### 6. 想换端口

```bash
PORT=8001 bash ./termux-start.sh
```

然后访问：

```text
http://127.0.0.1:8001
```

### 7. 本地没有 `dp / spdp`

手动执行一次：

```bash
cd /storage/emulated/0/daily-plan
bash ./termux-register-commands.sh
```

## 如果你把这份文档发给 GPT

可以直接告诉它：

```text
我现在只有手机，在安卓上通过 Termux 跑一个本地 Python Web App。
项目目录固定在 /storage/emulated/0/daily-plan。
请严格按照这份 termux-guide.md 带我一步一步操作，不要默认我在电脑上，也不要把 cd 命令和 termux-setup-storage 的 y/n 提示混在一起。
如果某一步失败，请先让我执行 pwd 和 ls，再判断我是不是进错目录。
```
