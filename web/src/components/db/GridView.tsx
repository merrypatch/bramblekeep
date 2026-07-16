import { ImageIcon, MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Cell } from "@/components/DatabaseView";
import { ItemIcon } from "@/components/ItemIcon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type DbColumn, type GridSize, META_TYPES, type Row } from "@/lib/db";
import { cn } from "@/lib/utils";

/** Dimensions derived from card size. */
const SIZES: Record<GridSize, { min: string; img: string }> = {
  s: { min: "9rem", img: "h-24" },
  m: { min: "13rem", img: "h-36" },
  l: { min: "18rem", img: "h-52" },
};

/** Grid view (gallery): cards with image (cover or file column),
 * placeholder if none, and selected properties below. */
export function GridView({
  rows,
  cardColumns,
  columns,
  size,
  showImage,
  imageUrl,
  onOpenRow,
  onDeleteRow,
  onReorder,
}: {
  rows: Row[];
  /** Properties displayed below the card title. */
  cardColumns: DbColumn[];
  /** All columns in the schema (to resolve formulas). */
  columns: DbColumn[];
  size: GridSize;
  /** Show image area (false = "none" source, not even a placeholder). */
  showImage: boolean;
  /** URL of the row image (cover or first image of a column), or null. */
  imageUrl: (row: Row) => string | null;
  canCreate: boolean;
  onOpenRow: (id: string) => void;
  onAddRow?: () => void;
  onDeleteRow?: (row: Row) => void;
  /** Reorder via drag and drop (moves `fromId` to the position of `toId`). */
  onReorder?: (fromId: string, toId: string) => void;
}) {
  const { t } = useTranslation();
  const s = SIZES[size];
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${s.min}, 1fr))` }}
    >
      {rows.map((r) => {
        const src = imageUrl(r);
        return (
          <div
            key={r.id}
            draggable={!!onReorder}
            onDragStart={
              onReorder
                ? (e) => {
                    e.dataTransfer.setData("text/plain", r.id);
                    setDragId(r.id);
                  }
                : undefined
            }
            onDragOver={
              onReorder
                ? (e) => {
                    e.preventDefault();
                    setOverId(r.id);
                  }
                : undefined
            }
            onDragLeave={() => setOverId((o) => (o === r.id ? null : o))}
            onDrop={
              onReorder
                ? (e) => {
                    e.preventDefault();
                    const from = e.dataTransfer.getData("text/plain");
                    if (from) onReorder(from, r.id);
                    setDragId(null);
                    setOverId(null);
                  }
                : undefined
            }
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            className={cn(
              "group relative flex flex-col overflow-hidden rounded-lg border bg-background text-left transition-shadow hover:shadow-md",
              onReorder && "cursor-grab active:cursor-grabbing",
              overId === r.id && "ring-2 ring-primary",
              dragId === r.id && "opacity-50",
            )}
          >
            <button className="block w-full text-left" onClick={() => onOpenRow(r.id)}>
              {showImage &&
                (src ? (
                  <img src={src} alt="" className={`w-full ${s.img} object-cover`} />
                ) : (
                  <div className={`flex w-full ${s.img} items-center justify-center bg-muted`}>
                    <ImageIcon className="size-6 text-muted-foreground/40" />
                  </div>
                ))}
              <div className="flex items-center gap-1 px-2 pt-2">
                <ItemIcon icon={r.icon} size={16} className="shrink-0" />
                <span className="truncate text-sm font-medium">{r.title || t("common.untitled")}</span>
              </div>
            </button>
            {cardColumns.length > 0 && (
              <div className="space-y-0.5 px-2 pt-1 pb-2">
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
            {onDeleteRow && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="secondary"
                    aria-label={t("dbview.act.rowActions")}
                    className="absolute top-1 right-1 size-6 opacity-0 group-hover:opacity-100"
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="destructive" onSelect={() => onDeleteRow(r)}>
                    <Trash2 className="size-3.5" /> {t("dbview.act.deleteRow")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Columns offerable as an image source (file columns). */
export function imageColumns(columns: DbColumn[]): DbColumn[] {
  return columns.filter((c) => c.type === "files" && !META_TYPES.has(c.type));
}
