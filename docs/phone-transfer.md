# 电脑传到手机：最省事方案

如果你要把 **当前电脑里这份最新项目** 带到手机上，最稳妥的方式不是 `git clone`，而是：

1. 在电脑上打包当前工作区
2. 用手机浏览器从电脑下载这个包
3. 在手机上解压
4. 再用 Termux 安装和启动

## 为什么不推荐现在直接 `git clone`

因为你当前电脑工作区有未提交改动。

直接 `git clone` 只能拿到远端仓库的提交状态，拿不到你这台电脑上还没推送的最新改动。

所以这一步如果做错，手机上跑起来的会是旧版本。

## 推荐方式：用电脑临时开下载地址

### 电脑上执行

在项目根目录运行：

```powershell
& "C:\Users\cixia\AppData\Local\Programs\PowerShell\7\pwsh.exe" -File .\share-to-phone.ps1 -Serve
```

这个脚本会自动：

- 生成 `dist/daily-plan-termux.zip`
- 排除 `.git`、`data`、`.env`、缓存目录
- 在电脑上启动一个临时 HTTP 下载服务

### 手机上执行

用手机浏览器打开电脑终端里打印出来的地址，例如：

```text
http://192.168.x.x:8765/daily-plan-termux.zip
```

下载完成后，把压缩包解压到你准备用 Termux 运行的目录，例如：

```text
~/daily-plan
```

## 手机上跑起来

进入解压后的目录：

```bash
cd ~/daily-plan
bash ./termux-install.sh
bash ./termux-start.sh
```

## 如果下载地址打不开

先检查这几件事：

- 手机和电脑是否还连在同一个热点环境里
- 电脑上的 `share-to-phone.ps1 -Serve` 是否还在运行
- 电脑防火墙是否拦住了临时端口 `8765`

如果还是不通，就退回更笨但更稳的方式：

- 用微信、QQ 或其他传文件工具把 `dist/daily-plan-termux.zip` 发到手机
- 手机上解压后再走 Termux 启动
