# Termux Git 更新方案

这份文档解决的是两个问题：

1. 以后手机怎么 **一条命令拉取 GitHub 上的新版本**
2. 更新代码时，怎么 **保住手机里现有的 `data/daily_plan.db`**

核心结论：

- 以后手机项目目录最好变成一个真正的 Git 工作区
- 数据继续放在本地 `data/` 目录
- 以后更新只拉代码，不覆盖数据库

---

## 一、为什么这套方式更适合后续更新

如果你一直走“电脑打 zip -> 手机解压覆盖”，每次都要手动处理：

- 哪些文件该覆盖
- 哪些文件不能动
- 今天的数据会不会丢

而改成 Git 工作区后：

- 代码更新：`git pull`
- 数据保留：`data/` 继续留在本地
- 现在项目里已经有 `termux-update.sh`，以后直接跑它就行

---

## 二、第一次只做一次的迁移

如果你手机上当前已经有一个能跑的旧目录：

```text
/storage/emulated/0/daily-plan
```

并且里面已经有你今天的数据，那就不要直接删。

### 1. 先把旧目录改名留档

```bash
cd /storage/emulated/0
mv daily-plan daily-plan-old
```

### 2. 从 GitHub 克隆新的正式目录

```bash
cd /storage/emulated/0
git clone https://github.com/cixia-zhao/daily-plan.git daily-plan
```

### 3. 把旧数据复制回来

```bash
mkdir -p /storage/emulated/0/daily-plan/data
cp /storage/emulated/0/daily-plan-old/data/daily_plan.db /storage/emulated/0/daily-plan/data/
```

如果你还有备份数据库，也可以一起复制：

```bash
cp /storage/emulated/0/daily-plan-old/data/daily_plan.db.backup_* /storage/emulated/0/daily-plan/data/ 2>/dev/null || true
```

### 4. 在新目录里安装依赖

```bash
cd /storage/emulated/0/daily-plan
bash ./termux-install.sh
```

### 5. 启动并确认数据还在

```bash
bash ./termux-start.sh
```

浏览器打开：

```text
http://127.0.0.1:8000
```

确认今天的数据正常后，`daily-plan-old` 再决定删不删。

---

## 三、以后每次更新怎么做

以后只需要进项目目录执行：

```bash
cd /storage/emulated/0/daily-plan
bash ./termux-update.sh
```

这个脚本会自动做四件事：

1. 先备份当前数据库到 `backups/`
2. 执行 `git pull --ff-only`
3. 重新同步一次 Python 依赖
4. 保留你的本地 `data/` 目录不动

更新完再启动：

```bash
bash ./termux-start.sh
```

---

## 四、这套方案为什么不会覆盖你的数据

因为项目里的数据库默认是：

```text
data/daily_plan.db
```

而这个文件已经被 Git 忽略，不会被仓库里的代码版本覆盖。

所以只要你不手动删除 `data/`，更新代码不会抹掉已有数据。

---

## 五、什么时候不适合直接跑更新脚本

如果你在手机本地自己改过代码，例如改了：

- `app/`
- `README.md`
- `termux-start.sh`

那 `termux-update.sh` 会先停下来，避免把你本地代码状态搞乱。

这时先执行：

```bash
git status
```

看清楚改了什么，再决定是提交、还原，还是手动处理。

---

## 六、以后最短操作

以后日常更新就是这两条：

```bash
cd /storage/emulated/0/daily-plan
bash ./termux-update.sh
```

然后：

```bash
bash ./termux-start.sh
```
