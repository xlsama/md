# md — 浏览器里的本地 Markdown 编辑器

替代 Typora：编辑器跑在浏览器里，文件读写由本地常驻 Bun 服务完成，浏览器端零权限弹窗。
核心场景：本地 AI agent 和人交替编辑同一批 `.md` 文件，浏览器端实时看到外部变化。

本文档是实现契约。实现者遇到文档未覆盖的细节可自行决定，但**不得偏离已写明的决策**。

## 总架构

```
┌──────────────────────────────┐   WS(/ws, Zod 协议) + REST      ┌────────────────────────────────┐
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
- `packages/md`（包名 `@xlsama/md`，`"bin": {"md": "./src/cli.ts"}`，shebang `#!/usr/bin/env bun`，无构建步骤，bun 直跑 TS）：
  - Hono（HTTP 路由）、`Bun.serve` 原生 WebSocket、Zod
  - `oxfmt`（JS API：`format(fileName, text) → Promise<{code, errors}>`，已验证支持 markdown）
  - `autocorrect-node`（NAPI：`formatFor(text, filepath) → string`、`loadConfig(configStr)`）
  - `trash`（删除进系统废纸篓）
  - 搜索用系统 `rg`（spawn，`--json`），启动时检测缺失则搜索功能报错提示
- `packages/web`（包名 `@md/web`，private）：
  - Vite + React 19 + TypeScript + Tailwind CSS v4
  - `@meowdown/react` + `@meowdown/core`（编辑器，要求 React 19）
  - `@pierre/trees`（文件树）、`@pierre/diffs`（冲突对比）、`@pierre/theming`
  - `@iconify/react`（图标；用 `/offline` 入口 + `@iconify-icons/lucide` 的单图标数据，构建产物不依赖 Iconify 远程 API）
  - Zustand（状态）；少量 HTTP 调用直接用 `fetch` + 协议里的 Zod schema 校验响应（**没有引入 Hono RPC**：只有 health / settings / assets / link-meta 四个端点，`hc<AppType>` 的类型收益不足以抵消把整个 Hono 类型图拉进前端构建的代价）
  - TanStack Router（单路由，不引文件式路由生成器）：只承担两件事——`?file=<工作区相对路径>` 把当前打开的文件写进 URL（一律 `replace`，切文件不进历史栈），以及以该参数为 key 的**按文件滚动位置记忆**（编辑器滚动容器接 `data-scroll-restoration-id`）
- 不用：TanStack Query（WS 推送模型用不上）、CRDT、Service Worker。

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
│   │       ├── service.ts     # 开机自启：launchd / systemd user unit / 计划任务
│   │       ├── state.ts       # ~/.local/state/md/（state.json、daemon.log、pid）
│   │       ├── settings.ts    # ~/.config/md/settings.json 读写
│   │       ├── link-meta.ts   # /api/link-meta：抓取 + SSRF 防护 + 内存/磁盘两级缓存
│   │       └── protocol.ts    # 全部 Zod schema + TS 类型（web 通过 @xlsama/md/protocol 导入）
│   └── web/
│       ├── package.json
│       ├── vite.config.ts     # dev 时 /api /ws /raw 代理到 daemon
│       └── src/
│           ├── main.tsx / app.tsx
│           ├── ws.ts          # WS 客户端：连接、重连（1s 退避）、消息分发
│           ├── session.ts     # WS 协议 ↔ 编辑器的命令式桥接（保存/冲突/回灌/当前文档）
│           ├── store.ts       # Zustand：只存 UI 要渲染的东西——
│           │                  #   root、treePaths/mdFiles（树的派生形态，不存原始 TreeNode）、
│           │                  #   docPath/docLoading、dirtyPath、conflict、toc/tocPref/tocWide、
│           │                  #   readOnly、toasts、dialog、settings/settingsOpen、connected
│           │                  # 文档内容与 baseHash 不进 store，它们归 session.ts（编辑器才是内容的家）
│           ├── components/    # 文件名 kebab-case，导出的组件名 PascalCase
│           │   ├── file-tree.tsx        # @pierre/trees + 右键菜单（新建/重命名/删除）
│           │   ├── editor.tsx           # Meowdown 桥接（详见「编辑器桥接」）
│           │   ├── conflict-banner.tsx  # 外部改动冲突条（展开对比用 lazy() 动态载入下一行）
│           │   ├── conflict-diff.tsx     # @pierre/diffs 并排对比，单独一个 chunk（~131KB gzip，首屏不加载）
│           │   ├── toc.tsx              # 当前文档标题大纲，点击滚动定位
│           │   ├── icon-button.tsx      # 带 tooltip 的 icon 按钮
│           │   ├── menu.tsx             # 下拉/右键菜单的共用外观 + 外部点击/Esc 关闭
│           │   ├── icon.tsx             # @iconify/react/offline + lucide 离线图标数据
│           │   └── top-bar.tsx          # 侧栏开关、文件名、只读切换、大纲开关
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
  排除是**双向**的：这些路径下的 watcher 事件既不广播 `external`，也不触发全树 rescan（否则一次 `git rebase` 会把工作区重扫上百遍）。
- 树是否变化用扫描时顺带累加的轻量签名（FNV，按排序后的 depth+kind+name 折叠）比较，不做整树 JSON 序列化。
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

1. **保存链路**：编辑 → 防抖 500ms → `save{content, baseHash}` → 服务端校验 hash → **格式化管线** → **再校验一次磁盘 hash** → 写盘 → 记录 echo → 回 `saved{content(格式化后), hash}`；同文件的其他客户端收 `external`。
   第二次校验是必须的：格式化是异步的（autocorrect + oxfmt），这段时间足够 agent 落一次写入，只查一次就会把它静默覆盖掉。第二次不符同样回 `conflict` 并**丢弃本次写入**（磁盘保留外部内容）。`force-save` 两次校验都跳过。
2. **格式化管线**（仅浏览器保存触发，agent/外部写入**永不**被主动改写）：
   `autocorrect-node.formatFor(text, path)` → `oxfmt.format(path, text)`，**顺序固定 autocorrect 在前**（先插空格再排版，表格对齐/换行才正确）。oxfmt 返回 errors 非空时降级用 autocorrect 结果写盘，不阻塞保存。磁盘上的文件因此永远是格式化后的。
3. **echo 抑制**：写盘前记录 `(path → hash)` 到 recent-writes（TTL 2s）；watcher 事件读文件算 hash，命中则忽略。
4. **外部改动**：watcher（fs.watch recursive，事件按 path 防抖 200ms）→ 读内容广播 `external`。客户端：文件未打开→只可能影响树；打开且**不脏**→ 直接 `setMarkdown` 刷入、更新 baseHash；打开且**脏**→ 顶部 ConflictBanner，可展开 @pierre/diffs 并排对比（我的 vs 磁盘），选「用磁盘版」→ 加载 diskContent，选「保留我的」→ `force-save`。
5. **保存冲突**（`save` 被拒回 `conflict`）：同样走 ConflictBanner 流程。
6. **脏状态定义**：编辑器内容自上次 `saved`/`file` 之后发生过 `onDocChange` 且尚未收到对应回执。
7. **脏标记（文件树黄点）**：脏态持续 **1s** 后才亮，正常防抖保存的瞬时脏态不亮——否则打字时黄点一闪一闪，而且每次都要 `model.setIcons()` 重绘整棵树的行。冲突与保存失败**立即**亮（它们要等人处理），熄灭永远立即。
8. **断线重连**：重连后收到的第一条 `workspace` 处理完，若本地仍是脏的（包括「保存发出去了但连接断在回执之前」），立刻 `flushSave()` 补发——否则那次编辑只存在于浏览器里。

## 编辑器桥接（editor.tsx，实现最需小心的部分）

Meowdown 是非受控组件：`<MeowdownEditor initialMarkdown={…} handleRef={ref} mode={mode} …/>`，
`ref.current`: `getMarkdown() / setMarkdown() / getSelection() / setSelection() / getState() / setState()`；变更通知 `onDocChange`（无参，需自己 `getMarkdown()`）；程序化 setMarkdown 不触发 onDocChange。

- **切文件**：flush 未决保存 → 对新文件 `setMarkdown(content)`（同一编辑器实例，不 remount）。
- **保存**：`onDocChange` → 标脏 → 防抖 500ms → `getMarkdown()` 发 `save`。`Cmd+S` flush 立即保存。
- **格式化空闲回灌**：收到 `saved` 后若 `saved.content !== 发送的 content`，暂存 pendingFormatted。在「停止输入 2s / Cmd+S / 切文件 / 编辑器失焦」且此后无新编辑时：`getSelection()` → `setMarkdown(saved.content)` → `setSelection`（越界则 clamp 到文档尾）→ 更新 baseHash。有新编辑则丢弃 pending，等下一轮保存。
- **渲染模式**：编辑器固定 `mode="focus"`（Typora 式「光标处显源码」）。**没有 focus / show / hide 三模式切换**——切换器做过又移除了，三选一里另外两个没人用。**不做 Source 源码模式**。
- **只读开关**：TopBar 有一个只读切换（`readOnly` 传给编辑器），状态存 localStorage `md:read-only`。它只挡输入，不改渲染模式。
- **Wikilinks**：`onWikilinkSearch(query)` → 用 store 里树的 `.md` 基名（去扩展名）模糊过滤；`onWikilinkClick(target)` → 按基名在树中找文件发 `open`，找不到 toast 提示不存在。
- **图片显示**：`resolveImageUrl(src)`：相对路径改写为 `/raw/<当前文件所在目录>/<src>`；http(s) 绝对地址原样返回。
- **图片占位态**（`image-loading.ts` + `lib/image-status.ts`）：加载中流光骨架、失败换成图标+「图片加载失败」卡片，都写在 `data-md-img` 上。规则：**新出现的图片一律以 loading 起步**；只有「这个元素当前的 src 真的 error 了」才进失败态——`error` 事件延后一个 task 再按当时的 src 复核，src 在中途被改写（相对路径 resolve 前后是两个 src）时那次 error 直接作废。失败态**忽略**持久化的 `data-width/height`（那尺寸描述的是一张不存在的图），统一用标准占位框；加载中仍尊重持久化尺寸，免得图进来时跳版。
- **块级媒体宽度**：图片 / 视频 / 推文 / 站点卡片共用 `--md-media-width: min(390px, 100%)`，边缘在正文列里对齐。用户手动拖过的尺寸继续尊重，上限是正文列宽（resizable root 自带 `max-width: 100%`，天然被容器夹住）。
- **粘贴图片**：拦截 paste/drop 中的图片（Meowdown 若有 upload/file 回调 prop 优先走它，没有则在容器上拦 paste 事件）→ `POST /api/assets`（multipart：file + docPath）→ 服务端存 `<doc 所在目录>/assets/<yyyyMMdd-HHmmss>-<原名或 pasted.png>` → 返回相对路径 → 编辑器光标处插入 ``。
- **粘贴转存远程图片**（`importPastedImages` 开关，默认开）：容器 paste 事件 capture 阶段读剪贴板文本（不动粘贴本身），提取其中的远程图片 URL（markdown `![]()` 与 `<img src>`，单次上限 50、去重）→ 逐个 `POST /api/assets/import`（并发 3）→ daemon 按 link-meta 同款 SSRF 规则下载（仅 http(s)、逐跳查重定向、必须声明 image/* 类型、20MB 上限）存进 assetsDir，文件名 `<时间戳>-<URL哈希前8>.<扩展名>` → 前端把编辑器文档里的该 URL **按字面文本替换**为本地相对路径（正常 transaction：可撤销、光标经 mapping 保持、触发自动保存）。文档已切换/已编辑掉 URL 时替换自然落空。失败静默保留原链接，最后汇总一条 toast。动机：粘贴来的图片链接（飞书/Notion/带签名的 CDN）会过期，本地才留得住。
- **TOC**：对当前 markdown 提取标题行（跳过 code fence 内），点击 → 编辑器 DOM 里第 n 个对应 heading 元素 `scrollIntoView`。
- **暗色模式**：由「设置系统」的 `theme` 决定。三方样式（meowdown、@pierre/trees、@pierre/diffs）的颜色都是 `light-dark()` 对，因此强制主题只需在 `html` 上钉住 `color-scheme`；`system` 时移除该属性，回到 `prefers-color-scheme`。

## HTTP API（Hono 路由；前端直接 `fetch`，响应用 protocol 里的 Zod schema 校验）

| 路由 | 语义 |
|---|---|
| `GET /api/health` | `{ pid, version, workspace, clients, ripgrep, watching }`（clients = 当前 WS 连接数；`ripgrep` = `rg` 是否在 PATH 上；`watching` = 文件监听是否活着，为 false 时前端 toast 提示外部改动不会自动刷新） |
| `POST /api/open` | body `{ path }`（绝对路径）。解析 root/focus → 切工作区 → 广播 `focus`。返回 `{ url, clients }`。CLI 专用 |
| `POST /api/assets` | multipart 存图，返回 `{ relativePath }` |
| `POST /api/assets/import` | body `{ url, docPath }`。下载远程图片存进 assetsDir（SSRF 防护同 link-meta），返回 `{ relativePath, workspacePath }` |
| `GET /raw/*` | 按工作区相对路径回源文件（图片等）。**必须**做 realpath 包含校验防路径穿越 |
| `GET /ws` | WebSocket upgrade |
| `GET /*` | 静态服务 `packages/web/dist`（SPA fallback 到 index.html）；dist 不存在时返回提示页「先 pnpm build」。`assets/*` 文件名带内容哈希 → `immutable` 长缓存；index.html → `no-store`，否则升级后浏览器还端着上个版本的壳 |

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

- npm 包名 **`@xlsama/md`**（发布 packages/md 单包；`bin` 仍是 `md`），GitHub `xlsama/md`，public，MIT LICENSE。无 scope 的 `writedown` 被 npm 以「与 `write-down` 过于相似」拒绝，故走 scope。
- 运行时要求 Bun（bin shebang `#!/usr/bin/env bun`），README 写明 `bun` 为前置依赖，安装方式 `bun add -g @xlsama/md` / `pnpm add -g @xlsama/md`。
- 前端产物随包分发：`prepublishOnly` 构建 `@md/web` 并把 `dist` 拷入 `packages/md/web-dist/`，daemon 静态目录解析顺序：包内 `web-dist` → 仓库 `packages/web/dist`（开发态）。`files` 白名单：`src`、`web-dist`。
- 版本与发版：root `release` 脚本用 `bumpp`（升级版本 + 自动打 tag），root 维护 `CHANGELOG.md`。
- README 简短中英双语；`@md/server` 包更名为 `@xlsama/md`（web 侧 import 同步改 `@xlsama/md/protocol`）。

## 跨平台适配（2026-08-13 定稿）

分发方式仍是「用户自己装 Bun + npm 源码包」，不做单文件二进制：`bun build --compile` 验证过可行（原生模块能嵌、前端产物能嵌），但原生模块无法交叉编译，必须为每个平台配一条 CI 流水线，维护成本不划算。

Bun 覆盖 macOS / Linux / Windows，daemon 与编辑逻辑本身无平台假设，需要分支的只有三处：

- **开机自启**（`service.ts`）：macOS launchd plist + `launchctl bootstrap`；Linux systemd user unit（`~/.config/systemd/user/md.service`）+ `systemctl --user enable --now`；Windows 计划任务 `schtasks /SC ONLOGON`。不引第三方库（`auto-launch` 一类面向 GUI 应用且久未维护）。`md service plist` 更名为 `md service config`，保留 `plist` 别名。
- **状态与配置目录**：状态目录 Windows 用 `%LOCALAPPDATA%\md`，其余 `~/.local/state/md`；配置目录优先 `XDG_CONFIG_HOME`，Windows 回落 `%APPDATA%`，其余 `~/.config`。
- **打开浏览器**：darwin `open`、win32 `cmd /c start ""`（空标题参数不能省，否则 cmd 会把带引号的 URL 当窗口标题）、其余 `xdg-open`。

Linux / Windows 的运行时行为未在开发机上验证，只保证类型检查与单元测试通过。

## 块级链接富展示（embed + 站点卡片，2026-08-13 定稿）

**识别规则（纯渲染层，markdown 源文件永远只存裸 URL，可移植）**：「独占一个段落的裸链接」按域名分流：

- YouTube（youtube.com/watch、youtu.be）→ meowdown 已有 `youtube-embed` 节点（youtube-nocookie iframe，卡内播放）
- X / Twitter 的 status 链接 → meowdown 已有 `tweet-embed` 节点（platform.twitter.com iframe）
- 其他 http(s) → 自定义 `link-card` 节点（站点卡片）

行内链接一律保持普通链接。实现：meowdown extension 口子（`useExtension`）加 parse 规则「纯链接段落 → 对应节点」，序列化对称写回裸 URL；**必须有 roundtrip 测试**（parse→serialize→parse 稳定、与格式化管线幂等兼容）。

**站点卡片**：横向条卡（Notion 风）——左侧标题一行 truncate + 描述一行 + favicon·域名小字，右侧 og:image 小缩略图（有则显示）；整卡可点、新标签页打开；骨架复用图片 shimmer 风格；亮暗两套。**降级**：抓取失败（无网/超时/非 HTML/4xx5xx/无 og 数据）显示极简卡（域名 + URL），排版稳定不变形。

**服务端 `GET /api/link-meta?url=…`**：Bun HTMLRewriter 流式解析 `og:title/og:description/og:image/twitter:*/<title>/favicon link`；超时 5s、仅 text/html、响应上限 512KB、重定向上限 5。**缓存**：内存 + 磁盘（state 目录按 URL sha256 存 JSON），成功 TTL 7 天、失败 TTL 10 分钟。**SSRF 防护**：仅 http/https；解析后拒绝 localhost、127/10/172.16-31/192.168/169.254 网段与 `.local`（文档内容不得诱导 daemon 探测内网）。og:image/favicon 由浏览器直接加载原 URL，不经 daemon 代理。

## 设置系统（2026-08-13 定稿）

- **配置文件**：`~/.config/md/settings.json`（尊重 `$XDG_CONFIG_HOME`，目录自动创建）。扁平 JSON，读取时与默认值合并（缺字段向后兼容）。
- **API**：`GET /api/settings`（默认值合并后的完整配置）+ `PUT /api/settings`（zod 校验、原子写盘）。保存成功后 daemon 广播 `settings` WS 消息，所有页面即时应用。
- **文件监听**：daemon 监听配置目录（不是文件——原子写用 `rename`，盯文件的 watch 一次就失效），50ms 合并事件后重新读取；内容真变了才广播，所以自己写的那次不会回声。这条让「谁写的都算数」：另一个端口上的 daemon、编辑器、脚本改了文件，所有 daemon 与页面都跟着变，**没有任何设置需要重启才生效**。
- **配置项 v1**：
  - `theme`: `'system' | 'light' | 'dark'`（默认 system）
  - `format.autocorrect`: boolean（默认 true，服务端保存管线读取）
  - `format.oxfmt`: boolean（默认 true，同上）
  - `assetsDir`: string（默认 `assets`，`/api/assets` 使用；校验单段合法目录名）
  - `linkEmbeds`: boolean（默认 true，关掉后独占段落链接只渲染普通链接，前端渲染层读取）
  - `importPastedImages`: boolean（默认 true，粘贴时转存远程图片，见「粘贴转存远程图片」）
  - `saveDebounceMs`: number（默认 500，范围 100–5000，前端 session 读取）
  - `sidebarOpen`: boolean（默认 false，侧栏折叠状态；由 TopBar 的开关静默写入，不出现在设置 dialog 里）
  - `sidebarOpen`: boolean（默认 **false**——首屏侧栏收起、正文居中；TopBar 最左侧 panel-left 按钮切换，静默 PUT 持久化；**不进设置 dialog 表单**，无响应式行为，只认配置）
- **UI**：
  - 侧栏底部两个 icon 按钮（与上方按钮同款交互）：**主题切换**（太阳/月亮两态切换 light/dark；settings 里选了 system 则按钮从当前系统态起切）与**设置**（打开 dialog）
  - 设置 dialog：左侧 tabs（外观 / 编辑器）+ 右侧内容，**没有保存按钮**——改了就写：开关/主题点一下即落盘，输入框停手 400ms 落盘；关闭（左上角 ✕ / Esc / 点外面）会把还没到期的那次立刻写掉。成功不弹 toast（控件自己动了就是回执），失败才弹并把控件退回生效中的值
  - 半截的输入不写盘：非法字段（空目录名、超范围毫秒数）显示行内错误并**只跳过它自己**，同时改的其它字段照常保存；离开输入框时该字段退回生效值
  - 外观 tab：主题三选（系统/亮/暗）。编辑器 tab：autocorrect 开关、oxfmt 开关、图片目录名、链接卡片开关、自动保存防抖时长
- daemon 端消费（format 开关、assetsDir）在 PUT 后热生效，无需重启。

## 非目标（v1 不做）

PWA、Tauri、系统文件关联、Source 源码模式（彻底不做）、`#tags` 聚合、AI sparkle、CRDT、多工作区并存、编辑器内多标签页、`md fmt` 批量命令、格式化 agent 写入的文件、粘贴外链图片自动本地化（用户明确不要：外链保持外链，即使是限时签名 URL）。

**全文搜索（搜正文内容）**：2026-08-13 决定整体延后 —— 侧栏入口已移除，等连同「替换、正则、拦截浏览器 cmd+F」一起设计后再做。服务端 rg 能力与 `search`/`search-results` 协议保留不动，前端侧栏只做文件名过滤（fuzzysort，最多 **200** 条；满 200 条时列表底部标注「仅显示前 200 条结果」）。
