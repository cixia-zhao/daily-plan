# 前端页面与交互速查文档

> 最后更新：2026-06-30
> 覆盖文件：`app/templates/*.html`、`app/static/style.css`、`app/static/app.js`

## 模块职责

提供电脑和手机都可用的服务端模板页面。浏览器只通过 JSON API 操作，不读密钥、不自行生成规则，也不会自动确认任务。当前前端核心已经从“今天页里全做完”升级成“今天页确认清单，执行台记录白天，复盘页回看数据”。

## 文件索引

### `app/templates/base.html`

- **职责**：页面骨架、响应式 meta、顶部导航、Toast、自定义确认弹层、共享月历弹层和静态资源入口。
- **关键变化**：主导航里已经加入 `/execute` 入口。
- **被依赖**：全部页面模板通过 Jinja2 `extends` 继承。

### `app/templates/index.html`

- **职责**：今天页的晨间输入、草稿编辑、确认清单与待审池入口。
- **主要区域**：共享月历日期入口、“重置今日”按钮、待审池按钮与下拉浮层、晨间输入、任务草稿/正式清单、执行方法、时间占用摘要。
- **关键变化**：
  - 已确认后主按钮改成“进入执行台”，不再鼓励直接在今天页提交今日情况。
  - 主任务 `actual_minutes` 改成只读展示，避免和执行台形成两套数据源。
- **依赖接口**：计划、任务、待审项 API，以及 `DELETE /api/daily-data/{date}`。

### `app/templates/execute.html`

- **职责**：白天真实执行入口，负责开始任务有效时间、切到标签、补改时间段、勾完成并提交今日情况。
- **主要区域**：日期入口、当前激活状态、任务列表、计总标签区、中断标签区、任务执行看板、时间轴编辑区、底部提交区。
- **依赖接口**：`GET /api/daily-execution/{date}`、`POST /api/daily-execution/{date}/tasks/start`、`POST /api/daily-execution/{date}/labels/start`、`POST /api/daily-execution/{date}/stop`、`POST /api/daily-execution/{date}/segments`、`PUT/DELETE /api/daily-execution/{date}/segments/{id}`、`PATCH /api/tasks/{id}`、`POST /api/daily-plans/{date}/submit`。

### `app/templates/review.html`

- **职责**：单日复盘页，查看某一天的计划状态、顶部统计、任务执行看板，填写结构化晚间收束，并导出给 GPT 协作。
- **主要区域**：共享月历日期入口、“重置今日”按钮、四个总统计卡片、任务执行看板区、晚间收束表单、补充正文、GPT 协作区。
- **关键变化**：顶部统计和晚间收束之间新增了任务执行看板空态容器 `#daily-execution-board-empty` 和实际看板容器 `#daily-execution-board`。
- **依赖接口**：`GET /api/daily-review/{date}`、`POST /api/daily-reviews`、`PUT /api/daily-review/{date}/gpt-record`、`DELETE /api/daily-data/{date}`。

### `app/templates/weekly.html`

- **职责**：展示七日统计、共享月历全局日期导航、纸张感周进度条、周内当天复盘回看编辑、周整理摘要、GPT 导出入口、GPT 回复留档、最终周报编辑区和历史周报列表。
- **依赖接口**：`GET /api/calendar-status`、`GET /api/weekly-review`、`GET /api/daily-review/{date}`、`POST /api/daily-reviews`、`PUT /api/weekly-review/{end_date}/gpt-record`、`GET /api/weekly-reports`、`GET/PUT /api/weekly-reports/{end_date}`、`POST /api/weekly-reports/{end_date}/refresh`、`GET/PUT /api/settings`。

### `app/templates/gpt_workbench.html`

- **职责**：集中管理单日/单周 GPT 模板，并回看贴回来的协作记录。
- **依赖接口**：`GET /api/gpt-workbench`、`GET/PUT /api/settings`。

### `app/templates/settings.html`

- **职责**：维护当前阶段、项目起始日、预算、任务名称和执行标签，并说明 GPT 协作主路径。
- **关键变化**：
  - 设置页现在有执行标签编辑区 `#execution-label-fields`，可新增、编辑、删除自定义标签。
  - GPT 模板编辑仍然不在这里，而在 GPT 工作台。
- **依赖接口**：`GET/PUT /api/settings`。

### `app/static/app.js`

- **职责**：今天页、执行台、单日复盘、七日复盘、GPT 工作台和设置页的全部浏览器交互。
- **关键函数/组件**：
  - `renderTaskExecutionBoard()` (L141) — 把任务执行看板渲染成“总时间 / 有效时间 / 计总标签 / 中断标签”的轻量卡片。
  - `renderTimelineList()` (L838) — 执行台时间轴列表，负责激活段展示、补记卡片、时间段编辑与删除。
  - `renderExecutionSubmitList()` (L925) — 执行台底部勾选与提交区。
  - `renderExecutionTasks()` (L958) — 执行台任务列表与“开始有效时间”按钮。
  - `renderExecutionLabels()` (L999) — 执行台标签按钮区，按计总 / 中断两组渲染。
  - `renderExecutionState()` (L1026) — 执行台总入口，统一处理空态、激活态、任务看板、时间轴和提交区刷新。
  - `loadExecution()` (L1058) — 加载 `/api/daily-execution/{date}` 聚合数据。
  - `loadDailyReview()` (L1218) — 单日复盘页加载顶部统计、任务执行看板、复盘内容和 GPT 留档。
  - `loadWeeklyReview()` (L1389) — 七日复盘页加载周统计、内嵌复盘编辑、GPT 留档和历史周报。
  - `renderWorkbenchPrompts()` (L1493) — GPT 工作台模板切换和保存。
- **关键行为变化**：
  - 今天页 `#submit-today` 现在直接跳转到 `/execute?date=...`。
  - 执行台会在任何开始/切换动作后刷新整页聚合状态，不在前端自己缓存计算总时长。
  - 复盘页会用 `task_execution_board` 渲染中部任务看板。
  - 设置页会把 `execution_labels` 一并提交到 `/api/settings`。
- **依赖**：`/api/*`、模板中的固定元素 ID。
- **被依赖**：全部页面模板。

### `app/static/style.css`

- **职责**：暖色纸张视觉、任务卡、状态标签、表单、执行台、看板卡片、Toast 与窄屏单列布局。
- **关键布局/组件样式**：
  - 日期区按钮组、“重置今日”和待审池按钮/红点/浮层。
  - 主副航线双栏和等高五槽位布局。
  - 执行台任务卡、标签按钮、时间轴卡片、任务执行看板横条。
  - 自定义确认弹层、共享月历和窄屏单列适配。
- **注意**：执行台在手机上会频繁使用，改样式时优先保证触控面积、文本不断裂和时间轴表单不挤爆。

## 前后端关系

```text
今天页 → calendar-status / daily-plans / tasks / carryovers / daily-data
执行台 → daily-execution / tasks / daily-plans/submit
单日复盘页 → calendar-status / daily-review / daily-reviews / daily-data
七日复盘页 → calendar-status / weekly-review / weekly-reports
GPT 工作台 → gpt-workbench / settings
设置页 → settings
```

## 已知问题与注意事项

- 桌面端每栏固定显示五个槽位；移动端隐藏普通空槽，暂停运动卡仍保留。
- 今天页负责“确认清单”，执行台负责“白天记录”，单日复盘页负责“回看与晚间收束”；不要把三者职责重新混回一个页面。
- 执行台只对 `approved` 或 `submitted` 的日期开放；草稿状态会显示引导空态。
- 同一时刻全局只允许一个激活段；如果后续改交互，不要在前端做出“双计时”假象。
- 中断标签不并入任务总时间，但仍会显示在任务看板里。
- 执行台时间轴支持补记、编辑、删除；这块在手机上最容易暴露触控和日期输入问题。
- 设置页的执行标签分为系统标签和自定义标签；系统标签可改名但不可删。
- 单日复盘页和七日复盘页都支持“复制给 GPT -> 粘贴回项目”的手工协作闭环。
- 当前只做响应式页面，没有 PWA、离线缓存或前端构建链。
