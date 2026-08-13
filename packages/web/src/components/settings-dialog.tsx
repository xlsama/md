import type { Theme } from '@xlsama/md/protocol';
import { useEffect, useState } from 'react';
import { saveSettings } from '../api.ts';
import {
  formErrors,
  formPatch,
  hasErrors,
  isFormDirty,
  toForm,
  type SettingsForm,
} from '../lib/settings.ts';
import { useStore } from '../store.ts';

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
  const [saving, setSaving] = useState(false);
  /** Raised by a close attempt that would throw work away. */
  const [confirming, setConfirming] = useState(false);

  // The form is a snapshot taken when the dialog opens: a `settings` broadcast
  // arriving while it is open (another tab, the theme toggle) must not reach in
  // and rewrite what the user is editing.
  useEffect(() => {
    if (!open) return;
    setForm(toForm(useStore.getState().settings));
    setTab('appearance');
    setConfirming(false);
  }, [open]);

  const dirty = isFormDirty(form, settings);
  const errors = formErrors(form);
  const canSave = dirty && !hasErrors(errors) && !saving;

  const requestClose = () => {
    if (dirty) {
      setConfirming(true);
      return;
    }
    setSettingsOpen(false);
  };

  // Deliberately re-bound on every render: the handler closes over `dirty` and
  // `confirming`, and a stale copy of either would dismiss unsaved work.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (confirming) {
        setConfirming(false);
        return;
      }
      requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  if (!open) return null;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const next = await saveSettings(formPatch(form));
      // The daemon broadcasts this too; applying it here as well is what makes
      // the button fall back to disabled the instant the write lands.
      setSettings(next);
      setForm(toForm(next));
      pushToast('设置已保存');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '设置保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const update = (patch: Partial<SettingsForm>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        className="md-fade-in relative flex h-[min(31rem,78vh)] w-[min(40rem,92vw)] flex-col overflow-hidden rounded-2xl border border-[var(--md-border)] bg-[var(--md-panel)] shadow-xl"
      >
        <div className="flex min-h-0 flex-1">
          <nav
            role="tablist"
            aria-label="设置分类"
            className="flex w-36 shrink-0 flex-col gap-1 border-r border-[var(--md-border)] p-2"
          >
            <p className="px-2.5 pt-1 pb-2 text-xs font-medium text-[var(--md-muted)]">设置</p>
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
                      update({ theme });
                    }}
                  />
                }
              />
            ) : (
              <div className="divide-y divide-[var(--md-border)]">
                <Field
                  title="autocorrect"
                  hint="保存时自动在中英文之间插入空格、规范标点。"
                  control={
                    <Switch
                      checked={form.autocorrect}
                      label="autocorrect"
                      onChange={(autocorrect) => {
                        update({ autocorrect });
                      }}
                    />
                  }
                />
                <Field
                  title="oxfmt"
                  hint="保存时排版 Markdown：列表符号、表格对齐、换行。"
                  control={
                    <Switch
                      checked={form.oxfmt}
                      label="oxfmt"
                      onChange={(oxfmt) => {
                        update({ oxfmt });
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
                        update({ assetsDir: event.target.value });
                      }}
                      className={inputClass}
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
                        update({ linkEmbeds });
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
                        update({ saveDebounceMs: event.target.value });
                      }}
                      className={inputClass}
                    />
                  }
                />
              </div>
            )}
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--md-border)] px-4 py-3">
          <button
            type="button"
            onClick={requestClose}
            className="cursor-pointer rounded-lg px-3 py-1.5 text-xs ring-1 ring-[var(--md-border)] transition-colors hover:bg-[var(--md-hover)]"
          >
            关闭
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => {
              void save();
            }}
            className="cursor-pointer rounded-lg bg-[var(--md-accent)] px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>

        {confirming && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30">
            <div className="md-fade-in w-[min(20rem,84%)] rounded-xl border border-[var(--md-menu-border)] bg-[var(--md-menu-bg)] p-4 shadow-xl">
              <h2 className="text-sm font-medium">还有未保存的更改</h2>
              <p className="mt-1 text-xs text-[var(--md-muted)]">关闭会丢弃这些更改。</p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                  }}
                  className="cursor-pointer rounded-lg px-3 py-1.5 text-xs ring-1 ring-[var(--md-border)] transition-colors hover:bg-[var(--md-hover)]"
                >
                  继续编辑
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    setSettingsOpen(false);
                  }}
                  className="cursor-pointer rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                >
                  放弃更改
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
