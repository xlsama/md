import { describe, expect, test } from 'bun:test';
import { extractRemoteImageUrls } from '../src/lib/paste-images.ts';

describe('extractRemoteImageUrls', () => {
  test('finds markdown images and ignores plain links', () => {
    const text = [
      '# Doc',
      '![shot](https://cdn.example/a.png)',
      '[not an image](https://cdn.example/page)',
      '![](https://cdn.example/b.jpg?code=x&y=1)',
    ].join('\n');
    expect(extractRemoteImageUrls(text)).toEqual([
      'https://cdn.example/a.png',
      'https://cdn.example/b.jpg?code=x&y=1',
    ]);
  });

  test('finds html <img> sources too', () => {
    const html = '<p><img alt="x" src="https://cdn.example/c.png" width="10"></p>';
    expect(extractRemoteImageUrls(html)).toEqual(['https://cdn.example/c.png']);
  });

  test('leaves local and relative paths alone', () => {
    const text = ['![](assets/local.png)', '![](/raw/notes/pic.png)', '![](./x.png)'].join('\n');
    expect(extractRemoteImageUrls(text)).toEqual([]);
  });

  test('handles titles, angle brackets and deduplicates', () => {
    const text = [
      '![a](https://cdn.example/t.png "title")',
      '![b](<https://cdn.example/t.png>)',
    ].join('\n');
    expect(extractRemoteImageUrls(text)).toEqual(['https://cdn.example/t.png']);
  });

  test('a Feishu-style signed URL survives intact', () => {
    const url =
      'https://yechtech.feishu.cn/space/api/box/stream/download/asynccode/?code=YzE2NTVm&add_watermark=true&scene_type=CCM';
    expect(extractRemoteImageUrls(`![](${url})`)).toEqual([url]);
  });

  test('caps how many one paste may import', () => {
    const many = Array.from(
      { length: 80 },
      (_, i) => `![](https://cdn.example/${String(i)}.png)`
    ).join('\n');
    expect(extractRemoteImageUrls(many)).toHaveLength(50);
  });
});
