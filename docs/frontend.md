# 前端模块架构与交互契约

前端采用**服务端 Jinja2 模板 + 原生 CSS 设计令牌 + 按页面拆分的无构建 JavaScript**，兼顾极速首屏、高可维护性与离线韧性。

---

## 一、脚本加载拓扑

### 1. 全局基础层（由 `base.html` 统一按序 `defer` 加载）
1. `app/static/app.js`：DOM 简写（`$`/`$$`/`esc`）、带 HTTP 状态码的 `api()`、防截断 `toast()`、东八区 `todayIso()`、线性图标 `uiIcon()`、弹窗外侧关闭 `bindDialogBackdropClose()`、单例设置缓存 `ensureSettings()` / `setSettings()`、科目能力查询 `categoryMeta()`、纸面确认窗 `confirmAction()`、按日重置恢复与共享月历弹窗。所有核心能力同步暴露于 `window.DailyPlan`。
2. `app/static/surfaces.js`（`window.PlanUI`）：顶栏当前页指示线、跨页导航轻过渡、可复用页签控制器 `tabs()`、日期参数同步与「回到今天」显隐、`ExecutionSheetDrag` 移动端底部抽屉拖拽手势。
3. `app/static/visuals.js`（`window.PlanVisuals`）：基于 `categoryMeta()` 的科目矿物色板与线性图标渲染、日/周有效投入对比条形与折线/柱状 SVG 图表、时间去向纹理条。
4. `app/static/timeline.js`（`window.ExecutionTimeline`）：读写分离两阶段测量的高帧率可缩放横向时间轴、「点击选中、再点编辑」两步防误触交互、全部时间记录子视图切换。
5. `app/static/time-correction.js`（`TimeCorrectionDialog`）：执行中一键划出活动或补回切换的分屏弹窗控制器与幂等撤销条。
6. `app/static/network-recovery.js` + `app/static/pwa.js`（经 `pwa_controls.html` 加载）：断网横幅、退避重连只读探测、PWA 安装引导与 Service Worker 新版本受控切换。连接恢复后的被动同步保留未确认计时操作的错误提示，用户核对、关闭或重新操作后清除。

### 2. 页面按需模块（由各模板 `{% block page_scripts %}` 加载）
- `today.js`（`/`）：晨间目标输入与常用/历史分钟悬浮候选、计划草稿编辑、主副航线槽位交换、纸面内联待审池（快捷重排今天/明天/本周日、拆小、放下）。
- `execution.js`（`/execute`、`/review`、`/execute?date=...`）：
  - 在 `/execute` 运行完整课程推进、目标周长进度动画、有效细分内联增删改、分心/休息提醒、自动停止与词数弹窗。
  - 手机/平板的空闲悬浮入口仅显示计时图标，固定右下角；支持鼠标与触屏拖动、靠边停放及本机记住位置。拖动不展开面板、不写计时记录；缩放或旋转后按可见视口和安全区限位，键盘仍可正常打开。
  - 在 `/review` 与 `execution-history` 自动进入轻量 `recordsOnly` 模式，暴露 `window.DailyPlanRecords` 供按需打开时间轴编辑，**空闲时零后台轮询、零重复设置请求**。
- `review.js`（`/review`）：自然周步骤条、日/周数据看板与收尾面板切换、`localStorage` 本机草稿防丢暂存、ChatGPT 提示词一键复制与留档保存。
- `history.js`（`execution_history.html`）：历史日期只读项目概览与内联时间记录联动刷新。
- `settings.js`（`/settings`）：主项目动态增删排序、按科目折叠的有效细分标签卡片、未保存脏状态提示与数据库备份下载。
- `workbench.js`（`/gpt-workbench`）：兼容中文输入法组词（`compositionstart`/`compositionend`）的 `450ms` 防抖自动保存提示词编辑器与历史协作留档查阅。

---

## 二、样式表分层（`app/static/`）

1. `style.css`：全局 `:root` 暖沙纸色彩令牌、基础排版、表单与按钮、全站弹窗、工作台与设置页样式。
2. `surfaces.css`：顶栏胶囊导航、执行台抽屉/桌面双栏骨架、自动停止弹窗与矮横屏自适应（`.is-unpinned`）。
3. `ui-controls.css`：`44×44px` `.ui-icon-button` 规范与快捷时间修正弹窗细节。
4. `visuals.css` / `timeline.css` / `workspace.css`：数据图表纹理、横向时间轴色块、复盘周步骤条与协作区排版。
5. 页面专属样式（置于 `{% block page_styles %}` 最末加载，无需堆砌冗余选择器权重）：`today.css`、`review.css`、`history.css`。
