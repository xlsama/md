import { watch, type FSWatcher } from 'node:fs';
import { isExcludedRelPath, toPosix } from './files.ts';

export interface WatcherOptions {
  root: string;
  debounceMs?: number;
  onPath: (relPath: string) => void;
  onAny: () => void;
  onError?: (err: unknown) => void;
}

export class Watcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private anyTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly debounceMs: number;

  constructor(private readonly opts: WatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 200;
    try {
      this.watcher = watch(opts.root, { recursive: true, persistent: false }, (_event, filename) => {
        if (this.closed) return;
        this.schedule(filename);
      });
      this.watcher.on('error', (err) => opts.onError?.(err));
    } catch (err) {
      opts.onError?.(err);
    }
  }

  private schedule(filename: string | Buffer | null): void {
    this.scheduleAny();
    if (!filename) return;
    const rel = toPosix(typeof filename === 'string' ? filename : filename.toString('utf8'));
    if (!rel || isExcludedRelPath(rel)) return;
    const existing = this.timers.get(rel);
    if (existing) clearTimeout(existing);
    this.timers.set(
      rel,
      setTimeout(() => {
        this.timers.delete(rel);
        if (this.closed) return;
        this.opts.onPath(rel);
      }, this.debounceMs)
    );
  }

  private scheduleAny(): void {
    if (this.anyTimer) clearTimeout(this.anyTimer);
    this.anyTimer = setTimeout(() => {
      this.anyTimer = null;
      if (this.closed) return;
      this.opts.onAny();
    }, this.debounceMs);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.anyTimer) clearTimeout(this.anyTimer);
    this.anyTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}

export class EchoSuppressor {
  private entries = new Map<string, { hash: string; at: number }>();

  constructor(private readonly ttlMs = 2000) {}

  record(relPath: string, hash: string): void {
    this.entries.set(relPath, { hash, at: Date.now() });
    this.sweep();
  }

  matches(relPath: string, hash: string): boolean {
    const entry = this.entries.get(relPath);
    if (!entry) return false;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(relPath);
      return false;
    }
    return entry.hash === hash;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
