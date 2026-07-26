import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  countTasks,
  type TaskCount,
  type TaskScope,
  type TaskTreeNode,
  taskPercent,
} from "@/lib/taskProgress";

/** What the `taskProgress` block needs from the editor. Structural (not the
 * BlockNote generics) so the same component serves the editor and the public
 * read-only render. */
export interface ProgressEditor {
  readonly document: readonly TaskTreeNode[];
  onChange(callback: () => void): () => void;
}

/** Progress bar + percentage of a checklist. Presentational only. */
export function TaskProgressBar({
  count,
  scope,
  onToggleScope,
}: {
  count: TaskCount;
  scope: TaskScope;
  /** Absent = read-only render (public page): no scope switching. */
  onToggleScope?: () => void;
}) {
  const { t } = useTranslation();
  const pct = taskPercent(count);
  return (
    <div contentEditable={false} className="my-1 w-full select-none">
      <div className="flex items-center gap-3">
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("editor.taskProgress.aria", { done: count.done, total: count.total })}
          className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="shrink-0 text-sm font-medium tabular-nums">{pct}%</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {count.done}/{count.total}
        </span>
        {onToggleScope && (
          <button
            type="button"
            onClick={onToggleScope}
            title={t("editor.taskProgress.scope.switch")}
            className="shrink-0 rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t(scope === "page" ? "editor.taskProgress.scope.page" : "editor.taskProgress.scope.next")}
          </button>
        )}
      </div>
      {count.total === 0 && (
        <p className="mt-1 text-xs text-muted-foreground">{t("editor.taskProgress.empty")}</p>
      )}
    </div>
  );
}

/** `taskProgress` block connected to the document: recounts on every change,
 * local or remote (`onChange` includes remote updates by default). */
export function TaskProgressBlock({
  editor,
  blockId,
  scope,
  onToggleScope,
}: {
  editor: ProgressEditor;
  blockId: string;
  scope: TaskScope;
  onToggleScope?: () => void;
}) {
  const [count, setCount] = useState<TaskCount>(() => countTasks(editor.document, blockId, scope));

  useEffect(() => {
    // Same identity if the numbers haven't moved → no re-render per keystroke.
    const recount = () =>
      setCount((prev) => {
        const next = countTasks(editor.document, blockId, scope);
        return prev.done === next.done && prev.total === next.total ? prev : next;
      });
    recount();
    return editor.onChange(recount);
  }, [editor, blockId, scope]);

  return <TaskProgressBar count={count} scope={scope} onToggleScope={onToggleScope} />;
}
