# Changelog

## 0.1.0

首个版本 / Initial release.

- `md <path>` 在浏览器中打开本地 Markdown 文件或目录，常驻 Bun daemon 负责文件读写（只绑 `127.0.0.1`）
- Meowdown 混合渲染编辑器（focus / show / hide 三模式），防抖自动保存 + `Cmd+S`
- 保存自动格式化：autocorrect（中英文空格、标点）→ oxfmt（Markdown 排版），磁盘内容始终整洁；格式化结果空闲时回灌，不打断输入
- 外部（AI agent / 其他编辑器）改动实时同步；有未保存改动时弹冲突条，可展开并排 diff 选边
- 文件树（仅 `.md` 与目录）：新建 / 重命名 / 删除（进系统废纸篓）
- 粘贴图片自动存入文档同级 `assets/`，`[[wikilink]]` 补全与跳转，大纲侧栏，`rg` 全文搜索
- 暗色模式跟随系统；`md service install` 一键 launchd 开机自启
