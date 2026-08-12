# md — 浏览器里的本地 Markdown 编辑器

替代 Typora：编辑器跑在浏览器里，文件读写由本地常驻 Bun 服务完成，浏览器端零权限弹窗。
核心场景：本地 AI agent 和人交替编辑同一批 `.md` 文件，浏览器端实时看到外部变化。

本文档是实现契约。实现者遇到文档未覆盖的细节可自行决定，但**不得偏离已写明的决策**。

## 总架构

```
┌──────────────────────────────┐   WS(/ws, Zod 协议) + Hono RPC   ┌────────────────────────────────┐
│ 浏览器 http://127.0.0.1:2233   │ ◄──────────────────────────────► │ Bun daemon（只绑 127.0.0.1）      │
│ packages/web (React 19+Vite)  │                                  │ packages/md（server + CLI 同包）  │
│ @meowdown/react 编辑器         │                                  │ 文件 CRUD / watch / rg 搜索       │
│ @pierre/trees 文件树           │                                  │ 格式化管线 / 图片代理 / 废纸篓删除   │
│ @pierre/diffs 冲突对比          │                                  │ serve packages/web 构建产物       │
└──────────────────────────────┘                                  └────────────────────────────────┘
                                 md CLI：md [path] / md daemon / md service install|uninstall
```

## 技术栈与依赖

- pnpm workspace（root：`pnpm-workspace.yaml`），**所有依赖装 latest**，TypeScript 全程。
- `packages/md`（包名 `@md/server`，`"bin": {"md": "./src/cli.ts"}`，shebang `#!/usr/bin/env bun`，无构建步骤，bun 直跑 TS）：
  - Hono（HTTP + RPC 类型导出）、`Bun.serve` 原生 WebSocket、Zod
  - `oxfmt`（JS API：`format(fileName, text) → Promise<{code, errors}>`，已验证支持 markdown）
  - `autocorrect-node`（NAPI：`formatFor(text, filepath) → string`、`loadConfig(configStr)`）
  - `trash`（删除进系统废纸篓）
  - 搜索用系统 `rg`（spawn，`--json`），启动时检测缺失则搜索功能报错提示
- `packages/web`（包名 `@md/web`，private）：
  - Vite + React 19 + TypeScript + Tailwind CSS v4
  - `@meowdown/react` + `@meowdown/core`（编辑器，要求 React 19）
  - `@pierre/trees`（文件树）、`@pierre/diffs`（冲突对比）、`@pierre/theming`
  - `@iconify/react`（图标；用 `/offline` 入口 + `@iconify-icons/lucide` 的单图标数据，构建产物不依赖 Iconify 远程 API）
  - Zustand（状态）、ofetch 或 hono `hc`（少量 HTTP 调用）
- 不用：TanStack Query/Router（WS 推送模型用不上）、CRDT、Service Worker。

## 目录结构

```
md/
├── DESIGN.md
├── package.json              # workspace root，scripts：dev / build / start
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── md/
│   │   ├── package.json
│   │   └── src/
│   │       ├── cli.ts         # 入口：md [path] | md daemon | md service install|uninstall
│   │       ├── daemon.ts      # Bun.serve：Hono 路由 + WS upgrade + 静态资源
│   │       ├── workspace.ts   # 单一全局工作区状态（root、focus、树缓存、watcher 生命周期）
│   │       ├── files.ts       # 树扫描 / 读写 / create / rename / trash 删除，路径安全
│   │       ├── watcher.ts     # fs.watch recursive + 防抖 + echo 抑制
│   │       ├── format.ts      # autocorrect → oxfmt 管线 + 工作区配置发现
│   │       ├── search.ts      # rg --json 封装
│   │       ├── service.ts     # launchd plist 生成 / bootstrap / bootout
│   │       ├── state.ts       # ~/.local/state/md/（state.json、daemon.log、pid）
│   │       └── protocol.ts    # 全部 Zod schema + TS 类型（web 通过 @md/server/protocol 导入）
│   └── web/
│       ├── package.json
│       ├── vite.config.ts     # dev 时 /api /ws /raw 代理到 daemon
│       └── src/
│           ├── main.tsx / app.tsx
│           ├── ws.ts          # WS 客户端：连接、重连（1s 退避）、消息分发
│           ├── store.ts       # Zustand：tree、openFile{path,content,baseHash,dirty}、conflict、search、toc
│           ├── components/    # 文件名 kebab-case，导出的组件名 PascalCase
│           │   ├── file-tree.tsx        # @pierre/trees + 右键菜单（新建/重命名/删除）
│           │   ├── editor.tsx           # Meowdown 桥接（详见「编辑器桥接」）
│           │   ├── conflict-banner.tsx  # 外部改动冲突条 + @pierre/diffs 展开对比
│           │   ├── toc.tsx              # 当前文档标题大纲，点击滚动定位
│           │   ├── search-panel.tsx     # 全文搜索输入 + 结果列表，点击跳转
│           │   ├── menu.tsx             # 下拉/右键菜单的共用外观 + 外部点击/Esc 关闭
│           │   ├── icon.tsx             # @iconify/react/offline + lucide 离线图标数据
│           │   └── top-bar.tsx          # 文件名、focus/show/hide 模式切换、保存状态指示
│           └── lib/…
```

## 端口、配置与状态

- 默认端口 **2233**，覆盖顺序：`--port` flag > `MD_PORT` 环境变量 > 默认值。只绑 `127.0.0.1`。
- 状态目录 `~/.local/state/md/`：`state.json`（`{ lastWorkspace, lastFocus }`）、`daemon.log`、`daemon.pid`。
- 格式化配置：工作区根目录若存在 `.autocorrectrc` 传给 `loadConfig`；oxfmt 的 `format()` 传 `FormatConfig`（若工作区有 `.oxfmtrc.json` 读取合并），否则默认值。

## 工作区模型

- **单一全局工作区**。`md <file.md>` → root = 文件父目录、focus = 该文件；`md <dir>` → root = 目录；`md`（无参）→ 从 `state.json` 恢复上次。
- 切换工作区：关旧 watcher → 换 root → 重扫树 → 广播 `workspace` 给所有已连接客户端（页面跟着切）。
- 树只含目录和 `.md`/`.markdown` 文件；排除点开头文件/目录、`node_modules`。目录在前、字母序。
- `TreeNode = { name, path, kind: 'file' | 'dir', children? }`，`path` 一律为 workspace 相对路径（POSIX 分隔符）。

## WS 协议（`protocol.ts`，Zod discriminated union，字段 `type`）

版本一致性：内容同步以 **sha256 内容 hash** 为版本 token，无 rev 计数器。

Server → Client：

| type | payload | 时机 |
|---|---|---|
| `workspace` | `{ root, focus: string \| null, tree }` | 连接建立、工作区切换 |
| `tree` | `{ tree }` | 结构变化（增删改名、外部新增文件） |
| `focus` | `{ path }` | CLI 打开了某文件，所有客户端切过去 |
| `file` | `{ path, content, hash }` | 响应 `open` |
| `saved` | `{ path, content, hash }` | 保存成功回执；`content` 是**格式化后**全文（供空闲回灌） |
| `conflict` | `{ path, diskContent, diskHash }` | 保存时 baseHash 与磁盘不符 |
| `external` | `{ path, content, hash }` | watcher 检测到外部改动（非 echo） |
| `search-results` | `{ query, results: {path, line, column, preview}[] }` | 响应 `search` |
| `error` | `{ message, op? }` | 任意操作失败 |

Client → Server：

| type | payload | 语义 |
|---|---|---|
| `open` | `{ path }` | 请求文件内容 |
| `save` | `{ path, content, baseHash }` | 保存；服务端校验磁盘 hash == baseHash，不符回 `conflict` |
| `force-save` | `{ path, content }` | 冲突解决选「保留我的」时用，跳过 hash 校验 |
| `create` | `{ path, kind: 'file' \| 'dir' }` | 新建（文件初始内容空） |
| `rename` | `{ from, to }` | 重命名/移动 |
| `delete` | `{ path }` | 进废纸篓 |
| `search` | `{ query }` | rg 全文搜索（客户端防抖 300ms） |

## 同步与冲突模型（关键决策）

1. **保存链路**：编辑 → 防抖 500ms → `save{content, baseHash}` → 服务端校验 hash → **格式化管线** → 写盘 → 记录 echo → 回 `saved{content(格式化后), hash}`；同文件的其他客户端收 `external`。
2. **格式化管线**（仅浏览器保存触发，agent/外部写入**永不**被主动改写）：
   `autocorrect-node.formatFor(text, path)` → `oxfmt.format(path, text)`，**顺序固定 autocorrect 在前**（先插空格再排版，表格对齐/换行才正确）。oxfmt 返回 errors 非空时降级用 autocorrect 结果写盘，不阻塞保存。磁盘上的文件因此永远是格式化后的。
3. **echo 抑制**：写盘前记录 `(path → hash)` 到 recent-writes（TTL 2s）；watcher 事件读文件算 hash，命中则忽略。
4. **外部改动**：watcher（fs.watch recursive，事件按 path 防抖 200ms）→ 读内容广播 `external`。客户端：文件未打开→只可能影响树；打开且**不脏**→ 直接 `setMarkdown` 刷入、更新 baseHash；打开且**脏**→ 顶部 ConflictBanner，可展开 @pierre/diffs 并排对比（我的 vs 磁盘），选「用磁盘版」→ 加载 diskContent，选「保留我的」→ `force-save`。
5. **保存冲突**（`save` 被拒回 `conflict`）：同样走 ConflictBanner 流程。
6. **脏状态定义**：编辑器内容自上次 `saved`/`file` 之后发生过 `onDocChange` 且尚未收到对应回执。

## 编辑器桥接（editor.tsx，实现最需小心的部分）

Meowdown 是非受控组件：`<MeowdownEditor initialMarkdown={…} handleRef={ref} mode={mode} …/>`，
`ref.current`: `getMarkdown() / setMarkdown() / getSelection() / setSelection() / getState() / setState()`；变更通知 `onDocChange`（无参，需自己 `getMarkdown()`）；程序化 setMarkdown 不触发 onDocChange。

- **切文件**：flush 未决保存 → 对新文件 `setMarkdown(content)`（同一编辑器实例，不 remount）。
- **保存**：`onDocChange` → 标脏 → 防抖 500ms → `getMarkdown()` 发 `save`。`Cmd+S` flush 立即保存。
- **格式化空闲回灌**：收到 `saved` 后若 `saved.content !== 发送的 content`，暂存 pendingFormatted。在「停止输入 2s / Cmd+S / 切文件 / 编辑器失焦」且此后无新编辑时：`getSelection()` → `setMarkdown(saved.content)` → `setSelection`（越界则 clamp 到文档尾）→ 更新 baseHash。有新编辑则丢弃 pending，等下一轮保存。
- **模式切换**：TopBar 提供 focus / show / hide（`mode` prop），持久化到 localStorage。**不做 Source 模式、不做只读模式切换**。
- **Wikilinks**：`onWikilinkSearch(query)` → 用 store 里树的 `.md` 基名（去扩展名）模糊过滤；`onWikilinkClick(target)` → 按基名在树中找文件发 `open`，找不到 toast 提示不存在。
- **图片显示**：`resolveImageUrl(src)`：相对路径改写为 `/raw/<当前文件所在目录>/<src>`；http(s) 绝对地址原样返回。
- **粘贴图片**：拦截 paste/drop 中的图片（Meowdown 若有 upload/file 回调 prop 优先走它，没有则在容器上拦 paste 事件）→ `POST /api/assets`（multipart：file + docPath）→ 服务端存 `<doc 所在目录>/assets/<yyyyMMdd-HHmmss>-<原名或 pasted.png>` → 返回相对路径 → 编辑器光标处插入 ``。
- **TOC**：对当前 markdown 提取标题行（跳过 code fence 内），点击 → 编辑器 DOM 里第 n 个对应 heading 元素 `scrollIntoView`。
- **暗色模式**：跟随 `prefers-color-scheme`（无手动开关），Meowdown 的 `style.css` 与 `@pierre/theming` 主题一并接入。

## HTTP API（Hono，导出 `AppType` 供 RPC）

| 路由 | 语义 |
|---|---|
| `GET /api/health` | `{ pid, version, workspace, clients }`（clients = 当前 WS 连接数） |
| `POST /api/open` | body `{ path }`（绝对路径）。解析 root/focus → 切工作区 → 广播 `focus`。返回 `{ url, clients }`。CLI 专用 |
| `POST /api/assets` | multipart 存图，返回 `{ relativePath }` |
| `GET /raw/*` | 按工作区相对路径回源文件（图片等）。**必须**做 realpath 包含校验防路径穿越 |
| `GET /ws` | WebSocket upgrade |
| `GET /*` | 静态服务 `packages/web/dist`（SPA fallback 到 index.html）；dist 不存在时返回提示页「先 pnpm build」 |

所有文件操作（含 WS 消息里的 path）解析后必须落在 workspace root 之内，否则拒绝。

## CLI 行为（cli.ts）

```
md <path>                # 打开文件或目录
md                       # 恢复上次工作区
md daemon [--port N]     # 前台跑 daemon（launchd 用这个入口）
md service install       # 写 ~/Library/LaunchAgents/dev.md.daemon.plist + launchctl bootstrap
md service uninstall     # launchctl bootout + 删 plist
```

`md [path]` 流程：resolve 绝对路径（不存在则报错退出）→ `GET /api/health`，失败则 `Bun.spawn` detached 起 `md daemon`（stdout/stderr 追加到 daemon.log），轮询 health 至多 5s → `POST /api/open` → 若返回 `clients === 0` 则 `open http://127.0.0.1:<port>`（已有页面连着就不重复开 tab，页面会自己跟着 focus 切换）。

launchd plist：Label `dev.md.daemon`，`ProgramArguments` 用绝对路径（`process.execPath` 的 bun + cli.ts 绝对路径 + `daemon`），`RunAtLoad true`、`KeepAlive true`，日志重定向到 state 目录。

## 开发与构建

- root scripts：`dev`（并行：daemon + vite dev，vite 代理 `/api` `/ws` `/raw` 到 2233）、`build`（build web）、`start`（`md daemon`）。
- 全局命令安装：README 写明 `cd packages/md && bun link`（或 pnpm link --global）。

## 安全

只绑 127.0.0.1；`/raw` 与全部文件操作做 workspace 包含校验；删除只进废纸篓；daemon 不暴露任意路径读取（`/api/open` 只被本机 CLI 调用，它本身就是本机用户权限）。

## v1 验收清单

1. `md ~/notes` 打开浏览器显示文件树，点击文件可编辑，改动 ≤1s 落盘且磁盘内容已被 autocorrect+oxfmt 格式化
2. 外部 `echo >> file.md` 修改：浏览器不脏时 ≤1s 内容自动刷新；正在编辑（脏）时出现冲突条，展开可见 diff，两个选项都工作
3. 打字过程中光标不跳、输入不被格式化打断；停止输入 2s 后编辑器内容变为格式化版且光标位置合理
4. `md another.md` 在已连接页面上直接切换工作区+聚焦，不重复开 tab；无页面连接时自动开浏览器
5. 树上新建/重命名/删除工作，删除的文件出现在废纸篓
6. 粘贴截图 → `assets/` 目录出现文件，编辑器内图片立即显示，markdown 里是相对路径
7. 全文搜索出结果，点击跳到对应文件
8. TOC 显示当前文档标题，点击滚动定位；wikilink `[[` 出现候选，点击已存在的 wikilink 跳转
9. 暗色/亮色跟随系统
10. `md service install` 后重启（或 `launchctl kickstart`）daemon 存活，`md` 直接可用

## 发布与开源

- npm 包名 **`mdopen`**（发布 packages/md 单包；`bin` 仍是 `md`），GitHub `xlsama/mdopen`，public，MIT LICENSE。
- 运行时要求 Bun（bin shebang `#!/usr/bin/env bun`），README 写明 `bun` 为前置依赖，安装方式 `bun add -g mdopen` / `pnpm add -g mdopen`。
- 前端产物随包分发：`prepublishOnly` 构建 `@md/web` 并把 `dist` 拷入 `packages/md/web-dist/`，daemon 静态目录解析顺序：包内 `web-dist` → 仓库 `packages/web/dist`（开发态）。`files` 白名单：`src`、`web-dist`。
- 版本与发版：root `release` 脚本用 `bumpp`（升级版本 + 自动打 tag），root 维护 `CHANGELOG.md`。
- README 简短中英双语；`@md/server` 包更名为 `mdopen`（web 侧 import 同步改 `mdopen/protocol`）。

## 非目标（v1 不做）

PWA、Tauri、系统文件关联、Source 源码模式（彻底不做）、`#tags` 聚合、AI sparkle、CRDT、多工作区并存、编辑器内多标签页、`md fmt` 批量命令、格式化 agent 写入的文件。
