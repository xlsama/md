import fs from 'node:fs/promises';
import path from 'node:path';
import { format as oxfmt, type FormatConfig } from 'oxfmt';
import { formatFor, loadConfig } from 'autocorrect-node';
import { isMarkdown } from './files.ts';

const AUTOCORRECT_RC = ['.autocorrectrc', '.autocorrectrc.yml', '.autocorrectrc.yaml'];
const OXFMT_RC = ['.oxfmtrc.json'];
// Leave code blocks alone: rewriting a string literal or a comment inside one
// changes what the program does. A workspace `.autocorrectrc` still wins.
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
    // `loadConfig('')` is a no-op rather than a reset, so a complete config has
    // to be passed every time — otherwise the previous workspace's rules linger.
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

export interface FormatOutcome {
  text: string;
  autocorrectApplied: boolean;
  oxfmtApplied: boolean;
  errors: string[];
}

/** Which halves of the pipeline the user left switched on. */
export interface FormatToggles {
  autocorrect: boolean;
  oxfmt: boolean;
}

const BOTH_ON: FormatToggles = { autocorrect: true, oxfmt: true };

export async function formatMarkdownDetailed(
  filePath: string,
  source: string,
  toggles: FormatToggles = BOTH_ON
): Promise<FormatOutcome> {
  if (!isMarkdown(filePath)) {
    return { text: source, autocorrectApplied: false, oxfmtApplied: false, errors: [] };
  }
  const errors: string[] = [];
  let text = source;
  let autocorrectApplied = false;
  if (toggles.autocorrect) {
    try {
      const out = formatFor(text, filePath);
      if (typeof out === 'string') {
        text = out;
        autocorrectApplied = true;
      }
    } catch (err) {
      errors.push(`autocorrect: ${String(err)}`);
    }
  }

  let oxfmtApplied = false;
  if (toggles.oxfmt) {
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
  }

  return { text, autocorrectApplied, oxfmtApplied, errors };
}

export async function formatMarkdown(
  filePath: string,
  source: string,
  toggles?: FormatToggles
): Promise<string> {
  return (await formatMarkdownDetailed(filePath, source, toggles)).text;
}
