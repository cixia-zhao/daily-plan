# 项目交接与发布状态（HANDOFF.md）

> 历史迭代与早期完整发布流水已归档至 `docs/archive/handoff-history-2026-11.md`（日常开发无需读取归档文件）。

---

## 接手复核与补修（2026-11-18）

接手时，上一代理停在「本地重构完成、等待预览验收」，当时所有修改尚未提交、推送或部署。本次根据当前代码重新验证，补齐以下遗漏：

- **GET 到期计时仍会隐式写库**：共享连接入口与 `/return-today` 原本仍会调用自动停止结算。现仅后台与写请求落库，GET 在内存中将到期段投影为停止状态，时长限定在截止时刻，「回到今天」据此正确跳到复盘。只读回归覆盖已结束、运行中、已到期三种状态，逐请求对比数据库完整转储。
- **计时失败提示被网络恢复提前清除**：被动同步现在保留未确认操作提示，直到用户主动核对、关闭或重新操作；不重放失败的写请求。
- **统一写事务入口**：四个领域路由实际接入 `deps.begin_immediate()`，与工程契约一致。
- **热点预览地址识别**：原外网 UDP 探测会取到 VPN 虚拟网卡地址，现优先读取当前默认路由源地址，或通过当前网关查询本机源地址，不硬编码热点 IP。已恢复 `./preview-ui.sh --lan`；本次地址为本机 `http://127.0.0.1:8765/`、同热点 `http://192.168.149.192:8765/`，换网后以新启动输出为准。
- **旧浏览器用例适配**：对齐常驻桌面侧栏、历史页重试、全部记录子视图、科目折叠卡片、240ms 页签动画与复盘抽屉零轮询契约。通知专项使用显式 `--preview-notifications`，仅在 `/tmp` 数据库模拟，不外发；计时与布局断言等待抽屉动画结束。

最终复核：`234` 项 pytest、全部 `30` 组浏览器场景（含 PWA 生命周期与通知模拟）、JS 语法与网络恢复单测全部通过；对重构前预览备份执行两次迁移，原字段与记录不变、完整性与外键检查通过。测试均使用 `/tmp` 隔离数据库并关闭真实 AI 与手机通知。浏览器逐项日志位于本机 `/tmp/daily-plan-handoff-final-browser/`（临时目录，不作为长期交接资料）。

2026-11-18 用户已验收并明确授权提交、推送与生产部署。应用提交 `2295d1744c560c57cb287aef1ba71cc9fabb400e` 已推送 GitHub main，于中国时间 **21:22:41** 完成发布；独立 verify 与公网 HTTPS 只读验收均通过。详细记录见 [本次发布单](docs/releases/2026-11-18-full-stack-refactor.md)。收尾文档提交不改变线上应用版本。

---

## 一、本轮进展：2026-11-18 全栈架构解耦、书刊化 UI 统一与技术债清理（已发布）

- **当前状态**：**已完成代码重构、文档归档、用户验收、提交推送与正式部署；服务器 234 项隔离测试、迁移零损校验、36 项静态资源一致性及公网 HTTPS 验收通过，服务 active/running、NRestarts=0**。
- **本机预览地址**：通过 `./preview-ui.sh --lan` 运行于独立测试库 `data/ui-preview.db`（备份副本位于 `data/ui-preview-backups/pre-refactor-20261118-180950.db`，已通过 `deploy/verify-migration.py` 零损校验）。

### 核心重构与优化清单
1. **后端解耦、元数据驱动与性能/并发除雷**：
   - 将原 2716 行单体 `app/api.py` 拆分为领域引擎（`app/services/{clock,catalog,prompts,settings_store,execution_engine,review_engine}.py`）与模块化路由（`app/routers/{deps,plans,execution,reviews,settings}.py`），保留 `app/api.py` 兼容导出门面。
   - **统一科目能力目录（`catalog.py`）**：消除前后端 20+ 处 `math`/`english`/`computer`/`rehab` 魔法分支，内置 10 科与自定义 `custom_*` 项目共享一套能力配置（默认类型、学习目标口径、词数支持、子科目、常用分钟、色板与图标），历史数据 100% 无缝兼容。
   - **统一时区引擎（`clock.py`）**：全站前后端统一锁定 `Asia/Shanghai`，消除模块导入期固化 `date.today()` 及午夜跨时区错位隐患。
   - **SQLite 只读保证与查询提速**：所有 `GET` 路由与 `/return-today` 改为纯内存进度核算（100% 零隐式写库）；所有写路由统一 `BEGIN IMMEDIATE` 并将外部 AI 调用移出数据库连接；周复盘由 150+ 次逐日查询压缩为 6 条批量 SQL；时间段重叠检测收窄为 `±2 天` 安全索引窗口；后台 `auto_stop` 与 `reminders` 增加只读前置探测。
2. **前端按需模块化、书刊视觉统一与交互减负**：
   - 将原 2900 行单体 `app/static/app.js` 拆分为核心共享层 `app.js` 与按需页面脚本 `today.js`、`execution.js`、`settings.js`、`workbench.js`；移除复盘页与历史记录页中隐藏重复渲染的 `execution_tasks.html` 节点，并在 `recordsOnly` 模式下停用后台常驻轮询与重复 `/api/settings` 请求。
   - **彻底清除旧绿色系残留**：重写 `app/static/style.css` 并统一附属样式表，全面收敛至第二代暖沙纸色板（`#f4f1e9` / `#fffdf8` / `#29251f` / `#ac624a`），修复移动端 `<16px` 输入框缩放隐患。
   - **高频体验升级**：
     - 今天页「待审池」用纸面卡片内联编辑器（快捷重排今天/明天/本周日、内联拆小、直接放下）彻底替代浏览器原生 `prompt()`。
     - 设置页移除已废弃的精力预算三输入框与底部大段静态教程卡片，主项目置顶，有效细分标签改为按科目折叠卡片，新增未保存变更提示。
     - GPT 工作台修复中文输入法组词吞字与每次按键全量重绘失焦 Bug（接入 `compositionstart`/`compositionend` + `450ms` 防抖自动保存 + 删除/恢复二次确认）。
     - 全站 9 类弹窗统一补齐右上角线性关闭叉号与点击遮罩外侧关闭。
3. **老文档与冗余资产归档瘦身**：
   - 将 175KB 历史交接单、96KB 旧计划稿、十月份旧发布单、6.1MB 历史过程截图与早期废弃 Windows/Termux 脚本统一归入 `docs/archive/`，重写精炼 `AGENTS.md`、`README.md`、`Tutor.md`、`DESIGN.md`、`docs/` 现役文档，`规划文档/` 原封不动。

---

## 二、当前线上生产环境基线

- **正式网址**：`https://120.55.53.215/`（SSH 别名 `aliyun`，部署用户 `codexdev`）
- **当前运行版本**：`2295d1744c560c57cb287aef1ba71cc9fabb400e`（2026-11-18 发布：全栈拆分、交互优化、只读保证与文档归档）
- **程序入口**：`/opt/daily-plan/current -> /opt/daily-plan/releases/2295d1744c560c57cb287aef1ba71cc9fabb400e`
- **生产数据库**：`/var/lib/daily-plan/daily_plan.db`
- **最近生产备份**：`/var/backups/daily-plan/predeploy-pwa-2295d17-20261118-212237.db`
- **发布结果记录**：`/var/backups/daily-plan/deployment-pwa-2295d17-20261118-212237.json`
- **上一稳定版本（需要紧急回退时使用）**：`a83e9f7afc05f33d469902080fd7ccdb8b1b4080`

### 标准生产发布流程（待用户验收预览并明确授权后执行）
1. 本机确认工作区干净，提交并推送 `main` 分支，记录完整 40 位提交哈希 `<COMMIT>`。
2. 打包干净源码归档并上传至 `/tmp/daily-plan-release-source.tar`，复用离线锁定依赖包执行 `stage`（自动在隔离临时库跑全量 `pytest`）：
   ```bash
   python3 /opt/daily-plan/current/deploy/release.py stage <COMMIT> --source-archive /tmp/daily-plan-release-source.tar --archive-sha <SHA256> --wheel-archive <WHEELS_TAR> --wheel-sha <WHEELS_SHA>
   ```
3. 经 [已验证的服务器授权管理入口](docs/server-https-entry.md#服务器维护授权入口) 进入 root 管理会话，使用新版本目录自身的 `.venv/bin/python` 执行只读备份预检与正式原子切换（内置自动迁移双重核对与失败自动回滚）：
   ```bash
   /opt/daily-plan/releases/<COMMIT>/.venv/bin/python /opt/daily-plan/releases/<COMMIT>/deploy/release.py precheck <COMMIT>
   /opt/daily-plan/releases/<COMMIT>/.venv/bin/python /opt/daily-plan/releases/<COMMIT>/deploy/release.py deploy <COMMIT>
   /opt/daily-plan/releases/<COMMIT>/.venv/bin/python /opt/daily-plan/releases/<COMMIT>/deploy/release.py verify <COMMIT>
   ```

### 生产紧急回退命令
若需要回退至上一稳定版 `a83e9f7afc05f33d469902080fd7ccdb8b1b4080`，先对上线后的当前库做一致性备份，再经上述授权入口执行以下命令。本轮无破坏性表结构变更，只切换程序，不以旧库覆盖新记录：
```bash
systemctl stop daily-plan.service && ln -sfn /opt/daily-plan/releases/a83e9f7afc05f33d469902080fd7ccdb8b1b4080 /opt/daily-plan/current && systemctl start daily-plan.service && /opt/daily-plan/current/.venv/bin/python /opt/daily-plan/current/deploy/release.py verify a83e9f7afc05f33d469902080fd7ccdb8b1b4080
```
