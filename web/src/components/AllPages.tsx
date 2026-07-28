import { ChevronDown, ChevronUp, Copy, Search, Share2, Star, Table2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { GraphView } from "@/components/db/GraphView";
import { ItemIcon } from "@/components/ItemIcon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { getPageGraph, type PageGraph } from "@/lib/api";
import type { GraphModel } from "@/lib/graph";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import type { ItemMeta } from "@/lib/api";

/** Sortable columns of the table. */
type SortKey = "name" | "type" | "parent" | "viewed";

/**
 * Dedicated page: free browsing of everything the user has access to (the same
 * set as the sidebar, without the cap), rendered as a database-like table —
 * sortable columns, multi-row selection and bulk actions (duplicate / delete /
 * favorite). Reuses `items` (listItems); search filters by title.
 */
export function AllPages({
  items,
  currentUserId,
  onSelect,
  onBulkDuplicate,
  onBulkDelete,
  onBulkFavorite,
}: {
  items: ItemMeta[];
  currentUserId: string;
  onSelect: (id: string) => void;
  onBulkDuplicate: (ids: string[]) => void;
  onBulkDelete: (ids: string[]) => void;
  onBulkFavorite: (ids: string[], favorite: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mode, setMode] = useState<"table" | "graph">("table");
  const [graph, setGraph] = useState<PageGraph | null>(null);

  // Fetch the page graph lazily, the first time the graph view is opened.
  useEffect(() => {
    if (mode !== "graph" || graph) return;
    let alive = true;
    getPageGraph()
      .then((g) => alive && setGraph(g))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mode, graph]);

  const graphModel = useMemo<GraphModel | null>(() => {
    if (!graph) return null;
    const untitled = t("common.untitled");
    return {
      nodes: graph.nodes.map((n) => ({
        id: n.id,
        label: n.title || untitled,
        // Databases get their own kind: drawn as a rounded square, not a
        // differently-coloured circle (cf. GraphView).
        group: n.is_db ? "database" : "row",
      })),
      edges: graph.edges.map((e) => ({ source: e.src, target: e.dst })),
    };
  }, [graph, t]);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const parentTitle = (it: ItemMeta): string =>
    it.parent_item_id ? (byId.get(it.parent_item_id)?.title || t("common.untitled")) : "";

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }),
    [i18n.language],
  );

  const query = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const filtered = query
      ? items.filter((it) => (it.title ?? "").toLowerCase().includes(query))
      : items;
    const title = (it: ItemMeta): string => it.title || "￿";
    const parentOf = (it: ItemMeta): string =>
      it.parent_item_id ? (byId.get(it.parent_item_id)?.title || t("common.untitled")) : "";
    const cmp = (a: ItemMeta, b: ItemMeta): number => {
      switch (sort.key) {
        case "type":
          return (a.db_schema ? 1 : 0) - (b.db_schema ? 1 : 0);
        case "parent":
          return parentOf(a).localeCompare(parentOf(b), undefined, { sensitivity: "base" });
        case "viewed":
          // Never-opened (null) sorts to the end regardless of direction.
          return (a.last_viewed_ts ?? -Infinity) - (b.last_viewed_ts ?? -Infinity);
        default:
          return title(a).localeCompare(title(b), undefined, { sensitivity: "base" });
      }
    };
    // Stable secondary sort by title so ties keep a predictable order.
    return [...filtered].sort((a, b) => {
      const primary = cmp(a, b) * sort.dir;
      if (primary !== 0) return primary;
      return title(a).localeCompare(title(b), undefined, { sensitivity: "base" });
    });
  }, [items, query, sort, byId, t]);

  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  // Selection helpers. Selection persists across search filtering.
  const selectedItems = useMemo(() => items.filter((it) => selected.has(it.id)), [items, selected]);
  const canDuplicate = selectedItems.filter((it) => it.can_edit);
  const canDelete = selectedItems.filter((it) => it.owner_id === currentUserId);

  const toggleOne = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const shownIds = shown.map((it) => it.id);
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => selected.has(id));
  const someShownSelected = shownIds.some((id) => selected.has(id));
  const toggleAllShown = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of shownIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const clear = () => setSelected(new Set());

  const runDuplicate = () => {
    if (canDuplicate.length > 0) onBulkDuplicate(canDuplicate.map((it) => it.id));
    clear();
  };
  const runFavorite = () => {
    if (selectedItems.length > 0) onBulkFavorite(selectedItems.map((it) => it.id), true);
    clear();
  };
  const runDelete = () => {
    if (canDelete.length > 0) onBulkDelete(canDelete.map((it) => it.id));
    setConfirmDelete(false);
    clear();
  };

  const Th = ({ col, label, className }: { col: SortKey; label: string; className?: string }) => (
    <th className={cn("px-3 py-2 text-left font-medium", className)}>
      <button
        type="button"
        onClick={() => toggleSort(col)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {sort.key === col &&
          (sort.dir === 1 ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />)}
      </button>
    </th>
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("allPages.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("allPages.count", { count: items.length })}
          </p>
        </div>
        {/* Table ⇄ graph view toggle. */}
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border p-0.5">
          <button
            type="button"
            onClick={() => setMode("table")}
            aria-label={t("allPages.viewTable")}
            className={cn(
              "flex size-7 items-center justify-center rounded text-muted-foreground hover:text-foreground",
              mode === "table" && "bg-accent text-foreground",
            )}
          >
            <Table2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => setMode("graph")}
            aria-label={t("allPages.viewGraph")}
            className={cn(
              "flex size-7 items-center justify-center rounded text-muted-foreground hover:text-foreground",
              mode === "graph" && "bg-accent text-foreground",
            )}
          >
            <Share2 className="size-4" />
          </button>
        </div>
      </div>

      {mode === "graph" ? (
        graphModel ? (
          <GraphView
            model={graphModel}
            height={600}
            onOpen={(id) => onSelect(id)}
            kindLabels={{ row: t("allPages.legendPages"), database: t("allPages.legendDatabases") }}
          />
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">{t("allPages.graphLoading")}</p>
        )
      ) : (
        <>
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("allPages.search")}
          className="pl-9"
          autoFocus
        />
      </div>

      {/* Bulk action bar — shown only when a selection exists. */}
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium">
            {t("allPages.selected", { count: selected.size })}
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="outline" onClick={runFavorite}>
            <Star className="size-3.5" /> {t("allPages.bulkFavorite")}
          </Button>
          <Button size="sm" variant="outline" onClick={runDuplicate} disabled={canDuplicate.length === 0}>
            <Copy className="size-3.5" /> {t("allPages.bulkDuplicate")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
            disabled={canDelete.length === 0}
          >
            <Trash2 className="size-3.5" /> {t("allPages.bulkDelete")}
          </Button>
          <Button size="sm" variant="ghost" onClick={clear} aria-label={t("allPages.clearSelection")}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("allPages.empty")}</p>
      ) : shown.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("allPages.noMatch")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2">
                  <Checkbox
                    checked={allShownSelected ? true : someShownSelected ? "indeterminate" : false}
                    onCheckedChange={(v) => toggleAllShown(v === true)}
                    aria-label={t("allPages.selectAll")}
                  />
                </th>
                <Th col="name" label={t("allPages.colName")} />
                <Th col="type" label={t("allPages.colType")} className="hidden sm:table-cell" />
                <Th col="parent" label={t("allPages.colParent")} className="hidden md:table-cell" />
                <Th col="viewed" label={t("allPages.colViewed")} className="hidden sm:table-cell" />
              </tr>
            </thead>
            <tbody>
              {shown.map((it) => {
                const parent = parentTitle(it);
                const isSel = selected.has(it.id);
                return (
                  <tr
                    key={it.id}
                    onClick={() => onSelect(it.id)}
                    className={cn(
                      "cursor-pointer border-b last:border-0 transition-colors hover:bg-accent",
                      isSel && "bg-accent/50",
                    )}
                  >
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSel}
                        onCheckedChange={(v) => toggleOne(it.id, v === true)}
                        aria-label={it.title || t("common.untitled")}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <ItemIcon
                          icon={it.icon}
                          kind={it.db_schema ? "database" : "page"}
                          size={16}
                          className="shrink-0"
                        />
                        <span className="truncate font-medium">
                          {it.title || t("common.untitled")}
                        </span>
                      </span>
                    </td>
                    <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                      {it.db_schema ? t("allPages.typeDatabase") : t("allPages.typePage")}
                    </td>
                    <td className="hidden max-w-[16rem] truncate px-3 py-2 text-muted-foreground md:table-cell">
                      {parent || "—"}
                    </td>
                    <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                      {it.last_viewed_ts != null ? dateFmt.format(it.last_viewed_ts) : t("allPages.never")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
        </>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("allPages.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("allPages.deleteBody", { count: canDelete.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={runDelete}>{t("allPages.deleteConfirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
