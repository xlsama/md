import { LinkTargetError, assertPublicTarget, normalizeLinkUrl } from './link-meta.ts';

export const ASSET_IMPORT_TIMEOUT_MS = 15_000;
export const ASSET_IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/**
 * Extensions worth trusting, keyed by the MIME type the origin declared.
 * Anything else is refused rather than guessed: this endpoint writes whatever
 * a pasted URL points at into the user's workspace, and «it said it was an
 * image» is the whole contract.
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/tiff': 'tiff',
};

export interface DownloadedImage {
  bytes: Uint8Array;
  /** Extension matching the declared content type, without the dot. */
  extension: string;
}

export interface DownloadImageOptions {
  allowPrivateHosts?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Fetches a remote image for import into the workspace.
 *
 * The transport rules mirror {@link fetchLinkMeta} — only http(s), redirects
 * followed by hand with the private-host guard re-checked on every hop — but
 * the acceptance rules are stricter: the response must declare an image type
 * this module knows an extension for, and the body is read under a byte cap
 * that aborts the transfer instead of trusting `content-length`.
 */
export async function downloadImage(
  raw: string,
  options: DownloadImageOptions = {}
): Promise<DownloadedImage> {
  const timeoutMs = options.timeoutMs ?? ASSET_IMPORT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? ASSET_IMPORT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    let current = normalizeLinkUrl(raw, { allowPrivateHosts: options.allowPrivateHosts });
    let response: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (options.allowPrivateHosts !== true) await assertPublicTarget(current.hostname);
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'image/*,*/*;q=0.5' },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (location === null || location.trim() === '') {
          throw new LinkTargetError('重定向缺少 Location');
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new LinkTargetError('重定向地址无法解析');
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new LinkTargetError('重定向到了不支持的协议');
        }
        current = next;
        continue;
      }
      response = res;
      break;
    }

    if (response === null) throw new LinkTargetError('重定向次数过多');
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${String(response.status)}`);
    }

    const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const extension = IMAGE_EXTENSIONS[mime];
    if (extension === undefined) {
      await response.body?.cancel().catch(() => {});
      throw new Error(mime === '' ? '响应没有声明图片类型' : `不是图片（${mime}）`);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body !== null) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`图片超过 ${String(Math.round(maxBytes / 1024 / 1024))}MB 上限`);
        }
        chunks.push(value);
      }
    }
    if (total === 0) throw new Error('图片内容为空');

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, extension };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('下载超时');
    if (controller.signal.aborted) throw new Error('下载超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
