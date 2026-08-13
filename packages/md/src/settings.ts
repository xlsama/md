import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
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
  if (xdg !== undefined && xdg.trim() !== '') return path.join(path.resolve(xdg), 'md');
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData !== undefined && appData.trim() !== '') return path.join(path.resolve(appData), 'md');
  }
  return path.join(homedir(), '.config', 'md');
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

/**
 * Follows the settings file while the daemon runs.
 *
 * Without this the in-process copy is only ever refreshed by our own `PUT`, so
 * anything else that writes the file — a second daemon on another port, an
 * editor, `md config` — is invisible until a restart. Watching removes the
 * restart from the picture entirely: whoever writes the file, every daemon
 * picks it up and every page hears about it.
 *
 * The *directory* is watched rather than the file: {@link writeAtomic} replaces
 * it through `rename`, which detaches a watch on the old inode after the first
 * write. Events are coalesced because one save arrives as several (the temp
 * file, the rename), and a re-read that changes nothing is dropped — otherwise
 * our own writes would echo back out as broadcasts.
 */
export function watchSettings(onChange: (settings: Settings) => void): () => void {
  const file = settingsPath();
  const dir = path.dirname(file);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  let closed = false;

  const reload = (): void => {
    timer = null;
    const before = JSON.stringify(fromCache());
    void loadSettings().then(
      (settings) => {
        if (closed || JSON.stringify(settings) === before) return;
        onChange(settings);
      },
      () => {}
    );
  };

  const start = (): void => {
    if (closed) return;
    try {
      watcher = watch(dir, (_event, name) => {
        if (name !== null && name !== path.basename(file)) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(reload, 50);
      });
      // A config directory that is deleted out from under us takes the watch
      // with it; the daemon keeps serving the settings it has either way.
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  };

  // The directory is created lazily by the first write, so it may not be there
  // yet — in which case there is nothing to watch until it is.
  void fs.mkdir(dir, { recursive: true }).then(start, start);

  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    watcher?.close();
    watcher = null;
  };
}
