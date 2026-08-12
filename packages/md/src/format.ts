import fs from 'node:fs/promises';
import path from 'node:path';
import { format as oxfmt, type FormatConfig } from 'oxfmt';
import { formatFor, loadConfig } from 'autocorrect-node';
import { isMarkdown } from './files.ts';

const AUTOCORRECT_RC = ['.autocorrectrc', '.autocorrectrc.yml', '.autocorrectrc.yaml'];
const OXFMT_RC = ['.oxfmtrc.json'];
// 代码块里的字符串/注释不动：改字面量会改变程序行为。用户的 .autocorrectrc 优先。
const DEFAULT_AUTOCORRECT_CONFIG = JSON.stringify({ context: { codeblock: 0 } });

let oxfmtConfig: FormatConfig | undefined;

async function readFirst(root: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    try {
      return await fs.readFile(path.join(root, name), 'utf8');
    } catch {}
  }
  return null;
}

export async function loadWorkspaceFormatConfig(root: string): Promise<void> {
  const autocorrectRc = await readFirst(root, AUTOCORRECT_RC);
  try {
    // loadConfig('') 是 no-op 而非重置，必须显式传完整配置，否则上个工作区的配置会残留
    loadConfig(autocorrectRc ?? DEFAULT_AUTOCORRECT_CONFIG);
  } catch {
    try {
      loadConfig(DEFAULT_AUTOCORRECT_CONFIG);
    } catch {}
  }

  const oxfmtRc = await readFirst(root, OXFMT_RC);
  oxfmtConfig = undefined;
  if (oxfmtRc) {
    try {
      const parsed: unknown = JSON.parse(oxfmtRc);
      if (parsed && typeof parsed === 'object') oxfmtConfig = parsed as FormatConfig;
    } catch {}
  }
}

export function currentOxfmtConfig(): FormatConfig | undefined {
  return oxfmtConfig;
}

export interface FormatOutcome {
  text: string;
  autocorrectApplied: boolean;
  oxfmtApplied: boolean;
  errors: string[];
}

export async function formatMarkdownDetailed(filePath: string, source: string): Promise<FormatOutcome> {
  if (!isMarkdown(filePath)) {
    return { text: source, autocorrectApplied: false, oxfmtApplied: false, errors: [] };
  }
  const errors: string[] = [];
  let text = source;
  let autocorrectApplied = false;
  try {
    const out = formatFor(text, filePath);
    if (typeof out === 'string') {
      text = out;
      autocorrectApplied = true;
    }
  } catch (err) {
    errors.push(`autocorrect: ${String(err)}`);
  }

  let oxfmtApplied = false;
  try {
    const result = await oxfmt(filePath, text, oxfmtConfig);
    const resultErrors = result.errors ?? [];
    if (resultErrors.length === 0 && typeof result.code === 'string') {
      text = result.code;
      oxfmtApplied = true;
    } else {
      for (const e of resultErrors) errors.push(`oxfmt: ${typeof e === 'string' ? e : JSON.stringify(e)}`);
    }
  } catch (err) {
    errors.push(`oxfmt: ${String(err)}`);
  }

  return { text, autocorrectApplied, oxfmtApplied, errors };
}

export async function formatMarkdown(filePath: string, source: string): Promise<string> {
  return (await formatMarkdownDetailed(filePath, source)).text;
}
