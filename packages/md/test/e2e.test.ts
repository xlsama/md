import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { startDaemon, type DaemonHandle } from '../src/daemon.ts';
import { hashContent, setDeleter } from '../src/files.ts';
import { buildPlist, defaultPlistOptions, plistPath } from '../src/service.ts';
import type { ClientMessage, ServerMessage, ServerMessageOf, ServerMessageType, TreeNode } from '../src/protocol.ts';

const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'md-e2e-'));
const ROOT = await fs.realpath(tmpBase);
const WORKSPACE = path.join(ROOT, 'workspace');
const OTHER = path.join(ROOT, 'other');
process.env.MD_STATE_DIR = path.join(ROOT, 'state');

setDeleter(async (abs) => {
  await fs.rm(abs, { recursive: true, force: true });
});

class Client {
  private queue: ServerMessage[] = [];
  private waiters: { type: ServerMessageType; resolve: (msg: ServerMessage) => void }[] = [];

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      const index = this.waiters.findIndex((w) => w.type === msg.type);
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter!.resolve(msg);
        return;
      }
      this.queue.push(msg);
    });
  }

  static connect(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const client = new Client(ws);
      ws.addEventListener('open', () => resolve(client));
      ws.addEventListener('error', reject);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor<T extends ServerMessageType>(type: T, timeoutMs = 5000): Promise<ServerMessageOf<T>> {
    const index = this.queue.findIndex((m) => m.type === type);
    if (index >= 0) {
      const [msg] = this.queue.splice(index, 1);
      return msg as ServerMessageOf<T>;
    }
    return new Promise<ServerMessageOf<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout waiting for "${type}"`));
      }, timeoutMs);
      const wrapped = (msg: ServerMessage) => {
        clearTimeout(timer);
        resolve(msg as ServerMessageOf<T>);
      };
      this.waiters.push({ type, resolve: wrapped });
    });
  }

  async expectNone(type: ServerMessageType, waitMs: number): Promise<void> {
    await Bun.sleep(waitMs);
    const found = this.queue.find((m) => m.type === type);
    if (found) throw new Error(`unexpected "${type}" message: ${JSON.stringify(found).slice(0, 200)}`);
  }

  drain(): void {
    this.queue = [];
  }

  close(): void {
    this.ws.close();
  }
}

function rawRequest(port: number, target: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(buf);
    }, timeoutMs);
    socket.on('data', (chunk) => {
      buf += chunk.toString();
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(buf);
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function flatten(tree: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      out.push(`${node.kind}:${node.path}`);
      if (node.children) walk(node.children);
    }
  };
  walk(tree);
  return out;
}

const MESSY = [
  '# 标题Hello世界123',
  '',
  '*   项目一Item',
  '*  项目二Item',
  '',
  '| a | bb |',
  '|--|--|',
  '| 中文English | 2 |',
  '',
].join('\n');

let daemon: DaemonHandle;
let client: Client;

beforeAll(async () => {
  await fs.mkdir(path.join(WORKSPACE, 'sub'), { recursive: true });
  await fs.mkdir(path.join(WORKSPACE, 'node_modules'), { recursive: true });
  await fs.mkdir(path.join(WORKSPACE, '.hidden'), { recursive: true });
  await fs.mkdir(OTHER, { recursive: true });
  await fs.writeFile(path.join(WORKSPACE, 'note.md'), '# note\n', 'utf8');
  await fs.writeFile(path.join(WORKSPACE, 'sub', 'deep.md'), '# deep\n\nzephyrium keyword here\n', 'utf8');
  await fs.writeFile(path.join(WORKSPACE, 'ignore.txt'), 'not markdown\n', 'utf8');
  await fs.writeFile(path.join(WORKSPACE, 'node_modules', 'pkg.md'), '# pkg\n', 'utf8');
  await fs.writeFile(path.join(WORKSPACE, '.hidden', 'secret.md'), '# secret\n', 'utf8');
  await fs.writeFile(path.join(OTHER, 'elsewhere.md'), '# elsewhere\n', 'utf8');

  daemon = await startDaemon({ port: 0, webDist: path.join(ROOT, 'no-such-dist') });
  client = await Client.connect(daemon.port);
  await client.waitFor('workspace');
});

afterAll(async () => {
  client?.close();
  await daemon?.stop();
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('http api', () => {
  test('GET /api/health', async () => {
    const res = await fetch(`${daemon.url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pid: number; version: string; clients: number };
    expect(body.pid).toBe(process.pid);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.clients).toBeGreaterThanOrEqual(1);
  });

  test('POST /api/open switches workspace and broadcasts workspace tree', async () => {
    const res = await fetch(`${daemon.url}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(WORKSPACE, 'note.md') }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { root: string; focus: string | null; clients: number; url: string };
    expect(body.root).toBe(WORKSPACE);
    expect(body.focus).toBe('note.md');
    expect(body.clients).toBe(1);

    const msg = await client.waitFor('workspace');
    expect(msg.root).toBe(WORKSPACE);
    const paths = flatten(msg.tree);
    expect(paths).toContain('file:note.md');
    expect(paths).toContain('dir:sub');
    expect(paths).toContain('file:sub/deep.md');
    expect(paths).not.toContain('file:ignore.txt');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.hidden'))).toBe(false);

    const focus = await client.waitFor('focus');
    expect(focus.path).toBe('note.md');
  });

  test('GET /* falls back to placeholder page when web/dist is missing', async () => {
    const res = await fetch(`${daemon.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('pnpm build');
  });
});

describe('ws file lifecycle', () => {
  test('open returns file content and hash', async () => {
    client.drain();
    client.send({ type: 'open', path: 'note.md' });
    const file = await client.waitFor('file');
    expect(file.path).toBe('note.md');
    expect(file.content).toBe('# note\n');
    expect(file.hash).toBe(hashContent('# note\n'));
  });

  test('save formats through autocorrect + oxfmt and echoes no external', async () => {
    client.drain();
    client.send({ type: 'open', path: 'note.md' });
    const file = await client.waitFor('file');

    client.send({ type: 'save', path: 'note.md', content: MESSY, baseHash: file.hash });
    const saved = await client.waitFor('saved');

    expect(saved.content).not.toBe(MESSY);
    expect(saved.content).toContain('# 标题 Hello 世界 123');
    expect(saved.content).toContain('- 项目一 Item');
    expect(saved.content).toContain('中文 English');
    expect(saved.content).toMatch(/\| ------------ \|/);

    const onDisk = await fs.readFile(path.join(WORKSPACE, 'note.md'), 'utf8');
    expect(onDisk).toBe(saved.content);
    expect(saved.hash).toBe(hashContent(onDisk));

    await client.expectNone('external', 1200);
  });

  test('save with stale baseHash yields conflict', async () => {
    client.drain();
    const current = await fs.readFile(path.join(WORKSPACE, 'note.md'), 'utf8');
    client.send({ type: 'save', path: 'note.md', content: '# whatever\n', baseHash: hashContent('stale') });
    const conflict = await client.waitFor('conflict');
    expect(conflict.path).toBe('note.md');
    expect(conflict.diskContent).toBe(current);
    expect(conflict.diskHash).toBe(hashContent(current));
    expect(await fs.readFile(path.join(WORKSPACE, 'note.md'), 'utf8')).toBe(current);
  });

  test('force-save skips the hash check', async () => {
    client.drain();
    client.send({ type: 'force-save', path: 'note.md', content: '# forced锚point\n' });
    const saved = await client.waitFor('saved');
    expect(saved.content).toContain('# forced 锚 point');
    expect(await fs.readFile(path.join(WORKSPACE, 'note.md'), 'utf8')).toBe(saved.content);
  });

  test('external write broadcasts external with raw (unformatted) content', async () => {
    client.drain();
    const external = '# external编辑123\n\n*   messy\n';
    await fs.writeFile(path.join(WORKSPACE, 'note.md'), external, 'utf8');
    const msg = await client.waitFor('external');
    expect(msg.path).toBe('note.md');
    expect(msg.content).toBe(external);
    expect(msg.hash).toBe(hashContent(external));
    expect(await fs.readFile(path.join(WORKSPACE, 'note.md'), 'utf8')).toBe(external);
  });
});

describe('ws tree mutations', () => {
  test('create broadcasts tree', async () => {
    client.drain();
    client.send({ type: 'create', path: 'created.md', kind: 'file' });
    const tree = await client.waitFor('tree');
    expect(flatten(tree.tree)).toContain('file:created.md');
    expect(await fs.readFile(path.join(WORKSPACE, 'created.md'), 'utf8')).toBe('');

    client.drain();
    client.send({ type: 'create', path: 'folder', kind: 'dir' });
    const tree2 = await client.waitFor('tree');
    expect(flatten(tree2.tree)).toContain('dir:folder');
  });

  test('rename broadcasts tree', async () => {
    client.drain();
    client.send({ type: 'rename', from: 'created.md', to: 'folder/renamed.md' });
    let paths: string[] = [];
    for (let i = 0; i < 3 && !paths.includes('file:folder/renamed.md'); i++) {
      const tree = await client.waitFor('tree');
      paths = flatten(tree.tree);
    }
    expect(paths).toContain('file:folder/renamed.md');
    expect(paths).not.toContain('file:created.md');
  });

  test('delete removes the file and broadcasts tree', async () => {
    client.drain();
    client.send({ type: 'delete', path: 'folder/renamed.md' });
    let paths: string[] = ['file:folder/renamed.md'];
    for (let i = 0; i < 3 && paths.includes('file:folder/renamed.md'); i++) {
      const tree = await client.waitFor('tree');
      paths = flatten(tree.tree);
    }
    expect(paths).not.toContain('file:folder/renamed.md');
    expect(await fs.exists(path.join(WORKSPACE, 'folder', 'renamed.md'))).toBe(false);
  });

  test('rejects paths outside the workspace', async () => {
    client.drain();
    client.send({ type: 'open', path: '../other/elsewhere.md' });
    const err = await client.waitFor('error');
    expect(err.op).toBe('open');
    expect(err.message).toContain('escapes workspace');
  });
});

describe('search', () => {
  test('search returns ripgrep hits', async () => {
    client.drain();
    client.send({ type: 'search', query: 'zephyrium' });
    const results = await client.waitFor('search-results');
    expect(results.query).toBe('zephyrium');
    expect(results.results.length).toBeGreaterThanOrEqual(1);
    const hit = results.results.find((r) => r.path === 'sub/deep.md');
    expect(hit).toBeDefined();
    expect(hit!.line).toBe(3);
    expect(hit!.column).toBe(1);
    expect(hit!.preview).toContain('zephyrium');
  });
});

describe('path traversal', () => {
  const encodedAttempts = [
    '/raw/%2e%2e%2f%2e%2e%2fetc%2fhosts',
    '/raw/..%2f..%2fetc%2fhosts',
    '/raw/sub%2f..%2f..%2f..%2fetc%2fhosts',
  ];

  for (const attempt of encodedAttempts) {
    test(`rejects ${attempt}`, async () => {
      const res = await fetch(`${daemon.url}${attempt}`);
      const text = await res.text();
      expect(res.status).toBe(403);
      expect(text).not.toContain('localhost');
    });
  }

  const literalAttempts = ['/raw/../../etc/hosts', '/raw/%2e%2e/%2e%2e/etc/hosts', '/raw/sub/../../../etc/hosts'];

  for (const attempt of literalAttempts) {
    test(`never leaks through ${attempt}`, async () => {
      const raw = await rawRequest(daemon.port, attempt);
      expect(raw).not.toContain('localhost');
      expect(raw).not.toMatch(/##\s*\n# Host Database/);
    });
  }

  test('absolute-looking path stays inside the workspace', async () => {
    const res = await fetch(`${daemon.url}/raw//etc/hosts`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('localhost');
  });

  test('serves a legit file under /raw', async () => {
    const res = await fetch(`${daemon.url}/raw/sub/deep.md`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('zephyrium');
  });
});

describe('assets', () => {
  test('POST /api/assets stores next to the doc', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }));
    form.set('docPath', 'sub/deep.md');
    const res = await fetch(`${daemon.url}/api/assets`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relativePath: string; workspacePath: string };
    expect(body.relativePath).toMatch(/^assets\/\d{8}-\d{6}-shot\.png$/);
    expect(body.workspacePath).toBe(`sub/${body.relativePath}`);
    expect(await fs.exists(path.join(WORKSPACE, body.workspacePath))).toBe(true);
  });
});

describe('multi client', () => {
  test('a save reaches the other clients as external', async () => {
    const other = await Client.connect(daemon.port);
    await other.waitFor('workspace');
    client.drain();
    other.drain();

    client.send({ type: 'open', path: 'note.md' });
    const file = await client.waitFor('file');
    client.send({ type: 'save', path: 'note.md', content: '# 二号client测试\n', baseHash: file.hash });

    const saved = await client.waitFor('saved');
    const external = await other.waitFor('external');
    expect(external.path).toBe('note.md');
    expect(external.content).toBe(saved.content);
    expect(external.hash).toBe(saved.hash);
    await client.expectNone('external', 800);
    other.close();
    await Bun.sleep(100);
  });
});

describe('service', () => {
  test('buildPlist renders a valid launchd agent', () => {
    const plist = buildPlist(defaultPlistOptions(3993));
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>dev.md.daemon</string>');
    expect(plist).toContain(`<string>${process.execPath}</string>`);
    expect(plist).toContain(`<string>${path.resolve(import.meta.dir, '..', 'src', 'cli.ts')}</string>`);
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<string>--port</string>');
    expect(plist).toContain('<string>3993</string>');
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toContain(path.join(ROOT, 'state', 'daemon.log'));
    expect(plistPath()).toBe(path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.md.daemon.plist'));
  });

  test('buildPlist omits --port when unset', () => {
    const plist = buildPlist(defaultPlistOptions());
    expect(plist).not.toContain('--port');
  });
});

describe('workspace switching', () => {
  test('switching root closes the old watcher and rescans', async () => {
    client.drain();
    const res = await fetch(`${daemon.url}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: OTHER }),
    });
    expect(res.status).toBe(200);
    const msg = await client.waitFor('workspace');
    expect(msg.root).toBe(OTHER);
    expect(msg.focus).toBeNull();
    expect(flatten(msg.tree)).toEqual(['file:elsewhere.md']);

    client.drain();
    await fs.writeFile(path.join(WORKSPACE, 'note.md'), '# stale workspace write\n', 'utf8');
    await client.expectNone('external', 800);

    await fs.writeFile(path.join(OTHER, 'elsewhere.md'), '# new elsewhere\n', 'utf8');
    const external = await client.waitFor('external');
    expect(external.path).toBe('elsewhere.md');
  });
});
