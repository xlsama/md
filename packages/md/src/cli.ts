#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import pkg from '../package.json';
import {
  DEFAULT_SETTINGS,
  healthResponseSchema,
  openResponseSchema,
  type HealthResponse,
} from './protocol.ts';
import { settingsPath } from './settings.ts';
import { ensureStateDir, logPath, readState, resolvePort } from './state.ts';
import { runDaemonForeground } from './daemon.ts';
import { installService, serviceConfig, uninstallService } from './service.ts';

const USAGE = `md — a local Markdown editor in your browser

Usage:
  md <path>                 Open a file or directory (starts the daemon if needed)
  md                        Reopen the last workspace
  md config                 Print the settings file path and contents
  md daemon [--port N]      Run the daemon in the foreground
  md service install        Install a startup service (launchd / systemd / Task Scheduler)
  md service uninstall      Remove the startup service
  md service config         Print the service config without writing it

Options:
  --port N                  Port (default 2233, or set MD_PORT)
  -h, --help                Show this help
  -v, --version             Show version
`;

interface ParsedArgs {
  positional: string[];
  port?: number;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let port: number | undefined;
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--port' || arg === '-p') {
      const next = argv[++i];
      const parsed = next ? Number.parseInt(next, 10) : Number.NaN;
      if (!Number.isFinite(parsed)) fail(`--port needs a number`);
      port = parsed;
    } else if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (!Number.isFinite(parsed)) fail(`--port needs a number`);
      port = parsed;
    } else if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '-v' || arg === '--version') {
      version = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, port, help, version };
}

function fail(message: string): never {
  console.error(`md: ${message}`);
  process.exit(1);
}

async function fetchHealth(port: number, timeoutMs = 800): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const parsed = healthResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function spawnDaemon(port: number): Promise<void> {
  await ensureStateDir();
  const fd = fs.openSync(logPath(), 'a');
  const proc = Bun.spawn({
    cmd: [process.execPath, path.resolve(import.meta.dir, 'cli.ts'), 'daemon', '--port', String(port)],
    stdin: 'ignore',
    stdout: fd,
    stderr: fd,
    detached: true,
    env: { ...process.env },
  });
  proc.unref();
}

async function waitForHealth(port: number, timeoutMs = 5000): Promise<HealthResponse | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port, 500);
    if (health) return health;
    await Bun.sleep(120);
  }
  return null;
}

async function restartDaemon(port: number, pid: number): Promise<HealthResponse | null> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port, 400);
    // launchd (KeepAlive) may already have brought the new code back up; with
    // no launchd around, the process simply stays gone and we start it here.
    if (health?.version === pkg.version) return health;
    if (!health) {
      await spawnDaemon(port);
      return waitForHealth(port);
    }
    await Bun.sleep(150);
  }
  return null;
}

async function openBrowser(url: string): Promise<void> {
  // The empty string after `start` is the window title: without it cmd.exe treats
  // a quoted URL as the title and opens nothing.
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    const proc = Bun.spawn({ cmd, stdout: 'ignore', stderr: 'ignore' });
    proc.unref();
  } catch {}
}

async function commandOpen(target: string | undefined, port: number): Promise<void> {
  let resolved: string;
  if (target) {
    resolved = path.resolve(target);
  } else {
    const state = await readState();
    if (!state.lastWorkspace) fail('no previous workspace — run `md <path>` first');
    resolved = state.lastWorkspace;
  }
  if (!fs.existsSync(resolved)) fail(`path not found: ${resolved}`);

  let health = await fetchHealth(port);
  if (health && health.version !== pkg.version) {
    console.log(`md: daemon ${health.version} → ${pkg.version}, restarting…`);
    health = await restartDaemon(port, health.pid);
    if (!health) fail(`daemon restart failed on port ${port} — see ${logPath()}`);
  }
  if (!health) {
    await spawnDaemon(port);
    health = await waitForHealth(port);
    if (!health) fail(`daemon failed to start on port ${port} — see ${logPath()}`);
  }

  const res = await fetch(`http://127.0.0.1:${port}/api/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: resolved }),
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}));
    const message =
      body && typeof body === 'object' && 'error' in body ? String((body).error) : res.statusText;
    fail(`open failed: ${message}`);
  }
  const data = openResponseSchema.parse(await res.json());
  if (data.clients === 0 && process.env['MD_NO_OPEN'] !== '1') {
    await openBrowser(data.url);
    console.log(`md: opened ${data.url}`);
  } else {
    console.log(`md: focused ${data.focus ?? data.root} in ${data.clients} connected tab(s)`);
  }
}

async function commandConfig(): Promise<void> {
  const file = settingsPath();
  console.log(`# ${file}`);
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {}
  if (raw === null) {
    // Nothing written yet: the daemon runs on the defaults, so print those
    // rather than leaving the reader with a path and no idea what is in effect.
    console.log('# not created yet — running on these defaults');
    console.log(JSON.stringify(DEFAULT_SETTINGS, null, 2));
    return;
  }
  process.stdout.write(raw.endsWith('\n') ? raw : `${raw}\n`);
}

async function commandDaemon(port: number): Promise<void> {
  const state = await readState();
  const root = state.lastWorkspace && fs.existsSync(state.lastWorkspace) ? state.lastWorkspace : null;
  const focus = root ? (state.lastFocus ?? null) : null;
  await runDaemonForeground({ port, root, focus });
  await new Promise<never>(() => {});
}

async function commandService(action: string | undefined, port: number | undefined): Promise<void> {
  switch (action) {
    case 'install': {
      const target = await installService(port);
      console.log(`md: installed ${target}`);
      return;
    }
    case 'uninstall': {
      const target = await uninstallService();
      console.log(`md: uninstalled ${target}`);
      return;
    }
    case 'config':
    case 'plist': {
      const { target, contents } = serviceConfig(port);
      console.log(`# ${target}`);
      console.log(contents);
      return;
    }
    default:
      fail('usage: md service install|uninstall|config');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.version) {
    console.log(pkg.version);
    return;
  }
  const port = resolvePort(args.port);
  const [command, ...rest] = args.positional;

  switch (command) {
    case 'config':
      await commandConfig();
      return;
    case 'daemon':
      await commandDaemon(port);
      return;
    case 'service':
      await commandService(rest[0], args.port);
      return;
    default:
      await commandOpen(command, port);
  }
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
