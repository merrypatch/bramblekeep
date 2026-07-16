import { Lock, LockOpen } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { TableSkeleton } from "@/components/ui/skeletons";
import { getItem, type ItemMeta } from "@/lib/api";
import { acquireRoom, releaseRoom, type Room } from "@/lib/room";

/** Sort/filters per view, specific to a linked database block. */
export type ViewState = Record<
  string,
  { sort?: { key: string; dir: "asc" | "desc" } | null; filters?: { id: string; key: string; query: string }[] }
>;

// Lazy loaded to break the import cycle: editorSchema -> DatabaseView ->
// Editor -> editorSchema (import only happens at block render time).
const DatabaseView = lazy(() =>
  import("@/components/DatabaseView").then((m) => ({ default: m.DatabaseView })),
);

/** Inline database rendered within a page (block `dbview`). Loads the
 * meta + its dedicated room, then delegates to DatabaseView. `contentEditable={false}`
 * : the editor does not treat the interior as text. */
export function InlineDatabase({
  itemId,
  locked,
  onToggleLock,
  hiddenViews,
  onSetHiddenViews,
  viewState,
  onSetViewState,
}: {
  itemId: string;
  /** Lock specific to this block: read-only view without locking the source db. */
  locked?: boolean;
  onToggleLock?: () => void;
  /** Hidden views specific to this block (not to the database schema). */
  hiddenViews?: string[];
  onSetHiddenViews?: (ids: string[]) => void;
  /** Sort/filters specific to this block (per view), serialized in the block. */
  viewState?: ViewState;
  onSetViewState?: (next: ViewState) => void;
}) {
  const { t } = useTranslation();
  const [meta, setMeta] = useState<ItemMeta | null>(null);
  const [missing, setMissing] = useState(false);
  const [rt, setRt] = useState<Room | null>(null);

  useEffect(() => {
    setRt(acquireRoom(itemId));
    return () => releaseRoom(itemId);
  }, [itemId]);

  useEffect(() => {
    let alive = true;
    setMeta(null);
    setMissing(false);
    getItem(itemId)
      .then((m) => alive && setMeta(m))
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [itemId]);

  if (missing || (meta && meta.db_schema == null)) {
    return (
      <div contentEditable={false} className="my-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        {t("dbview.inline.unavailable")}
      </div>
    );
  }
  if (!meta || !rt) {
    return (
      <div contentEditable={false} className="my-2 p-2">
        <TableSkeleton />
      </div>
    );
  }

  return (
    <div contentEditable={false} className="group/inlinedb relative my-2 w-full min-w-0">
      {onToggleLock && (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={locked ? t("dbview.inline.unlock") : t("dbview.inline.lock")}
          title={locked ? t("dbview.inline.locked") : t("dbview.inline.lock")}
          className={locked ? "absolute top-1 right-1 z-10" : "absolute top-1 right-1 z-10 opacity-0 group-hover/inlinedb:opacity-100"}
          onClick={onToggleLock}
        >
          {locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
        </Button>
      )}
      <Suspense fallback={<div className="p-2"><TableSkeleton /></div>}>
        <DatabaseView
          dbId={itemId}
          schemaJson={meta.db_schema}
          canEdit={!locked && meta.can_edit}
          canCreate={!locked && (meta.can_create ?? false)}
          canDelete={!locked && (meta.can_delete ?? false)}
          doc={rt.doc}
          awareness={rt.awareness}
          hiddenViews={hiddenViews}
          onSetHiddenViews={onSetHiddenViews}
          viewState={viewState}
          onSetViewState={onSetViewState}
        />
      </Suspense>
    </div>
  );
}
