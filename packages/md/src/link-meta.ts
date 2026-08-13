import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './state.ts';
import type { LinkMeta, LinkMetaResponse } from './protocol.ts';

export const LINK_META_TIMEOUT_MS = 5000;
export const LINK_META_MAX_BYTES = 512 * 1024;
export const LINK_META_MAX_REDIRECTS = 5;
export const LINK_META_SUCCESS_TTL = 7 * 24 * 60 * 60 * 1000;
export const LINK_META_FAILURE_TTL = 10 * 60 * 1000;

const MEMORY_LIMIT = 512;
const TITLE_LIMIT = 300;
const DESCRIPTION_LIMIT = 600;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 writedown-link-preview';

/** A URL we refuse to fetch at all — bad scheme, or a host that names the machine itself. */
export class LinkTargetError extends Error {}

// ------------------------------------------------------------------- SSRF --

/** Hosts that resolve to the machine itself (or its network) by name alone. */
const BLOCKED_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function parseIpv4(ip: string): number[] | null {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').map((part) => Number.parseInt(part, 10));
}

/** Expands any IPv6 spelling (including `::ffff:1.2.3.4`) into its 16 bytes. */
function parseIpv6(ip: string): number[] | null {
  const bare = ip.split('%')[0] ?? '';
  if (!net.isIPv6(bare)) return null;

  let text = bare;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    const hi = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const lo = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  const rest = halves[1];
  let groups: string[];
  if (rest === undefined) {
    groups = head;
  } else {
    const tailGroups = rest === '' ? [] : rest.split(':');
    const missing = 8 - head.length - tailGroups.length;
    if (missing < 0) return null;
    groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null;
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

function isPrivateV4(bytes: number[]): boolean {
  const a = bytes[0] ?? 0;
  const b = bytes[1] ?? 0;
  const c = bytes[2] ?? 0;
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol / TEST-NET-1
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateV6(bytes: number[]): boolean {
  const leadingZeros = bytes.slice(0, 10).every((byte) => byte === 0);
  if (leadingZeros) {
    // `::ffff:a.b.c.d` is an IPv4 address wearing a costume; `::1`/`::` and the
    // deprecated `::a.b.c.d` form are never worth reaching out to.
    if (bytes[10] === 0xff && bytes[11] === 0xff) return isPrivateV4(bytes.slice(12));
    return true;
  }
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b0 === 0xff) return true; // multicast
  if (b0 === 0x00 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return true; // NAT64
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // Teredo
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // documentation
  return false;
}

/**
 * Whether an IP literal points somewhere we must never let a document reach.
 *
 * Anything that does not parse as an address is treated as unsafe: this only
 * ever runs on strings we already believe to be addresses, so a parse failure
 * means we do not understand the target well enough to allow it.
 */
export function isPrivateAddress(ip: string): boolean {
  const bare = stripBrackets(ip.trim());
  const v4 = parseIpv4(bare);
  if (v4 !== null) return isPrivateV4(v4);
  const v6 = parseIpv6(bare);
  if (v6 !== null) return isPrivateV6(v6);
  return true;
}

/** Literal check: names and IP literals that are unsafe without touching DNS. */
export function isBlockedHostname(hostname: string): boolean {
  const host = stripBrackets(hostname.trim().toLowerCase()).replace(/\.$/, '');
  if (host === '') return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (net.isIP(host) !== 0) return isPrivateAddress(host);
  return false;
}

/**
 * Normalises a caller-supplied URL and rejects the ones we will not fetch.
 *
 * Only the two layers that need no I/O happen here (scheme + literal host), so
 * the daemon can answer an obviously bad request with a 400 without spending a
 * DNS round trip on it. The address-level check runs later, per redirect hop.
 */
export function normalizeLinkUrl(raw: string, options: { allowPrivateHosts?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LinkTargetError('URL 无法解析');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LinkTargetError('只支持 http/https 链接');
  }
  if (options.allowPrivateHosts !== true && isBlockedHostname(url.hostname)) {
    throw new LinkTargetError('拒绝抓取本机或内网地址');
  }
  url.hash = '';
  return url;
}

/**
 * Resolves a hostname and rejects it when *any* answer is private.
 *
 * This is the second half of the SSRF defence: the literal check above cannot
 * see through a name, and Bun's `fetch` gives us no hook on the socket it ends
 * up connecting to. Pre-resolving does not fully close the DNS-rebinding window
 * — the runtime resolves again for the actual connection — but a name that
 * *ever* answers with a private address never gets fetched, which is what
 * rebinding attacks rely on.
 */
export async function assertPublicTarget(hostname: string): Promise<void> {
  if (isBlockedHostname(hostname)) throw new LinkTargetError('拒绝抓取本机或内网地址');
  const host = stripBrackets(hostname);
  if (net.isIP(host) !== 0) return;

  const records = await lookup(host, { all: true, verbatim: true }).catch(() => null);
  if (records === null || records.length === 0) throw new LinkTargetError('域名无法解析');
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new LinkTargetError('域名解析到了内网地址');
  }
}

// ------------------------------------------------------------------- parse --

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
};

/**
 * Decodes the entities that survive `HTMLRewriter`.
 *
 * lol-html hands back attribute values and text chunks exactly as they were
 * written, so `&amp;` in an `og:description` would otherwise reach the card
 * verbatim. Only the handful of references that actually show up in page
 * metadata are supported; anything else is left alone rather than guessed at.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref.startsWith('#x') || ref.startsWith('#X')
        ? Number.parseInt(ref.slice(2), 16)
        : Number.parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

function cleanText(raw: string | null, limit: number): string | null {
  if (raw === null) return null;
  const text = decodeEntities(raw).replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function absoluteUrl(raw: string | null, base: URL): string | null {
  if (raw === null) return null;
  const value = decodeEntities(raw).trim();
  if (value === '') return null;
  try {
    const resolved = new URL(value, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

interface IconCandidate {
  rel: string;
  href: string;
}

function iconRank(rel: string): number {
  const tokens = rel.split(/\s+/);
  if (tokens.includes('icon') && !tokens.includes('apple-touch-icon')) return 0;
  if (tokens.includes('shortcut')) return 1;
  if (tokens.includes('apple-touch-icon') || tokens.includes('apple-touch-icon-precomposed')) return 2;
  return 3;
}

/** `rel="icon"` beats the Apple/mask variants, which are often monochrome or huge. */
function bestIcon(candidates: IconCandidate[]): string | null {
  let best: IconCandidate | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const value = iconRank(candidate.rel);
    if (value < bestRank) {
      best = candidate;
      bestRank = value;
    }
  }
  return best?.href ?? null;
}

function charsetOf(contentType: string): string {
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  const label = match?.[1]?.toLowerCase();
  if (label === undefined || label === '') return 'utf-8';
  try {
    // Constructing one is the only way to ask whether the label is supported.
    const probe = new TextDecoder(label);
    return probe.encoding;
  } catch {
    return 'utf-8';
  }
}

/**
 * Pulls a response body chunk by chunk and hangs up early.
 *
 * Everything a card needs lives in `<head>`, so reading stops at the first
 * `</head>` and, failing that, at `limit` bytes — cancelling the reader closes
 * the connection instead of quietly draining the rest of the document. The
 * bytes are buffered rather than piped straight into `HTMLRewriter` because
 * Bun's rewriter only transforms an already-materialised body; a streaming
 * `Response` makes `transform()` fail with "Failed to pipe stream".
 */
async function readCappedHtml(response: Response, limit: number): Promise<string> {
  const body = response.body;
  const decoder = new TextDecoder(charsetOf(response.headers.get('content-type') ?? ''), {
    fatal: false,
  });
  if (body === null) return '';

  const reader = body.getReader();
  let html = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      const remaining = limit - total;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      total += slice.byteLength;
      html += decoder.decode(slice, { stream: true });
      if (total >= limit || /<\/head\s*>/i.test(html)) break;
    }
  } finally {
    html += decoder.decode();
    await reader.cancel().catch(() => {});
  }
  return html;
}

function displayDomain(url: URL): string {
  return url.hostname.replace(/^www\./i, '');
}

/** Runs the fetched `<head>` through `HTMLRewriter`, keeping only what a card renders. */
export function extractLinkMeta(html: string, finalUrl: URL): LinkMeta {
  const metas = new Map<string, string>();
  const icons: IconCandidate[] = [];
  let baseHref: string | null = null;
  let title = '';
  let titleDone = false;

  const rewriter = new HTMLRewriter()
    .on('base', {
      element(el) {
        const href = el.getAttribute('href');
        if (href !== null && baseHref === null) baseHref = href;
      },
    })
    .on('meta', {
      element(el) {
        const key = (el.getAttribute('property') ?? el.getAttribute('name') ?? '').trim().toLowerCase();
        const content = el.getAttribute('content');
        if (key === '' || content === null) return;
        // First declaration wins, matching how crawlers read duplicated tags.
        if (!metas.has(key)) metas.set(key, content);
      },
    })
    .on('title', {
      text(chunk) {
        if (titleDone) return;
        title += chunk.text;
        if (chunk.lastInTextNode) titleDone = true;
      },
    })
    .on('link', {
      element(el) {
        const rel = (el.getAttribute('rel') ?? '').trim().toLowerCase();
        const href = el.getAttribute('href');
        if (rel === '' || href === null) return;
        const tokens = rel.split(/\s+/);
        const wanted = ['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon'];
        if (!tokens.some((token) => wanted.includes(token))) return;
        icons.push({ rel, href });
      },
    });

  rewriter.transform(html);

  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = metas.get(key);
      if (value !== undefined && value.trim() !== '') return value;
    }
    return null;
  };

  const base = (baseHref === null ? null : absoluteUrl(baseHref, finalUrl)) ?? finalUrl.toString();
  const baseUrl = new URL(base);

  return {
    url: finalUrl.toString(),
    domain: displayDomain(finalUrl),
    title: cleanText(pick('og:title', 'twitter:title') ?? (title === '' ? null : title), TITLE_LIMIT),
    description: cleanText(
      pick('og:description', 'twitter:description', 'description'),
      DESCRIPTION_LIMIT
    ),
    image: absoluteUrl(
      pick('og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'),
      baseUrl
    ),
    favicon: absoluteUrl(bestIcon(icons), baseUrl) ?? `${finalUrl.origin}/favicon.ico`,
    siteName: cleanText(pick('og:site_name', 'application-name'), TITLE_LIMIT),
  };
}

// ------------------------------------------------------------------- fetch --

export interface FetchLinkMetaOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  /** Test-only: lets the fetcher reach 127.0.0.1 so a mock server can stand in. */
  allowPrivateHosts?: boolean;
}

function failure(error: string): LinkMetaResponse {
  return { ok: false, error };
}

/**
 * Fetches one URL's card metadata.
 *
 * Redirects are followed by hand (`redirect: 'manual'`) so every hop goes back
 * through the address check — an allowed page that 302s to `169.254.169.254`
 * would otherwise walk straight past the guard on the original URL.
 */
export async function fetchLinkMeta(
  raw: string,
  options: FetchLinkMetaOptions = {}
): Promise<LinkMetaResponse> {
  const timeoutMs = options.timeoutMs ?? LINK_META_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? LINK_META_MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    let current = normalizeLinkUrl(raw, { allowPrivateHosts: options.allowPrivateHosts });
    let response: Response | null = null;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (options.allowPrivateHosts !== true) await assertPublicTarget(current.hostname);
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'user-agent': USER_AGENT,
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (location === null || location.trim() === '') return failure('重定向缺少 Location');
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return failure('重定向地址无法解析');
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return failure('重定向到了不支持的协议');
        }
        current = next;
        continue;
      }
      response = res;
      break;
    }

    if (response === null) return failure('重定向次数过多');
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return failure(`HTTP ${String(response.status)}`);
    }

    const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (mime !== 'text/html' && mime !== 'application/xhtml+xml') {
      await response.body?.cancel().catch(() => {});
      return failure(mime === '' ? '响应没有声明 HTML 类型' : `不是 HTML 页面（${mime}）`);
    }

    const html = await readCappedHtml(response, LINK_META_MAX_BYTES);
    const finalUrl = new URL(response.url === '' ? current.toString() : response.url);
    return { ok: true, meta: extractLinkMeta(html, finalUrl) };
  } catch (err) {
    if (err instanceof LinkTargetError) return failure(err.message);
    if (err instanceof Error && err.name === 'AbortError') return failure('抓取超时');
    if (controller.signal.aborted) return failure('抓取超时');
    return failure(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- cache --

interface CacheRecord {
  url: string;
  expiresAt: number;
  response: LinkMetaResponse;
}

export interface LinkMetaCacheOptions {
  /** Directory holding the JSON shards; defaults to `<state>/link-meta`. */
  dir?: string;
  fetcher?: (url: string) => Promise<LinkMetaResponse>;
  now?: () => number;
  successTtlMs?: number;
  failureTtlMs?: number;
  /** Test-only: lets the daemon reach 127.0.0.1 so a mock server can stand in. */
  allowPrivateHosts?: boolean;
}

function cacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function isCacheRecord(value: unknown): value is CacheRecord {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<CacheRecord>;
  if (typeof record.expiresAt !== 'number' || typeof record.url !== 'string') return false;
  const response = record.response;
  if (response === null || typeof response !== 'object') return false;
  return typeof (response as { ok?: unknown }).ok === 'boolean';
}

/**
 * Two-level cache in front of {@link fetchLinkMeta}.
 *
 * Memory answers the common case (the same card re-rendered as the document
 * reparses); the disk shard survives a daemon restart, which matters because a
 * cold cache means every card in a link-heavy note re-fetches at once. In-flight
 * requests are shared, so a document with the same URL twice makes one request.
 */
export class LinkMetaCache {
  private readonly memory = new Map<string, CacheRecord>();
  private readonly inflight = new Map<string, Promise<LinkMetaResponse>>();
  private readonly dir: string;
  private readonly fetcher: (url: string) => Promise<LinkMetaResponse>;
  private readonly now: () => number;
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;
  readonly allowPrivateHosts: boolean;

  constructor(options: LinkMetaCacheOptions = {}) {
    this.dir = options.dir ?? path.join(stateDir(), 'link-meta');
    this.allowPrivateHosts = options.allowPrivateHosts === true;
    const allowPrivateHosts = this.allowPrivateHosts;
    this.fetcher = options.fetcher ?? ((url) => fetchLinkMeta(url, { allowPrivateHosts }));
    this.now = options.now ?? (() => Date.now());
    this.successTtlMs = options.successTtlMs ?? LINK_META_SUCCESS_TTL;
    this.failureTtlMs = options.failureTtlMs ?? LINK_META_FAILURE_TTL;
  }

  async get(url: string): Promise<LinkMetaResponse> {
    const key = cacheKey(url);
    const fresh = this.memory.get(key);
    if (fresh !== undefined && fresh.expiresAt > this.now()) return fresh.response;

    const stored = await this.readDisk(key);
    if (stored !== null) {
      if (stored.expiresAt > this.now()) {
        this.remember(key, stored);
        return stored.response;
      }
      // The shard is stale and about to be replaced; drop it now so a URL that
      // is never asked for again does not leave its file behind forever.
      await this.deleteDisk(key);
    }

    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;

    const task = this.fetcher(url)
      .catch((err: unknown) => failure(err instanceof Error ? err.message : String(err)))
      .then(async (response) => {
        const ttl = response.ok ? this.successTtlMs : this.failureTtlMs;
        const record: CacheRecord = { url, expiresAt: this.now() + ttl, response };
        this.remember(key, record);
        await this.writeDisk(key, record);
        return response;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, task);
    return task;
  }

  private remember(key: string, record: CacheRecord): void {
    this.memory.delete(key);
    this.memory.set(key, record);
    if (this.memory.size <= MEMORY_LIMIT) return;
    const oldest = this.memory.keys().next();
    if (oldest.done !== true) this.memory.delete(oldest.value);
  }

  private shardPath(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  private async readDisk(key: string): Promise<CacheRecord | null> {
    try {
      const raw = await fs.readFile(this.shardPath(key), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isCacheRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeDisk(key: string, record: CacheRecord): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.shardPath(key), `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // A cache that cannot be written is still a working cache in memory.
    }
  }

  private async deleteDisk(key: string): Promise<void> {
    await fs.rm(this.shardPath(key), { force: true }).catch(() => {});
  }

  /**
   * Deletes every expired shard. Called once at daemon start: without it the
   * only thing that removes a shard is asking for the same URL again, so a
   * directory full of links visited once would never shrink.
   *
   * Unreadable and unparseable shards are removed too — nothing else will.
   */
  async sweepExpired(): Promise<number> {
    const names = await fs.readdir(this.dir).catch(() => null);
    if (names === null) return 0;
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -'.json'.length);
      const record = await this.readDisk(key);
      if (record !== null && record.expiresAt > this.now()) continue;
      await this.deleteDisk(key);
      removed += 1;
    }
    return removed;
  }
}
