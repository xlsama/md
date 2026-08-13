/**
 * Recognises the one shape that gets a rich block rendering: a paragraph whose
 * entire content is a single bare link.
 *
 * The markdown on disk only ever holds the URL — the card, the YouTube player
 * and the tweet are decorations drawn over an ordinary paragraph — so this is
 * the whole of the "parse" side, and it works on plain text rather than on the
 * document tree to stay testable without a browser.
 */

export type LinkBlockSyntax = 'bare' | 'autolink';

export interface LinkBlock {
  /** The URL itself, without the `<>` an autolink wraps it in. */
  url: string;
  syntax: LinkBlockSyntax;
}

/** No whitespace, an explicit scheme, and nothing else on the line. */
const BARE_URL = /^https?:\/\/[^\s<>]+$/i;

/**
 * Classifies a paragraph's text.
 *
 * Returns `null` for everything that is not exactly one link — prose around a
 * URL, a `[label](url)` inline link, two URLs, a scheme-less `www.` host — so
 * inline links keep rendering as inline links.
 */
export function detectLinkBlock(text: string): LinkBlock | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const autolink = trimmed.startsWith('<') && trimmed.endsWith('>');
  const url = autolink ? trimmed.slice(1, -1).trim() : trimmed;
  if (!BARE_URL.test(url)) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.hostname === '') return null;

  return { url, syntax: autolink ? 'autolink' : 'bare' };
}

/** `www.`-stripped hostname, for the minimal card and the favicon caption. */
export function linkDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}
