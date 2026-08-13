/**
 * Finds the remote images a piece of pasted Markdown points at.
 *
 * These are the URLs worth importing into the workspace: pasted image links —
 * Feishu, Notion, CDN links with signed tokens — tend to expire out from under
 * the document, so the daemon downloads them once and the document keeps a
 * local path instead. Relative and `/raw/` paths are already local and are
 * left alone.
 */

/** `![alt](url)` — the URL may carry a title and may be wrapped in `<…>`. */
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?(https?:\/\/[^\s<>)"']+)>?(?:\s+["'][^)]*)?\)/gi;
/** Raw `<img src="…">`, which Feishu and browsers also put on the clipboard. */
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi;

/** More than this in one paste is a scrape, not a document. */
const MAX_URLS = 50;

export function extractRemoteImageUrls(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of [MARKDOWN_IMAGE, HTML_IMAGE]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const url = match[1];
      if (url === undefined) continue;
      found.add(url);
      if (found.size >= MAX_URLS) return [...found];
    }
  }
  return [...found];
}
