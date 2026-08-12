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

export const serverMessageSchema = z.discriminatedUnion('type', [
  workspaceMessageSchema,
  treeMessageSchema,
  focusMessageSchema,
  fileMessageSchema,
  savedMessageSchema,
  conflictMessageSchema,
  externalMessageSchema,
  searchResultsMessageSchema,
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

export interface HealthResponse {
  pid: number;
  version: string;
  workspace: string | null;
  clients: number;
  ripgrep: boolean;
}

export interface OpenResponse {
  url: string;
  clients: number;
  root: string;
  focus: string | null;
}

export interface AssetResponse {
  relativePath: string;
  workspacePath: string;
}

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
