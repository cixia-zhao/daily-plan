# 今天页设计参考与实现

2026-10-11。根据用户要求进行网站搜索、界面图像搜索和 GitHub 项目检索，阅读以下官方说明、仓库 README 与截图信息。借鉴信息层级和布局方法，未复制外部源码、素材或引入依赖。

| 参考 | 本轮采用的方向 |
| --- | --- |
| [Things 官方功能介绍](https://culturedcode.com/things/features/) | 详情按需展开，常用清单保持清楚；不把全部编辑字段放在默认页面 |
| [Todoist 今天视图](https://www.todoist.com/help/todoist/get-started/plan-your-day-with-the-today-view-UVUXaiSs) | 以当天安排为中心，主操作易找到 |
| [GitHub：Planify](https://github.com/alainm23/planify) 与 [官网](https://useplanify.com/) | 清晰的分组和轻量清单，减少每行的重复装饰 |
| [GitHub：Super Productivity](https://github.com/super-productivity/super-productivity) | 计划与实际时间明确区分，保留用户本来的计时流程 |
| [GitHub：Planly](https://github.com/drkokorev/Planly) | 紧凑的移动日计划；本轮不引入其同步或时间轴逻辑 |
| [NN/g：视觉层级](https://www.nngroup.com/articles/visual-hierarchy-ux-definition/) | 用大小、颜色与分组体现主次，边框克制；不让每个元素一样突出 |
| [NN/g：移动端次要内容](https://www.nngroup.com/articles/defer-secondary-content-for-mobile/) | 默认呈现关键任务，次要信息逐步打开 |

## 实际设计

暖白底色、深绿色主要操作、低饱和科目标识。日期与状态是辅助信息，页面标题和科目名称突出，目标分钟直接编辑。清单行用细分隔线，详细编辑用行尾“···”入口。保存修改为次要按钮，确认计划为主要按钮。主要安排和其他活动切换显示；原有主副航线数据逻辑保持。

手机单列；平板和电脑在 760px 及以上使用“左侧清单、右侧目标概览”。小视口按可用高度减少留白，保留正常字体、44px 输入及操作区，不禁止滚动。默认清单仍能一屏操作；追加很多活动和详细历史允许滚动。

今天页专用样式为 `app/static/today.css`，通过 index.html 的 page_styles 块加载；共用 style.css 保留基础组件与统一色彩。业务规则与数据库迁移无改动。

## 本轮验证

81 个 Python 3.12 测试通过；JavaScript 语法、Python 编译及 diff 检查通过。独立预览多视口：360×640、390×720、768×1024、1024×680、1280×720，默认清单整体处于一屏、确认按钮可见、无横向溢出。晨间输入、弹窗编辑/保存、主副交换、0 目标计时/刷新、临时活动、背单词改删、习惯休息及日周统计通过，无 JavaScript 错误。已检查独立示例数据的手机、平板、晨间与设置实际页面截图。

实体手机和平板新设计待用户试用，尚未提交、推送或部署正式网站。设计审美由用户在实际设备确认；自动化检查只能验证操作与布局条件。

## 暖纸主题与去模板感（2026-10-11，当前预览）

用户认可上一版排版，但不喜欢绿色，指定参考 Claude Code 产品官网。本次实读官网公开 CSS，以 #faf9f5 暖纸色、#141413 炭黑与少量陶土色调整；保留手机清单和平板概览布局。科目标识统一暖灰，移除主按钮阴影与装饰箭头；概览文字改成具体操作说明。标题用系统衬线字体，输入和正文保留系统无衬线。

视觉偏好以根目录 DESIGN.md 为准；此前文档中绿色主题描述是上一版状态。独立预览已更新，81 个 Python 3.12 测试及手机/平板首屏与常用操作流程通过，文字对比度与实际截图已检查。尚未提交、推送或部署；实体设备这一版等待用户查看。

### 本轮搜索与证据

- [Claude Code 官网](https://claude.com/product/claude-code)：读取 HTML 所链接的四份公开 CSS，核实 --color-gray-050、--color-gray-150、--color-gray-950、--color-clay 与 --theme-button-primary-bg 等实际声明。不是按搜索摘要猜颜色。
- [InterfaceKit：什么使页面像 AI 生成](https://blog.interfacekit.io/what-makes-a-website-look-ai-generated)：参考其装饰、通用文案和跨页一致性的检查方法，不将其视作能客观识别生成来源的判据。
- [SmoothUI：通用 AI 界面问题](https://smoothui.dev/blog/ai-design-slop)：参考“渲染、检查、修正”的循环，不安装其推广工具或复制第三方组件。

本次没有改业务规则、数据库或服务器配置。深陶土文字 #a94f32 对纸色 #faf9f5 的计算对比度约 5.18:1；炭黑对纸色约 17.5:1。辅助文字从更浅暖灰加深为 #5e5d59。对比度检查是颜色计算，不替代完整无障碍审计。
