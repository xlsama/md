import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pkg from '../package.json';

const SRC = path.resolve(import.meta.dir, '..', 'src');

async function fetchHealth(port: number): Promise<{ pid: number; version: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    return (await res.json()) as { pid: number; version: string };
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
