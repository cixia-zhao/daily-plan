# 电脑执行分屏与按进度回今天发布（2026-10-31）

用户明确授权“推送并且部署”。应用`5ded3f959c31c3c37d8b8f5f65e3db0aaf977ccd`已推送GitHub main，并于中国时间2026-10-31 19:12:41部署至https://120.55.53.215/。发布交接随收尾提交推送，不改变运行应用版本。

## 发布内容

- 1000px及以上执行页右侧常驻计时与记录，停止及刷新后保留；窄屏手机／平板继续原抽屉及运行迷你条。处理收起途中切到宽屏的状态。
- 修复迷你条错误读取真假值导致undefined，显示真实任务名及细分名。
- 计划、历史执行、复盘的“回到今天”统一只读跳转。正在计时优先执行页；没有运行段且已有保存记录或词数则当天日复盘；已确认未执行去执行页，无计划／仅草稿去今天页。以中国时间当天判断，保留登录保护和no-store。
- 无数据库结构变更，未带入预览数据、配置或凭据。

## 验证与实际结果

本机Python3.12临时库216项全套通过；responsive_workspace、date_navigation、timer_sheet及mobile四组独立临时库浏览器验证通过，覆盖宽屏左右布局、手机名称、关闭中跨断点、真实按钮进度导航、计时记录切页／手势／自动停止与完整手机流程。语法、编译、Git差异检查通过；实体触感与iOS仍待日常使用确认。

服务器新发布目录沿用既有离线锁定依赖（Python3.12.3、FastAPI0.153.0），216项临时库测试通过，33.45秒。上线前在线备份及停服最终备份的副本分别初始化两次，所有原列原行、完整性和外键保持；113段、184任务及其他原表记录保持。正式初始化后、启动前与最终验证副本逐表逐行一致。

19:12:40开始，19:12:41完成原子切换。受保护五页面、历史页200、三处统一回今天链接、当天跳转／运行优先／登录保护、28项静态资源逐字节一致、日周接口、自动停止／补记及PWA检查通过。相关服务与定时器active，应用NRestarts=0，通知configured=true／preview=false，生产配置哈希保持。

本机公网可信HTTPS登录200、未登录执行及回今天303到登录、API401、28资源逐字节一致、PWA资源与HTTP301跳转均通过；只做GET验收，未写生产测试记录、调用AI或发送测试通知。

## 版本、归档与备份

- 应用提交：5ded3f959c31c3c37d8b8f5f65e3db0aaf977ccd。
- 源码归档SHA256：1f401fbed5efe5550ff95bdbdb6e7f5e5a3911790d041c0969133f0d6d2485dd。
- 锁定依赖归档SHA256：ab250f45e4a5e54ffa8bea41e56b6deb2768b13f453f99dcc5896f5dfe96c228。
- 当前目录：/opt/daily-plan/releases/5ded3f959c31c3c37d8b8f5f65e3db0aaf977ccd。
- 上一目录：/opt/daily-plan/releases/03c7bcdb25056fa5b06bd107ac698adbb366cfd6，完整保留。
- 上传归档及脚本：/home/codexdev/daily-plan-staging/20261031-5ded3f9/。
- 在线备份：/var/backups/daily-plan/precheck-pwa-5ded3f9-20261031-191202.db。
- 在线验证副本：/var/backups/daily-plan/precheck-pwa-5ded3f9-20261031-191202-validated.db。
- 最终备份：/var/backups/daily-plan/predeploy-pwa-5ded3f9-20261031-191240.db。
- 最终验证副本：/var/backups/daily-plan/predeploy-pwa-5ded3f9-20261031-191240-validated.db。
- 部署结果：/var/backups/daily-plan/deployment-pwa-5ded3f9-20261031-191240.json。

备份文件沿用发布脚本既有pwa前缀，具体版本由5ded3f9标识。独立预览继续使用data/ui-preview.db与ui-preview-backups，未与正式数据混用。

## 回退

先备份上线后的当前数据库，再停止daily-plan.service，将/opt/daily-plan/current原子切回上述03c7bcd旧目录，重启并验收登录、数据、计时和通知。只回退程序，不用旧数据库覆盖上线后的记录；上一版本具备相同自动停止数据结构。本轮无已知发布阻塞。
