import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { DEFAULT_SETTINGS, settingsSchema, type Settings, type SettingsPatch } from './protocol.ts';

/**
 * User settings live in the *config* directory, not the state directory: they
 * are something the user owns and may back up, while `~/.local/state/md` holds
 * throwaway runtime bookkeeping. `MD_CONFIG_DIR` overrides everything so a test
 * (or a second daemon) can run against its own file.
 */
export function configDir(): string {
  const override = process.env.MD_CONFIG_DIR;
  if (override !== undefined && override !== '') return path.resolve(override);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim() !== '') return path.join(path.resolve(xdg), 'writedown');
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData !== undefined && appData.trim() !== '') return path.join(path.resolve(appData), 'writedown');
  }
  return path.join(homedir(), '.config', 'writedown');
}

export function settingsPath(): string {
  return path.join(configDir(), 'settings.json');
}

/**
 * The in-process copy every request reads. It is keyed by the file it was read
 * from, so a changed `MD_CONFIG_DIR` can never be served stale values from the
 * previous location.
 */
let cache: { file: string; settings: Settings } | null = null;

function fromCache(): Settings | null {
  return cache !== null && cache.file === settingsPath() ? cache.settings : null;
}

/**
 * Reads the file and merges it over the defaults. A missing, unreadable or
 * malformed file is not an error — the daemon has to start either way — so the
 * outcome is always a complete configuration.
 */
export async function loadSettings(): Promise<Settings> {
  const file = settingsPath();
  let raw: unknown = null;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    raw = null;
  }
  const settings = settingsSchema.parse(raw !== null && typeof raw === 'object' ? raw : {});
  cache = { file, settings };
  return settings;
}

/** The current settings. Falls back to the defaults until `loadSettings` ran. */
export function getSettings(): Settings {
  return fromCache() ?? DEFAULT_SETTINGS;
}

/**
 * Writes through a sibling temp file and one `rename`, so a reader either sees
 * the whole previous file or the whole new one — never a truncated JSON.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`;
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Applies a validated patch over the current settings and persists the result. */
export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const current = getSettings();
  const next = settingsSchema.parse({
    ...current,
    ...patch,
    format: { ...current.format, ...patch.format },
  });
  const file = settingsPath();
  await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  cache = { file, settings: next };
  return next;
}

/** Drops the cached copy; the next read goes back to disk. */
export function resetSettingsCache(): void {
  cache = null;
}
