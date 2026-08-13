import {
  DEFAULT_SETTINGS,
  isAssetsDirName,
  SAVE_DEBOUNCE_MAX,
  SAVE_DEBOUNCE_MIN,
  settingsSchema,
  type Settings,
  type SettingsPatch,
  type Theme,
} from '@xlsama/md/protocol';

/**
 * The daemon is the only owner of the settings, but it is a WebSocket round
 * trip away — and the theme has to be right in the very first painted frame.
 * The last known configuration is therefore mirrored into `localStorage` and
 * used until the real one arrives (milliseconds later, over the same
 * connection that delivers the workspace).
 */
export function readCachedSettings(raw: string | null): Settings {
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    return settingsSchema.parse(typeof parsed === 'object' && parsed !== null ? parsed : {});
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * The settings dialog's own state. Everything the form does not show —
 * `sidebarOpen`, which is UI state written by the sidebar toggle — is
 * deliberately absent, so a change made behind the dialog's back can never
 * make its save button look dirty.
 */
export interface SettingsForm {
  theme: Theme;
  autocorrect: boolean;
  oxfmt: boolean;
  assetsDir: string;
  linkEmbeds: boolean;
  /** Text rather than a number: a half-typed value must not fight the input. */
  saveDebounceMs: string;
}

export function toForm(settings: Settings): SettingsForm {
  return {
    theme: settings.theme,
    autocorrect: settings.format.autocorrect,
    oxfmt: settings.format.oxfmt,
    assetsDir: settings.assetsDir,
    linkEmbeds: settings.linkEmbeds,
    saveDebounceMs: String(settings.saveDebounceMs),
  };
}

export interface FormErrors {
  assetsDir?: string;
  saveDebounceMs?: string;
}

export function formErrors(form: SettingsForm): FormErrors {
  const errors: FormErrors = {};
  if (!isAssetsDirName(form.assetsDir)) errors.assetsDir = '只能是一个目录名，不能包含 / 或 \\';
  const ms = Number(form.saveDebounceMs);
  if (
    form.saveDebounceMs.trim() === '' ||
    !Number.isInteger(ms) ||
    ms < SAVE_DEBOUNCE_MIN ||
    ms > SAVE_DEBOUNCE_MAX
  ) {
    errors.saveDebounceMs = `请填 ${String(SAVE_DEBOUNCE_MIN)}–${String(SAVE_DEBOUNCE_MAX)} 之间的整数`;
  }
  return errors;
}

export function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The part of the form that may be written right now.
 *
 * The dialog saves as you type, so it constantly holds values that are on their
 * way to being valid — an empty folder name mid-retype, a `1` that is going to
 * become `1000`. Those fields fall back to what is already in effect instead of
 * blocking the fields beside them: flipping a switch still lands immediately
 * while a number is half-typed.
 */
export function committableForm(form: SettingsForm, settings: Settings): SettingsForm {
  const errors = formErrors(form);
  if (!hasErrors(errors)) return form;
  const saved = toForm(settings);
  return {
    ...form,
    assetsDir: errors.assetsDir === undefined ? form.assetsDir : saved.assetsDir,
    saveDebounceMs:
      errors.saveDebounceMs === undefined ? form.saveDebounceMs : saved.saveDebounceMs,
  };
}

/** Whether anything the form owns differs from the settings it was opened with. */
export function isFormDirty(form: SettingsForm, settings: Settings): boolean {
  const saved = toForm(settings);
  return (
    form.theme !== saved.theme ||
    form.autocorrect !== saved.autocorrect ||
    form.oxfmt !== saved.oxfmt ||
    form.assetsDir !== saved.assetsDir ||
    form.linkEmbeds !== saved.linkEmbeds ||
    form.saveDebounceMs.trim() !== saved.saveDebounceMs
  );
}

/** The body of the `PUT`. Only valid forms reach this. */
export function formPatch(form: SettingsForm): SettingsPatch {
  return {
    theme: form.theme,
    format: { autocorrect: form.autocorrect, oxfmt: form.oxfmt },
    assetsDir: form.assetsDir,
    linkEmbeds: form.linkEmbeds,
    saveDebounceMs: Number(form.saveDebounceMs),
  };
}
