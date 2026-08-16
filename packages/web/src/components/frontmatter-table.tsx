import { useEditor } from '@meowdown/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  addField,
  displayValue,
  isFreeKey,
  parseInput,
  readAttr,
  readFrontmatter,
  removeField,
  renameField,
  setField,
  setListField,
  writeAttr,
  type FrontmatterField,
} from '../lib/frontmatter.ts';
import { useStore } from '../store.ts';
import { Icon } from './icon.tsx';

/**
 * The document's YAML frontmatter, shown as a property table above the text.
 *
 * The block lives on the `doc` node as one verbatim string — meowdown peels it
 * off on parse and writes it back on serialize, and never renders it — so this
 * table is the only place it can be read or edited. Every edit dispatches a
 * `setDocAttribute` transaction, which is an ordinary undoable step: it lands
 * in the history and trips `onDocChange`, so the autosave pipeline persists it
 * exactly like a change to the prose.
 *
 * Rendered as a child of `MeowdownEditor` so it can reach the editor through
 * ProseKit's context, and pulled above the text with `order: -1` — the wrapper
 * is a flex column, and `children` are appended after the editor element.
 */
export function FrontmatterTable() {
  const editor = useEditor({ update: true });
  const readOnly = useStore((s) => s.readOnly);
  const body = readAttr(editor);

  if (body === null) return null;

  const write = (next: string): void => {
    writeAttr(editor, next);
  };

  const drop = (): void => {
    writeAttr(editor, null);
  };

  const { fields, unsupported } = readFrontmatter(body);

  // An empty block has nothing else in it, so its controls cannot wait for a
  // hover to announce themselves — there would be nothing on screen to hover.
  return (
    <div className={fields.length === 0 ? 'md-frontmatter md-frontmatter-bare' : 'md-frontmatter'}>
      {unsupported ? (
        <div className="rounded-lg border border-[var(--md-border)] px-3 py-2">
          <p className="pb-1.5 text-[var(--md-muted)]">
            这段 frontmatter 不是键值映射，为避免改坏内容只做展示。
          </p>
          <pre className="overflow-x-auto font-mono text-[0.75rem] whitespace-pre">{body}</pre>
        </div>
      ) : (
        <>
          {fields.map((field) => (
            <Row
              key={field.key}
              field={field}
              readOnly={readOnly}
              onWrite={write}
              body={body}
            />
          ))}
          {!readOnly && (
            <AddRow
              body={body}
              onWrite={write}
              onDropBlock={fields.length === 0 ? drop : undefined}
            />
          )}
        </>
      )}
    </div>
  );
}

function Row({
  field,
  body,
  readOnly,
  onWrite,
}: {
  field: FrontmatterField;
  body: string;
  readOnly: boolean;
  onWrite: (next: string) => void;
}) {
  return (
    <div className="md-frontmatter-row group">
      <KeyCell
        name={field.key}
        readOnly={readOnly}
        onRename={(to) => {
          onWrite(renameField(body, field.key, to));
        }}
        taken={(name) => !isFreeKey(body, name)}
      />

      <div className="min-w-0 flex-1">
        {field.kind === 'text' && (
          <TextValue
            value={field.value}
            readOnly={readOnly}
            onChange={(text) => {
              onWrite(setField(body, field.key, text));
            }}
          />
        )}
        {field.kind === 'list' && (
          <ListValue
            items={field.items}
            readOnly={readOnly}
            onChange={(items) => {
              onWrite(setListField(body, field.key, items));
            }}
          />
        )}
        {field.kind === 'raw' && (
          <pre className="overflow-x-auto py-1 font-mono text-[0.75rem] text-[var(--md-muted)] whitespace-pre">
            {field.source}
          </pre>
        )}
      </div>

      {!readOnly && (
        <button
          type="button"
          aria-label={`删除属性 ${field.key}`}
          onClick={() => {
            onWrite(removeField(body, field.key));
          }}
          className="md-frontmatter-drop"
        >
          <Icon name="x" className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * The property name. Unlike a value, it is committed on Enter or blur rather
 * than on every keystroke: a half-typed name is a different property, and
 * renaming through every prefix of it would both churn the file and collide
 * with the name being replaced.
 */
function KeyCell({
  name,
  readOnly,
  taken,
  onRename,
}: {
  name: string;
  readOnly: boolean;
  taken: (name: string) => boolean;
  onRename: (to: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    setDraft(name);
  }, [name]);

  const commit = (): void => {
    const next = draft.trim();
    if (next === name) return;
    if (next === '' || taken(next)) {
      setDraft(name);
      return;
    }
    onRename(next);
  };

  return (
    <input
      value={draft}
      readOnly={readOnly}
      spellCheck={false}
      aria-label="属性名"
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (submitted(event)) event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(name);
          event.currentTarget.blur();
        }
      }}
      className="md-frontmatter-key"
    />
  );
}

/**
 * A scalar value, written through on every keystroke so the autosave debounce
 * is the only thing between typing and the file.
 *
 * The input keeps its own draft rather than reading the document back: a value
 * makes a round trip through YAML, and `042` coming back as `42` mid-word would
 * rewrite the text under the caret. `echo` is what the draft is expected to
 * look like once it has made that trip, so a document change that is not our
 * own — an undo, a switch to another file — still resets the field.
 */
function TextValue({
  value,
  readOnly,
  onChange,
}: {
  value: string;
  readOnly: boolean;
  onChange: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const echo = useRef<string | null>(null);

  useEffect(() => {
    if (echo.current === value) return;
    echo.current = null;
    setDraft(value);
  }, [value]);

  const edit = (text: string): void => {
    setDraft(text);
    echo.current = displayValue(parseInput(text));
    onChange(text);
  };

  const shared = {
    value: draft,
    readOnly,
    spellCheck: false,
    'aria-label': '属性值',
    onChange: (event: { target: { value: string } }) => {
      edit(event.target.value);
    },
    className: 'md-frontmatter-value',
  };

  return draft.includes('\n') ? (
    <textarea {...shared} rows={Math.min(8, draft.split('\n').length)} />
  ) : (
    <input {...shared} />
  );
}

/**
 * A sequence of scalars, as one chip per item. Items commit on blur so an
 * emptied chip can still be typed into before it is dropped as blank.
 */
function ListValue({
  items,
  readOnly,
  onChange,
}: {
  items: string[];
  readOnly: boolean;
  onChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState<string[] | null>(null);
  const shown = draft ?? items;

  const commit = (next: string[]): void => {
    setDraft(null);
    if (next.length === items.length && next.every((item, i) => item === items[i])) return;
    onChange(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-1 py-0.5">
      {shown.map((item, index) => (
        <span key={index} className="md-frontmatter-chip">
          <input
            value={item}
            readOnly={readOnly}
            spellCheck={false}
            aria-label={`第 ${String(index + 1)} 项`}
            autoFocus={item === '' && draft !== null}
            size={Math.max(1, item.length)}
            onChange={(event) => {
              setDraft(shown.map((v, i) => (i === index ? event.target.value : v)));
            }}
            onBlur={() => {
              commit(shown.filter((v) => v.trim() !== ''));
            }}
            onKeyDown={(event) => {
              if (submitted(event)) event.currentTarget.blur();
              if (event.key === 'Escape') {
                setDraft(null);
                event.currentTarget.blur();
              }
            }}
          />
          {!readOnly && (
            <button
              type="button"
              aria-label={`删除 ${item}`}
              onClick={() => {
                commit(shown.filter((_v, i) => i !== index));
              }}
            >
              <Icon name="x" className="size-3" />
            </button>
          )}
        </span>
      ))}

      {!readOnly && (
        <button
          type="button"
          aria-label="添加一项"
          onClick={() => {
            setDraft([...shown, '']);
          }}
          className="md-frontmatter-chip-add"
        >
          <Icon name="plus" className="size-3" />
        </button>
      )}
    </div>
  );
}

/**
 * The "add a property" row. The name is held locally until it is committed:
 * an empty name is not a property, so nothing is written to the document until
 * there is one.
 */
function AddRow({
  body,
  onWrite,
  onDropBlock,
}: {
  body: string;
  onWrite: (next: string) => void;
  /** Only offered while the block is empty — otherwise rows are removed one by one. */
  onDropBlock?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = (): void => {
    const key = draft.trim();
    setAdding(false);
    setDraft('');
    if (isFreeKey(body, key)) onWrite(addField(body, key));
  };

  if (adding) {
    return (
      <div className="md-frontmatter-row">
        <input
          autoFocus
          value={draft}
          spellCheck={false}
          placeholder="属性名"
          aria-label="新属性名"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (submitted(event)) event.currentTarget.blur();
            if (event.key === 'Escape') {
              setDraft('');
              setAdding(false);
            }
          }}
          className="md-frontmatter-key"
        />
        <span className="flex-1" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => {
          setAdding(true);
        }}
        className="md-frontmatter-add"
      >
        <Icon name="plus" className="size-3.5" />
        添加属性
      </button>

      {onDropBlock !== undefined && (
        <button type="button" onClick={onDropBlock} className="md-frontmatter-add">
          <Icon name="trash" className="size-3.5" />
          移除属性块
        </button>
      )}
    </div>
  );
}

/** Enter, but not the Enter that closes an IME candidate window. */
function submitted(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && !event.nativeEvent.isComposing;
}
