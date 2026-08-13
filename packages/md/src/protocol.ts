import { z } from 'zod';

export interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: TreeNode[];
}

export const treeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    kind: z.enum(['file', 'dir']),
    children: z.array(treeNodeSchema).optional(),
  })
);

export const treeSchema = z.array(treeNodeSchema);

export const searchHitSchema = z.object({
  path: z.string(),
  line: z.number().int(),
  column: z.number().int(),
  preview: z.string(),
});

export type SearchHit = z.infer<typeof searchHitSchema>;

export const workspaceMessageSchema = z.object({
  type: z.literal('workspace'),
  root: z.string(),
  focus: z.string().nullable(),
  tree: treeSchema,
});

export const treeMessageSchema = z.object({
  type: z.literal('tree'),
  tree: treeSchema,
});

export const focusMessageSchema = z.object({
  type: z.literal('focus'),
  path: z.string(),
});

export const fileMessageSchema = z.object({
  type: z.literal('file'),
  path: z.string(),
  content: z.string(),
  hash: z.string(),
});

export const savedMessageSchema = z.object({
  type: z.literal('saved'),
  path: z.string(),
  content: z.string(),
  hash: z.string(),
});

export const conflictMessageSchema = z.object({
  type: z.literal('conflict'),
  path: z.string(),
  diskContent: z.string(),
  diskHash: z.string(),
});

export const externalMessageSchema = z.object({
  type: z.literal('external'),
  path: z.string(),
  content: z.string(),
  hash: z.string(),
});

export const searchResultsMessageSchema = z.object({
  type: z.literal('search-results'),
  query: z.string(),
  results: z.array(searchHitSchema),
});

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  op: z.string().optional(),
});

export const themeSchema = z.enum(['system', 'light', 'dark']);
export type Theme = z.infer<typeof themeSchema>;

export const SAVE_DEBOUNCE_MIN = 100;
export const SAVE_DEBOUNCE_MAX = 5000;

/**
 * Whether a string is usable as the per-document image folder: exactly one path
 * segment, so an asset can never be written outside the document's own
 * directory.
 */
export function isAssetsDirName(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  if (value !== value.trim()) return false;
  if (value === '.' || value === '..') return false;
  return !/[/\\\0]/.test(value);
}

/**
 * How wide the file tree may be dragged, in CSS pixels.
 *
 * The floor is where a nested file name stops being readable at all; below it
 * the drag collapses the panel instead of narrowing it further. The ceiling
 * keeps the tree from eating the document on a laptop screen.
 */
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 256;

const assetsDirSchema = z.string().refine(isAssetsDirName, '图片目录名必须是单段合法目录名');
const saveDebounceMsSchema = z.number().int().min(SAVE_DEBOUNCE_MIN).max(SAVE_DEBOUNCE_MAX);
const sidebarWidthSchema = z.number().int().min(SIDEBAR_MIN_WIDTH).max(SIDEBAR_MAX_WIDTH);

/**
 * The settings file as it is *read*: every field falls back to its default, so
 * a hand-edited file that lost a key — or gained a nonsense value — still
 * yields a complete, usable configuration instead of an error.
 *
 * `settingsPatchSchema` below is the strict counterpart used by `PUT`, where a
 * bad value has to be refused rather than quietly replaced.
 */
export const settingsSchema = z.object({
  theme: themeSchema.catch('system'),
  format: z
    .object({
      autocorrect: z.boolean().catch(true),
      oxfmt: z.boolean().catch(true),
    })
    .catch({ autocorrect: true, oxfmt: true }),
  assetsDir: assetsDirSchema.catch('assets'),
  linkEmbeds: z.boolean().catch(true),
  /**
   * Whether pasting Markdown that points at remote images downloads them into
   * `assetsDir` and rewrites the links. On by default because pasted image
   * URLs — Feishu, Notion, CDN links with signed tokens — tend to expire out
   * from under the document.
   */
  importPastedImages: z.boolean().catch(true),
  saveDebounceMs: saveDebounceMsSchema.catch(500),
  /**
   * UI state rather than a preference, but it lives here so the sidebar is in
   * the same shape on the next launch. Deliberately absent from the settings
   * dialog.
   */
  sidebarOpen: z.boolean().catch(false),
  /** UI state as well: where the reader last left the tree's edge. */
  sidebarWidth: sidebarWidthSchema.catch(SIDEBAR_DEFAULT_WIDTH),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

/** A partial update: only the fields present are changed. */
export const settingsPatchSchema = z.object({
  theme: themeSchema.optional(),
  format: z
    .object({
      autocorrect: z.boolean().optional(),
      oxfmt: z.boolean().optional(),
    })
    .optional(),
  assetsDir: assetsDirSchema.optional(),
  linkEmbeds: z.boolean().optional(),
  importPastedImages: z.boolean().optional(),
  saveDebounceMs: saveDebounceMsSchema.optional(),
  sidebarOpen: z.boolean().optional(),
  sidebarWidth: sidebarWidthSchema.optional(),
});

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const settingsMessageSchema = z.object({
  type: z.literal('settings'),
  settings: settingsSchema,
});

export const serverMessageSchema = z.discriminatedUnion('type', [
  workspaceMessageSchema,
  treeMessageSchema,
  focusMessageSchema,
  fileMessageSchema,
  savedMessageSchema,
  conflictMessageSchema,
  externalMessageSchema,
  searchResultsMessageSchema,
  settingsMessageSchema,
  errorMessageSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServerMessageType = ServerMessage['type'];
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;

export const openMessageSchema = z.object({
  type: z.literal('open'),
  path: z.string(),
});

export const saveMessageSchema = z.object({
  type: z.literal('save'),
  path: z.string(),
  content: z.string(),
  baseHash: z.string(),
});

export const forceSaveMessageSchema = z.object({
  type: z.literal('force-save'),
  path: z.string(),
  content: z.string(),
});

export const createMessageSchema = z.object({
  type: z.literal('create'),
  path: z.string(),
  kind: z.enum(['file', 'dir']),
});

export const renameMessageSchema = z.object({
  type: z.literal('rename'),
  from: z.string(),
  to: z.string(),
});

export const deleteMessageSchema = z.object({
  type: z.literal('delete'),
  path: z.string(),
});

export const searchMessageSchema = z.object({
  type: z.literal('search'),
  query: z.string(),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  openMessageSchema,
  saveMessageSchema,
  forceSaveMessageSchema,
  createMessageSchema,
  renameMessageSchema,
  deleteMessageSchema,
  searchMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>;

export const openRequestSchema = z.object({ path: z.string() });
export type OpenRequest = z.infer<typeof openRequestSchema>;

export const linkMetaQuerySchema = z.object({ url: z.string().min(1) });
export type LinkMetaQuery = z.infer<typeof linkMetaQuerySchema>;

/** Everything a link card renders, all of it optional except the identity. */
export const linkMetaSchema = z.object({
  /** Final URL after redirects — what the card actually describes. */
  url: z.string(),
  /** `www.`-stripped hostname, shown next to the favicon. */
  domain: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  favicon: z.string().nullable(),
  siteName: z.string().nullable(),
});

export type LinkMeta = z.infer<typeof linkMetaSchema>;

/**
 * `GET /api/link-meta` answers 200 either way: a page we could not read is a
 * normal outcome that renders the minimal card, not a request-level error.
 * Only a URL we refuse to fetch at all (bad scheme, private host) is a 400.
 */
export const linkMetaResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), meta: linkMetaSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type LinkMetaResponse = z.infer<typeof linkMetaResponseSchema>;

/**
 * `GET /api/health`. Beyond liveness it reports the two capabilities that can
 * be missing at runtime — ripgrep on `PATH`, and a live filesystem watcher —
 * so the CLI and the browser can both say what is degraded rather than
 * behaving oddly.
 */
export const healthResponseSchema = z.object({
  pid: z.number(),
  version: z.string(),
  workspace: z.string().nullable(),
  clients: z.number(),
  /**
   * Both capabilities default rather than failing the parse: `md` upgrades
   * itself by asking an older daemon for its version, and a schema that refused
   * a response predating these fields would read that daemon as "not running"
   * and try to start a second one on the same port.
   */
  ripgrep: z.boolean().catch(false),
  watching: z.boolean().catch(false),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const openResponseSchema = z.object({
  url: z.string(),
  clients: z.number(),
  root: z.string(),
  focus: z.string().nullable(),
});

export type OpenResponse = z.infer<typeof openResponseSchema>;

/**
 * `POST /api/assets`. `relativePath` is relative to the document (what goes
 * into the markdown); `workspacePath` is relative to the workspace root (what
 * `/raw/` serves).
 */
export const assetResponseSchema = z.object({
  relativePath: z.string(),
  workspacePath: z.string(),
});

export type AssetResponse = z.infer<typeof assetResponseSchema>;

/**
 * `POST /api/assets/import`: download `url` into the assets directory beside
 * `docPath`. Answers with the same shape as `POST /api/assets`.
 */
export const assetImportRequestSchema = z.object({
  url: z.string().min(1),
  docPath: z.string(),
});

export type AssetImportRequest = z.infer<typeof assetImportRequestSchema>;

export function parseClientMessage(raw: string): { ok: true; value: ClientMessage } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { ok: true, value: parsed.data };
}
