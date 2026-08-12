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

  private watcher: Watcher | null = null;
  private echo = new EchoSuppressor(2000);
  private knownHashes = new Map<string, string>();
  private treeSignature = '';
  private rescanQueue: Promise<void> = Promise.resolve();

  constructor(private broadcast: Broadcast) {}

  setBroadcast(fn: Broadcast): void {
    this.broadcast = fn;
  }

  async setRoot(root: string, focus: string | null, persist = true): Promise<void> {
    const realRoot = await realpathOrSelf(path.resolve(root));
    this.closeWatcher();
    this.echo.clear();
    this.knownHashes.clear();
    this.root = realRoot;
    this.focus = focus;
    await loadWorkspaceFormatConfig(realRoot);
    this.tree = await scanTree(realRoot);
    this.treeSignature = JSON.stringify(this.tree);
    this.startWatcher();
    if (persist) {
      await writeState({ lastWorkspace: realRoot, lastFocus: focus }).catch(() => {});
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

  relative(abs: string): string {
    return relativeInRoot(this.requireRoot(), abs);
  }

  private startWatcher(): void {
    const root = this.root;
    if (!root) return;
    this.watcher = new Watcher({
      root,
      debounceMs: 200,
      onPath: (rel) => {
        void this.handlePathEvent(root, rel);
      },
      onAny: () => {
        void this.rescan();
      },
      onError: () => {},
    });
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
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
      const tree = await scanTree(root);
      const signature = JSON.stringify(tree);
      if (!force && signature === this.treeSignature) return false;
      this.tree = tree;
      this.treeSignature = signature;
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
