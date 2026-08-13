# writedown

[English](./README.md) | 简体中文

在浏览器里编辑本地 Markdown 文件。一条 `md` 命令，文件读写走本地常驻服务，浏览器端零权限弹窗；AI agent 改动实时同步进编辑器，保存自动排版。

![writedown](docs/screenshot-zh.jpg)

## 特性

- **即开即用** — `md file.md` / `md dir`，daemon 未启动会自动拉起
- **Typora 式所见即所得** — [Meowdown](https://github.com/prosekit/meowdown) 混合渲染，语法只在光标处露出
- **保存即格式化** — [autocorrect](https://github.com/huacnlee/autocorrect)（中英文空格）+ [oxfmt](https://github.com/oxc-project/oxfmt)（Markdown 排版），磁盘永远整洁，回灌不打断输入
- **与 AI agent 共同编辑** — 外部改动实时同步；冲突时并排 diff 选边
- **链接卡片** — 独占段落的 YouTube / X / 网站链接渲染为播放器、推文卡、站点卡片，文件里仍是纯 URL
- **文件树（内联新建/重命名）、文件名模糊过滤、大纲、wikilink、图片粘贴、设置面板、亮暗主题**
- **开机自启** — `md service install`（macOS launchd）

## 安装

需要 [Bun](https://bun.sh) ≥ 1.2。

```bash
bun add -g writedown   # 或 pnpm add -g writedown
```

升级无需手动重启：下次运行 `md` 时 CLI 发现 daemon 版本不一致会自动重启它，已打开的页面自动重连。

```bash
bun add -g writedown@latest   # 升级
```

## 使用

```bash
md notes.md               # 打开单个文件（工作区为其父目录）
md ~/notes                # 打开目录
md                        # 恢复上次工作区
md service install        # 开机自启（launchd）
md service uninstall
```

端口默认 `2233`（`--port` / `MD_PORT` 覆盖），只监听 `127.0.0.1`。配置存在 `~/.config/writedown/settings.json`，应用内设置面板可改。

## 开发

```bash
pnpm install
pnpm dev      # daemon (2233) + vite dev (5173)
pnpm test     # bun test（server e2e + web 单元测试）
pnpm lint     # oxlint
pnpm build    # tsc -b + vite build
```

架构与协议设计见 [DESIGN.md](./DESIGN.md)。

## License

[MIT](./LICENSE)
