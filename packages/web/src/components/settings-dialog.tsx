import type { Theme } from '@xlsama/md/protocol';
import { useEffect, useRef, useState } from 'react';
import { saveSettings } from '../api.ts';
import { IconButton } from './icon-button.tsx';
import {
  committableForm,
  formErrors,
  formPatch,
  isFormDirty,
  toForm,
  type SettingsForm,
} from '../lib/settings.ts';
import { useStore } from '../store.ts';

/**
 * How long a *typed* field waits before it is written.
 *
 * Switches and the theme picker do not wait at all — one click is the whole
 * change. Text and numbers are still being composed while they are being read,
 * so they settle first; short enough that leaving the dialog straight after
 * typing feels like it saved on the last keystroke.
 */
const COMMIT_DEBOUNCE = 400;

type Tab = 'appearance' | 'editor';

const TABS: { id: Tab; label: string }[] = [
  { id: 'appearance', label: '外观' },
  { id: 'editor', label: '编辑器' },
];

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
];

/** A labelled row: the control on the right, the explanation under the title. */
function Field({
  title,
  hint,
  control,
  error,
}: {
  title: string;
  hint: string;
  control: React.ReactNode;
  error?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-[var(--md-muted)]">{hint}</p>
        {error !== undefined && <p className="mt-1 text-xs text-red-500">{error}</p>}
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => {
        onChange(!checked);
      }}
      className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors ${
        checked ? 'bg-[var(--md-accent)]' : 'bg-[var(--md-border)]'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-[var(--md-bg)] p-1 ring-1 ring-[var(--md-border)]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => {
            onChange(option.value);
          }}
          className={`cursor-pointer rounded-md px-2.5 py-1 text-xs transition-colors ${
            option.value === value
              ? 'bg-[var(--md-accent)] font-medium text-white'
              : 'text-[var(--md-muted)] hover:bg-[var(--md-hover)] hover:text-[var(--md-fg)]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const inputClass =
  'w-40 rounded-lg bg-[var(--md-bg)] px-2.5 py-1.5 text-sm ring-1 ring-[var(--md-border)] outline-none focus:ring-[var(--md-accent)]';

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setSettings = useStore((s) => s.setSettings);
  const pushToast = useStore((s) => s.pushToast);

  const [tab, setTab] = useState<Tab>('appearance');
  const [form, setForm] = useState<SettingsForm>(() => toForm(settings));
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The form as it was last typed, while its write is still pending. Non-null
   * is also what marks the form as "being edited right now", which is what keeps
   * a `settings` broadcast from rewriting the field under the cursor.
   */
  const editing = useRef<SettingsForm | null>(null);

  const clearTimer = () => {
    if (commitTimer.current === null) return;
    clearTimeout(commitTimer.current);
    commitTimer.current = null;
  };

  useEffect(() => {
    if (!open) return;
    setForm(toForm(useStore.getState().settings));
    setTab('appearance');
    editing.current = null;
    clearTimer();
  }, [open]);

  // A change made elsewhere — another tab, the sidebar's theme button, the
  // settings file itself — is followed live, since there is no longer a local
  // draft that it could overwrite. Except while one is being typed.
  useEffect(() => {
    if (editing.current !== null) return;
    setForm((current) => (isFormDirty(current, settings) ? toForm(settings) : current));
  }, [settings]);

  // Unmounting with a keystroke still in the timer would lose it; the dialog is
  // only ever closed through `close`, but a reload or a route change is not.
  useEffect(() => clearTimer, []);

  const errors = formErrors(form);

  /**
   * Writes the form. Called on every change, so it stays quiet when there is
   * nothing to say: an unchanged form is not sent, and a successful write shows
   * no toast — the control moving *is* the confirmation.
   */
  const commit = (next: SettingsForm): void => {
    clearTimer();
    editing.current = null;
    const current = useStore.getState().settings;
    const payload = committableForm(next, current);
    if (!isFormDirty(payload, current)) return;
    void saveSettings(formPatch(payload))
      .then((saved) => {
        setSettings(saved);
      })
      .catch((err: unknown) => {
        pushToast(err instanceof Error ? err.message : '设置保存失败', 'error');
        // A refused write leaves the control showing something that is not in
        // effect anywhere, so it goes back to what is.
        setForm(toForm(useStore.getState().settings));
      });
  };

  const close = () => {
    if (editing.current !== null) commit(editing.current);
    setSettingsOpen(false);
  };

  // Re-bound on every render so the handler never closes over a stale draft.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  if (!open) return null;

  /** A switch or a segmented choice: one click is the whole change. */
  const choose = (patch: Partial<SettingsForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    commit(next);
  };

  /** A typed field: written once it stops changing. */
  const edit = (patch: Partial<SettingsForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    editing.current = next;
    clearTimer();
    commitTimer.current = setTimeout(() => {
      commit(next);
    }, COMMIT_DEBOUNCE);
  };

  /**
   * Leaving a field that never became valid. Its half-typed text was never
   * written, so it is dropped for the value that is actually in effect rather
   * than left on screen looking like a setting.
   */
  const settle = () => {
    if (editing.current !== null) commit(editing.current);
    const current = useStore.getState().settings;
    setForm((draft) => committableForm(draft, current));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="md-fade-in relative flex h-[min(31rem,78vh)] w-[min(40rem,92vw)] overflow-hidden rounded-2xl border border-[var(--md-border)] bg-[var(--md-panel)] shadow-xl"
      >
        <div className="flex min-h-0 flex-1">
          <nav
            role="tablist"
            aria-label="设置分类"
            className="flex w-36 shrink-0 flex-col gap-1 border-r border-[var(--md-border)] p-2"
          >
            <div className="flex items-center justify-between gap-1 pt-0.5 pr-0.5 pb-1.5 pl-2.5">
              <p className="text-xs font-medium text-[var(--md-muted)]">设置</p>
              <IconButton icon="x" label="关闭设置" placement="bottom" onClick={close} />
            </div>
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                onClick={() => {
                  setTab(entry.id);
                }}
                className={`cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                  tab === entry.id
                    ? 'bg-[var(--md-hover)] font-medium text-[var(--md-fg)]'
                    : 'text-[var(--md-muted)] hover:bg-[var(--md-hover)] hover:text-[var(--md-fg)]'
                }`}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          <div role="tabpanel" className="min-w-0 flex-1 overflow-y-auto px-5 py-2">
            {tab === 'appearance' ? (
              <Field
                title="主题"
                hint="选择亮色或暗色后不再跟随系统。"
                control={
                  <Segmented
                    value={form.theme}
                    options={THEMES}
                    onChange={(theme) => {
                      choose({ theme });
                    }}
                  />
                }
              />
            ) : (
              <div className="divide-y divide-[var(--md-border)]">
                <Field
                  title="中英文排版"
                  hint="保存时自动在中英文之间插入空格、规范标点。"
                  control={
                    <Switch
                      checked={form.autocorrect}
                      label="中英文排版"
                      onChange={(autocorrect) => {
                        choose({ autocorrect });
                      }}
                    />
                  }
                />
                <Field
                  title="Markdown 排版"
                  hint="保存时统一列表符号、对齐表格、规整换行。"
                  control={
                    <Switch
                      checked={form.oxfmt}
                      label="Markdown 排版"
                      onChange={(oxfmt) => {
                        choose({ oxfmt });
                      }}
                    />
                  }
                />
                <Field
                  title="图片目录名"
                  hint="粘贴的图片存到文档同级的这个目录里。"
                  error={errors.assetsDir}
                  control={
                    <input
                      type="text"
                      value={form.assetsDir}
                      spellCheck={false}
                      aria-label="图片目录名"
                      onChange={(event) => {
                        edit({ assetsDir: event.target.value });
                      }}
                      onBlur={settle}
                      className={inputClass}
                    />
                  }
                />
                <Field
                  title="粘贴时转存图片"
                  hint="粘贴的内容里带网络图片时，自动下载到图片目录并改用本地链接，防止外链过期失效。"
                  control={
                    <Switch
                      checked={form.importPastedImages}
                      label="粘贴时转存图片"
                      onChange={(importPastedImages) => {
                        choose({ importPastedImages });
                      }}
                    />
                  }
                />
                <Field
                  title="链接卡片"
                  hint="独占一段的裸链接渲染成卡片或嵌入；关掉后只是普通链接。"
                  control={
                    <Switch
                      checked={form.linkEmbeds}
                      label="链接卡片"
                      onChange={(linkEmbeds) => {
                        choose({ linkEmbeds });
                      }}
                    />
                  }
                />
                <Field
                  title="自动保存延迟"
                  hint="停止输入多久后写入磁盘，单位毫秒（100–5000）。"
                  error={errors.saveDebounceMs}
                  control={
                    <input
                      type="number"
                      min={100}
                      max={5000}
                      step={100}
                      value={form.saveDebounceMs}
                      aria-label="自动保存延迟"
                      onChange={(event) => {
                        edit({ saveDebounceMs: event.target.value });
                      }}
                      onBlur={settle}
                      className={inputClass}
                    />
                  }
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
