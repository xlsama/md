import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { startDaemon, type DaemonHandle } from '../src/daemon.ts';
import { downloadImage } from '../src/asset-import.ts';
import { fetchLinkMeta } from '../src/link-meta.ts';
import {
  assetResponseSchema,
  DEFAULT_SETTINGS,
  healthResponseSchema,
  linkMetaResponseSchema,
  openResponseSchema,
  serverMessageSchema,
  settingsSchema,
  type Settings,
} from '../src/protocol.ts';
import { formatMarkdown } from '../src/format.ts';
import { settingsPath } from '../src/settings.ts';
import { hashContent, setDeleter } from '../src/files.ts';
import {
  buildPlist,
  buildSystemdUnit,
  defaultPlistOptions,
  defaultSystemdOptions,
  plistPath,
  windowsTaskCommand,
} from '../src/service.ts';
import type { ClientMessage, ServerMessage, ServerMessageOf, ServerMessageType, TreeNode } from '../src/protocol.ts';

const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'md-e2e-'));
const ROOT = await fs.realpath(tmpBase);
const WORKSPACE = path.join(ROOT, 'workspace');
const OTHER = path.join(ROOT, 'other');
process.env.MD_STATE_DIR = path.join(ROOT, 'state');
// Settings live in the config directory, which is a different override.
process.env.MD_CONFIG_DIR = path.join(ROOT, 'config');

setDeleter(async (abs) => {
  await fs.rm(abs, { recursive: true, force: true });
});

class Client {
  private queue: ServerMessage[] = [];
  private waiters: { type: ServerMessageType; resolve: (msg: ServerMessage) => void }[] = [];

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      // Parsed rather than cast: every frame the daemon sends is checked
      // against the protocol on its way into the tests too.
      const msg = serverMessageSchema.parse(JSON.parse(String(event.data)));
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
    const body = healthResponseSchema.parse(await res.json());
    expect(body.pid).toBe(process.pid);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.clients).toBeGreaterThanOrEqual(1);
    // Nothing is open yet, so there is nothing to watch either.
    expect(body.watching).toBe(body.workspace !== null);
  });

  test('POST /api/open switches workspace and broadcasts workspace tree', async () => {
    const res = await fetch(`${daemon.url}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(WORKSPACE, 'note.md') }),
    });
    expect(res.status).toBe(200);
    const body = openResponseSchema.parse(await res.json());
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

    // An open workspace is a watched one, which is what the browser checks
    // before deciding whether external edits will show up on their own.
    const health = healthResponseSchema.parse(await (await fetch(`${daemon.url}/api/health`)).json());
    expect(health.workspace).toBe(WORKSPACE);
    expect(health.watching).toBe(true);
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

  test('create refuses a file that is not markdown', async () => {
    client.drain();
    for (const name of ['test23', 'hello', 'notes.txt', '.hidden-thing']) {
      client.send({ type: 'create', path: name, kind: 'file' });
      const err = await client.waitFor('error');
      expect(`${name}: ${err.message}`).toBe(`${name}: only .md files can be created`);
      expect(err.op).toBe('create');
    }
    await client.expectNone('tree', 300);
    const onDisk = await fs.readdir(WORKSPACE);
    expect(onDisk).not.toContain('test23');
    expect(onDisk).not.toContain('hello');
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

  test('churn under an excluded directory never reaches the tree', async () => {
    client.drain();
    const git = path.join(WORKSPACE, '.git');
    await fs.mkdir(path.join(git, 'objects'), { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      await fs.writeFile(path.join(git, 'objects', `blob-${String(i)}`), `x${String(i)}`, 'utf8');
    }
    await fs.writeFile(path.join(git, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await fs.writeFile(path.join(WORKSPACE, 'node_modules', 'pkg.md'), '# pkg changed\n', 'utf8');
    // Neither a rescan (`tree`) nor a content push (`external`) may follow: a
    // rebase writing thousands of objects would otherwise rescan the workspace
    // once per debounce window.
    await client.expectNone('tree', 900);
    await client.expectNone('external', 100);

    // …while an ordinary file in the same workspace still does.
    await fs.writeFile(path.join(WORKSPACE, 'watched.md'), '# watched\n', 'utf8');
    const tree = await client.waitFor('tree');
    expect(flatten(tree.tree)).toContain('file:watched.md');
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
    const body = assetResponseSchema.parse(await res.json());
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

  test('buildSystemdUnit renders a user unit', () => {
    const unit = buildSystemdUnit(defaultSystemdOptions(3993));
    expect(unit).toContain('[Service]');
    expect(unit).toContain('ExecStart=');
    expect(unit).toContain('daemon --port 3993');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain(`StandardOutput=append:${path.join(ROOT, 'state', 'daemon.log')}`);
  });

  test('buildSystemdUnit quotes executables containing spaces', () => {
    const unit = buildSystemdUnit({ argv: ['/opt/my apps/md', 'daemon'], logFile: '/tmp/md.log' });
    expect(unit).toContain('ExecStart="/opt/my apps/md" daemon');
  });

  test('windowsTaskCommand keeps the daemon subcommand and port', () => {
    expect(windowsTaskCommand(3993)).toContain('daemon --port 3993');
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

describe('a remembered document that is gone', () => {
  test('is dropped on start rather than handed to the page', async () => {
    const dir = path.join(ROOT, 'focus-start');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'kept.md'), '# kept\n', 'utf8');

    // What a restart looks like: `state.json` still names the document that was
    // open last time, and it was deleted in between.
    const other = await startDaemon({ root: dir, focus: 'deleted.md', persistState: false, port: 0 });
    try {
      const page = await Client.connect(other.port);
      expect((await page.waitFor('workspace')).focus).toBeNull();
      page.close();
      await Bun.sleep(50);
    } finally {
      await other.stop();
    }
  });

  test('is forgotten as soon as it disappears', async () => {
    const dir = path.join(ROOT, 'focus-live');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'doomed.md'), '# doomed\n', 'utf8');

    const other = await startDaemon({ root: dir, focus: 'doomed.md', persistState: false, port: 0 });
    try {
      const page = await Client.connect(other.port);
      expect((await page.waitFor('workspace')).focus).toBe('doomed.md');

      await fs.rm(path.join(dir, 'doomed.md'));
      await page.waitFor('tree');

      const second = await Client.connect(other.port);
      expect((await second.waitFor('workspace')).focus).toBeNull();
      page.close();
      second.close();
      await Bun.sleep(50);
    } finally {
      await other.stop();
    }
  });
});

describe('save races an external write', () => {
  const RACE = path.join(ROOT, 'race');
  const FILE = 'race.md';
  const BASE = '# base\n';
  const OUTSIDE = '# written by an agent\n';
  let raceDaemon: DaemonHandle;
  let raceClient: Client;

  beforeAll(async () => {
    await fs.mkdir(RACE, { recursive: true });
    await fs.writeFile(path.join(RACE, FILE), BASE, 'utf8');
    raceDaemon = await startDaemon({
      port: 0,
      root: RACE,
      persistState: false,
      webDist: path.join(ROOT, 'no-such-dist'),
      // Wide enough for the test to slip a write in between the hash check the
      // save starts with and the one it now ends with.
      format: async (file, source, toggles) => {
        await Bun.sleep(500);
        return formatMarkdown(file, source, toggles);
      },
    });
    raceClient = await Client.connect(raceDaemon.port);
    await raceClient.waitFor('workspace');
  });

  afterAll(async () => {
    raceClient?.close();
    await raceDaemon?.stop();
  });

  test('a write that lands while formatting runs wins, and the save is refused', async () => {
    raceClient.drain();
    raceClient.send({ type: 'open', path: FILE });
    const opened = await raceClient.waitFor('file');
    expect(opened.content).toBe(BASE);

    raceClient.send({
      type: 'save',
      path: FILE,
      content: '# from the browser\n',
      baseHash: opened.hash,
    });
    // Inside the formatting window: the first hash check has already passed.
    await Bun.sleep(150);
    await fs.writeFile(path.join(RACE, FILE), OUTSIDE, 'utf8');

    const conflict = await raceClient.waitFor('conflict');
    expect(conflict.path).toBe(FILE);
    expect(conflict.diskContent).toBe(OUTSIDE);
    expect(conflict.diskHash).toBe(hashContent(OUTSIDE));
    // The browser's version was dropped rather than written over the agent's.
    expect(await fs.readFile(path.join(RACE, FILE), 'utf8')).toBe(OUTSIDE);
    await raceClient.expectNone('saved', 400);
    expect(await fs.readFile(path.join(RACE, FILE), 'utf8')).toBe(OUTSIDE);
  });

  test('force-save still writes through the same window', async () => {
    raceClient.drain();
    raceClient.send({ type: 'force-save', path: FILE, content: '# forced\n' });
    const saved = await raceClient.waitFor('saved');
    expect(await fs.readFile(path.join(RACE, FILE), 'utf8')).toBe(saved.content);
  });
});

describe('asset import', () => {
  // A 1×1 transparent PNG — small, but a real image with real bytes.
  const PNG = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0)
  );

  let origin: import('bun').Server<undefined>;
  let base: string;
  let importDaemon: DaemonHandle;
  const IMPORT_ROOT = path.join(ROOT, 'import-ws');

  beforeAll(async () => {
    origin = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url);
        switch (url.pathname) {
          case '/pic.png':
            return new Response(PNG, { headers: { 'content-type': 'image/png' } });
          case '/hop':
            return new Response(null, { status: 302, headers: { location: '/pic.png' } });
          case '/page':
            return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
          case '/naked':
            return new Response(PNG);
          case '/big':
            return new Response(new Uint8Array(256 * 1024), {
              headers: { 'content-type': 'image/png' },
            });
          default:
            return new Response('missing', { status: 404 });
        }
      },
    });
    base = `http://127.0.0.1:${String(origin.port)}`;
    await fs.mkdir(IMPORT_ROOT, { recursive: true });
    await fs.writeFile(path.join(IMPORT_ROOT, 'note.md'), '# n\n');
    importDaemon = await startDaemon({
      port: 0,
      root: IMPORT_ROOT,
      persistState: false,
      webDist: path.join(ROOT, 'no-such-dist'),
      linkMeta: { dir: path.join(ROOT, 'import-link-meta'), allowPrivateHosts: true },
    });
  });

  afterAll(async () => {
    await importDaemon.stop();
    origin.stop(true);
  });

  const importAsset = (body: unknown) =>
    fetch(`${importDaemon.url}/api/assets/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('downloads a remote image into the assets directory', async () => {
    const res = await importAsset({ url: `${base}/pic.png`, docPath: 'note.md' });
    expect(res.status).toBe(200);
    const body = assetResponseSchema.parse(await res.json());
    expect(body.relativePath).toMatch(/^assets\/\d{8}-\d{6}-[0-9a-f]{8}\.png$/);
    const onDisk = await fs.readFile(path.join(IMPORT_ROOT, body.workspacePath));
    expect(new Uint8Array(onDisk)).toEqual(PNG);
  });

  test('follows a redirect to the actual image', async () => {
    const res = await importAsset({ url: `${base}/hop`, docPath: 'note.md' });
    expect(res.status).toBe(200);
  });

  test('refuses a response that is not an image', async () => {
    for (const target of [`${base}/page`, `${base}/naked`, `${base}/gone`]) {
      const res = await importAsset({ url: target, docPath: 'note.md' });
      expect(`${target} -> ${String(res.status)}`).toBe(`${target} -> 400`);
    }
  });

  test('the byte cap aborts an oversized download', async () => {
    await expect(
      downloadImage(`${base}/big`, { allowPrivateHosts: true, maxBytes: 64 * 1024 })
    ).rejects.toThrow(/上限/);
  });

  test('the private-host guard still applies on a normal daemon', async () => {
    // The main daemon has no `allowPrivateHosts`, so the same request is
    // refused before any bytes move.
    const res = await fetch(`${daemon.url}/api/assets/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${base}/pic.png`, docPath: 'note.md' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('link metadata', () => {
  const PAGE = [
    '<!doctype html><html><head>',
    '<title>Fallback &amp; Title</title>',
    '<base href="/pages/">',
    '<meta property="og:title" content="Hello &amp; World">',
    '<meta property="og:description" content="Two   spaces\nand a newline">',
    '<meta property="og:image" content="cover.png">',
    '<meta property="og:site_name" content="Mock Site">',
    '<link rel="apple-touch-icon" href="/apple.png">',
    '<link rel="icon" href="icon.svg">',
    '</head><body>ignored</body></html>',
  ].join('\n');

  let origin: import('bun').Server<undefined>;
  let base: string;
  let hits: Map<string, number>;
  let linkDaemon: DaemonHandle;

  beforeAll(async () => {
    hits = new Map();
    origin = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const url = new URL(req.url);
        hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
        switch (url.pathname) {
          case '/page':
            return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
          case '/redirect':
            return new Response(null, { status: 302, headers: { location: '/page' } });
          case '/json':
            return Response.json({ nope: true });
          case '/slow':
            await Bun.sleep(5000);
            return new Response('too late');
          default:
            return new Response('missing', { status: 404 });
        }
      },
    });
    base = `http://127.0.0.1:${String(origin.port)}`;
    linkDaemon = await startDaemon({
      port: 0,
      webDist: path.join(ROOT, 'no-such-dist'),
      linkMeta: {
        dir: path.join(ROOT, 'link-meta'),
        allowPrivateHosts: true,
        failureTtlMs: 150,
        // Every hop of the real fetcher runs, only pointed at the mock origin
        // and with a timeout short enough for a test to wait out.
        fetcher: (url) => fetchLinkMeta(url, { allowPrivateHosts: true, timeoutMs: 400 }),
      },
    });
  });

  afterAll(async () => {
    await linkDaemon?.stop();
    await origin?.stop(true);
  });

  const ask = async (target: string) => {
    const res = await fetch(`${linkDaemon.url}/api/link-meta?url=${encodeURIComponent(target)}`);
    expect(res.status).toBe(200);
    return linkMetaResponseSchema.parse(await res.json());
  };

  test('reads open-graph tags, resolving relative URLs against <base>', async () => {
    const body = await ask(`${base}/page`);
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.meta.title).toBe('Hello & World');
    expect(body.meta.description).toBe('Two spaces and a newline');
    expect(body.meta.image).toBe(`${base}/pages/cover.png`);
    // `rel="icon"` wins over the Apple variant, and resolves against <base>.
    expect(body.meta.favicon).toBe(`${base}/pages/icon.svg`);
    expect(body.meta.siteName).toBe('Mock Site');
    expect(body.meta.domain).toBe('127.0.0.1');
  });

  test('a second request is answered from cache without touching the origin', async () => {
    const before = hits.get('/page') ?? 0;
    expect((await ask(`${base}/page`)).ok).toBe(true);
    expect(hits.get('/page')).toBe(before);

    // …and it survives a restart, because the answer is also on disk.
    const shards = await fs.readdir(path.join(ROOT, 'link-meta'));
    expect(shards.some((name) => name.endsWith('.json'))).toBe(true);
  });

  test('follows redirects to the final page', async () => {
    const body = await ask(`${base}/redirect`);
    expect(body.ok).toBe(true);
    if (body.ok) expect(body.meta.url).toBe(`${base}/page`);
  });

  test('refuses anything that is not HTML', async () => {
    const body = await ask(`${base}/json`);
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.error).toContain('application/json');
  });

  test('gives up on a page that never answers', async () => {
    const body = await ask(`${base}/slow`);
    expect(body.ok).toBe(false);
    if (!body.ok) expect(body.error).toBe('抓取超时');
  });

  test('a failure is cached briefly, then retried', async () => {
    expect((await ask(`${base}/gone`)).ok).toBe(false);
    const afterFirst = hits.get('/gone');
    expect(afterFirst).toBe(1);

    await ask(`${base}/gone`);
    expect(hits.get('/gone')).toBe(afterFirst);

    await Bun.sleep(220);
    await ask(`${base}/gone`);
    expect(hits.get('/gone')).toBe(2);
  });

  test('refuses to fetch the machine it runs on', async () => {
    // This daemon has no `allowPrivateHosts`, so the guard is live.
    for (const target of [
      'http://127.0.0.1:9/x',
      'http://localhost:9/x',
      'http://192.168.1.10/x',
      'http://10.0.0.1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:9/x',
      'http://printer.local/x',
      'file:///etc/passwd',
      'ftp://example.com/x',
    ]) {
      const res = await fetch(`${daemon.url}/api/link-meta?url=${encodeURIComponent(target)}`);
      expect(`${target} -> ${String(res.status)}`).toBe(`${target} -> 400`);
    }
  });

  test('an unparseable url is rejected, a public one is not', async () => {
    const bad = await fetch(`${daemon.url}/api/link-meta?url=${encodeURIComponent('not a url')}`);
    expect(bad.status).toBe(400);
    const missing = await fetch(`${daemon.url}/api/link-meta`);
    expect(missing.status).toBe(400);
  });
});

describe('settings', () => {
  const put = (patch: unknown) =>
    fetch(`${daemon.url}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });

  const putOk = async (patch: unknown): Promise<void> => {
    const res = await put(patch);
    expect(`${JSON.stringify(patch)} -> ${String(res.status)}`).toBe(`${JSON.stringify(patch)} -> 200`);
    await res.json();
  };

  const get = async (): Promise<Settings> => {
    const res = await fetch(`${daemon.url}/api/settings`);
    expect(res.status).toBe(200);
    return settingsSchema.parse(await res.json());
  };

  // An earlier suite leaves the daemon pointed at `OTHER`; the format and
  // assets checks below write into the main workspace.
  beforeAll(async () => {
    await fetch(`${daemon.url}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: WORKSPACE }),
    });
    await client.waitFor('workspace');
  });

  afterAll(async () => {
    await put(DEFAULT_SETTINGS);
  });

  test('GET answers with the defaults before anything was ever written', async () => {
    expect(await get()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({
      theme: 'system',
      format: { autocorrect: true, oxfmt: true },
      assetsDir: 'assets',
      linkEmbeds: true,
      importPastedImages: true,
      saveDebounceMs: 500,
      sidebarOpen: false,
      sidebarWidth: 256,
    });
  });

  test('PUT persists to disk and broadcasts the merged result', async () => {
    client.drain();
    const res = await put({ theme: 'dark', saveDebounceMs: 900, sidebarOpen: true });
    expect(res.status).toBe(200);
    const body = settingsSchema.parse(await res.json());
    expect(body.theme).toBe('dark');
    expect(body.saveDebounceMs).toBe(900);
    expect(body.sidebarOpen).toBe(true);
    // Untouched fields keep their values rather than being reset.
    expect(body.format).toEqual({ autocorrect: true, oxfmt: true });

    const broadcast = await client.waitFor('settings');
    expect(broadcast.settings).toEqual(body);

    const onDisk = settingsSchema.parse(JSON.parse(await fs.readFile(settingsPath(), 'utf8')));
    expect(onDisk).toEqual(body);
    expect(await get()).toEqual(body);
  });

  test('a fresh client is handed the settings on connect', async () => {
    const other = await Client.connect(daemon.port);
    const msg = await other.waitFor('settings');
    expect(msg.settings.theme).toBe('dark');
    other.close();
    await Bun.sleep(50);
  });

  test('a file written by someone else is picked up and broadcast, no restart', async () => {
    client.drain();
    const before = await get();
    const outside: Settings = { ...before, saveDebounceMs: 1234, assetsDir: 'outside' };
    await fs.writeFile(settingsPath(), `${JSON.stringify(outside, null, 2)}\n`, 'utf8');

    const broadcast = await client.waitFor('settings');
    expect(broadcast.settings).toEqual(outside);
    // The daemon's own copy moved with it — this is what the save pipeline and
    // the asset upload read.
    expect(await get()).toEqual(outside);
  });

  test('our own write does not echo back a second time', async () => {
    const res = await put({ assetsDir: 'assets' });
    expect(res.status).toBe(200);
    await client.waitFor('settings');
    // The watcher sees the write too; re-reading it changes nothing, so it says
    // nothing.
    await client.expectNone('settings', 300);
  });

  test('illegal values are refused and change nothing', async () => {
    const before = await get();
    for (const patch of [
      { theme: 'blue' },
      { saveDebounceMs: 10 },
      { saveDebounceMs: 99_999 },
      { saveDebounceMs: 300.5 },
      { assetsDir: '../escape' },
      { assetsDir: 'nested/dir' },
      { assetsDir: '' },
      { assetsDir: '..' },
      { linkEmbeds: 'yes' },
      { format: { oxfmt: 'no' } },
    ]) {
      const res = await put(patch);
      expect(`${JSON.stringify(patch)} -> ${String(res.status)}`).toBe(`${JSON.stringify(patch)} -> 400`);
    }
    expect(await get()).toEqual(before);
    await client.expectNone('settings', 200);
  });

  test('the format switches decide what actually lands on disk', async () => {
    const file = 'settings-fmt.md';
    await fs.writeFile(path.join(WORKSPACE, file), '', 'utf8');
    await daemon.workspace.rescan(true);

    const save = async (content: string): Promise<string> => {
      client.drain();
      client.send({ type: 'open', path: file });
      const opened = await client.waitFor('file');
      client.send({ type: 'save', path: file, content, baseHash: opened.hash });
      const saved = await client.waitFor('saved');
      expect(await fs.readFile(path.join(WORKSPACE, file), 'utf8')).toBe(saved.content);
      return saved.content;
    };

    await putOk({ format: { autocorrect: true, oxfmt: true } });
    const both = await save(MESSY);
    expect(both).toContain('# 标题 Hello 世界 123');
    expect(both).toContain('- 项目一 Item');

    // autocorrect only: the CJK spacing lands, the list marker stays as typed.
    await putOk({ format: { autocorrect: true, oxfmt: false } });
    const autocorrectOnly = await save(MESSY);
    expect(autocorrectOnly).toContain('# 标题 Hello 世界 123');
    expect(autocorrectOnly).toContain('*   项目一 Item');

    // oxfmt only: the list is normalised, the CJK spacing is not inserted.
    await putOk({ format: { autocorrect: false, oxfmt: true } });
    const oxfmtOnly = await save(MESSY);
    expect(oxfmtOnly).toContain('# 标题Hello世界123');
    expect(oxfmtOnly).toContain('- 项目一Item');

    // Both off: the bytes the browser sent are the bytes on disk.
    await putOk({ format: { autocorrect: false, oxfmt: false } });
    expect(await save(MESSY)).toBe(MESSY);
  });

  test('assetsDir decides where a pasted image is written', async () => {
    await putOk({ assetsDir: '图片' });
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }));
    form.set('docPath', 'sub/deep.md');
    const res = await fetch(`${daemon.url}/api/assets`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = z
      .object({ relativePath: z.string(), workspacePath: z.string() })
      .parse(await res.json());
    expect(body.relativePath).toMatch(/^图片\/\d{8}-\d{6}-shot\.png$/);
    expect(body.workspacePath).toBe(`sub/${body.relativePath}`);
    expect(await fs.exists(path.join(WORKSPACE, body.workspacePath))).toBe(true);
  });

  test('a hand-edited file keeps the fields it understands and defaults the rest', async () => {
    await fs.writeFile(
      settingsPath(),
      JSON.stringify({ theme: 'light', saveDebounceMs: 'soon', unknownKey: 1 }),
      'utf8'
    );
    const restarted = await startDaemon({ port: 0, webDist: path.join(ROOT, 'no-such-dist') });
    try {
      const res = await fetch(`${restarted.url}/api/settings`);
      const body = settingsSchema.parse(await res.json());
      expect(body.theme).toBe('light');
      expect(body.saveDebounceMs).toBe(500);
      expect(body).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' });
    } finally {
      await restarted.stop();
    }
  });
});
