import { describe, expect, test } from 'bun:test';
import {
  decodeEntities,
  extractLinkMeta,
  isBlockedHostname,
  isPrivateAddress,
  LinkTargetError,
  normalizeLinkUrl,
} from '../src/link-meta.ts';

describe('address classification', () => {
  test('rejects every address family that points inward', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '127.255.255.254',
      '100.64.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '192.0.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      'fd00::1',
      'fc00::1',
      'fe80::1234',
      'ff02::1',
      '64:ff9b::1.2.3.4',
      '2001:db8::1',
      'not-an-address',
    ]) {
      expect(`${ip}=${String(isPrivateAddress(ip))}`).toBe(`${ip}=true`);
    }
  });

  test('lets the public internet through', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '172.15.0.1', '199.16.0.1', '2606:4700::1111']) {
      expect(`${ip}=${String(isPrivateAddress(ip))}`).toBe(`${ip}=false`);
    }
  });

  test('blocks host names that mean "this machine" without a lookup', () => {
    for (const host of ['localhost', 'LOCALHOST', 'printer.local', 'db.internal', 'x.home.arpa', '[::1]', '127.0.0.1']) {
      expect(`${host}=${String(isBlockedHostname(host))}`).toBe(`${host}=true`);
    }
    for (const host of ['example.com', 'localhost.example.com', 'github.com']) {
      expect(`${host}=${String(isBlockedHostname(host))}`).toBe(`${host}=false`);
    }
  });
});

describe('normalizeLinkUrl', () => {
  test('accepts http(s) and drops the fragment', () => {
    expect(normalizeLinkUrl('https://example.com/a?b=1#frag').toString()).toBe(
      'https://example.com/a?b=1'
    );
  });

  test('refuses other schemes and private targets', () => {
    for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1/', 'nonsense']) {
      expect(() => normalizeLinkUrl(raw)).toThrow(LinkTargetError);
    }
  });

  test('the escape hatch only lifts the address check, never the scheme check', () => {
    expect(normalizeLinkUrl('http://127.0.0.1:8080/x', { allowPrivateHosts: true }).hostname).toBe(
      '127.0.0.1'
    );
    expect(() => normalizeLinkUrl('file:///x', { allowPrivateHosts: true })).toThrow(LinkTargetError);
  });
});

describe('decodeEntities', () => {
  test('handles the references that show up in page metadata', () => {
    expect(decodeEntities('A &amp; B &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x2014; &hellip;')).toBe(
      'A & B <c> "d" \'e\' — …'
    );
  });

  test('leaves anything it does not know alone', () => {
    expect(decodeEntities('&unknownthing; &amp;')).toBe('&unknownthing; &');
  });
});

const at = (html: string) => extractLinkMeta(html, new URL('https://www.example.com/docs/page'));

describe('extractLinkMeta', () => {
  test('prefers open-graph, falls back to twitter, then to the document title', () => {
    expect(at('<title>Doc</title>').title).toBe('Doc');
    expect(at('<title>Doc</title><meta name="twitter:title" content="Tw">').title).toBe('Tw');
    expect(
      at('<title>Doc</title><meta name="twitter:title" content="Tw"><meta property="og:title" content="Og">')
        .title
    ).toBe('Og');
  });

  test('resolves relative image and icon URLs, and strips www from the domain', () => {
    const meta = at('<meta property="og:image" content="../img/a.png"><link rel="icon" href="/i.ico">');
    expect(meta.image).toBe('https://www.example.com/img/a.png');
    expect(meta.favicon).toBe('https://www.example.com/i.ico');
    expect(meta.domain).toBe('example.com');
  });

  test('falls back to the conventional favicon path when the page declares none', () => {
    expect(at('<title>x</title>').favicon).toBe('https://www.example.com/favicon.ico');
  });

  test('ignores an image URL that is not http(s)', () => {
    expect(at('<meta property="og:image" content="javascript:alert(1)">').image).toBeNull();
  });

  test('collapses whitespace and reports nothing rather than empty strings', () => {
    const meta = at('<meta property="og:description" content="  a \n\n b  "><title>   </title>');
    expect(meta.description).toBe('a b');
    expect(meta.title).toBeNull();
  });
});
