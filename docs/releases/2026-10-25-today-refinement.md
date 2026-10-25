# 今天页排版与目标修改发布（2026-10-25）

用户明确授权“推上去git并且部署”。应用`dacabf9b551f0ac186506cca08f90414e90bdfff`已推送GitHub main，于中国时间2026-10-25 22:16:43部署至https://120.55.53.215/。后续发布交接提交不改变运行应用版本。

## 发布内容

- 今天页标题、清单内容面与侧概览分开，手机14px／平板24px横向留白，页签、行与底部按钮沿共同边线，修复全站表面覆盖和零内边距组合造成的贴边。
- 日期和顶栏控件统一44px，去掉日期双层留白与重复“待”字方块；三位数分钟不被浏览器步进器挤窄，原15分钟键盘步进保持。
- “修改目标时长”带入当前草稿的实际值；保存通过既有草稿更新直接返回清单，取消不写库，其他活动、名称、标准、排序与类型保留。失败留输入、保存中防重复／切日／取消，脏输入切日确认，不重新生成草稿。

关键文件为app/templates/index.html、app/static/today.css、app/static/app.js。没有后端接口和数据库结构变更。没有复制预览数据、更新生产密码、通知凭据或反向代理配置。

## 验证与发布过程

本机七组不同临时库浏览器通过：today_refinement、mobile、compact_ui、target_quick、main_projects、morning_preferences、responsive_workspace；覆盖360／390／768／1024／1280、首屏／主副详情、目标候选与整数校验、带入／取消／保存返回／失败重试／刷新／属性保留／切日及请求中保护，以及其他页导航和计时面板。截图实读、JS语法和差异检查通过。此前阶段未改后端，没有把旧196项当本机本轮结果。

本次发布在服务器Python3.12独立新目录重新运行全套，196项临时库pytest通过（25.58秒）。沿用上一正式版锁定离线依赖，未升级旧应用环境。在线与停服最终备份的副本各初始化两次，完整性、外键及全部原字段／记录通过；正式初始化后、启动服务前与验证副本逐表逐行一致，随后原子切换current并启动服务。

只读验收五页面200、12项CSS／JS与源码逐字节一致、今天页新内容面和目标编辑／取消控件、日周比较接口、历史执行地址303、正确生产库与通知configured=true／preview=false、未登录API401。应用、ntfy、Nginx、备份和证书定时器active，NRestarts=0。公网可信TLS、登录200、首页未登录303、HTTP301及12静态资源逐字节一致。生产环境文件哈希保持。没有生产示例写入、AI调用或测试通知发送。

实体软键盘、iOS和真实触控手感未专门覆盖；七组浏览器不替代实机评价。

## 精确版本与备份

- 应用：dacabf9b551f0ac186506cca08f90414e90bdfff。
- 当前目录：/opt/daily-plan/releases/dacabf9b551f0ac186506cca08f90414e90bdfff。
- 上一目录：/opt/daily-plan/releases/768bb84b6c0fca876304f121b55dafcb210dfcf8，完整保留。
- 开始／完成：中国时间2026-10-25 22:16:42／22:16:43。
- 在线备份：/var/backups/daily-plan/precheck-today-dacabf9-20261025-221626.db。
- 最终备份：/var/backups/daily-plan/predeploy-today-dacabf9-20261025-221642.db。
- 验证副本：上述备份同名-validated.db。
- 部署结果：/var/backups/daily-plan/deployment-today-dacabf9-20261025-221642.json。
- 部署脚本：/var/backups/daily-plan/deploy-today-dacabf9.py。
- 源码归档SHA256：5c5ade907ee5e3f496af04f7acc703035c4fb9ef1ce24fc8b35752414cae9ad0。
- 离线依赖归档SHA256：ab250f45e4a5e54ffa8bea41e56b6deb2768b13f453f99dcc5896f5dfe96c228。

## 回退与后续

先备份上线后的现库并核对活动计时，停止daily-plan.service，将/opt/daily-plan/current原子切回上述上一目录，再启动并核验健康、登录和静态资源。无结构迁移，旧应用继续使用原库；界面和目标修改流程恢复旧版。禁止以旧备份覆盖上线后真实记录，数据库恢复须另行评估。

本机与GitHub保存应用及收尾交接，线上固定运行应用提交。独立预览继续保留既有测试状态，未把测试数据带到生产。下一步用户刷新正式站点验证日常操作。
