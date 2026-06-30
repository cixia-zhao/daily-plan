# 执行页与任务时间看板第一版

把“确认今日清单后到提交今日情况”这一段升级成可真实日用的本地执行记录流程。完成后，白天可在独立执行页里记录任务有效时间、标签时间和中断时间；晚上在单日复盘页能直接看到每个已执行任务的数据看板。

## 变更清单

### 后端与数据层

#### [MODIFY] [app/models.py](</C:/Users/cixia/Desktop/daily plan/app/models.py>)
- 新增 `task_execution_segments` 表，保存任务执行时间段、标签快照和中断记录。
- 保留原有 `tasks.actual_minutes` 字段，但改为由有效时间聚合同步。

#### [MODIFY] [app/database.py](</C:/Users/cixia/Desktop/daily plan/app/database.py>)
- 为老库补齐 `task_execution_segments` 表和索引。
- 确保增量初始化不会破坏已有数据。

#### [MODIFY] [app/schemas.py](</C:/Users/cixia/Desktop/daily plan/app/schemas.py>)
- 新增执行标签配置、执行段创建/编辑输入模型。
- 扩展设置结构，支持 `execution_labels`。

#### [MODIFY] [app/api.py](</C:/Users/cixia/Desktop/daily plan/app/api.py>)
- 新增执行页聚合接口和时间段增删改查接口。
- 在提交今日情况前校验无未结束时间段，并把任务有效时间同步到 `actual_minutes`。
- 为单日复盘接口补充任务执行看板数据。

### 前端页面与交互

#### [MODIFY] [app/main.py](</C:/Users/cixia/Desktop/daily plan/app/main.py>)
- 新增 `/execute` 页面路由。

#### [MODIFY] [app/templates/base.html](</C:/Users/cixia/Desktop/daily plan/app/templates/base.html>)
- 在主导航新增“执行台”入口。

#### [MODIFY] [app/templates/index.html](</C:/Users/cixia/Desktop/daily plan/app/templates/index.html>)
- 已确认后把主按钮从“提交今日情况”改成“进入执行台”。
- 主任务实际分钟改成只读展示，避免形成双数据源。

#### [NEW] [app/templates/execute.html](</C:/Users/cixia/Desktop/daily plan/app/templates/execute.html>)
- 新增独立执行页，承载任务切换、标签切换、时间轴补改和提交入口。

#### [MODIFY] [app/templates/review.html](</C:/Users/cixia/Desktop/daily plan/app/templates/review.html>)
- 在总统计和晚间收束之间新增任务执行看板区域。

#### [MODIFY] [app/templates/settings.html](</C:/Users/cixia/Desktop/daily plan/app/templates/settings.html>)
- 增加执行标签配置区域，支持自定义标签。

#### [MODIFY] [app/static/app.js](</C:/Users/cixia/Desktop/daily plan/app/static/app.js>)
- 新增执行页状态管理、时间段切换、补记编辑、任务看板渲染。
- 更新今天页、复盘页、设置页的联动逻辑。

#### [MODIFY] [app/static/style.css](</C:/Users/cixia/Desktop/daily plan/app/static/style.css>)
- 补充执行页、时间轴、任务看板和标签设置样式。

### 测试

#### [MODIFY] [tests/test_api.py](</C:/Users/cixia/Desktop/daily plan/tests/test_api.py>)
- 新增执行段接口、提交流程、聚合看板和标签配置测试。

#### [MODIFY] [tests/test_ui_and_settings.py](</C:/Users/cixia/Desktop/daily plan/tests/test_ui_and_settings.py>)
- 新增 `/execute` 页面、执行看板、设置页标签配置相关断言。

## 验证计划

### 自动化测试
- 命令：`python -m pytest -q`
- 预期：执行段、设置页、执行页和复盘页新增回归测试通过。

- 命令：`python -m compileall app tests`
- 预期：`app/` 与 `tests/` 全部可编译。

- 命令：`node --check app/static/app.js`
- 预期：前端脚本语法通过。

### 手动验证
1. 确认某天清单后，今天页出现“进入执行台”入口。
2. 进入执行台后，开始任务有效时间，切换计总标签，再切回任务，确认只有一个激活项。
3. 切到“吃饭”等中断标签，确认中断被记录但不并入任务总时间。
4. 在时间轴里补记、编辑、删除一段，确认任务看板即时刷新。
5. 在执行台勾选任务并提交，确认仍有未结束段时会被拦住。
6. 打开单日复盘页，确认能看到任务总时间、有效时间、标签时间和次数。
