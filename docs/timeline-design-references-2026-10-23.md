# 时间轴交互与标签设计参考

2026-10-23，按用户要求检索并实读官方产品说明和设计资料。以下为本项目的设计取舍，未引入第三方时间轴运行库。

| 实读来源 | 支持的原则 | 本项目采用方式 |
| --- | --- | --- |
| [Toggl：日历时间记录](https://support.toggl.com/en-us/article/tracking-time-in-the-calendar-view-1fftm9r/) | 短记录可省略块内详情，通过放大和选择查看；可调整显示时间范围 | 短段保留真实宽度，不裁切半个字；点选后展示完整信息 |
| [Apple：图表选择与滚动](https://developer.apple.com/videos/play/wwdc2023/10037/?time=469) | 选择用于逐步披露详情，固定可见时间范围后滚动浏览更多数据 | 默认两小时视窗，原生横滑；选择详情只在需要时出现 |
| [vis-timeline 官方说明](https://visjs.github.io/vis-timeline/docs/timeline/index.html) | 时序可平移、缩放，选择与编辑为可分开的交互 | 保留箭头、鼠标拖动、键盘方向；首次选择、再次点击编辑按用户明确要求实现 |
| [NN/g：图标可用性](https://www.nngroup.com/articles/icon-usability/) | 多数图标有歧义，需要文字及一致语境辅助 | 执行卡片保留名称，宽时间段可配图标；窄段不硬塞图文，选择详情提供完整含义 |

## 实施取舍

- 单条真实时序，无项目筛选或分轨。取消将全天挤满窄条的模式；两小时默认可进一步放大到一小时。
- 图文标签按可见宽度测量，完整显示；足够显示名称时优先保留名称，极窄段仅保留色块。轴下图例及“空白：未记录”按用户要求删除，实际未记录空档仍保留。
- 宽段、记录候选及当前运行段遵循同一选择状态。第一次点击选中，第二次才编辑；候选列表提供触控面积，滑动只浏览。进入编辑仍须显式保存才写入。
- 暖纸底配低饱和项目色和细色边。分心／生活分别为淡暖玫瑰与石色，取消原大面积斜纹和点纹。
- 用户指出初选数学∑和英语Aa难看后，替换为Lucide官方Calculator与Languages；在时间轴和执行卡片共用。其他线形标识为项目内简单SVG。

## 图标来源

- [Calculator](https://lucide.dev/icons/calculator) 与 [Languages](https://lucide.dev/icons/languages)，SVG原文件保存在app/static/icons/；内联复用路径，不安装依赖或运行时请求外站。
- 官方源为[Lucide仓库](https://github.com/lucide-icons/lucide/tree/main/icons)，版权和完整ISC／派生MIT许可保存在app/static/icons/LICENSE.lucide.txt。

## 验证范围

临时数据库浏览器检查首次选择／再次编辑、长短与30秒记录、真实触屏平移、鼠标拖动、箭头与同步保留位置、四种视口完整标签及无页面横向溢出。手机实机字体、惯性与iOS Safari仍需实际试用；不将自动检查等同于审美验收。


## 面板显隐与入口取舍

- 实读[Material底部面板](https://m1.material.io/components/bottom-sheets.html)：辅助操作可渐进展示，展开方式应服务当前任务。结合本项目需要持续点课程、保留页面上下文，采用页面内展开；没有照搬覆盖课程的底部抽屉。
- 检索[Material悬浮按钮](https://m1.material.io/components/buttons-floating-action-button.html)，采用单一“计时与记录”入口并配文字，避免无标签计时器图标歧义。Apple面板页面仅返回动态加载内容，未读到完整正文，不作为本轮具体布局依据。
- 用户明确确认空闲整块收起、页面内展开、运行仅计时／停止吸顶，优先级高于一般规范。旧02独占的补录入口迁移后才移除；运行控制不可被收起，错误自动进入可见区，历史日期保留小提示。
- 单击短段不再自动打开候选列表；列表改“全部时间记录”，放大用加减放大镜、记录用列表图标并保留辅助标签。列表随补录／同步更新，空列表仍能补录。
