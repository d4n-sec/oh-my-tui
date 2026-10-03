import { useEffect, useRef, useState } from "react";

interface Props {
  value: string;
  onSave: (next: string) => void | Promise<void>;
  displayClassName?: string;
  inputClassName?: string;
  displayTag?: "span" | "h1";
  title?: string;
}

/**
 * Click-to-edit label shared by the session list, the machine header and the
 * terminal header, so the interaction is identical everywhere.
 *
 * A blur schedules the commit ~200ms later instead of committing immediately,
 * so on touch devices a tap on 保存/取消 is not pre-empted by the input losing
 * focus first (the classic "hand tremor" mis-save). Pressing either button
 * cancels the pending blur commit.
 */
export function InlineEdit({
  value,
  onSave,
  displayClassName = "editable",
  inputClassName = "title-input inline",
  displayTag = "span",
  title = "点击重命名",
}: Props): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const blurTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(
    () => () => {
      if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
    },
    [],
  );

  function clearBlur(): void {
    if (blurTimer.current !== null) {
      window.clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  }

  function commit(): void {
    clearBlur();
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) void onSave(next);
  }

  function cancel(): void {
    clearBlur();
    setEditing(false);
    setDraft(value);
  }

  function scheduleBlurCommit(): void {
    clearBlur();
    blurTimer.current = window.setTimeout(() => {
      blurTimer.current = null;
      setEditing(false);
      const next = draft.trim();
      if (next && next !== value) void onSave(next);
    }, 200);
  }

  if (editing) {
    return (
      <span className="inline-edit">
        <input
          className={inputClassName}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={scheduleBlurCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") cancel();
          }}
        />
        <button className="mini" onMouseDown={(e) => e.preventDefault()} onClick={commit}>
          保存
        </button>
        <button className="mini" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
          取消
        </button>
      </span>
    );
  }

  const Tag = displayTag;
  return (
    <Tag
      className={displayClassName}
      title={title}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </Tag>
  );
}
