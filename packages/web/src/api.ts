import {
  assetResponseSchema,
  healthResponseSchema,
  settingsSchema,
  type AssetResponse,
  type HealthResponse,
  type Settings,
  type SettingsPatch,
} from 'mdopen/protocol';
import { z } from 'zod';

/**
 * The daemon's own report on itself, or `null` when it cannot be reached or
 * answers something we do not recognise.
 *
 * The page is served by the daemon it is asking about, so a failure here means
 * something is badly wrong; the only caller treats that the same as "nothing to
 * warn about" rather than raising a second alarm.
 */
export async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return null;
    const parsed = healthResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Writes a partial update. The daemon answers with the merged configuration and
 * broadcasts it, so the caller does not have to apply anything itself — the
 * `settings` message arriving over the WebSocket does that for every page.
 */
export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = z.object({ error: z.string() }).safeParse(payload);
    throw new Error(detail.success ? detail.data.error : `保存失败（HTTP ${String(res.status)}）`);
  }
  const parsed = settingsSchema.safeParse(payload);
  if (!parsed.success) throw new Error('设置接口返回了预期之外的数据');
  return parsed.data;
}

/**
 * Uploads a pasted or dropped file next to the document.
 *
 * The daemon answers with `relativePath` (relative to the document, written
 * into the markdown) and `workspacePath` (relative to the workspace, used for
 * `/raw/` display); `resolveImageUrl` derives the latter from the former, so
 * only `relativePath` is handed back to the editor.
 */
export async function uploadAsset(file: File, docPath: string): Promise<AssetResponse> {
  const body = new FormData();
  body.append('file', file, file.name === '' ? 'pasted.png' : file.name);
  body.append('docPath', docPath);

  const res = await fetch('/api/assets', { method: 'POST', body });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = z.object({ error: z.string() }).safeParse(payload);
    throw new Error(detail.success ? detail.data.error : `上传失败（HTTP ${String(res.status)}）`);
  }
  const parsed = assetResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error('上传接口返回了预期之外的数据');
  return parsed.data;
}
