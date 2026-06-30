# Termux 手机实操说明

这份文档是给 **只有手机、通过 Termux + 手机浏览器运行“今日航线”** 的场景准备的。

默认前提：

- 你已经把项目文件放到了手机里
- 项目目录固定为：

```text
/storage/emulated/0/daily-plan
```

- 你后面可能会把这份文档直接发给手机上的 GPT，让它继续带你一步一步操作

## 先记住最重要的结论

当前最推荐的用法不是 APK，也不是先折腾打包，而是：

1. 用 `Termux` 启动本地 Python 后端
2. 用手机浏览器访问 `http://127.0.0.1:8000`
3. 跑通后把这个网页“添加到主屏幕”

这样最稳，出问题也最好排查。

---

## 一、先确认项目目录放对了

项目目录应该是：

```text
/storage/emulated/0/daily-plan
```

并且这个目录第一层里应该**直接**能看到这些内容：

- `app`
- `termux-install.sh`
- `termux-start.sh`
- `README.md`

注意，不要多嵌套一层。

### 正确示例

```text
/storage/emulated/0/daily-plan/termux-install.sh
```

### 错误示例

```text
/storage/emulated/0/daily-plan/daily-plan-termux/termux-install.sh
```

如果是错误示例，说明你解压多套了一层目录，需要把里面那层内容挪出来。

---

## 二、第一次进入 Termux 时怎么做

### 1. 先给存储权限

在 Termux 里执行：

```bash
termux-setup-storage
```

如果它出现：

```text
Do you want to continue? (y/n)
```

你只输入：

```bash
y
```

然后回车。

不要把别的命令直接接在 `(y/n)` 这一行后面输入。

### 2. 进入项目目录

权限处理完以后，再单独执行：

```bash
cd /storage/emulated/0/daily-plan
```

然后执行：

```bash
pwd
```

正常应该返回：

```text
/storage/emulated/0/daily-plan
```

再执行：

```bash
ls
```

你应该能看到：

- `app`
- `termux-install.sh`
- `termux-start.sh`

如果这里看不到，说明你还没真正进入项目目录。

---

## 三、第一次安装

确认已经在项目目录后，执行：

```bash
bash ./termux-install.sh
```

这个脚本会自动做几件事：

- 安装 `python`
- 安装 `git`
- 安装项目依赖
- 初始化 `.env`

注意：Termux 自带的 `python-pip` 不能用 `pip install --upgrade pip` 直接升级，所以如果你以前见过这条报错：

```text
ERROR: Installing pip is forbidden, this will break the python-pip package (termux).
```

那不是你操作错了，而是旧脚本不兼容。更新后的 `termux-install.sh` 已经去掉了这一步。

这一段第一次可能会比较久，属于正常现象。

如果中间有权限、网络或镜像问题，不要自己乱跳步骤，先把完整报错贴给 GPT 或开发者。

---

## 四、每天启动

以后每天只需要这样：

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

---

## 五、第一次跑通后立刻做的事

浏览器能打开后，马上把网页添加到主屏幕：

### Chrome / Edge

1. 打开菜单
2. 选择“添加到主屏幕”

这样后面用起来更像一个 App，但本质上仍然是最稳的浏览器方案。

---

## 六、明天实际怎么用

### 早上

1. 打开 `Termux`
2. 执行：

```bash
dp
```

3. 打开主屏幕图标或浏览器
4. 生成草稿
5. 手动确认今日清单
6. 进入执行台

### 白天

1. 开始当前任务的有效时间
2. 中途切换到计总标签或中断标签
3. 如果忘记切换，晚上再补时间段

### 晚上

1. 在执行台勾完成并提交今日情况
2. 打开单日复盘页看任务执行看板
3. 写晚间收束

---

## 七、最常见的坑

### 1. `cd ~/daily-plan` 报不存在

这是因为项目不在 `~/daily-plan`，而是在手机存储根目录里。

你应该用：

```bash
cd /storage/emulated/0/daily-plan
```

### 2. `bash ./termux-install.sh` 报找不到文件

说明你当前不在项目目录里。

先执行：

```bash
pwd
ls
```

确认当前路径是不是：

```text
/storage/emulated/0/daily-plan
```

### 3. 浏览器打不开 `127.0.0.1:8000`

优先排查这几件事：

1. `Termux` 里的服务是不是还在运行
2. 你是不是先把 `termux-start.sh` 运行起来了
3. 地址是不是写成了：

```text
http://127.0.0.1:8000
```

而不是别的 IP

### 4. 想换端口

```bash
PORT=8001 bash ./termux-start.sh
```

然后浏览器访问：

```text
http://127.0.0.1:8001
```

### 5. 想换数据库位置

先不要急着改。

第一阶段最稳妥的做法是先继续使用默认路径：

```text
data/daily_plan.db
```

等确认整个流程真的顺手了，再考虑迁移。

---

## 八、快捷命令

最新的安装脚本会自动注册两个快捷命令：

```bash
dp
```

- 直接启动今日航线

```bash
spdp
```

- 先更新 GitHub 最新代码，再启动今日航线

如果你刚拉了新版本，但本地还没有这两个命令，可以手动执行一次：

```bash
cd /storage/emulated/0/daily-plan
bash ./termux-register-commands.sh
```

---

## 九、如果你把这份文档发给 GPT

你可以直接告诉它：

```text
我现在只有手机，在安卓上通过 Termux 跑一个本地 Python Web App。
项目目录固定在 /storage/emulated/0/daily-plan。
请严格按照这份 termux-quickstart.md 带我一步一步操作，不要默认我在电脑上，也不要把 cd 命令和 termux-setup-storage 的 y/n 提示混在一起。
如果某一步失败，请先让我执行 pwd 和 ls，再判断我是不是进错目录。
```

这样 GPT 更不容易带偏。
