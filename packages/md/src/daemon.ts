#!/usr/bin/env bun
import path from 'node:path';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Server, ServerWebSocket } from 'bun';
import pkg from '../package.json';
import {
  assetImportRequestSchema,
  linkMetaQuerySchema,
  openRequestSchema,
  parseClientMessage,
  settingsPatchSchema,
  type ClientMessage,
  type ServerMessage,
} from './protocol.ts';
import { downloadImage } from './asset-import.ts';
import { getSettings, loadSettings, updateSettings, watchSettings } from './settings.ts';
import { LinkMetaCache, LinkTargetError, normalizeLinkUrl, type LinkMetaCacheOptions } from './link-meta.ts';
import {
  createEntry,
  deleteEntry,
  hashContent,
  isMarkdown,
  PathViolationError,
  renameEntry,
  sanitizeAssetName,
  timestampPrefix,
} from './files.ts';
import { formatMarkdown } from './format.ts';
import { hasRipgrep, search } from './search.ts';
import { resolveTarget, Workspace } from './workspace.ts';
import { clearPid, resolvePort, writePid } from './state.ts';

export interface DaemonOptions {
  port?: number;
  hostname?: string;
  root?: string | null;
  focus?: string | null;
  webDist?: string;
  persistState?: boolean;
  writePidFile?: boolean;
  version?: string;
  /** Overrides for the link-card metadata cache; tests inject a fake fetcher. */
  linkMeta?: LinkMetaCacheOptions;
  /**
   * The formatting pipeline a save runs through. Only tests replace it — with a
   * deliberately slow one, to open the window between "the disk was checked"
   * and "the disk is written" that the second hash check has to cover.
   */
  format?: typeof formatMarkdown;
}

interface WSData {
  id: number;
}

type MdSocket = ServerWebSocket<WSData>;

interface DaemonContext {
  workspace: Workspace;
  clients: Set<MdSocket>;
  webDist: string;
  version: string;
  linkMeta: LinkMetaCache;
  format: typeof formatMarkdown;
  broadcast: (msg: ServerMessage) => void;
  send: (ws: MdSocket, msg: ServerMessage) => void;
  sendOthers: (ws: MdSocket, msg: ServerMessage) => void;
  url: () => string;
}

export interface DaemonHandle {
  server: Server<WSData>;
  port: number;
  url: string;
  workspace: Workspace;
  clients: () => number;
  stop: () => Promise<void>;
}

// The npm package ships `web-dist` (copied in by `prepublishOnly`); inside the
// repository that directory does not exist, so development falls back to
// `packages/web/dist`.
const PACKAGED_WEB_DIST = path.resolve(import.meta.dir, '..', 'web-dist');
const DEV_WEB_DIST = path.resolve(import.meta.dir, '..', '..', 'web', 'dist');
const DEFAULT_WEB_DIST = existsSync(PACKAGED_WEB_DIST) ? PACKAGED_WEB_DIST : DEV_WEB_DIST;

const PLACEHOLDER_PAGE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>md</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100vh; background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2rem; line-height: 1.7; }
  code { background: color-mix(in srgb, CanvasText 12%, transparent); padding: .15em .4em; border-radius: .3em; }
</style>
</head>
<body><main>
<h1>md daemon 正在运行</h1>
<p>前端构建产物还不存在。请先在仓库根目录执行：</p>
<p><code>pnpm install &amp;&amp; pnpm build</code></p>
<p>开发模式请用 <code>pnpm dev</code>（Vite 会把 <code>/api</code>、<code>/ws</code>、<code>/raw</code> 代理到本 daemon）。</p>
</main></body></html>
`;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function contentTypeFor(file: string): string | undefined {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return map[ext];
}

function createRoutes(ctx: DaemonContext) {
  return new Hono()
    .get('/api/health', (c) =>
      c.json({
        pid: process.pid,
        version: ctx.version,
        workspace: ctx.workspace.root,
        clients: ctx.clients.size,
        ripgrep: hasRipgrep(),
        watching: ctx.workspace.watching,
      })
    )
    .post('/api/open', zValidator('json', openRequestSchema), async (c) => {
      const body = c.req.valid('json');
      try {
        const target = await resolveTarget(body.path);
        if (ctx.workspace.root !== target.root) {
          await ctx.workspace.setRoot(target.root, target.focus);
        } else {
          ctx.workspace.setFocus(target.focus);
        }
        if (target.focus) ctx.broadcast({ type: 'focus', path: target.focus });
        return c.json({
          url: ctx.url(),
          clients: ctx.clients.size,
          root: target.root,
          focus: target.focus,
        });
      } catch (err) {
        return c.json({ error: errorMessage(err) }, 400);
      }
    })
    .get('/api/settings', (c) => c.json(getSettings()))
    .put('/api/settings', zValidator('json', settingsPatchSchema), async (c) => {
      try {
        const settings = await updateSettings(c.req.valid('json'));
        // Every page applies the new settings straight away — including the one
        // that did not send the change.
        ctx.broadcast({ type: 'settings', settings });
        return c.json(settings);
      } catch (err) {
        return c.json({ error: errorMessage(err) }, 500);
      }
    })
    .post('/api/assets', async (c) => {
      try {
        ctx.workspace.requireRoot();
        const form = await c.req.formData();
        const file = form.get('file');
        if (!(file instanceof File)) return c.json({ error: 'missing file' }, 400);
        const docPathRaw = form.get('docPath');
        const docPath = typeof docPathRaw === 'string' ? docPathRaw : '';
        const name = `${timestampPrefix()}-${sanitizeAssetName(file.name)}`;
        return c.json(await saveAsset(ctx, docPath, name, await file.arrayBuffer()));
      } catch (err) {
        const status = err instanceof PathViolationError ? 403 : 400;
        return c.json({ error: errorMessage(err) }, status);
      }
    })
    .post('/api/assets/import', zValidator('json', assetImportRequestSchema), async (c) => {
      const { url, docPath } = c.req.valid('json');
      try {
        ctx.workspace.requireRoot();
        const image = await downloadImage(url, {
          allowPrivateHosts: ctx.linkMeta.allowPrivateHosts,
        });
        // The URL hash keeps two images pasted in the same second apart; the
        // original names are meaningless tokens on most hosts anyway.
        const name = `${timestampPrefix()}-${hashContent(url).slice(0, 8)}.${image.extension}`;
        return c.json(await saveAsset(ctx, docPath, name, image.bytes));
      } catch (err) {
        const status = err instanceof PathViolationError ? 403 : 400;
        return c.json({ error: errorMessage(err) }, status);
      }
    })
    .get('/api/link-meta', zValidator('query', linkMetaQuerySchema), async (c) => {
      const { url } = c.req.valid('query');
      let target: URL;
      try {
        target = normalizeLinkUrl(url, { allowPrivateHosts: ctx.linkMeta.allowPrivateHosts });
      } catch (err) {
        const status = err instanceof LinkTargetError ? 400 : 500;
        return c.json({ error: errorMessage(err) }, status);
      }
      const body = await ctx.linkMeta.get(target.toString());
      // The daemon owns the TTL; letting the browser cache too would make a
      // failed card impossible to retry without a hard reload.
      c.header('cache-control', 'no-store');
      return c.json(body);
    })
    .get('/raw/*', async (c) => {
      if (!ctx.workspace.root) return c.json({ error: 'no workspace open' }, 409);
      const raw = c.req.path.slice('/raw/'.length);
      let rel: string;
      try {
        rel = decodeURIComponent(raw);
      } catch {
        return c.json({ error: 'bad path' }, 400);
      }
      try {
        const abs = await ctx.workspace.resolve(rel);
        const stat = await fs.stat(abs).catch(() => null);
        if (!stat?.isFile()) return c.json({ error: 'not found' }, 404);
        const file = Bun.file(abs);
        const type = contentTypeFor(abs);
        return new Response(file, {
          headers: {
            'cache-control': 'no-cache',
            ...(type ? { 'content-type': type } : {}),
          },
        });
      } catch (err) {
        if (err instanceof PathViolationError) return c.json({ error: 'forbidden' }, 403);
        return c.json({ error: errorMessage(err) }, 400);
      }
    })
    .get('*', async (c) => {
      const pathname = decodeURIComponent(new URL(c.req.url).pathname);
      const asset = await serveWebAsset(ctx.webDist, pathname);
      if (asset) return asset;
      return c.html(PLACEHOLDER_PAGE, 200);
    });
}

/**
 * Writes an asset beside `docPath` under the configured assets directory.
 * `relativePath` is what goes into the markdown; `workspacePath` is what
 * `/raw/` serves. Both come back to the caller in the response body.
 */
async function saveAsset(
  ctx: DaemonContext,
  docPath: string,
  name: string,
  bytes: ArrayBuffer | Uint8Array
): Promise<{ relativePath: string; workspacePath: string }> {
  const docDir = docPath ? path.posix.dirname(docPath) : '.';
  const dirPrefix = docDir === '.' || docDir === '' ? '' : `${docDir}/`;
  const relativePath = `${getSettings().assetsDir}/${name}`;
  const workspacePath = `${dirPrefix}${relativePath}`;
  const abs = await ctx.workspace.resolve(workspacePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await Bun.write(abs, bytes);
  return { relativePath, workspacePath };
}

async function serveWebAsset(dist: string, pathname: string): Promise<Response | null> {
  const indexPath = path.join(dist, 'index.html');
  const hasIndex = await fs
    .stat(indexPath)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!hasIndex) return null;

  const rel = pathname.replace(/^\/+/, '');
  if (rel) {
    const candidate = path.resolve(dist, rel);
    if (
      candidate.startsWith(`${dist}${path.sep}`) &&
      // The shell itself must never take this branch — it gets `no-store` below.
      candidate !== indexPath
    ) {
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isFile()) {
        const type = contentTypeFor(candidate);
        // Everything under `assets/` carries a content hash in its name, so the
        // URL changes whenever the file does; anything else gets no directive.
        const hashed = candidate.startsWith(path.join(dist, 'assets') + path.sep);
        return new Response(Bun.file(candidate), {
          headers: {
            ...(type ? { 'content-type': type } : {}),
            ...(hashed ? { 'cache-control': 'public, max-age=31536000, immutable' } : {}),
          },
        });
      }
    }
  }
  // The shell, on the other hand, keeps its URL forever and names the hashed
  // bundles — cached, it would keep serving the previous version of the app
  // after an upgrade until someone hard-reloads.
  return new Response(Bun.file(indexPath), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function handleMessage(ctx: DaemonContext, ws: MdSocket, msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case 'open': {
      const file = await ctx.workspace.readFile(msg.path);
      ctx.workspace.setFocus(msg.path);
      ctx.send(ws, { type: 'file', ...file });
      return;
    }
    case 'save':
    case 'force-save': {
      const rel = msg.path;
      if (!isMarkdown(rel)) throw new Error('only markdown files can be saved');
      const disk = await ctx.workspace.diskState(rel);
      const conflict = (state: { content: string; hash: string }): void => {
        ctx.send(ws, {
          type: 'conflict',
          path: rel,
          diskContent: state.content,
          diskHash: state.hash,
        });
      };
      if (msg.type === 'save' && disk.hash !== msg.baseHash) {
        conflict(disk);
        return;
      }
      const formatted = await ctx.format(disk.abs, msg.content, getSettings().format);
      if (msg.type === 'save') {
        // Formatting is asynchronous and can take long enough for an agent to
        // land a write of its own in the meantime. Checking the disk once more
        // right before the write closes that window: the alternative is
        // silently overwriting an edit that was made after we looked.
        const now = await ctx.workspace.diskState(rel);
        if (now.hash !== msg.baseHash) {
          conflict(now);
          return;
        }
      }
      const written = await ctx.workspace.writeFormatted(rel, disk.abs, formatted);
      ctx.send(ws, { type: 'saved', path: rel, content: written.content, hash: written.hash });
      ctx.sendOthers(ws, {
        type: 'external',
        path: rel,
        content: written.content,
        hash: written.hash,
      });
      return;
    }
    case 'create': {
      const abs = await ctx.workspace.resolve(msg.path);
      if (msg.kind === 'file' && !isMarkdown(abs)) throw new Error('only .md files can be created');
      await createEntry(abs, msg.kind);
      if (msg.kind === 'file') ctx.workspace.noteWrite(msg.path, '');
      await ctx.workspace.rescan(true);
      return;
    }
    case 'rename': {
      const fromAbs = await ctx.workspace.resolve(msg.from);
      const toAbs = await ctx.workspace.resolve(msg.to);
      await renameEntry(fromAbs, toAbs);
      if (ctx.workspace.focus === msg.from) {
        ctx.workspace.setFocus(msg.to);
        ctx.broadcast({ type: 'focus', path: msg.to });
      }
      await ctx.workspace.rescan(true);
      return;
    }
    case 'delete': {
      const abs = await ctx.workspace.resolve(msg.path);
      await deleteEntry(abs);
      if (ctx.workspace.focus === msg.path) ctx.workspace.setFocus(null);
      await ctx.workspace.rescan(true);
      return;
    }
    case 'search': {
      const root = ctx.workspace.requireRoot();
      const results = await search(root, msg.query);
      ctx.send(ws, { type: 'search-results', query: msg.query, results });
      return;
    }
  }
}

export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  await loadSettings();
  const clients = new Set<MdSocket>();
  const webDist = options.webDist ?? DEFAULT_WEB_DIST;
  let server: Server<WSData> | null = null;

  const broadcast = (msg: ServerMessage) => {
    const payload = JSON.stringify(msg);
    for (const client of clients) {
      try {
        client.send(payload);
      } catch {}
    }
  };

  const workspace = new Workspace(broadcast);

  const ctx: DaemonContext = {
    workspace,
    clients,
    webDist,
    version: options.version ?? pkg.version,
    linkMeta: new LinkMetaCache(options.linkMeta),
    format: options.format ?? formatMarkdown,
    broadcast,
    send: (ws, msg) => {
      try {
        ws.send(JSON.stringify(msg));
      } catch {}
    },
    sendOthers: (ws, msg) => {
      const payload = JSON.stringify(msg);
      for (const client of clients) {
        if (client === ws) continue;
        try {
          client.send(payload);
        } catch {}
      }
    },
    url: () => `http://127.0.0.1:${server?.port ?? 0}`,
  };

  const app = createRoutes(ctx);
  let nextId = 1;

  server = Bun.serve<WSData>({
    port: options.port ?? resolvePort(),
    hostname: options.hostname ?? '127.0.0.1',
    idleTimeout: 120,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        if (srv.upgrade(req, { data: { id: nextId++ } })) return undefined;
        return new Response('expected websocket upgrade', { status: 426 });
      }
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ctx.send(ws, workspace.workspaceMessage());
        // Sent unprompted so a page can theme itself and size its save debounce
        // from the first frame, without a second round trip over HTTP.
        ctx.send(ws, { type: 'settings', settings: getSettings() });
      },
      close(ws) {
        clients.delete(ws);
      },
      async message(ws, raw) {
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        const parsed = parseClientMessage(text);
        if (!parsed.ok) {
          ctx.send(ws, { type: 'error', message: parsed.error });
          return;
        }
        try {
          await handleMessage(ctx, ws, parsed.value);
        } catch (err) {
          ctx.send(ws, { type: 'error', message: errorMessage(err), op: parsed.value.type });
        }
      },
    },
  });

  if (options.root) {
    await workspace.setRoot(options.root, options.focus ?? null, options.persistState !== false);
  }

  // Shards for pages nobody has looked at in a week are dead weight; clearing
  // them on start keeps the cache directory from growing without bound.
  void ctx.linkMeta.sweepExpired();

  // Settings changed by anything other than this daemon reach the open pages the
  // same way our own writes do, so nothing about a settings change ever asks for
  // a restart — of the daemon or of the browser.
  const unwatchSettings = watchSettings((settings) => {
    broadcast({ type: 'settings', settings });
  });

  if (options.writePidFile) await writePid(process.pid).catch(() => {});

  const listenPort = server.port ?? 0;
  const handle: DaemonHandle = {
    server,
    port: listenPort,
    url: `http://127.0.0.1:${listenPort}`,
    workspace,
    clients: () => clients.size,
    stop: async () => {
      unwatchSettings();
      workspace.close();
      await server?.stop(true);
      clients.clear();
      if (options.writePidFile) await clearPid();
    },
  };
  return handle;
}

export async function runDaemonForeground(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const handle = await startDaemon({ ...options, writePidFile: true });
  const shutdown = () => {
    void handle.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(`md daemon listening on ${handle.url} (pid ${process.pid})`);
  if (handle.workspace.root) console.log(`workspace: ${handle.workspace.root}`);
  if (!hasRipgrep()) console.warn('warning: rg not found in PATH — full-text search disabled');
  return handle;
}
