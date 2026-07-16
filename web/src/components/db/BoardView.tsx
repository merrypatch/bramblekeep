import { ChevronDown, ChevronRight, Maximize2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Cell } from "@/components/DatabaseView";
import { IconEditor } from "@/components/IconEditor";
import { OptionBadge } from "@/components/db/OptionBadge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DbColumn, Row } from "@/lib/db";
import { cn } from "@/lib/utils";

const NO_VALUE = "__none";

/** Kanban view: columns = options of a select field; cards = rows.
 * Dragging a card changes the field value (native drag&drop). */
export function BoardView({
  rows,
  column,
  cardColumns,
  columns,
  canEdit,
  canCreate,
  onOpenRow,
  onSetIcon,
  onSetValue,
  onAddRow,
  onDeleteRow,
  onReorder,
  onReorderColumn,
  collapsed,
  onToggleFold,
}: {
  rows: Row[];
  column: DbColumn;
  /** Properties displayed on the card (excluding grouping column). */
  cardColumns: DbColumn[];
  /** All columns of the schema (to resolve formulas). */
  columns: DbColumn[];
  /** Edit permission (dragging a card = changing value) — editor+. */
  canEdit: boolean;
  /** Add card permission — creator+. */
  canCreate: boolean;
  onOpenRow: (id: string) => void;
  /** Changes the card icon (if editable). */
  onSetIcon?: (id: string, icon: string) => void;
  onSetValue: (rowId: string, value: string) => void;
  onAddRow: (value: string) => void;
  onDeleteRow?: (row: Row) => void;
  /** Reorders: places `fromId` right before `toId` (shared order). */
  onReorder?: (fromId: string, toId: string) => void;
  /** Reorders categories: places the `from` option in `to`'s position. */
  onReorderColumn?: (from: string, to: string) => void;
  /** Collapsed categories (persisted). If missing, ephemeral local fallback. */
  collapsed?: string[];
  onToggleFold?: (opt: string) => void;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState<string | null>(null);
  const [overCard, setOverCard] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [localCollapsed, setLocalCollapsed] = useState<Set<string>>(new Set());
  const collapsedSet = onToggleFold ? new Set(collapsed ?? []) : localCollapsed;
  const toggleFold = (opt: string) => {
    if (onToggleFold) onToggleFold(opt);
    else
      setLocalCollapsed((s) => {
        const next = new Set(s);
        if (next.has(opt)) next.delete(opt);
        else next.add(opt);
        return next;
      });
  };
  const groups = [...(column.options ?? []), NO_VALUE];
  const valueOf = (r: Row) => {
    const v = r.props[column.id];
    if (typeof v === "string" && v) return v;
    // An empty "Status" is worth its default option (as displayed by the table)
    // -> consistency: never in "No value" if a default exists.
    return column.type === "status" ? (column.defaultOption ?? "") : "";
  };
  const rowsIn = (opt: string) =>
    rows.filter((r) => (opt === NO_VALUE ? valueOf(r) === "" : valueOf(r) === opt));

  /** Card dropped on another: changes column if needed, then reorders. */
  const dropOnCard = (fromId: string, target: Row, opt: string) => {
    setOverCard(null);
    if (!fromId || fromId === target.id) return;
    const targetVal = opt === NO_VALUE ? "" : opt;
    const fromRow = rows.find((r) => r.id === fromId);
    if (fromRow && valueOf(fromRow) !== targetVal) onSetValue(fromId, targetVal);
    onReorder?.(fromId, target.id);
  };

  // Measured available height (viewport - top of board) -> bounded columns
  // precisely, regardless of headers/covers above. Cards
  // scroll inside, the page does not overflow.
  const boardRef = useRef<HTMLDivElement>(null);
  const [maxH, setMaxH] = useState<number | undefined>(undefined);
  useEffect(() => {
    const update = () => {
      const el = boardRef.current;
      if (!el) return;
      // Margin = pb-2 of the board (8) + py-6 bottom of the DatabaseView container (24) + spacing.
      const h = Math.max(200, window.innerHeight - el.getBoundingClientRect().top - 40);
      setMaxH((prev) => (prev === undefined || Math.abs(prev - h) > 1 ? h : prev));
    };
    update();
    // Also reacts to asynchronous loading of cover / icon addition
    // (the top of the board goes down) -> columns scroll internally, not the page.
    const ro = new ResizeObserver(update);
    ro.observe(document.body);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div ref={boardRef} className="flex gap-3 overflow-x-auto pb-2">
      {groups.map((opt) => {
        const isCollapsed = collapsedSet.has(opt);
        const label = opt === NO_VALUE ? null : opt;
        return (
        <div
          key={opt}
          onDragOver={canEdit ? (e) => { e.preventDefault(); setOver(opt); } : undefined}
          onDragLeave={() => setOver((o) => (o === opt ? null : o))}
          onDrop={
            canEdit
              ? (e) => {
                  e.preventDefault();
                  const col = e.dataTransfer.getData("text/col");
                  if (col) {
                    if (col !== opt) onReorderColumn?.(col, opt);
                  } else {
                    const rowId = e.dataTransfer.getData("text/plain");
                    if (rowId) onSetValue(rowId, opt === NO_VALUE ? "" : opt);
                  }
                  setOver(null);
                  setOverCol(null);
                }
              : undefined
          }
          style={isCollapsed ? undefined : { maxHeight: maxH }}
          className={cn(
            "shrink-0 rounded-lg border bg-muted p-2",
            // Column bounded to available height (measured): cards scroll
            // inside, container does not exceed page height.
            // Collapsed = narrow; expanded = flexible (grows as others
            // collapse), bounded to remain readable.
            isCollapsed ? "w-11" : "flex min-w-[16rem] max-w-md flex-1 flex-col",
            over === opt && "ring-2 ring-primary/40",
            overCol === opt && "ring-2 ring-primary/60",
          )}
        >
          {isCollapsed ? (
            <button
              className="flex w-full flex-col items-center gap-1 text-xs font-medium text-muted-foreground"
              onClick={() => toggleFold(opt)}
              title={label ?? t("dbview.act.noValue")}
            >
              <ChevronRight className="size-3.5" />
              <span className="opacity-60">{rowsIn(opt).length}</span>
              <span className="[writing-mode:vertical-rl] max-h-40 truncate">
                {label ?? t("dbview.act.noValue")}
              </span>
            </button>
          ) : (
          <>
          <div
            draggable={canCreate && opt !== NO_VALUE && !!onReorderColumn}
            onDragStart={(e) => e.dataTransfer.setData("text/col", opt)}
            onDragOver={
              onReorderColumn
                ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setOverCol(opt);
                  }
                : undefined
            }
            className={cn(
              "mb-2 flex items-center gap-1 px-1 text-xs font-medium text-muted-foreground",
              canCreate && opt !== NO_VALUE && onReorderColumn && "cursor-grab active:cursor-grabbing",
            )}
          >
            <button
              aria-label={t("dbview.act.collapse")}
              className="shrink-0 hover:text-foreground"
              onClick={() => toggleFold(opt)}
            >
              <ChevronDown className="size-3.5" />
            </button>
            {opt === NO_VALUE ? (
              <span>{t("dbview.act.noValue")}</span>
            ) : (
              <OptionBadge value={opt} color={column.optionColors?.[opt]} />
            )}
            <span className="opacity-60">{rowsIn(opt).length}</span>
          </div>
          {canCreate && (
            <Button
              variant="ghost"
              size="sm"
              className="mb-1.5 h-7 w-full justify-start gap-1 text-xs text-muted-foreground"
              onClick={() => onAddRow(opt === NO_VALUE ? "" : opt)}
            >
              <Plus className="size-3.5" /> {t("dbview.act.add")}
            </Button>
          )}
          <div className="-mr-1 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {rowsIn(opt).map((r) => (
              <div
                key={r.id}
                draggable={canEdit}
                onDragStart={(e) => e.dataTransfer.setData("text/plain", r.id)}
                onDragEnd={() => setOverCard(null)}
                onDragOver={
                  canEdit
                    ? (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setOverCard(r.id);
                        setOver(null);
                      }
                    : undefined
                }
                onDrop={
                  canEdit
                    ? (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        dropOnCard(e.dataTransfer.getData("text/plain"), r, opt);
                      }
                    : undefined
                }
                onClick={() => onOpenRow(r.id)}
                className={`group flex cursor-pointer flex-col gap-1 rounded-md border bg-background px-2 py-1.5 text-sm shadow-sm hover:bg-accent ${overCard === r.id ? "border-t-2 border-t-primary" : ""}`}
              >
                <div className="flex items-start gap-1">
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <IconEditor
                      icon={r.icon}
                      size={14}
                      className="shrink-0"
                      canEdit={!!onSetIcon}
                      onChange={(v) => onSetIcon?.(r.id, v)}
                    />
                    <span className="truncate">{r.title || t("common.untitled")}</span>
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("dbview.act.rowActions")}
                        className="-my-1 shrink-0 opacity-0 group-hover:opacity-60 hover:opacity-100"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenuItem onSelect={() => onOpenRow(r.id)}>
                        <Maximize2 className="size-3.5" /> {t("dbview.view.open")}
                      </DropdownMenuItem>
                      {onDeleteRow && (
                        <DropdownMenuItem variant="destructive" onSelect={() => onDeleteRow(r)}>
                          <Trash2 className="size-3.5" /> {t("dbview.act.deleteRow")}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {cardColumns.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    {cardColumns.map((c) => {
                      const v = r.props[c.id];
                      if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) return null;
                      return (
                        <div key={c.id} className="text-xs text-muted-foreground">
                          <Cell col={c} value={v} canEdit={false} rowProps={r.props} columns={columns} onChange={() => {}} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
          </>
          )}
        </div>
        );
      })}
    </div>
  );
}
