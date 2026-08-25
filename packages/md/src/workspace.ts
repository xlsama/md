import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerMessage, TreeNode } from './protocol.ts';
import {
  hashContent,
  isMarkdown,
  readTextIfExists,
  realpathOrSelf,
  relativeInRoot,
  resolveInRoot,
  scanTree,
  writeText,
} from './files.ts';
import { EchoSuppressor, Watcher } from './watcher.ts';
import { loadWorkspaceFormatConfig } from './format.ts';
import { writeState } from './state.ts';

export type Broadcast = (msg: ServerMessage) => void;

export class Workspace {
  root: string | null = null;
  focus: string | null = null;
  tree: TreeNode[] = [];
  /**
   * Whether the filesystem watcher is alive. `false` means external edits will
   * not be noticed until the page is reloaded — reported over `/api/health` so
   * the browser can say so out loud instead of silently going stale.
   */
  watching = false;
  /**
   * Whether the root could be listed on the last scan. `false` means the empty
   * tree is a refusal, not an empty folder — on macOS a daemon detached from
   * the terminal that spawned it loses its grant to the folders under privacy
   * control (`~/Downloads`, `~/Documents`, `~/Desktop`), and from then on both
   * `readdir` and `fs.watch` come back `EPERM`.
   */
  readable = true;

  private watcher: Watcher | null = null;
  private echo = new EchoSuppressor(2000);
  private knownHashes = new Map<string, string>();
  private treeSignature = '';
  private rescanQueue: Promise<void> = Promise.resolve();

  constructor(private readonly broadcast: Broadcast) {}

  async setRoot(root: string, focus: string | null, persist = true): Promise<void> {
    const realRoot = await realpathOrSelf(path.resolve(root));
    this.closeWatcher();
    this.echo.clear();
    this.knownHashes.clear();
    this.root = realRoot;
    this.focus = focus;
    await loadWorkspaceFormatConfig(realRoot);
    const scan = await scanTree(realRoot);
    this.tree = scan.tree;
    this.treeSignature = scan.signature;
    this.readable = scan.readable;
    if (!scan.readable) {
      console.error(
        `[md] cannot list ${realRoot}; the file tree will be empty. ` +
          'Re-run `md <path>` from a terminal that can read it.'
      );
    }
    // `focus` comes back from `state.json` across restarts, so it may well name
    // a file that was deleted in the meantime — and it is broadcast below, where
    // every page would immediately ask to open it.
    await this.pruneFocus();
    this.startWatcher();
    if (persist) {
      await writeState({ lastWorkspace: realRoot, lastFocus: this.focus }).catch(() => {});
    }
    this.broadcast(this.workspaceMessage());
  }

  workspaceMessage(): ServerMessage {
    return { type: 'workspace', root: this.root ?? '', focus: this.focus, tree: this.tree };
  }

  requireRoot(): string {
    if (!this.root) throw new Error('no workspace open');
    return this.root;
  }

  async resolve(rel: string): Promise<string> {
    return resolveInRoot(this.requireRoot(), rel);
  }

  private startWatcher(): void {
    const root = this.root;
    if (!root) return;
    // Set first: a watcher that fails to start reports it from inside the
    // constructor, and that verdict has to win.
    this.watching = true;
    this.watcher = new Watcher({
      root,
      debounceMs: 200,
      onPath: (rel) => {
        void this.handlePathEvent(root, rel);
      },
      onAny: () => {
        void this.rescan();
      },
      onError: (err) => {
        this.watching = false;
        console.error(`[md] watcher stopped for ${root}; external changes will go unnoticed:`, err);
      },
    });
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watching = false;
  }

  private async handlePathEvent(root: string, rel: string): Promise<void> {
    if (this.root !== root) return;
    if (!isMarkdown(rel)) return;
    const abs = path.join(root, rel);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) {
      this.knownHashes.delete(rel);
      return;
    }
    const content = await readTextIfExists(abs);
    if (content === null) return;
    const hash = hashContent(content);
    if (this.echo.matches(rel, hash)) {
      this.knownHashes.set(rel, hash);
      return;
    }
    if (this.knownHashes.get(rel) === hash) return;
    this.knownHashes.set(rel, hash);
    if (this.root !== root) return;
    this.broadcast({ type: 'external', path: rel, content, hash });
  }

  async rescan(force = false): Promise<boolean> {
    const run = this.rescanQueue.then(async () => {
      const root = this.root;
      if (!root) return false;
      const { tree, signature, readable } = await scanTree(root);
      this.readable = readable;
      if (!force && signature === this.treeSignature) return false;
      this.tree = tree;
      this.treeSignature = signature;
      // The remembered document may be what just disappeared — deleted from a
      // terminal, renamed by a branch switch. Keeping it would hand it to the
      // next page that connects, which would ask to open a file that is gone.
      if (await this.pruneFocus()) await writeState({ lastFocus: null }).catch(() => {});
      this.broadcast({ type: 'tree', tree });
      return true;
    });
    this.rescanQueue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  async readFile(rel: string): Promise<{ path: string; content: string; hash: string }> {
    const abs = await this.resolve(rel);
    const content = await fs.readFile(abs, 'utf8');
    const hash = hashContent(content);
    this.knownHashes.set(rel, hash);
    return { path: rel, content, hash };
  }

  async diskState(rel: string): Promise<{ abs: string; content: string; hash: string }> {
    const abs = await this.resolve(rel);
    const content = (await readTextIfExists(abs)) ?? '';
    return { abs, content, hash: hashContent(content) };
  }

  async writeFormatted(rel: string, abs: string, text: string): Promise<{ content: string; hash: string }> {
    const hash = hashContent(text);
    this.echo.record(rel, hash);
    await writeText(abs, text);
    this.knownHashes.set(rel, hash);
    return { content: text, hash };
  }

  noteWrite(rel: string, text: string): void {
    const hash = hashContent(text);
    this.echo.record(rel, hash);
    this.knownHashes.set(rel, hash);
  }

  setFocus(rel: string | null): void {
    this.focus = rel;
    void writeState({ lastFocus: rel }).catch(() => {});
  }

  /**
   * Drops a remembered document that is not on disk any more. Answers whether
   * it dropped one, so the caller can decide when that is worth persisting.
   */
  private async pruneFocus(): Promise<boolean> {
    const rel = this.focus;
    const root = this.root;
    if (rel === null || root === null) return false;
    const stat = await fs.stat(path.join(root, rel)).catch(() => null);
    if (stat?.isFile() === true) return false;
    this.focus = null;
    return true;
  }

  close(): void {
    this.closeWatcher();
    this.echo.clear();
    this.knownHashes.clear();
  }
}

export interface ResolvedTarget {
  root: string;
  focus: string | null;
}

export async function resolveTarget(targetPath: string): Promise<ResolvedTarget> {
  const abs = path.resolve(targetPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw new Error(`path not found: ${abs}`);
  if (stat.isDirectory()) {
    return { root: await realpathOrSelf(abs), focus: null };
  }
  if (!isMarkdown(abs)) throw new Error(`not a markdown file: ${abs}`);
  const root = await realpathOrSelf(path.dirname(abs));
  return { root, focus: relativeInRoot(root, await realpathOrSelf(abs)) };
}
