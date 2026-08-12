import { z } from 'zod';

/**
 * `/api/health` also reports ripgrep availability, which the shared
 * `HealthResponse` interface in `mdopen/protocol` does not declare yet.
 */
const healthSchema = z.object({
  pid: z.number(),
  version: z.string(),
  workspace: z.string().nullable(),
  clients: z.number(),
  ripgrep: z.boolean(),
});

const assetSchema = z.object({
  relativePath: z.string(),
  workspacePath: z.string(),
});

export type Health = z.infer<typeof healthSchema>;
export type Asset = z.infer<typeof assetSchema>;

export async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return null;
    const parsed = healthSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Uploads a pasted or dropped file next to the document.
 *
 * The daemon answers with `relativePath` (relative to the document, written
 * into the markdown) and `workspacePath` (relative to the workspace, used for
 * `/raw/` display); `resolveImageUrl` derives the latter from the former, so
 * only `relativePath` is handed back to the editor.
 */
export async function uploadAsset(file: File, docPath: string): Promise<Asset> {
  const body = new FormData();
  body.append('file', file, file.name === '' ? 'pasted.png' : file.name);
  body.append('docPath', docPath);

  const res = await fetch('/api/assets', { method: 'POST', body });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = z.object({ error: z.string() }).safeParse(payload);
    throw new Error(detail.success ? detail.data.error : `上传失败（HTTP ${String(res.status)}）`);
  }
  const parsed = assetSchema.safeParse(payload);
  if (!parsed.success) throw new Error('上传接口返回了预期之外的数据');
  return parsed.data;
}
