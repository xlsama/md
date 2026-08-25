import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pkg from '../package.json';
import { healthResponseSchema, type HealthResponse } from '../src/protocol.ts';

const SRC = path.resolve(import.meta.dir, '..', 'src');

async function fetchHealth(port: number): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const parsed = healthResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function waitHealth(port: number, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port);
    if (health) return health;
    await Bun.sleep(120);
  }
  return null;
}

describe('CLI 版本升级自动重启 daemon', () => {
  test('daemon 版本与 CLI 不一致时被重启为新版本', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'md-upgrade-state-'));
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'md-upgrade-ws-'));
    await fs.writeFile(path.join(ws, 'a.md'), '# upgrade\n', 'utf8');
    const port = 21000 + Math.floor(Math.random() * 2000);
    const env = { ...process.env, MD_STATE_DIR: stateDir, MD_NO_OPEN: '1' };

    const oldDaemon = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `import { startDaemon } from '${SRC}/daemon.ts'; await startDaemon({ port: ${port}, version: '0.0.0-old', writePidFile: true }); await new Promise(() => {});`,
      ],
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env,
    });

    const before = await waitHealth(port);
    expect(before?.version).toBe('0.0.0-old');

    const cli = Bun.spawn({
      cmd: [process.execPath, path.join(SRC, 'cli.ts'), '--port', String(port), ws],
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });
    const exitCode = await cli.exited;
    const stderr = await new Response(cli.stderr).text();
    expect(exitCode, stderr).toBe(0);

    const after = await waitHealth(port);
    expect(after?.version).toBe(pkg.version);
    expect(after?.pid).not.toBe(before?.pid);

    if (after) {
      try {
        process.kill(after.pid, 'SIGTERM');
      } catch {}
    }
    oldDaemon.kill();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }, 20000);
});

describe('CLI 在 daemon 失去工作区访问权时重启它', () => {
  test('工作区不可读的 daemon 被换成一个读得到的', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'md-access-state-'));
    // Realpath'd up front: the daemon cannot resolve a directory it may not
    // read, and a root spelled `/var/…` against a target spelled `/private/var/…`
    // would look like a different workspace and rescan itself well again.
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'md-access-ws-')));
    await fs.writeFile(path.join(ws, 'a.md'), '# denied\n', 'utf8');
    const port = 23000 + Math.floor(Math.random() * 2000);
    const env = { ...process.env, MD_STATE_DIR: stateDir, MD_NO_OPEN: '1' };

    // Stands in for a daemon that outlived its macOS grant: it opens the
    // workspace while the directory refuses to be listed, and the permission is
    // handed back before the CLI runs — so the CLI can do what it cannot.
    await fs.chmod(ws, 0o000);
    const denied = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `import { startDaemon } from '${SRC}/daemon.ts'; await startDaemon({ port: ${port}, root: ${JSON.stringify(ws)}, writePidFile: true }); await new Promise(() => {});`,
      ],
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env,
    });

    const before = await waitHealth(port);
    expect(before?.readable).toBe(false);
    await fs.chmod(ws, 0o755);

    const cli = Bun.spawn({
      cmd: [process.execPath, path.join(SRC, 'cli.ts'), '--port', String(port), ws],
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });
    const exitCode = await cli.exited;
    const stderr = await new Response(cli.stderr).text();
    expect(exitCode, stderr).toBe(0);

    const after = await waitHealth(port);
    expect(after?.pid).not.toBe(before?.pid);
    expect(after?.readable).toBe(true);

    if (after) {
      try {
        process.kill(after.pid, 'SIGTERM');
      } catch {}
    }
    denied.kill();
    await fs.chmod(ws, 0o755).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }, 20000);

  test('谁都读不到的工作区不会引发重启', async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'md-access-keep-state-'));
    const ws = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'md-access-keep-ws-')));
    await fs.writeFile(path.join(ws, 'a.md'), '# denied\n', 'utf8');
    const port = 25000 + Math.floor(Math.random() * 2000);
    const env = { ...process.env, MD_STATE_DIR: stateDir, MD_NO_OPEN: '1' };

    await fs.chmod(ws, 0o000);
    const denied = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        `import { startDaemon } from '${SRC}/daemon.ts'; await startDaemon({ port: ${port}, root: ${JSON.stringify(ws)}, writePidFile: true }); await new Promise(() => {});`,
      ],
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      env,
    });

    const before = await waitHealth(port);
    expect(before?.readable).toBe(false);

    const cli = Bun.spawn({
      cmd: [process.execPath, path.join(SRC, 'cli.ts'), '--port', String(port), ws],
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });
    await cli.exited;
    const stderr = await new Response(cli.stderr).text();
    // Restarting would change nothing, so the daemon is left alone and the
    // reason is said out loud instead.
    expect(stderr).toContain('cannot list');

    const after = await waitHealth(port);
    expect(after?.pid).toBe(before?.pid);

    denied.kill();
    await fs.chmod(ws, 0o755).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }, 20000);
});
