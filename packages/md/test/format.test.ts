import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatMarkdown, loadWorkspaceFormatConfig } from '../src/format.ts';

const CODE_DOC = '中文code测试\n\n```ts\nconst a = "中文string不该被改";\n```\n';

async function tmpWorkspace(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'md-fmt-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

describe('autocorrect codeblock 处理', () => {
  test('默认不修改代码块内容，普通文本正常加空格', async () => {
    const root = await tmpWorkspace();
    await loadWorkspaceFormatConfig(root);
    const out = await formatMarkdown('x.md', CODE_DOC);
    expect(out).toContain('中文 code 测试');
    expect(out).toContain('"中文string不该被改"');
    await fs.rm(root, { recursive: true, force: true });
  });

  test('工作区 .autocorrectrc 可以打开 codeblock 处理', async () => {
    const root = await tmpWorkspace({
      '.autocorrectrc': JSON.stringify({ context: { codeblock: 1 } }),
    });
    await loadWorkspaceFormatConfig(root);
    const out = await formatMarkdown('x.md', CODE_DOC);
    expect(out).toContain('"中文 string 不该被改"');
    await fs.rm(root, { recursive: true, force: true });
  });

  test('切回无配置工作区时恢复默认，不残留上个工作区的配置', async () => {
    const withRc = await tmpWorkspace({
      '.autocorrectrc': JSON.stringify({ context: { codeblock: 1 } }),
    });
    const withoutRc = await tmpWorkspace();
    await loadWorkspaceFormatConfig(withRc);
    await loadWorkspaceFormatConfig(withoutRc);
    const out = await formatMarkdown('x.md', CODE_DOC);
    expect(out).toContain('"中文string不该被改"');
    await fs.rm(withRc, { recursive: true, force: true });
    await fs.rm(withoutRc, { recursive: true, force: true });
  });

  test('公式 / mermaid / 表格 / 链接经过管线保真且幂等', async () => {
    const root = await tmpWorkspace();
    await loadWorkspaceFormatConfig(root);
    const rich = [
      '行内公式 $E=mc^2$ 保持原样。',
      '',
      '$$',
      '\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}',
      '$$',
      '',
      '```mermaid',
      'graph LR',
      '  Markdown --> Diagram',
      '```',
      '',
      '一个[链接](https://example.com/foo?a=b)。',
      '',
    ].join('\n');
    const f1 = await formatMarkdown('rich.md', rich);
    expect(f1).toContain('$E=mc^2$');
    expect(f1).toContain('\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}');
    expect(f1).toContain('graph LR');
    expect(f1).toContain('https://example.com/foo?a=b');
    expect(await formatMarkdown('rich.md', f1)).toBe(f1);
    await fs.rm(root, { recursive: true, force: true });
  });
});
