# 本次控件调整依据（2026-11-06）

本页记录第一项界面优化的实施依据；不替代用户尚未确认开始的跨项目设计偏好总结。

- [NN/G：图标可用性](https://www.nngroup.com/articles/icon-usability/)：熟悉图标能节省空间，但含义依赖用户经验与使用位置。本次将加号、编辑、返回、关闭图标化，保留保存与时间修正的明确文字，图标附可访问名称。
- [NN/G：一致性与标准](https://www.nngroup.com/articles/consistency-and-standards/)：同一功能在产品内部采用相同模式。本次抽取共用尺寸与状态，统一时间编辑、自动停止、应用说明及时间修正的关闭按钮。
- [Carbon：按钮规范](https://www.carbondesignsystem.com/building-blocks/core/components/button/guidelines)：用主次层级、统一尺寸和间距区分动作。右上角图标工具、快捷动作和保存按钮各有稳定位置，移除须进入确认步骤。
- [Apple：按钮](https://developer.apple.com/design/human-interface-guidelines/buttons)：熟悉动作配熟悉符号，并通过外观表达层级。本次保留暖纸、炭黑与陶土，仅用细边、轻接触阴影和按压反馈补充表面层次，不改变既有页面布局。

实现：app/static/ui-controls.css、app/static/icons/ui.svg及time-correction.js。手机触控至少44px，内部图形18px；必要滚动和键盘焦点保留。第二项仍等待用户确认。
