import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export interface PersistedState {
  lastWorkspace?: string;
  lastFocus?: string | null;
}

export const DEFAULT_PORT = 2233;

export function stateDir(): string {
  const override = process.env.MD_STATE_DIR;
  if (override) return path.resolve(override);
  return path.join(homedir(), '.local', 'state', 'md');
}

export function statePath(): string {
  return path.join(stateDir(), 'state.json');
}

export function logPath(): string {
  return path.join(stateDir(), 'daemon.log');
}

export function pidPath(): string {
  return path.join(stateDir(), 'daemon.pid');
}

export async function ensureStateDir(): Promise<string> {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function readState(): Promise<PersistedState> {
  try {
    const raw = await fs.readFile(statePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return {};
}

export async function writeState(next: PersistedState): Promise<void> {
  await ensureStateDir();
  const merged = { ...(await readState()), ...next };
  await fs.writeFile(statePath(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

export function resolvePort(flagPort?: number): number {
  if (flagPort && Number.isFinite(flagPort)) return flagPort;
  const env = process.env.MD_PORT;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_PORT;
}

export async function writePid(pid: number): Promise<void> {
  await ensureStateDir();
  await fs.writeFile(pidPath(), `${pid}\n`, 'utf8');
}

export async function clearPid(): Promise<void> {
  try {
    await fs.unlink(pidPath());
  } catch {}
}
